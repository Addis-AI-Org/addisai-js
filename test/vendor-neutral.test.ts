import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Customers buy Addis AI models. Published docs and examples must not name the
// third-party models or vendors underneath them.
const VENDOR =
  /gemini|google|vertex|azure|microsoft|openai|whisper|\bgpt|chatgpt|claude|anthropic|elevenlabs|indextts|pyannote|latentsync|\bflash\b|supabase/i;

const root = resolve(__dirname, "..");
const docs = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  ...readdirSync(join(root, "examples")).map((name) => join("examples", name)),
];

function comments(source: string): string[] {
  return [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map((match) => match[0]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

describe("vendor neutrality", () => {
  it("README, changelog, contributing guide and examples name no third-party model or vendor", () => {
    for (const path of docs) {
      readFileSync(join(root, path), "utf8")
        .split("\n")
        .forEach((line, index) => {
          expect(line, `${path}:${index + 1}`).not.toMatch(VENDOR);
        });
    }
  });

  it("source comments name no third-party model or vendor", () => {
    for (const path of sourceFiles("src")) {
      for (const comment of comments(readFileSync(join(root, path), "utf8"))) {
        expect(comment, path).not.toMatch(VENDOR);
      }
    }
  });
});
