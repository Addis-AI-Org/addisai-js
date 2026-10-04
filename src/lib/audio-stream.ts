import { AddisAIError } from "../core/errors.js";
import { parseNDJSON } from "../core/sse.js";
import { parseVoiceFrames } from "../core/voice-frames.js";

/**
 * A stream of audio byte chunks. Async-iterable (`for await` yields
 * `Uint8Array`), with helpers to collect or save the audio. Normalizes the two
 * legacy stream encodings (newline-delimited base64 JSON chunks, or a raw audio
 * byte stream) into a single byte stream.
 */
export class AudioStream implements AsyncIterable<Uint8Array> {
  private consumed = false;
  /** Clip and wallet metadata, available after the iterator reaches completion. */
  metadata: Record<string, unknown> | null = null;
  /** Reuse this ID to recover a failed generation without a second charge. */
  clientRequestId?: string;

  constructor(
    private readonly response: Response,
    private readonly mode: "ndjson" | "raw" | "framed" | "replay",
    private readonly controller?: AbortController,
  ) {}

  static fromResponse(response: Response, controller?: AbortController): AudioStream {
    if (response.headers.get("x-addis-audio-protocol") === "mp3-frames-v1") return new AudioStream(response, "framed", controller);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const mode = contentType.includes("ndjson") || contentType.includes("json") ? "ndjson" : "raw";
    return new AudioStream(response, mode, controller);
  }

  static fromVoiceResponse(response: Response, controller?: AbortController): AudioStream {
    if (response.headers.get("x-addis-audio-protocol") === "mp3-frames-v1") return new AudioStream(response, "framed", controller);
    if ((response.headers.get("content-type") ?? "").includes("application/json")) return new AudioStream(response, "replay", controller);
    throw new AddisAIError("Unsupported voice stream protocol.");
  }

  /** Cancel the stream and underlying request. */
  abort(): void {
    this.controller?.abort();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.consumed) throw new AddisAIError("This stream has already been consumed.");
    this.consumed = true;
    if (!this.response.body) return;

    if (this.mode === "replay") {
      const payload = await this.response.json();
      if (!payload?.data || payload.error) throw new AddisAIError("Voice generation did not complete.");
      this.metadata = payload.data;
      // Idempotent replay returns the already-paid clip. Audio is not resent.
      return;
    }
    if (this.mode === "framed") {
      for await (const part of parseVoiceFrames(this.response.body)) {
        if (part instanceof Uint8Array) yield part;
        else this.metadata = part;
      }
      return;
    }

    if (this.mode === "raw") {
      const reader = this.response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return;
    }

    for await (const obj of parseNDJSON(this.response.body)) {
      if (!obj) continue;
      if (obj.status === "error" || obj.error) {
        const message = obj.error?.message || "Audio stream failed.";
        throw new AddisAIError(message);
      }
      const b64 = obj.audio_chunk ?? obj.audio;
      if (typeof b64 === "string" && b64) yield decodeBase64(b64);
    }
  }

  /** Collect every chunk into a single ArrayBuffer. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out.buffer;
  }

  /** Stream the audio to a file on disk (Node/Bun/Deno). */
  async toFile(path: string): Promise<void> {
    const fs = await import("node:fs");
    const handle = fs.createWriteStream(path);
    try {
      for await (const chunk of this) {
        await new Promise<void>((resolve, reject) => {
          handle.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
        });
      }
    } finally {
      await new Promise<void>((resolve) => handle.end(resolve));
    }
  }
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
