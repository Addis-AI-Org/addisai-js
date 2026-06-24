import { AddisAIError } from "../core/errors.js";
import { type RequestOptions, type Transport } from "../core/request.js";
import { AudioStream } from "../lib/audio-stream.js";
import type { Language } from "./shared.js";

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[addisai] addis.legacy.audio is DEPRECATED. Migrate to addis.voice.generate(), " +
      "which uses the current, more capable voice model. The legacy /audio endpoint " +
      "may be removed in a future release.",
  );
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface LegacyAudioParams {
  text: string;
  /** "am" | "om". */
  language: Language;
}

/** Result of a legacy non-streaming synthesis. */
export class LegacyAudio {
  constructor(
    /** Base64-encoded audio (WAV or MP3, provider-dependent). */
    readonly audio: string,
  ) {}

  /** Decode the base64 audio into bytes. */
  arrayBuffer(): ArrayBuffer {
    const bytes = decodeBase64(this.audio);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  /** Write the decoded audio to disk (Node/Bun/Deno). */
  async toFile(path: string): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, Buffer.from(this.arrayBuffer()));
  }
}

/**
 * @deprecated The legacy `/audio` text-to-speech endpoint. Use
 * {@link Voice.generate} (`addis.voice.generate`) instead — it uses the current
 * voice model and returns durable, signed clips with idempotent billing.
 *
 * Provided only as a migration bridge for existing integrations. Limited to
 * 1500 characters for non-streaming synthesis.
 */
export class LegacyAudioResource {
  constructor(private readonly transport: Transport) {}

  /**
   * @deprecated Use `addis.voice.generate(...)`.
   * Synthesize speech via the legacy endpoint (non-streaming).
   */
  async generate(params: LegacyAudioParams, opts: RequestOptions = {}): Promise<LegacyAudio> {
    warnOnce();
    const body = await this.transport.request<{ audio?: string; audio_chunk?: string }>(
      { method: "POST", path: "/api/v1/audio", body: { text: params.text, language: params.language, stream: false } },
      opts,
    );
    const audio = body.audio ?? body.audio_chunk;
    if (!audio) throw new AddisAIError("Legacy audio response did not contain audio data.");
    return new LegacyAudio(audio);
  }

  /**
   * @deprecated Use `addis.voice.generate(...)`.
   * Stream synthesis via the legacy endpoint. Returns an {@link AudioStream} of
   * audio byte chunks. The SDK normalizes the two legacy encodings (Amharic
   * newline-delimited base64 JSON, Afan Oromo raw `audio/wav`) into one byte
   * stream. New code should not depend on this.
   */
  async stream(params: LegacyAudioParams, opts: RequestOptions = {}): Promise<AudioStream> {
    warnOnce();
    const { response, controller } = await this.transport.openStream(
      { method: "POST", path: "/api/v1/audio", body: { text: params.text, language: params.language, stream: true } },
      opts,
    );
    return AudioStream.fromResponse(response, controller);
  }
}

/** @deprecated Namespace for legacy endpoints retained for backward compatibility. */
export class Legacy {
  /** @deprecated Use `addis.voice` instead. */
  readonly audio: LegacyAudioResource;

  constructor(transport: Transport) {
    this.audio = new LegacyAudioResource(transport);
  }
}
