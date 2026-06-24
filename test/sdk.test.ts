import { describe, expect, it, vi } from "vitest";
import AddisAI, {
  AuthenticationError,
  IdempotencyConflictError,
  InsufficientCreditsError,
  RateLimitError,
  UnprocessableEntityError,
  ulid,
} from "../src/index.js";
import { resolveBaseURL } from "../src/core/env.js";
import { makeAPIError } from "../src/core/errors.js";
import { camelize } from "../src/core/camelize.js";
import { redactApiKey } from "../src/core/redact.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface Captured {
  url: string;
  init: RequestInit;
  body: any;
}

function clientWith(handler: (c: Captured) => Response): { addis: AddisAI; calls: Captured[] } {
  const calls: Captured[] = [];
  const fakeFetch = vi.fn(async (url: any, init: any) => {
    let body: any = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const captured: Captured = { url: String(url), init, body };
    calls.push(captured);
    return handler(captured);
  });
  const addis = new AddisAI({ apiKey: "sk_test_123", fetch: fakeFetch as any });
  return { addis, calls };
}

describe("security guards", () => {
  it("requires an API key", () => {
    const prev = process.env.ADDIS_API_KEY;
    delete process.env.ADDIS_API_KEY;
    expect(() => new AddisAI()).toThrow(/Missing API key/);
    if (prev) process.env.ADDIS_API_KEY = prev;
  });

  it("rejects raw supabase hosts", () => {
    expect(() => resolveBaseURL("https://vzootpcpzepaeirdnbvx.supabase.co/functions/v1")).toThrow(/supabase/);
  });

  it("rejects non-https except localhost", () => {
    expect(() => resolveBaseURL("http://api.addisassistant.com")).toThrow(/https/);
    expect(resolveBaseURL("http://localhost:54321")).toContain("localhost");
  });

  it("defaults to the Cloudflare endpoint", () => {
    expect(resolveBaseURL(undefined)).toBe("https://api.addisassistant.com");
  });

  it("redacts API keys", () => {
    expect(redactApiKey("sk_live_abcdef1234")).toBe("sk_l••••34");
    expect(new AddisAI({ apiKey: "sk_live_abcdef1234" }).toString()).not.toContain("abcdef");
  });
});

describe("ulid", () => {
  it("produces 26-char sortable ids", async () => {
    const a = ulid();
    expect(a).toHaveLength(26);
    expect(a).not.toBe(ulid()); // unique
    await new Promise((r) => setTimeout(r, 2));
    expect(a < ulid()).toBe(true); // time-sortable across a time gap
  });
});

describe("camelize", () => {
  it("deep-converts snake_case keys", () => {
    expect(camelize({ a_b: 1, c: { d_e: [{ f_g: 2 }] } })).toEqual({ aB: 1, c: { dE: [{ fG: 2 }] } } as any);
  });
});

describe("error normalization", () => {
  const h = (extra: Record<string, string> = {}) => extra;

  it("maps status codes to classes", () => {
    expect(makeAPIError(401, { error: { code: "UNAUTHORIZED", message: "x" } }, "", h())).toBeInstanceOf(AuthenticationError);
    expect(makeAPIError(402, { error: { code: "INSUFFICIENT_CREDITS", message: "x" } }, "", h())).toBeInstanceOf(InsufficientCreditsError);
    expect(makeAPIError(422, { error: { code: "TEXT_TOO_LONG", message: "x" } }, "", h())).toBeInstanceOf(UnprocessableEntityError);
  });

  it("distinguishes 409 idempotency conflicts", () => {
    const e = makeAPIError(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "x" } }, "", h());
    expect(e).toBeInstanceOf(IdempotencyConflictError);
  });

  it("exposes rate-limit headers", () => {
    const e = makeAPIError(429, { error: { code: "RATE_LIMITED", message: "x" } }, "", h({
      "retry-after": "12",
      "x-ratelimit-remaining": "0",
    })) as RateLimitError;
    expect(e.retryAfter).toBe(12);
    expect(e.remaining).toBe(0);
  });

  it("handles the legacy { status: error } envelope", () => {
    const e = makeAPIError(400, { status: "error", error: { code: "INVALID_INPUT", message: "bad" } }, "", h());
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toBe("bad");
  });
});

describe("voice.generate", () => {
  it("posts to the voice route, auto-generates an idempotency key, and maps the clip", async () => {
    const { addis, calls } = clientWith(() =>
      jsonResponse({
        data: {
          id: "clip_1",
          text: "ሰላም",
          text_preview: "ሰላም",
          voice_id: "am-hiwot",
          voice_name: "Hiwot",
          voice_descriptor: "Warm",
          language: "am",
          output_format: "mp3_44100",
          audio_url: "https://cdn.addisassistant.com/audio/clips/clip_1.mp3?token=x",
          mime_type: "audio/mpeg",
          duration_seconds: 1.2,
          character_count: 3,
          billable_characters: 3,
          download_name: "x.mp3",
          created_at: "2026-06-14T00:00:00Z",
          usage: { pricing_unit: "character", price_per_1000_characters: 4.8, credits_used: 0.0144, credits_remaining: 499.9, currency: "ETB" },
          meta: { ignored_voice_settings: ["style"], applied_provider_settings: { exaggeration: 0.5 }, idempotent_replay: false },
        },
      }),
    );

    const clip = await addis.voice.generate({ voiceId: "am-hiwot", text: "ሰላም", language: "am" });

    expect(calls[0].url).toContain("/api/v1/voice/generations");
    expect(calls[0].body.client_request_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(calls[0].body.voice_id).toBe("am-hiwot");
    expect(clip.id).toBe("clip_1");
    expect(clip.audioUrl).toContain("cdn.addisassistant.com");
    expect(clip.usage?.currency).toBe("ETB");
    // Security: provider-specific knobs are NOT exposed.
    expect((clip.meta as any).appliedProviderSettings).toBeUndefined();
    expect(clip.meta?.ignoredVoiceSettings).toEqual(["style"]);
  });

  it("surfaces InsufficientCreditsError", async () => {
    const { addis } = clientWith(() =>
      jsonResponse(
        { error: { code: "INSUFFICIENT_CREDITS", message: "low", details: [{ field: "wallet.balance", code: "balance_too_low", message: "balance is 3.10" }] } },
        { status: 402 },
      ),
    );
    await expect(addis.voice.generate({ voiceId: "am-hiwot", text: "x", language: "am" })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });
});

describe("chat.completions.create", () => {
  it("maps messages to native prompt/history, hides the model, reports addis-1-alef", async () => {
    const { addis, calls } = clientWith(() =>
      jsonResponse({
        status: "success",
        data: {
          response_text: "Addis Ababa",
          finish_reason: "STOP",
          usage_metadata: { prompt_token_count: 5, candidates_token_count: 2, total_token_count: 7 },
          modelVersion: "internal-should-be-hidden",
        },
      }),
    );

    const res = await addis.chat.completions.create({
      model: "gpt-4o", // accepted but ignored
      language: "am",
      system: "Be concise.",
      messages: [
        { role: "user", content: "Tell me about coffee." },
        { role: "assistant", content: "Coffee is Ethiopian." },
        { role: "user", content: "Capital of Ethiopia?" },
      ],
    });

    expect(calls[0].url).toContain("/api/v1/chat_generate");
    expect(calls[0].body.model).toBeUndefined();
    expect(calls[0].body.prompt).toBe("Capital of Ethiopia?");
    expect(calls[0].body.conversation_history).toHaveLength(2);
    expect(calls[0].body.target_language).toBe("am");
    expect(calls[0].body.system).toBe("Be concise.");
    expect(res.model).toBe("addis-1-alef");
    expect(res.choices[0].message.content).toBe("Addis Ababa");
    expect(res.choices[0].finish_reason).toBe("stop");
  });
});

describe("auth headers", () => {
  it("sends sk_ keys as x-api-key only (no Authorization)", async () => {
    const { addis, calls } = clientWith(() => jsonResponse({ status: "success", data: { translation: "ok", source_language: "en", target_language: "am", quality: null } }));
    await addis.translate.create({ text: "Hi", from: "en", to: "am" });
    const h = new Headers(calls[0].init.headers as any);
    expect(h.get("x-api-key")).toBe("sk_test_123");
    expect(h.get("authorization")).toBeNull();
  });
});

describe("translate.create", () => {
  it("maps the response", async () => {
    const { addis, calls } = clientWith(() =>
      jsonResponse({ status: "success", data: { translation: "ሰላም", source_language: "en", target_language: "am", quality: "high" } }),
    );
    const out = await addis.translate.create({ text: "Hello", from: "en", to: "am" });
    expect(calls[0].body.source_language).toBe("en");
    expect(out.text).toBe("ሰላም");
    expect(out.quality).toBe("high");
  });
});

describe("legacy.audio (deprecated bridge)", () => {
  it("posts to /api/v1/audio, decodes base64, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audioB64 = Buffer.from("RIFFfake").toString("base64");
    const { addis, calls } = clientWith(() => jsonResponse({ audio: audioB64 }));

    const out = await addis.legacy.audio.generate({ text: "ሰላም", language: "am" });
    await addis.legacy.audio.generate({ text: "again", language: "am" });

    expect(calls[0].url).toContain("/api/v1/audio");
    expect(calls[0].body.stream).toBe(false);
    expect(out.audio).toBe(audioB64);
    expect(Buffer.from(out.arrayBuffer()).toString()).toBe("RIFFfake");
    // Deprecation warning fires at most once per process.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("DEPRECATED")).length).toBe(1);
    warn.mockRestore();
  });
});

function streamResponse(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("chat streaming (SSE)", () => {
  const sse = [
    'data: {"type":"metadata","transcription_raw":"r","transcription_clean":"c"}\n\n',
    'data: {"type":"content","text":"Addis ","finish_reason":null}\n\n',
    'data: {"type":"content","text":"Ababa","finish_reason":"STOP","usage_metadata":{"prompt_token_count":5,"candidates_token_count":2,"total_token_count":7}}\n\n',
    "event: done\ndata: [DONE]\n\n",
  ].join("");

  it("routes to the streaming endpoint and yields content deltas", async () => {
    const { addis, calls } = clientWith(() => streamResponse(sse, "text/event-stream"));
    const stream = await addis.chat.completions.create({
      language: "am",
      messages: [{ role: "user", content: "Capital?" }],
      stream: true,
    });

    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";

    expect(calls[0].url).toContain("/api/v1/chat_generate");
    expect(calls[0].body.generation_config.stream).toBe(true);
    expect(text).toBe("Addis Ababa");
    expect(stream.transcription?.clean).toBe("c");
  });

  it("supports finalText() and finalCompletion() accumulators", async () => {
    const a = clientWith(() => streamResponse(sse, "text/event-stream"));
    const s1 = await a.addis.chat.completions.create({ language: "am", messages: [{ role: "user", content: "x" }], stream: true });
    expect(await s1.finalText()).toBe("Addis Ababa");

    const b = clientWith(() => streamResponse(sse, "text/event-stream"));
    const s2 = await b.addis.chat.completions.create({ language: "am", messages: [{ role: "user", content: "x" }], stream: true });
    const completion = await s2.finalCompletion();
    expect(completion.choices[0].message.content).toBe("Addis Ababa");
    expect(completion.choices[0].finish_reason).toBe("stop");
    expect(completion.usage?.total_tokens).toBe(7);
  });
});

describe("legacy audio streaming", () => {
  it("decodes ndjson base64 chunks (Amharic)", async () => {
    const ndjson =
      `{"audio_chunk":"${Buffer.from("AB").toString("base64")}","index":0}\n` +
      `{"audio_chunk":"${Buffer.from("CD").toString("base64")}","index":1}\n`;
    const { addis } = clientWith(() => streamResponse(ndjson, "application/x-ndjson"));
    const audio = await addis.legacy.audio.stream({ text: "ሰላም", language: "am" });
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe("ABCD");
  });

  it("passes through a raw audio byte stream (Afan Oromo)", async () => {
    const { addis } = clientWith(() => streamResponse("RIFFwav", "audio/wav"));
    const audio = await addis.legacy.audio.stream({ text: "akkam", language: "om" });
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe("RIFFwav");
  });
});

describe("retries", () => {
  it("retries once on a 500 then succeeds", async () => {
    let n = 0;
    const { addis, calls } = clientWith(() => {
      n++;
      if (n === 1) return jsonResponse({ error: { code: "x", message: "boom" } }, { status: 500 });
      return jsonResponse({ status: "success", data: { translation: "ok", source_language: "en", target_language: "am", quality: null } });
    });
    const out = await addis.translate.create({ text: "Hi", from: "en", to: "am" });
    expect(calls.length).toBe(2);
    expect(out.text).toBe("ok");
  });
});
