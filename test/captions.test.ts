import { describe, expect, it } from "vitest";
import AddisAI, { toSrt, toVtt, type ScribeSegment } from "../src/index.js";

const raw = { text: "ሰላም", request_id: "stable", seconds: 1, compute_ms: 5, backend: "standard", chunk: "1120ms", mode: "offline", model: "addis-scribe-streaming", usage: { record_id: "ledger", characters: 3, price_per_1000_characters: 3.5, credits_used: .0105, credits_remaining: 9.9895, currency: "ETB", settled: true } };
const segment: ScribeSegment = { text: "ሰላም ወዳጆቻችን እንዴት ከረማችሁ ዛሬ እንግዲህ እንግዳ አድርጌ ያቀረኩላችሁ", start: 18.8, end: 21.8 };
function client(fetch: typeof globalThis.fetch) { return new AddisAI({ apiKey: "test-secret", fetch }); }

describe("Scribe backend and timestamps options", () => {
  it("defaults to the standard backend and omits timestamps unless set", async () => {
    const seen: URL[] = [];
    const addis = client(async url => { seen.push(new URL(String(url))); return Response.json({ data: raw }); });
    await addis.scribe.transcribe({ audio: new Uint8Array([1]), requestId: "a" });
    await addis.scribe.transcribe({ audio: new Uint8Array([1]), requestId: "b", backend: "turbo", timestamps: "word" });
    await addis.scribe.transcribe({ audio: new Uint8Array([1]), requestId: "c", timestamps: "none" });
    expect(seen[0].searchParams.get("backend")).toBe("standard");
    expect(seen[0].searchParams.has("timestamps")).toBe(false);
    expect(seen[1].searchParams.get("backend")).toBe("turbo");
    expect(seen[1].searchParams.get("timestamps")).toBe("word");
    expect(seen[2].searchParams.get("timestamps")).toBe("none");
  });
  it("rejects unknown backends and timestamps before HTTP", async () => {
    let calls = 0; const addis = client(async () => { calls++; return Response.json({ data: raw }); });
    for (const backend of ["fast", "default", ""]) {
      await expect(addis.scribe.transcribe({ audio: new Uint8Array([1]), backend: backend as never })).rejects.toThrow(/backend/);
      await expect(addis.scribe.createSession({ backend: backend as never })).rejects.toThrow(/backend/);
    }
    await expect(addis.scribe.transcribe({ audio: new Uint8Array([1]), timestamps: "segment" as never })).rejects.toThrow(/timestamps/);
    expect(calls).toBe(0);
  });
  it("rejects word timestamps on stream() locally", async () => {
    let calls = 0; const addis = client(async () => { calls++; return Response.json({ data: raw }); });
    await expect(addis.scribe.stream({ audio: new Uint8Array([1]), timestamps: "word" })).rejects.toThrow(/completed uploads.*transcribe\(\)/);
    expect(calls).toBe(0);
  });
  it("surfaces words and segments on the result", async () => {
    const words = [{ text: "ሰላም", start: 18.9, end: 19.52 }];
    const addis = client(async () => Response.json({ data: { ...raw, words, segments: [segment] } }));
    const result = await addis.scribe.transcribe({ audio: new Uint8Array([1]), timestamps: "word" });
    expect(result.words).toEqual(words);
    expect(result.segments).toEqual([segment]);
    expect(toSrt(result)).toContain("00:00:18,800 --> 00:00:21,800");
  });
});

describe("caption helpers", () => {
  it("formats SRT exactly, wrapping Amharic at 42 characters", () => {
    expect(toSrt({ segments: [segment] })).toBe("1\n00:00:18,800 --> 00:00:21,800\nሰላም ወዳጆቻችን እንዴት ከረማችሁ ዛሬ እንግዲህ እንግዳ አድርጌ\nያቀረኩላችሁ\n");
  });
  it("formats VTT exactly", () => {
    expect(toVtt({ segments: [segment] })).toBe("WEBVTT\n\n00:00:18.800 --> 00:00:21.800\nሰላም ወዳጆቻችን እንዴት ከረማችሁ ዛሬ እንግዲህ እንግዳ አድርጌ\nያቀረኩላችሁ\n");
  });
  it("numbers cues, separates them with a blank line and keeps at most two lines", () => {
    const long = "ሀ".repeat(50);
    const segments = [
      { text: "ሰላም", start: 0, end: 0.83 },
      { text: `${long} ቃል ${"በ".repeat(40)} ሌላ ቃል`, start: 3725.4567, end: 3727 },
    ];
    expect(toSrt({ segments })).toBe(`1\n00:00:00,000 --> 00:00:00,830\nሰላም\n\n2\n01:02:05,457 --> 01:02:07,000\n${long}\nቃል ${"በ".repeat(40)} ሌላ ቃል\n`);
    expect(toVtt({ segments })).toBe(`WEBVTT\n\n00:00:00.000 --> 00:00:00.830\nሰላም\n\n01:02:05.457 --> 01:02:07.000\n${long}\nቃል ${"በ".repeat(40)} ሌላ ቃል\n`);
  });
  it("throws when segments are missing", () => {
    expect(() => toSrt({})).toThrow(/timestamps: "word"/);
    expect(() => toVtt({ segments: undefined })).toThrow(/segments/);
  });
});
