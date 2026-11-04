// Drift check against the live public API (no key, no cost). Runs in CI's drift job with ADDIS_DRIFT=1.
import { describe, expect, it } from "vitest";
import { REALTIME_LANGUAGES, SCRIBE_LANGUAGES } from "../src/index.js";

const base = (process.env.ADDIS_BASE_URL ?? "https://api.addisassistant.com").replace(/\/$/, "");
const get = async (path: string) => {
  const response = await fetch(base + path);
  expect(response.ok).toBe(true);
  return ((await response.json()) as { data: any }).data;
};

describe.skipIf(process.env.ADDIS_DRIFT !== "1")("live API drift", () => {
  it("Scribe languages match the SDK", async () => {
    const live = (await get("/api/v1/scribe")).languages as Record<string, { speakers: boolean; backends: string[] }>;
    expect(Object.keys(live).sort()).toEqual([...SCRIBE_LANGUAGES].sort());
    expect(Object.keys(live).filter((c) => !live[c]!.speakers)).toEqual(["sw"]);
  });

  it("real-time languages match the SDK", async () => {
    expect((await get("/api/v1/realtime")).languages).toEqual([...REALTIME_LANGUAGES]);
  });
});
