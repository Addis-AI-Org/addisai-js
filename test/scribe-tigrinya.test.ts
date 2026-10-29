import { expect, it } from "vitest";
import AddisAI, { type ScribeLanguage, type ScribeSocket } from "../src/index.js";

// Tigrinya (language: "ti") on every Scribe entry point, sent exactly like Afaan Oromo.
const ti = { text: "ሰላም ከመይ ኣለኻ", request_id: "ti1", seconds: 2, compute_ms: 5, backend: "turbo", chunk: "1120ms", mode: "offline", language: "ti", model: "addis-scribe-tigrinya-streaming", usage: { record_id: "ledger", characters: 11, price_per_1000_characters: 3.5, credits_used: .0385, credits_remaining: 9.96, currency: "ETB", settled: true } };
const ticket = { token: "ephemeral", request_id: "ti1", expires_at: 9999999999, websocket_url: "wss://api.addisassistant.com/api/v1/scribe/stream", backend: "turbo", chunk: "320ms", max_audio_seconds: 900, language: "ti" };
const queued = { request_id: "ti1", status: "queued", poll_url: "/api/v1/scribe/requests/ti1", job_url: "/api/v1/scribe/jobs/ti1" };
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

it("transcribe sends language=ti as a query parameter and maps the Tigrinya model", async () => {
  const { addis, seen } = recording(() => Response.json({ data: ti }));
  const language: ScribeLanguage = "ti";
  const result = await addis.scribe.transcribe({ audio, requestId: "ti1", language });
  expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "ti1", language: "ti", stream: "false" });
  expect(result.language).toBe("ti"); expect(result.model).toBe("addis-scribe-tigrinya-streaming");
});
it("transcribe keeps language=ti alongside captions and speaker labels", async () => {
  const { addis, seen } = recording(() => Response.json({ data: ti }));
  await addis.scribe.transcribe({ audio, requestId: "ti1", language: "ti", timestamps: "word", speakers: true });
  expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "ti1", timestamps: "word", speakers: "true", language: "ti", stream: "false" });
});
it("stream sends language=ti", async () => {
  const { addis, seen } = recording(() => Response.json({ data: ti }));
  expect((await (await addis.scribe.stream({ audio, requestId: "ti1", language: "ti" })).read()).language).toBe("ti");
  expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "ti1", language: "ti", stream: "true" });
});
it("live sessions send language ti in the JSON body", async () => {
  const { addis, seen } = recording(() => Response.json({ data: ticket }, { status: 201 }));
  expect((await addis.scribe.createSession({ requestId: "ti1", language: "ti" })).language).toBe("ti");
  expect(JSON.parse(String(seen[0].body))).toEqual({ backend: "turbo", chunk: "320ms", request_id: "ti1", language: "ti" });
  expect(seen[0].url.search).toBe("");
});
it("connect passes language ti to the ticket", async () => {
  class Socket implements ScribeSocket {
    handlers: Record<string, Array<(e: any) => void>> = {};
    constructor() { queueMicrotask(() => this.emit("open", {})); }
    addEventListener(type: string, cb: (e: any) => void) { (this.handlers[type] ??= []).push(cb); }
    emit(type: string, event: any) { for (const cb of this.handlers[type] ?? []) cb(event); }
    send(data: string | Uint8Array) {
      if (typeof data === "string" && JSON.parse(data).type === "session.authenticate") this.emit("message", { data: JSON.stringify({ type: "session.created", sample_rate: 16000, format: "pcm_s16le", request_id: "ti1", max_audio_seconds: 900 }) });
    }
    close() {}
  }
  const { addis, seen } = recording(() => Response.json({ data: ticket }, { status: 201 }));
  const live = await addis.scribe.connect({ requestId: "ti1", language: "ti" }, { webSocketFactory: () => new Socket() });
  expect(JSON.parse(String(seen[0].body)).language).toBe("ti"); live.close();
});
it("jobs.upload and transcribeLong send language=ti", async () => {
  const { addis, seen } = recording(s => s.method === "POST" ? Response.json({ data: queued }, { status: 202 }) : Response.json({ data: { ...ti, mode: "job", chunks: 1 } }));
  await addis.scribe.jobs.upload({ audio, requestId: "ti1", language: "ti" });
  const result = await addis.scribe.transcribeLong({ audio, requestId: "ti1", language: "ti" });
  const base = { backend: "turbo", chunk: "1120ms", request_id: "ti1", language: "ti" };
  expect(seen.filter(s => s.method === "POST").map(params)).toEqual([base, base]);
  expect(result.model).toBe("addis-scribe-tigrinya-streaming");
});
it("a job declaration sends language=ti as a query parameter, with an unchanged JSON body", async () => {
  const { addis, seen } = recording(() => Response.json({ data: { request_id: "ti1", status: "uploading", part_bytes: 4, parts: 3, received: [] } }, { status: 201 }));
  await addis.scribe.jobs.create({ requestId: "ti1", bytes: 10, language: "ti" });
  expect(seen.map(params)).toEqual([{ language: "ti" }]);
  expect(JSON.parse(String(seen[0].body))).toEqual({ backend: "turbo", chunk: "1120ms", request_id: "ti1", bytes: 10 });
});
