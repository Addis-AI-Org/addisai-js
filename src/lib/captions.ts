// Caption formatting for Scribe `segments`. Pure and local: no API call.
// Keep the algorithm identical to the Python SDK (addisai/_captions.py).
import { AddisAIError } from "../core/errors.js";
import type { ScribeSegment } from "../resources/scribe.js";

const MAX_LINE = 42;
const MAX_LINES = 2;

function segmentsOf(result: { segments?: ScribeSegment[] }): ScribeSegment[] {
  const segments = result?.segments;
  if (!Array.isArray(segments)) throw new AddisAIError('Scribe result has no segments. Transcribe with timestamps: "word" to build captions.');
  for (const segment of segments) {
    if (typeof segment?.text !== "string" || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
      throw new AddisAIError("Scribe segments need text, start and end.");
    }
  }
  return segments;
}

/** Greedy wrap at 42 characters per line; at most 2 lines, overflow joins line 2. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (Array.from(line).length + 1 + Array.from(word).length <= MAX_LINE) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), lines.slice(MAX_LINES - 1).join(" ")] : lines;
}

function timestamp(seconds: number, separator: "," | "."): string {
  const ms = Math.max(0, Math.floor(seconds * 1000 + 0.5));
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

function hasSpeaker(segment: ScribeSegment): segment is ScribeSegment & { speaker: number } {
  return segment.speaker !== undefined && segment.speaker !== null;
}

/** SRT: `Speaker N: ` is part of the text, so it counts toward the 42-character lines. */
function srtLines(segment: ScribeSegment): string[] {
  return wrap(hasSpeaker(segment) ? `Speaker ${segment.speaker}: ${segment.text}` : segment.text);
}

/** VTT: a `<v Speaker N>` voice span opens the first line and is not counted toward line length. */
function vttLines(segment: ScribeSegment): string[] {
  const lines = wrap(segment.text);
  if (!hasSpeaker(segment)) return lines;
  const [first = "", ...rest] = lines;
  return [`<v Speaker ${segment.speaker}>${first}`, ...rest];
}

function cues(segments: ScribeSegment[], separator: "," | ".", numbered: boolean): string[] {
  return segments.map((segment, index) => [
    ...(numbered ? [String(index + 1)] : []),
    `${timestamp(segment.start, separator)} --> ${timestamp(segment.end, separator)}`,
    ...(numbered ? srtLines(segment) : vttLines(segment)),
  ].join("\n"));
}

/** Format `segments` as SubRip (SRT) text; throws if the result has no segments. Labelled segments get a `Speaker N: ` prefix. */
export function toSrt(result: { segments?: ScribeSegment[] }): string {
  const blocks = cues(segmentsOf(result), ",", true);
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/** Format `segments` as WebVTT text; throws if the result has no segments. Labelled segments get a `<v Speaker N>` voice span. */
export function toVtt(result: { segments?: ScribeSegment[] }): string {
  const blocks = cues(segmentsOf(result), ".", false);
  return blocks.length ? `WEBVTT\n\n${blocks.join("\n\n")}\n` : "WEBVTT\n";
}
