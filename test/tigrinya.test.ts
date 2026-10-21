import { describe, expect, it, vi } from "vitest";
import AddisAI from "../src/index.js";

type Captured = { url: string; init: any; body: any };

function clientWith(handler: () => Response): { addis: AddisAI; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch = vi.fn(async (url: any, init: any) => {
    let body: any = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* keep raw */ }
    }
    calls.push({ url: String(url), init, body });
    return handler();
  });
  return { addis: new AddisAI({ apiKey: "sk_test_123", fetch: fetch as any }), calls };
}

const ok = (data: unknown) => Response.json({ status: "success", data });

describe("Tigrinya (ti) across modalities", () => {
  it("chat sends target_language ti to the native endpoint", async () => {
    const { addis, calls } = clientWith(() =>
      ok({ response_text: "ሰላም", finish_reason: "STOP", usage_metadata: { prompt_token_count: 1, candidates_token_count: 1, total_token_count: 2 } }),
    );
    const res = await addis.chat.completions.create({ language: "ti", messages: [{ role: "user", content: "ሰላም" }] });
    expect(calls[0].url).toContain("/api/v1/chat_generate");
    expect(calls[0].body.target_language).toBe("ti");
    expect(res.choices[0].message.content).toBe("ሰላም");
  });

  it("speech-to-text sends language_code ti and keeps a null confidence", async () => {
    const { addis, calls } = clientWith(() => ok({ transcription: "ሎሚ ጽቡቕ መዓልቲ እዩ።", confidence: null, usage_metadata: { seconds: 2 } }));
    const out = await addis.speech.transcribe({ audio: Buffer.from("RIFFfake"), language: "ti" });
    expect(calls[0].url).toContain("/api/v2/stt");
    const form = calls[0].init.body as FormData;
    const requestData = form.get("request_data") as Blob;
    expect(JSON.parse(await requestData.text())).toEqual({ language_code: "ti" });
    expect(out.text).toBe("ሎሚ ጽቡቕ መዓልቲ እዩ።");
    expect(out.confidence).toBeNull();
  });

  it.each([
    ["en", "ti"],
    ["ti", "am"],
    ["om", "ti"],
  ] as const)("translates %s -> %s", async (from, to) => {
    const { addis, calls } = clientWith(() => ok({ translation: "x", source_language: from, target_language: to, quality: "high" }));
    const out = await addis.translate.create({ text: "Hello", from, to });
    expect(calls[0].body.source_language).toBe(from);
    expect(calls[0].body.target_language).toBe(to);
    expect(out.sourceLanguage).toBe(from);
    expect(out.targetLanguage).toBe(to);
  });

  it("voice generation accepts ti with every native Tigrinya voice", async () => {
    const voices = ["ti-berhane", "ti-senait", "ti-haben", "ti-rahel", "ti-filimon", "ti-danait", "ti-yonas"];
    const { addis, calls } = clientWith(() => ok({ estimated_cost: 1, currency: "ETB", characters: 4, balance: 10 }));
    for (const voiceId of voices) await addis.voice.estimate({ voiceId, language: "ti", text: "ሰላም" });
    expect(calls).toHaveLength(voices.length);
    for (const [i, voiceId] of voices.entries()) {
      expect(calls[i].body.language).toBe("ti");
      expect(calls[i].body.voice_id).toBe(voiceId);
    }
  });
});
