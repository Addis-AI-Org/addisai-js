import { expect, it } from "vitest";
import AddisAI, { type ScribeLanguage, type ScribeSocket } from "../src/index.js";

// Afaan Oromo (language: "om") on every Scribe entry point, and Amharic requests unchanged without it.
const om = { text: "Akkam jirtu", request_id: "om1", seconds: 2, compute_ms: 5, backend: "turbo", chunk: "1120ms", mode: "offline", language: "om", model: "addis-scribe-oromo-streaming", usage: { record_id: "ledger", characters: 11, price_per_1000_characters: 3.5, credits_used: .0385, credits_remaining: 9.96, currency: "ETB", settled: true } };
const ticket = { token: "ephemeral", request_id: "om1", expires_at: 9999999999, websocket_url: "wss://api.addisassistant.com/api/v1/scribe/stream", backend: "turbo", chunk: "320ms", max_audio_seconds: 900, language: "om" };
const queued = { request_id: "om1", status: "queued", poll_url: "/api/v1/scribe/requests/om1", job_url: "/api/v1/scribe/jobs/om1" };
type Seen = { method: string; url: URL; body: unknown };
function recording(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const addis = new AddisAI({ apiKey: "test-secret", fetch: async (url, init) => {
    const entry = { method: init?.method ?? "GET", url: new URL(String(url)), body: init?.body }; seen.push(entry); return respond(entry);
  } });
  return { addis, seen };
}
const params = (s: Seen) => Object.fromEntries(s.url.searchParams);
const audio = new Uint8Array([1, 2]);

it("transcribe sends language=om as a query parameter and maps the Oromo model", async () => {
  const { addis, seen } = recording(() => Response.json({ data: om }));
  const language: ScribeLanguage = "om";
  const result = await addis.scribe.transcribe({ audio, requestId: "om1", language });
  expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "om1", language: "om", stream: "false" });
  expect(result.language).toBe("om"); expect(result.model).toBe("addis-scribe-oromo-streaming");
});
it("transcribe without language sends exactly the request it sent before", async () => {
  const { addis, seen } = recording(() => Response.json({ data: { ...om, language: "am", model: "addis-scribe-streaming" } }));
  await addis.scribe.transcribe({ audio, requestId: "om1", timestamps: "word", speakers: true });
  expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "om1", timestamps: "word", speakers: "true", stream: "false" });
  expect(seen[0].url.toString()).not.toContain("language");
});
it("an explicit language: \"am\" is sent as given", async () => {
  const { addis, seen } = recording(() => Response.json({ data: om }));
  await addis.scribe.transcribe({ audio, requestId: "om1", language: "am" });
  expect(seen[0].url.searchParams.get("language")).toBe("am");
});
it("stream sends language only when set", async () => {
  const { addis, seen } = recording(() => Response.json({ data: om }));
  expect((await (await addis.scribe.stream({ audio, requestId: "om1", language: "om" })).read()).language).toBe("om");
  await (await addis.scribe.stream({ audio, requestId: "om1" })).read();
  expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "om1", language: "om", stream: "true" });
  expect(params(seen[1])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "om1", stream: "true" });
});
it("live sessions send language in the JSON body only when set", async () => {
  const { addis, seen } = recording(() => Response.json({ data: ticket }, { status: 201 }));
  expect((await addis.scribe.createSession({ requestId: "om1", language: "om" })).language).toBe("om");
  await addis.scribe.createSession({ requestId: "om1" });
  expect(JSON.parse(String(seen[0].body))).toEqual({ backend: "turbo", chunk: "320ms", request_id: "om1", language: "om" });
  expect(JSON.parse(String(seen[1].body))).toEqual({ backend: "turbo", chunk: "320ms", request_id: "om1" });
  expect(seen[0].url.search).toBe(""); expect(seen[1].url.search).toBe("");
});
it("connect passes language to the ticket", async () => {
  class Socket implements ScribeSocket {
    handlers: Record<string, Array<(e: any) => void>> = {};
    constructor() { queueMicrotask(() => this.emit("open", {})); }
    addEventListener(type: string, cb: (e: any) => void) { (this.handlers[type] ??= []).push(cb); }
    emit(type: string, event: any) { for (const cb of this.handlers[type] ?? []) cb(event); }
    send(data: string | Uint8Array) {
      if (typeof data === "string" && JSON.parse(data).type === "session.authenticate") this.emit("message", { data: JSON.stringify({ type: "session.created", sample_rate: 16000, format: "pcm_s16le", request_id: "om1", max_audio_seconds: 900 }) });
    }
    close() {}
  }
  const { addis, seen } = recording(() => Response.json({ data: ticket }, { status: 201 }));
  const live = await addis.scribe.connect({ requestId: "om1", language: "om" }, { webSocketFactory: () => new Socket() });
  expect(JSON.parse(String(seen[0].body)).language).toBe("om"); live.close();
});
it("jobs.upload and transcribeLong send language only when set", async () => {
  const { addis, seen } = recording(s => s.method === "POST" ? Response.json({ data: queued }, { status: 202 }) : Response.json({ data: { ...om, mode: "job", chunks: 1 } }));
  await addis.scribe.jobs.upload({ audio, requestId: "om1", language: "om" });
  await addis.scribe.jobs.upload({ audio, requestId: "om1" });
  const result = await addis.scribe.transcribeLong({ audio, requestId: "om1", language: "om" });
  const base = { backend: "turbo", chunk: "1120ms", request_id: "om1" };
  expect(seen.filter(s => s.method === "POST").map(params)).toEqual([{ ...base, language: "om" }, base, { ...base, language: "om" }]);
  expect(result.model).toBe("addis-scribe-oromo-streaming");
});
it("a job declaration sends language as a query parameter, with an unchanged JSON body", async () => {
  const { addis, seen } = recording(() => Response.json({ data: { request_id: "om1", status: "uploading", part_bytes: 4, parts: 3, received: [] } }, { status: 201 }));
  await addis.scribe.jobs.create({ requestId: "om1", bytes: 10, language: "om" });
  await addis.scribe.jobs.create({ requestId: "om1", bytes: 10 });
  expect(seen.map(params)).toEqual([{ language: "om" }, {}]);
  const body = { backend: "turbo", chunk: "1120ms", request_id: "om1", bytes: 10 };
  expect(seen.map(s => JSON.parse(String(s.body)))).toEqual([body, body]);
});
it("passes server refusals through and rejects non-string languages locally", async () => {
  const { addis, seen } = recording(() => Response.json({ error: { code: "UNSUPPORTED_LANGUAGE", message: "Use language=am|om." } }, { status: 422 }));
  await expect(addis.scribe.transcribe({ audio, requestId: "om1", language: "ti" as ScribeLanguage })).rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_LANGUAGE" });
  expect(seen).toHaveLength(1);
  for (const bad of ["", 1, true] as unknown as ScribeLanguage[]) {
    await expect(addis.scribe.transcribe({ audio, language: bad })).rejects.toThrow(/language/);
    await expect(addis.scribe.createSession({ language: bad })).rejects.toThrow(/language/);
    await expect(addis.scribe.jobs.create({ requestId: "om1", bytes: 10, language: bad })).rejects.toThrow(/language/);
    await expect(addis.scribe.transcribeLong({ audio, language: bad })).rejects.toThrow(/language/);
  }
  expect(seen).toHaveLength(1);
});
