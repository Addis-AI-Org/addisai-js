import { expect, it, vi } from "vitest";
import AddisAI, { type ScribeJobStatus } from "../src/index.js";

const MiB = 1024 * 1024; const PART = 32 * MiB; const SIZE = 95 * MiB + 1;
const usage = { record_id: "ledger", characters: 74210, price_per_1000_characters: 3.5, credits_used: 259.735, credits_remaining: 1240.27, currency: "ETB", settled: true };
const result = { request_id: "stable", text: "ሰላም ወዳጆቻችን", seconds: 9015.3, compute_ms: 61234, backend: "turbo", chunk: "1120ms", mode: "job", model: "addis-scribe-streaming", chunks: 6, words: [{ text: "ሰላም", start: .7, end: 1.1, speaker: 1 }], segments: [{ text: "ሰላም ወዳጆቻችን", start: .3, end: 4.2, speaker: 1 }], speakers: 3, usage };
const queued = { request_id: "stable", status: "queued", audio_seconds: null, poll_url: "/api/v1/scribe/requests/stable", job_url: "/api/v1/scribe/jobs/stable" };
const processing = { ...queued, status: "processing", audio_seconds: 9015.3, processed_seconds: 3000, chunks: { total: 6, done: 2 } };
function client(fetch: typeof globalThis.fetch) { return new AddisAI({ apiKey: "test-secret", fetch }); }
/** A file just over the one-request limit, with markers at every part boundary. */
function bigFile(): Uint8Array {
  const file = new Uint8Array(SIZE);
  file[0] = 1; file[PART - 1] = 2; file[PART] = 3; file[2 * PART - 1] = 4; file[2 * PART] = 5; file[SIZE - 1] = 6;
  return file;
}
it("uploads a small file in one request, polls until settled, reports progress and honours Retry-After", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const addis = client(async (url, init) => {
    const u = new URL(String(url)); calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (init?.method === "POST") {
      expect(u.pathname).toBe("/api/v1/scribe/jobs");
      expect(Object.fromEntries(u.searchParams)).toEqual({ request_id: "stable", backend: "turbo", chunk: "1120ms", timestamps: "word", speakers: "true" });
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      expect((init?.body as FormData).get("audio")).toBeInstanceOf(Blob);
      return Response.json({ data: queued }, { status: 202, headers: { "Retry-After": "5", Location: queued.poll_url } });
    }
    expect(u.pathname).toBe("/api/v1/scribe/requests/stable");
    if (calls.length === 2) return Response.json({ data: queued }, { status: 202, headers: { "Retry-After": "7" } });
    if (calls.length === 3) return Response.json({ data: processing }, { status: 202 });
    return Response.json({ data: result });
  });
  const progress: ScribeJobStatus[] = [];
  const pending = addis.scribe.transcribeLong({ audio: new Uint8Array([1, 2]), requestId: "stable", timestamps: "word", speakers: true, onProgress: p => progress.push(p) });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(calls).toHaveLength(2);           // Retry-After: 7 → no second poll yet
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(5_000); // no header → the default 5 s
  const transcript = await pending;
  expect(calls).toEqual(["POST /api/v1/scribe/jobs", "GET /api/v1/scribe/requests/stable", "GET /api/v1/scribe/requests/stable", "GET /api/v1/scribe/requests/stable"]);
  expect(transcript.mode).toBe("job"); expect(transcript.chunks).toBe(6); expect(transcript.speakers).toBe(3); expect(transcript.usage.creditsUsed).toBe(259.735);
  expect(progress.map(p => p.status)).toEqual(["queued", "processing"]);
  expect(progress[1]).toMatchObject({ requestId: "stable", audioSeconds: 9015.3, processedSeconds: 3000, chunks: { total: 6, done: 2 }, pollUrl: "/api/v1/scribe/requests/stable", jobUrl: "/api/v1/scribe/jobs/stable" });
  vi.useRealTimers();
});
it("declares a large file, sends every part in order as raw bytes, completes and waits", async () => {
  const puts: Array<{ index: number; length: number; first: number; last: number }> = []; const received: number[] = [];
  const addis = client(async (url, init) => {
    const u = new URL(String(url)); const method = init?.method;
    if (method === "POST" && u.pathname === "/api/v1/scribe/jobs") {
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ request_id: "stable", bytes: SIZE, backend: "turbo", chunk: "1120ms", speakers: true });
      return Response.json({ data: { request_id: "stable", status: "uploading", part_bytes: PART, parts: 3, received: [], expires_at: 1792000000, job_url: "/api/v1/scribe/jobs/stable" } }, { status: 201 });
    }
    if (method === "PUT") {
      const index = Number(u.pathname.split("/").pop()); expect(u.pathname).toBe(`/api/v1/scribe/jobs/stable/parts/${index}`);
      expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
      const body = init?.body as Uint8Array; puts.push({ index, length: body.byteLength, first: body[0]!, last: body[body.byteLength - 1]! }); received.push(index);
      return Response.json({ data: { index, received: [...received] } });
    }
    if (method === "POST" && u.pathname === "/api/v1/scribe/jobs/stable/complete") { expect(received).toEqual([0, 1, 2]); return Response.json({ data: queued }, { status: 202, headers: { "Retry-After": "5" } }); }
    expect(`${method ?? "GET"} ${u.pathname}`).toBe("GET /api/v1/scribe/requests/stable");
    return Response.json({ data: result });
  });
  const transcript = await addis.scribe.transcribeLong({ audio: bigFile(), requestId: "stable", speakers: true });
  expect(transcript.text).toBe(result.text); expect(transcript.words?.[0]?.speaker).toBe(1);
  expect(puts).toEqual([{ index: 0, length: PART, first: 1, last: 2 }, { index: 1, length: PART, first: 3, last: 4 }, { index: 2, length: SIZE - 2 * PART, first: 5, last: 6 }]);
});
it("resumes from the parts the server already has and resends a part after a connection error", async () => {
  const puts: number[] = []; let dropped = false;
  const addis = client(async (url, init) => {
    const u = new URL(String(url)); const method = init?.method;
    if (method === "POST" && u.pathname === "/api/v1/scribe/jobs") return Response.json({ data: { request_id: "stable", status: "uploading", part_bytes: PART, parts: 3, received: [0, 2], expires_at: 1792000000, job_url: "/api/v1/scribe/jobs/stable" } });
    if (method === "PUT") {
      const body = init?.body as Uint8Array;
      expect([u.pathname, body.byteLength, body[0], body[PART - 1]]).toEqual(["/api/v1/scribe/jobs/stable/parts/1", PART, 3, 4]);
      if (!dropped) { dropped = true; throw new TypeError("fetch failed"); }
      puts.push(1); return Response.json({ data: { index: 1, received: [0, 1, 2] } });
    }
    if (method === "POST") return Response.json({ data: queued }, { status: 202 });
    return Response.json({ data: result });
  });
  const transcript = await addis.scribe.transcribeLong({ audio: { data: new Blob([bigFile()]), filename: "long.wav", contentType: "audio/wav" }, requestId: "stable" });
  expect(transcript.chunks).toBe(6); expect(puts).toEqual([1]);
});
it("validates locally before any HTTP", async () => {
  let calls = 0; const addis = client(async () => { calls++; return Response.json({}); });
  const audio = new Uint8Array([1]);
  await expect(addis.scribe.jobs.upload({ audio, requestId: "bad/id" })).rejects.toThrow(/requestId/);
  await expect(addis.scribe.jobs.upload({ audio: new Uint8Array(SIZE) })).rejects.toThrow(/jobs\.create/);
  await expect(addis.scribe.jobs.create({ requestId: "stable", bytes: 10, backend: "standard", speakers: true })).rejects.toThrow(/turbo/);
  await expect(addis.scribe.jobs.create({ requestId: "stable", bytes: 0 })).rejects.toThrow(/bytes/);
  await expect(addis.scribe.transcribeLong({ audio, backend: "standard", speakers: true })).rejects.toThrow(/turbo/);
  await expect(addis.scribe.transcribeLong({ audio: new Uint8Array(), requestId: "stable" })).rejects.toThrow(/1 byte/);
  await expect(addis.scribe.jobs.putPart("stable", -1, audio)).rejects.toThrow(/index/);
  await expect(addis.scribe.jobs.putPart("stable", 0, new Uint8Array())).rejects.toThrow(/non-empty/);
  await expect(addis.scribe.jobs.wait("bad/id")).rejects.toThrow(/requestId/);
  expect(calls).toBe(0);
});
it("never automatically retries a paid job step", async () => {
  let calls = 0; const addis = client(async () => { calls++; return Response.json({ error: { code: "BILLING_PENDING", message: "recover" } }, { status: 503 }); });
  const opts = { maxRetries: 3 };
  await expect(addis.scribe.jobs.upload({ audio: new Uint8Array([1]), requestId: "stable" }, opts)).rejects.toMatchObject({ status: 503, code: "BILLING_PENDING" });
  await expect(addis.scribe.jobs.create({ requestId: "stable", bytes: 1 }, opts)).rejects.toMatchObject({ status: 503 });
  await expect(addis.scribe.jobs.putPart("stable", 0, new Uint8Array([1]), opts)).rejects.toMatchObject({ status: 503 });
  await expect(addis.scribe.jobs.complete("stable", opts)).rejects.toMatchObject({ status: 503 });
  expect(calls).toBe(4);
});
it("maps job status, capabilities and a finished job's result", async () => {
  const view = { request_id: "stable", status: "failed", part_bytes: 4194304, parts: 87, received: [0, 1], audio_seconds: 9015.3, processed_seconds: 1500, chunks: { total: 6, done: 1 }, poll_url: "/api/v1/scribe/requests/stable", job_url: "/api/v1/scribe/jobs/stable", expires_at: 1792000000, error: { code: "INVALID_AUDIO", message: "Longer than three hours." } };
  const jobs = { backends: ["turbo"], max_bytes: 536870912, max_seconds: 10800, max_upload_bytes: 99614720, part_bytes: 4194304, chunk_seconds: 1500, overlap_seconds: 30, timestamps: ["none", "word"], formats: ["json", "srt", "vtt"], defaults: { backend: "turbo", chunk: "1120ms", timestamps: "word", speakers: false } };
  const addis = client(async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/v1/scribe") return Response.json({ data: { language: "am", jobs } });
    if (u.pathname.endsWith("/complete")) return Response.json({ data: { ...result, idempotent_replay: true } });
    expect(`${init?.method} ${u.pathname}`).toBe("GET /api/v1/scribe/jobs/stable");
    return Response.json({ data: view });
  });
  expect(await addis.scribe.jobs.status("stable")).toEqual({ requestId: "stable", status: "failed", partBytes: 4194304, parts: 87, received: [0, 1], audioSeconds: 9015.3, processedSeconds: 1500, chunks: { total: 6, done: 1 }, pollUrl: "/api/v1/scribe/requests/stable", jobUrl: "/api/v1/scribe/jobs/stable", expiresAt: 1792000000, error: { code: "INVALID_AUDIO", message: "Longer than three hours." } });
  expect((await addis.scribe.capabilities()).jobs).toMatchObject({ maxUploadBytes: 99614720, partBytes: 4194304, maxSeconds: 10800, defaults: { timestamps: "word", speakers: false } });
  expect(await addis.scribe.jobs.complete("stable")).toMatchObject({ idempotentReplay: true, usage: { settled: true } });
});
it("throws the job's own error while polling and rejects unsettled or incomplete answers", async () => {
  const failed = client(async () => Response.json({ status: "error", error: { code: "INSUFFICIENT_CREDITS", message: "Top up." } }, { status: 402 }));
  await expect(failed.scribe.jobs.wait("stable")).rejects.toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" });
  const unsettled = client(async () => Response.json({ data: { ...result, usage: { ...usage, settled: false } } }));
  await expect(unsettled.scribe.jobs.wait("stable")).rejects.toThrow(/settled billing/);
  const incomplete = client(async () => Response.json({ status: "error", error: { code: "UPLOAD_INCOMPLETE", message: "2 parts are missing.", missing: [1, 2] } }, { status: 409 }));
  await expect(incomplete.scribe.jobs.complete("stable")).rejects.toMatchObject({ status: 409, code: "UPLOAD_INCOMPLETE" });
  const endless = client(async () => Response.json({ data: processing }, { status: 202 }));
  await expect(endless.scribe.jobs.wait("stable", { pollMs: 1, timeoutMs: 10 })).rejects.toThrow(/still running/);
});
