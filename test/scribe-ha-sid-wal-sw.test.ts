import { describe, expect, it } from "vitest";
import AddisAI, { type ScribeLanguage, type ScribeSocket } from "../src/index.js";

// Hausa, Sidama, Wolaytta and Swahili on every Scribe entry point, sent exactly like Afaan Oromo and Tigrinya.
const models = {
  ha: ["addis-scribe-hausa-streaming", "sannu da zuwa"],
  sid: ["addis-scribe-sidama-streaming", "sidaamu afoo"],
  wal: ["addis-scribe-wolaytta-streaming", "wolaytta doonaa"],
  sw: ["addis-scribe-swahili-streaming", "Habari za asubuhi."],
} as const;
const codes = Object.keys(models) as Array<keyof typeof models>;
const result = (code: keyof typeof models, extra: Record<string, unknown> = {}) => ({
  text: models[code][1], request_id: `${code}1`, seconds: 2, compute_ms: 5, backend: "turbo", chunk: "1120ms", mode: "offline",
  language: code, model: models[code][0],
  usage: { record_id: "ledger", characters: models[code][1].length, price_per_1000_characters: 3.5, credits_used: .05, credits_remaining: 9.95, currency: "ETB", settled: true },
  ...extra,
});
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

it("ScribeLanguage accepts every Scribe language", () => {
  const all: ScribeLanguage[] = ["am", "om", "ti", "ha", "sid", "wal", "sw", "en"];
  expect(all).toHaveLength(8);
});

describe.each(codes)("language %s", code => {
  const language: ScribeLanguage = code;
  const ticket = { token: "ephemeral", request_id: `${code}1`, expires_at: 9999999999, websocket_url: "wss://api.addisassistant.com/api/v1/scribe/stream", backend: "turbo", chunk: "320ms", max_audio_seconds: 900, language: code };
  const queued = { request_id: `${code}1`, status: "queued", poll_url: `/api/v1/scribe/requests/${code}1`, job_url: `/api/v1/scribe/jobs/${code}1` };

  it("transcribe sends the language as a query parameter and maps the model", async () => {
    const { addis, seen } = recording(() => Response.json({ data: result(code) }));
    const out = await addis.scribe.transcribe({ audio, requestId: `${code}1`, language });
    expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: `${code}1`, language: code, stream: "false" });
    expect(out.language).toBe(code); expect(out.model).toBe(models[code][0]);
  });
  it("transcribe keeps the language alongside captions (and speaker labels where offered)", async () => {
    const { addis, seen } = recording(() => Response.json({ data: result(code) }));
    const speakers = code !== "sw";
    await addis.scribe.transcribe({ audio, requestId: `${code}1`, language, timestamps: "word", ...(speakers ? { speakers: true } : {}) });
    expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: `${code}1`, timestamps: "word", ...(speakers ? { speakers: "true" } : {}), language: code, stream: "false" });
  });
  it("stream sends the language", async () => {
    const { addis, seen } = recording(() => Response.json({ data: result(code) }));
    expect((await (await addis.scribe.stream({ audio, requestId: `${code}1`, language })).read()).language).toBe(code);
    expect(params(seen[0])).toEqual({ backend: "turbo", chunk: "1120ms", request_id: `${code}1`, language: code, stream: "true" });
  });
  it("live sessions send the language in the JSON body", async () => {
    const { addis, seen } = recording(() => Response.json({ data: ticket }, { status: 201 }));
    expect((await addis.scribe.createSession({ requestId: `${code}1`, language })).language).toBe(code);
    expect(JSON.parse(String(seen[0].body))).toEqual({ backend: "turbo", chunk: "320ms", request_id: `${code}1`, language: code });
    expect(seen[0].url.search).toBe("");
  });
  it("connect passes the language to the ticket", async () => {
    class Socket implements ScribeSocket {
      handlers: Record<string, Array<(e: any) => void>> = {};
      constructor() { queueMicrotask(() => this.emit("open", {})); }
      addEventListener(type: string, cb: (e: any) => void) { (this.handlers[type] ??= []).push(cb); }
      emit(type: string, event: any) { for (const cb of this.handlers[type] ?? []) cb(event); }
      send(data: string | Uint8Array) {
        if (typeof data === "string" && JSON.parse(data).type === "session.authenticate") this.emit("message", { data: JSON.stringify({ type: "session.created", sample_rate: 16000, format: "pcm_s16le", request_id: `${code}1`, max_audio_seconds: 900 }) });
      }
      close() {}
    }
    const { addis, seen } = recording(() => Response.json({ data: ticket }, { status: 201 }));
    const live = await addis.scribe.connect({ requestId: `${code}1`, language }, { webSocketFactory: () => new Socket() });
    expect(JSON.parse(String(seen[0].body)).language).toBe(code); live.close();
  });
  it("jobs.upload and transcribeLong send the language", async () => {
    const { addis, seen } = recording(s => s.method === "POST" ? Response.json({ data: queued }, { status: 202 }) : Response.json({ data: result(code, { mode: "job", chunks: 1 }) }));
    await addis.scribe.jobs.upload({ audio, requestId: `${code}1`, language });
    const out = await addis.scribe.transcribeLong({ audio, requestId: `${code}1`, language });
    const base = { backend: "turbo", chunk: "1120ms", request_id: `${code}1`, language: code };
    expect(seen.filter(s => s.method === "POST").map(params)).toEqual([base, base]);
    expect(out.model).toBe(models[code][0]);
  });
  it("a job declaration sends the language as a query parameter, with an unchanged JSON body", async () => {
    const { addis, seen } = recording(() => Response.json({ data: { request_id: `${code}1`, status: "uploading", part_bytes: 4, parts: 3, received: [] } }, { status: 201 }));
    await addis.scribe.jobs.create({ requestId: `${code}1`, bytes: 10, language });
    expect(seen.map(params)).toEqual([{ language: code }]);
    expect(JSON.parse(String(seen[0].body))).toEqual({ backend: "turbo", chunk: "1120ms", request_id: `${code}1`, bytes: 10 });
  });
});
