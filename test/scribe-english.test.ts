import { expect, it } from "vitest";
import AddisAI, { SCRIBE_LANGUAGES } from "../src/index.js";

// English on Addis Scribe (2026-11-13): language "en" is sent exactly like the other non-Amharic languages.
const result = {
  text: "Good morning everyone.", request_id: "en1", seconds: 2, compute_ms: 5, backend: "turbo", chunk: "1120ms", mode: "offline",
  language: "en", model: "addis-scribe-english-streaming",
  usage: { record_id: "ledger", characters: 22, price_per_1000_characters: 3.5, credits_used: .08, credits_remaining: 9.92, currency: "ETB", settled: true },
};

it("SCRIBE_LANGUAGES includes English", () => {
  expect(SCRIBE_LANGUAGES).toContain("en");
});

it("transcribe sends language=en and maps the English model", async () => {
  const seen: URL[] = [];
  const addis = new AddisAI({ apiKey: "test-secret", fetch: async (url) => { seen.push(new URL(String(url))); return Response.json({ data: result }); } });
  const out = await addis.scribe.transcribe({ audio: new Uint8Array([1, 2]), requestId: "en1", language: "en" });
  expect(seen[0]!.searchParams.get("language")).toBe("en");
  expect(out.language).toBe("en");
  expect(out.model).toBe("addis-scribe-english-streaming");
});
