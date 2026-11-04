import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICES, REALTIME_LANGUAGES, VOICE_LANGUAGES, VOICES } from "../src/index.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const table = readme.slice(readme.indexOf("<!-- languages:start -->"), readme.indexOf("<!-- languages:end -->"));
const rows = table.split("\n").filter((line) => line.startsWith("| ") && line.includes("`"));
const code = (line: string) => /`([a-z]+)`/.exec(line)![1]!;

describe("README language table", () => {
  it("has one row per voice language, in order", () => {
    expect(rows.map(code)).toEqual([...VOICE_LANGUAGES]);
  });

  it("lists every voice, default first", () => {
    for (const line of rows) {
      const language = code(line) as keyof typeof VOICES;
      const ids = [...line.split("|")[3]!.matchAll(/`([a-z]+-[a-z0-9-]+)`/g)].map((m) => m[1]);
      expect(ids[0]).toBe(DEFAULT_VOICES[language]);
      if (language === "am") expect(line).toContain(`and ${VOICES.am.length - 1} more`);
      else expect(ids).toEqual([...VOICES[language]]);
    }
  });

  it("marks exactly the streaming languages", () => {
    for (const line of rows) expect(line.includes("| yes |")).toBe((REALTIME_LANGUAGES as readonly string[]).includes(code(line)));
  });

  it("never names a retired voice", () => {
    expect(readme).not.toContain("ha-hauwa");
    expect(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")).not.toContain("ha-hauwa");
  });
});
