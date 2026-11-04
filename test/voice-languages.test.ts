import { describe, expect, it, vi } from "vitest";
import AddisAI, {
  connectRealtime, DEFAULT_VOICES, REALTIME_LANGUAGES, toBatchJsonl, VOICE_LANGUAGES, VOICES,
  type Language, type RealtimeLanguage, type RealtimeSession,
} from "../src/index.js";

const unsupported = ["en", "fr", "unknown", "", null];
const allVoices = Object.entries(VOICES).flatMap(([language, ids]) => ids.map((voiceId) => ({ language: language as Language, voiceId })));
const clipResponse = (language: string, voiceId: string) => Response.json({ data: { id: "clip", language, voice_id: voiceId } });

describe("voice language scope", () => {
  it("exports the seven voice languages, the four streaming languages and the catalog mirror", () => {
    expect(VOICE_LANGUAGES).toEqual(["am", "om", "ti", "sw", "ha", "sid", "wal"]);
    expect(REALTIME_LANGUAGES).toEqual(VOICE_LANGUAGES);
    expect(DEFAULT_VOICES).toEqual({ am: "am-hamen", om: "om-bikila", ti: "ti-berhane", sw: "sw-rashid",
      ha: "ha-mustapha", sid: "sid-tigist", wal: "wal-tona" });
    expect(VOICES.ha).toEqual(["ha-mustapha", "ha-sani", "ha-usman", "ha-musa"]);
    expect(VOICES.ha).not.toContain("ha-hauwa"); // retired
    for (const { language, voiceId } of allVoices) expect(voiceId.split("-", 1)[0]).toBe(language);
    expect(new Set(allVoices.map((v) => v.voiceId)).size).toBe(allVoices.length);
  });

  it.each(unsupported)("rejects %s before an HTTP call or socket is opened", async (raw) => {
    const fetch = vi.fn(async () => Response.json({ data: [] }));
    const webSocketFactory = vi.fn();
    const addis = new AddisAI({ apiKey: "secret", fetch });
    // Deliberately bypass TypeScript, as plain JavaScript callers can do.
    const language = raw as Language;
    const realtimeLanguage = raw as RealtimeLanguage;
    const params = { language, voiceId: "am-hamen", text: "A complete sentence." };
    const streamParams = { ...params, language: realtimeLanguage };
    const voice = /Voice language must be/;
    const streaming = /Streamed and real-time voice language must be/;
    const legacy = /Legacy audio language must be/;
    for (const [call, error] of [
      [() => addis.voice.generate(params), voice],
      [() => addis.voice.stream(streamParams), streaming],
      [() => addis.voice.estimate(params), voice],
      [() => addis.realtime.createSession(streamParams), streaming],
      [() => addis.realtime.connect(streamParams, { webSocketFactory }), streaming],
      [() => addis.textToSpeech.convert("am-hamen", params), voice],
      [() => addis.textToSpeech.stream("am-hamen", streamParams), streaming],
      [() => addis.legacy.audio.generate({ ...params, language: raw as "am" }), legacy],
      [() => addis.legacy.audio.stream({ ...params, language: raw as "am" }), legacy],
      [() => addis.voices.list({ language }), voice],
    ] as const) await expect(call()).rejects.toThrow(error);
    expect(() => addis.voice.clips.list({ language })).toThrow(voice);
    await expect(connectRealtime({ language: realtimeLanguage } as RealtimeSession, { webSocketFactory })).rejects.toThrow(streaming);
    expect(fetch).not.toHaveBeenCalled();
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("names every voice language in the error", async () => {
    const addis = new AddisAI({ apiKey: "secret", fetch: vi.fn() });
    const error = await addis.voice.generate({ language: "en" as Language, voiceId: "en-emma", text: "A complete sentence." }).catch((e) => e);
    for (const name of ["am (Amharic)", "om (Afaan Oromo)", "ti (Tigrinya)", "sw (Swahili)", "ha (Hausa)", "sid (Sidama)", "wal (Wolaytta)"]) {
      expect(String(error.message)).toContain(name);
    }
  });

  it.each(allVoices)("generates, estimates and batches $voiceId in $language", async ({ language, voiceId }) => {
    const calls: Array<{ path: string; body: any }> = [];
    const addis = new AddisAI({ apiKey: "secret", fetch: async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return clipResponse(language, voiceId);
    } });
    const input = { language, voiceId, text: "A complete sentence." };
    await addis.voice.generate(input);
    await addis.voice.estimate(input);
    await addis.textToSpeech.convert(voiceId, { language, text: input.text });
    expect(toBatchJsonl([{ customId: "a", ...input }])).toContain(`"voice_id":"${voiceId}"`);
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/voice/generations", "/api/v1/voice/estimate", "/api/v1/voice/generations"]);
    for (const call of calls) expect([call.body.language, call.body.voice_id]).toEqual([language, voiceId]);
  });

  it.each(REALTIME_LANGUAGES)("streams and opens real-time sessions in %s", async (language) => {
    const voiceId = DEFAULT_VOICES[language];
    const calls: Array<{ path: string; body: any }> = [];
    const addis = new AddisAI({ apiKey: "secret", fetch: async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      if (String(url).endsWith("/stream")) {
        return new Response(new TextEncoder().encode('\u0000\u0000\u0000\u0000{"data":{"id":"clip","usage":{"credits_used":1}}}'),
          { headers: { "X-Addis-Audio-Protocol": "mp3-frames-v1" } });
      }
      return Response.json({ data: { token: "t", language } });
    } });
    const stream = await addis.voice.stream({ language, voiceId, text: "A complete sentence." });
    await stream.arrayBuffer();
    await addis.realtime.createSession({ language, voiceId });
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/voice/generations/stream", "/api/v1/realtime/sessions"]);
    for (const call of calls) expect([call.body.language, call.body.voice_id]).toEqual([language, voiceId]);
  });

  it.each([["sid", "wal-tona"], ["ti", "am-hamen"], ["sw", "Rashid"], ["wal", ""], ["ha", "ha_musa"], ["sid", undefined]])(
    "rejects voice %s / %s locally", async (language, voiceId) => {
      const fetch = vi.fn();
      const addis = new AddisAI({ apiKey: "secret", fetch });
      const input = { language: language as Language, voiceId: voiceId as string, text: "A complete sentence." };
      await expect(addis.voice.generate(input)).rejects.toThrow(/voiceId/);
      expect(() => toBatchJsonl([{ customId: "a", ...input }])).toThrow(/voiceId/);
      expect(fetch).not.toHaveBeenCalled();
    });

  it("returns every supported language when the server returns a wider catalog", async () => {
    const codes = ["am", "om", "ti", "sid", "wal", "ha", "sw", "en", "fr"];
    const addis = new AddisAI({ apiKey: "secret", fetch: async () => Response.json({ data: codes.map((language) => ({ id: `${language}-x`, language })) }) });
    expect((await addis.voices.list()).map((voice) => voice.language)).toEqual(["am", "om", "ti", "sid", "wal", "ha", "sw"]);
  });

  it.each(VOICE_LANGUAGES)("lists the %s catalog", async (language) => {
    const seen: Array<string | null> = [];
    const addis = new AddisAI({ apiKey: "secret", fetch: async (url) => {
      seen.push(new URL(String(url)).searchParams.get("language"));
      return Response.json({ data: VOICES[language].map((id) => ({ id, language })) });
    } });
    expect((await addis.voices.list({ language })).map((voice) => voice.id)).toEqual([...VOICES[language]]);
    expect(seen).toEqual([language]);
  });

  it("keeps existing clip history accessible", async () => {
    const addis = new AddisAI({ apiKey: "secret", fetch: async () => Response.json({ data: [
      { id: "historic", language: "en", voice_id: "older-voice" },
      { id: "current", language: "ti", voice_id: "ti-berhane" },
    ] }) });
    const page = await addis.voice.clips.list();
    expect(page.data.map((clip) => [clip.id, clip.language])).toEqual([["historic", "en"], ["current", "ti"]]);
  });
});
