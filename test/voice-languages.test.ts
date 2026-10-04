import { describe, expect, it, vi } from "vitest";
import AddisAI, { connectRealtime, type Language, type RealtimeSession } from "../src/index.js";

const excluded = ["sid", "wal", "ha", "sw", "en", "fr", "unknown", "", null];
const supported = [
  { language: "am", voiceId: "am-hamen" },
  { language: "om", voiceId: "om-bikila" },
  { language: "ti", voiceId: "ti-berhane" },
] as const;

describe("voice language scope", () => {
  it.each(excluded)("rejects %s before an HTTP call or socket is opened", async (raw) => {
    const fetch = vi.fn(async () => Response.json({ data: [] }));
    const webSocketFactory = vi.fn();
    const addis = new AddisAI({ apiKey: "secret", fetch });
    // Deliberately bypass TypeScript, as plain JavaScript callers can do.
    const language = raw as Language;
    const params = { language, voiceId: "voice", text: "A complete sentence." };
    const error = /am \(Amharic\), om \(Afaan Oromo\), or ti \(Tigrinya\)/;
    for (const call of [
      () => addis.voice.generate(params),
      () => addis.voice.stream(params),
      () => addis.voice.estimate(params),
      () => addis.realtime.createSession(params),
      () => addis.realtime.connect(params, { webSocketFactory }),
      () => addis.textToSpeech.convert("voice", params),
      () => addis.textToSpeech.stream("voice", params),
      () => addis.legacy.audio.generate(params),
      () => addis.legacy.audio.stream(params),
      () => addis.voices.list({ language }),
    ]) await expect(call()).rejects.toThrow(error);
    expect(() => addis.voice.clips.list({ language })).toThrow(error);
    await expect(connectRealtime({ language } as RealtimeSession, { webSocketFactory })).rejects.toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it.each(supported)("sends $language with its matching voice through every modern voice entry point", async (params) => {
    const calls: Array<{ path: string; body?: any }> = [];
    const addis = new AddisAI({ apiKey: "secret", fetch: async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith("/stream")) {
        return new Response(new TextEncoder().encode('\u0000\u0000\u0000\u0000{"data":{"id":"clip","usage":{"credits_used":1}}}'),
          { headers: { "X-Addis-Audio-Protocol": "mp3-frames-v1" } });
      }
      return Response.json({ data: { id: "clip", language: params.language, voice_id: params.voiceId } });
    } });
    const input = { ...params, text: "A complete sentence." };
    await addis.voice.generate(input);
    const stream = await addis.voice.stream(input);
    await stream.arrayBuffer();
    await addis.voice.estimate(input);
    await addis.realtime.createSession(params);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/voice/generations", "/api/v1/voice/generations/stream",
      "/api/v1/voice/estimate", "/api/v1/realtime/sessions",
    ]);
    for (const call of calls) {
      expect(call.body.language).toBe(params.language);
      expect(call.body.voice_id).toBe(params.voiceId);
    }
  });

  it("exposes only the three supported languages when the server returns a wider catalog", async () => {
    const catalog = [...supported.map((v) => ({ id: v.voiceId, language: v.language })),
      ...["sid", "wal", "ha", "sw", "en", "fr"].map((language) => ({ id: `${language}-other`, language }))];
    const addis = new AddisAI({ apiKey: "secret", fetch: async () => Response.json({ data: catalog }) });
    expect((await addis.voices.list()).map((voice) => voice.id)).toEqual(["am-hamen", "om-bikila", "ti-berhane"]);
  });

  it("keeps existing clip history accessible without permitting new generation in its language", async () => {
    const addis = new AddisAI({ apiKey: "secret", fetch: async () => Response.json({ data: [
      { id: "historic", language: "en", voice_id: "older-voice" },
      { id: "current", language: "ti", voice_id: "ti-berhane" },
    ] }) });
    const page = await addis.voice.clips.list();
    expect(page.data.map((clip) => [clip.id, clip.language])).toEqual([["historic", "en"], ["current", "ti"]]);
  });
});
