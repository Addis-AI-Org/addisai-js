import { AddisAIError } from "../core/errors.js";
import type { FetchLike } from "../core/request.js";
import type { Language, OutputFormat } from "../resources/shared.js";

export interface ClipUsage {
  /** Current Voice 2 clips use minute billing; older clips may use character billing. */
  pricingUnit: "minute" | "character";
  pricePerMinute?: number;
  pricePerAudioMinute?: number;
  pricePer1000Characters?: number;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  currency: string;
}

export interface ClipMeta {
  /** Voice settings the request sent that the engine did not apply. */
  ignoredVoiceSettings: string[];
  /** True when this result was replayed from a prior identical request (no new billing). */
  idempotentReplay: boolean;
}

export interface ClipData {
  id: string;
  text: string;
  textPreview: string;
  voiceId: string;
  voiceName: string;
  voiceDescriptor: string;
  language: Language;
  outputFormat: OutputFormat;
  audioUrl: string;
  mimeType: string;
  durationSeconds: number | null;
  characterCount: number;
  billableCharacters: number;
  downloadName: string;
  createdAt: string;
  usage?: ClipUsage;
  meta?: ClipMeta;
  /** The idempotency key used for this generation. */
  clientRequestId?: string;
}

/**
 * A generated audio clip. Exposes the signed playback URL plus convenience
 * helpers to fetch the bytes or write them to disk.
 */
export class AddisClip implements ClipData {
  readonly id!: string;
  readonly text!: string;
  readonly textPreview!: string;
  readonly voiceId!: string;
  readonly voiceName!: string;
  readonly voiceDescriptor!: string;
  readonly language!: Language;
  readonly outputFormat!: OutputFormat;
  readonly audioUrl!: string;
  readonly mimeType!: string;
  readonly durationSeconds!: number | null;
  readonly characterCount!: number;
  readonly billableCharacters!: number;
  readonly downloadName!: string;
  readonly createdAt!: string;
  readonly usage?: ClipUsage;
  readonly meta?: ClipMeta;
  readonly clientRequestId?: string;

  constructor(data: ClipData, private readonly fetchImpl: FetchLike) {
    Object.assign(this, data);
  }

  /** Fetch the audio bytes from the signed playback URL. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (!this.audioUrl) throw new AddisAIError("This clip has no audioUrl to download.");
    const res = await this.fetchImpl(this.audioUrl);
    if (!res.ok) {
      throw new AddisAIError(`Failed to download clip ${this.id}: HTTP ${res.status}.`);
    }
    return res.arrayBuffer();
  }

  /** Write the audio to a file on disk (Node/Bun/Deno). */
  async toFile(path: string): Promise<void> {
    const buffer = await this.arrayBuffer();
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, Buffer.from(buffer));
  }
}
