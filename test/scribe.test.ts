import { expect, it } from "vitest";
import AddisAI, { connectScribe, type ScribeSession, type ScribeSocket } from "../src/index.js";

const raw = { text: "ሰላም😀", request_id: "stable", seconds: 1, compute_ms: 5, backend: "cpu", chunk: "1120ms", mode: "offline", model: "addis-scribe-streaming", usage: { record_id: "ledger", characters: 6, price_per_1000_characters: 3.5, credits_used: .021, credits_remaining: 9.979, currency: "ETB", settled: true } };
const ticket: ScribeSession = { token: "ephemeral", requestId: "stable", expiresAt: 9999999999, websocketUrl: "wss://api.addisassistant.com/api/v1/scribe/stream", backend: "cpu", chunk: "320ms", maxAudioSeconds: 180 };
function client(fetch: typeof globalThis.fetch) { return new AddisAI({ apiKey: "test-secret", fetch }); }
function ndjson(events: unknown[]): Response {
  const bytes = new TextEncoder().encode(events.map(e => JSON.stringify(e)).join("\n")); let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close(); } }), { headers: { "Content-Type": "application/x-ndjson" } });
}
it("sends Scribe multipart and stable request ID, maps timing and settled usage", async () => {
  const addis = client(async (url, init) => {
    expect(new URL(String(url)).pathname).toBe("/api/v1/scribe/transcribe");
    expect(new URL(String(url)).searchParams.get("request_id")).toBe("stable");
    expect(new URL(String(url)).searchParams.get("stream")).toBe("false");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("test-secret");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
    expect((init?.body as FormData).get("audio")).toBeInstanceOf(Blob);
    return Response.json({ data: raw });
  });
  const result = await addis.scribe.transcribe({ audio: new Uint8Array([1, 2]), requestId: "stable" });
  expect(result.text).toBe(raw.text); expect(result.computeMs).toBe(5); expect(result.usage.creditsUsed).toBe(.021);
});
it("never automatically retries a paid upload or ticket issuance", async () => {
  let calls = 0; const addis = client(async () => { calls++; return Response.json({ error: { code: "BILLING_PENDING", message: "recover" } }, { status: 503 }); });
  await expect(addis.scribe.transcribe({ audio: new Uint8Array([1, 2]), requestId: "stable" }, { maxRetries: 3 })).rejects.toThrow("recover");
  await expect(addis.scribe.createSession({ requestId: "stable" }, { maxRetries: 3 })).rejects.toThrow("recover");
  expect(calls).toBe(2);
});
it("parses split UTF-8 partials and a completion without a trailing newline", async () => {
  const stream = await client(async () => ndjson([{ type: "transcript.partial", text: "ሰላ", request_id: "stable" }, { type: "transcript.completed", data: raw }])).scribe.stream({ audio: new Uint8Array([1, 2]), requestId: "stable" });
  const events = []; for await (const event of stream) events.push(event);
  expect(events.map(e => e.type)).toEqual(["transcript.partial", "transcript.completed"]);
  expect(stream.requestId).toBe("stable"); expect(stream.completion?.usage.characters).toBe(6);
});
it("handles already paid JSON replay through the streaming interface", async () => {
  const stream = await client(async () => Response.json({ data: { ...raw, idempotent_replay: true } })).scribe.stream({ audio: new Uint8Array([1, 2]), requestId: "stable" });
  expect((await stream.read()).idempotentReplay).toBe(true);
});
it("rejects truncated and unsettled completions and preserves stream error codes", async () => {
  for (const events of [[{ type: "transcript.partial", text: "ሰላ", request_id: "stable" }], [{ type: "transcript.completed", data: { ...raw, usage: { settled: false } } }]]) {
    const stream = await client(async () => ndjson(events)).scribe.stream({ audio: new Uint8Array([1, 2]) });
    await expect(stream.read()).rejects.toThrow(/billing/);
  }
  const stream = await client(async () => ndjson([{ type: "error", status: 429, error: { code: "BUSY", message: "busy" } }])).scribe.stream({ audio: new Uint8Array([1, 2]) });
  await expect(stream.read()).rejects.toMatchObject({ status: 429, code: "BUSY" });
});
it("validates inputs before HTTP and recovers a result without uploading audio", async () => {
  let calls = 0; const addis = client(async url => { calls++; expect(String(url)).toContain("/requests/stable"); return Response.json({ data: { ...raw, idempotent_replay: true } }); });
  await expect(addis.scribe.createSession({ requestId: "bad/id" })).rejects.toThrow(/requestId/);
  await expect(addis.scribe.transcribe({ audio: new Uint8Array() })).rejects.toThrow(/25 MiB/);
  expect(calls).toBe(0); expect((await addis.scribe.recover("stable")).idempotentReplay).toBe(true); expect(calls).toBe(1);
});
it("maps capabilities, usage and default microphone session parameters", async () => {
  const addis = client(async (url, init) => {
    if (String(url).endsWith("/sessions")) { expect(JSON.parse(String(init?.body))).toEqual({ backend: "cpu", chunk: "320ms", request_id: "stable" }); return Response.json({ data: { ...ticket, websocket_url: ticket.websocketUrl, request_id: "stable" } }); }
    if (String(url).endsWith("/usage")) return Response.json({ data: { balance: 10, currency: "ETB", pricing: { unit: "character", price_per_1000_characters: 3.5 } } });
    return Response.json({ data: { language: "am", max_audio_seconds: 180 } });
  });
  expect((await addis.scribe.capabilities()).language).toBe("am");
  expect((await addis.scribe.usage()).pricing.pricePer1000Characters).toBe(3.5);
  expect((await addis.scribe.createSession({ requestId: "stable" })).requestId).toBe("stable");
});
class Socket implements ScribeSocket {
  handlers: Record<string, Array<(e: any) => void>> = {}; sent: Array<string | Uint8Array> = []; bufferedAmount = 0; closed = false;
  constructor(private replay = false) { queueMicrotask(() => this.emit("open", {})); }
  addEventListener(type: string, cb: (e: any) => void) { (this.handlers[type] ??= []).push(cb); }
  emit(type: string, event: any) { for (const cb of this.handlers[type] ?? []) cb(event); }
  event(data: unknown) { this.emit("message", { data: JSON.stringify(data) }); }
  send(data: string | Uint8Array) {
    this.sent.push(data); if (typeof data !== "string") { this.event({ type: "transcript.partial", text: "ሰላ", request_id: "stable" }); return; }
    const event = JSON.parse(data);
    if (event.type === "session.authenticate") this.event(this.replay ? { type: "transcript.completed", data: { ...raw, idempotent_replay: true } } : { type: "session.created", sample_rate: 16000, format: "pcm_s16le", request_id: "stable" });
    if (event.type === "audio.finish") this.event({ type: "transcript.completed", data: raw });
  }
  close() { this.closed = true; this.emit("close", {}); }
}
it("uses a first-frame ticket, sends PCM as binary, finishes and exposes settled metadata", async () => {
  const socket = new Socket(); const live = await connectScribe(ticket, { webSocketFactory: url => { expect(url).not.toContain("ephemeral"); return socket; } });
  live.sendAudio(new Uint8Array(6400)); live.finish();
  const events = []; for await (const event of live) events.push(event.type);
  expect(events).toEqual(["session.created", "transcript.partial", "transcript.completed"]);
  expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: "session.authenticate", token: "ephemeral" });
  expect(socket.sent[1]).toBeInstanceOf(Uint8Array); expect(live.completion?.usage.settled).toBe(true); live.close();
});
it("accepts completed microphone replay without requiring session.created or sending audio", async () => {
  const socket = new Socket(true); const live = await connectScribe(ticket, { webSocketFactory: () => socket });
  expect(live.completion?.idempotentReplay).toBe(true); expect(socket.sent).toHaveLength(1);
  await expect((async () => { for await (const event of live) expect(event.type).toBe("transcript.completed"); })()).resolves.toBeUndefined(); live.close();
});
it("rejects socket URL credentials, invalid PCM and slow audio sending", async () => {
  await expect(connectScribe({ ...ticket, websocketUrl: ticket.websocketUrl + "?token=secret" })).rejects.toThrow(/without credentials/);
  const socket = new Socket(); const live = await connectScribe(ticket, { webSocketFactory: () => socket });
  expect(() => live.sendAudio(new Uint8Array(3))).toThrow(/PCM16/);
  socket.bufferedAmount = 300000; expect(() => live.sendAudio(new Uint8Array(6400))).toThrow(/keep up/); live.close();
});
it("reports interrupted sockets rather than successful completion", async () => {
  const socket = new Socket(); const live = await connectScribe(ticket, { webSocketFactory: () => socket }); socket.close();
  await expect((async () => { for await (const _event of live) {} })()).rejects.toThrow(/billing confirmation/);
});
