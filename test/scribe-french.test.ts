import { expect, it } from "vitest";
import AddisAI, { SCRIBE_LANGUAGES, type ScribeLanguage } from "../src/index.js";

// French on Addis Scribe (2026-11-15): language "fr" is sent exactly like the other non-Amharic languages.
const result = {
  text: "Bonjour à tous.", request_id: "fr1", seconds: 2, compute_ms: 5, backend: "turbo", chunk: "1120ms", mode: "offline",
  language: "fr", model: "addis-scribe-french-streaming",
  usage: { record_id: "ledger", characters: 15, price_per_1000_characters: 3.5, credits_used: .05, credits_remaining: 9.95, currency: "ETB", settled: true },
};

it("SCRIBE_LANGUAGES includes French, after English", () => {
  expect(SCRIBE_LANGUAGES).toContain("fr");
  expect(SCRIBE_LANGUAGES.slice(-2)).toEqual(["en", "fr"]);
  const language: ScribeLanguage = "fr";
  expect(language).toBe("fr");
});

it("transcribe sends language=fr and maps the French model", async () => {
  const seen: URL[] = [];
  const addis = new AddisAI({ apiKey: "test-secret", fetch: async (url) => { seen.push(new URL(String(url))); return Response.json({ data: result }); } });
  const out = await addis.scribe.transcribe({ audio: new Uint8Array([1, 2]), requestId: "fr1", language: "fr" });
  expect(seen[0]!.searchParams.get("language")).toBe("fr");
  expect(out.language).toBe("fr");
  expect(out.model).toBe("addis-scribe-french-streaming");
});
