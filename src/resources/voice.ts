import { camelize } from "../core/camelize.js";
import { ulid } from "../core/idempotency.js";
import { NotSupportedError } from "../core/errors.js";
import { CursorPage, CursorPagePromise, type Page } from "../core/pagination.js";
import { type RequestOptions, type Transport, unwrapData } from "../core/request.js";
import { AddisClip, type ClipData } from "../lib/clip.js";
import type { AudioStream } from "../lib/audio-stream.js";
import type { Language, OutputFormat } from "./shared.js";

/** ElevenLabs-style voice controls, expressed on a 0–100 scale. */
export interface VoiceSettings {
  speed?: number;
  stability?: number;
  similarity?: number;
  style?: number;
}

export interface VoiceGenerateParams {
  voiceId: string;
  text: string;
  language: Language;
  /** Default "mp3_44100". */
  outputFormat?: OutputFormat;
  voiceSettings?: VoiceSettings;
  /**
   * Idempotency key. Auto-generated if omitted and reused across retries so a
   * retried request is never billed twice. Reusing a key with changed inputs
   * raises IdempotencyConflictError.
   */
  clientRequestId?: string;
}

export interface VoiceEstimateParams {
  voiceId: string;
  text: string;
  language: Language;
  outputFormat?: OutputFormat;
}

export interface VoiceEstimate {
  characterCount: number;
  billableCharacters: number;
  pricingUnit: "character";
  pricePer1000Characters: number;
  estimatedCost: number;
  currency: string;
  currentBalance: number;
  estimatedBalanceAfter: number;
  canGenerate: boolean;
}

export interface VoiceUsage {
  walletId: string;
  balance: number;
  formattedBalance: string;
  currency: string;
  lastDeductionAt: string | null;
  totalSpend: number;
  formattedTotalSpend: string;
  maxTtsCharacters: number;
  pricing: {
    unit: string;
    pricePer1000Characters: number;
    minimumCharge: number;
    currency: string;
  };
  budget: unknown | null;
}

export interface ClipListParams {
  limit?: number;
  cursor?: string;
  language?: Language;
  voiceId?: string;
}

const VOICE_TIMEOUT_FLOOR_MS = 95_000;

export class Voice {
  readonly clips: Clips;

  constructor(private readonly transport: Transport) {
    this.clips = new Clips(transport);
  }

  /** Synthesize speech and return the generated clip. */
  async generate(params: VoiceGenerateParams, opts: RequestOptions = {}): Promise<AddisClip> {
    const clientRequestId = params.clientRequestId ?? ulid();
    const body = {
      text: params.text,
      language: params.language,
      voice_id: params.voiceId,
      output_format: params.outputFormat ?? "mp3_44100",
      voice_settings: params.voiceSettings,
      stream: false,
      client_request_id: clientRequestId,
    };
    const data = unwrapData<Record<string, unknown>>(
      await this.transport.request(
        { method: "POST", path: "/api/v1/voice/generations", body, timeoutFloor: VOICE_TIMEOUT_FLOOR_MS },
        opts,
      ),
    );
    return new AddisClip({ ...mapClip(data), clientRequestId }, this.transport.fetch);
  }

  /**
   * Streaming synthesis. The surface is stable for when the API enables it;
   * until then it raises NotSupportedError. Use {@link Voice.generate} today.
   */
  async stream(_params: VoiceGenerateParams, _opts?: RequestOptions): Promise<AudioStream> {
    throw new NotSupportedError(
      "Streaming voice synthesis is not yet available. Use voice.generate().",
    );
  }

  /** Pre-flight cost estimate (and whether the wallet can cover it). */
  async estimate(params: VoiceEstimateParams, opts: RequestOptions = {}): Promise<VoiceEstimate> {
    const body = {
      text: params.text,
      language: params.language,
      voice_id: params.voiceId,
      output_format: params.outputFormat ?? "mp3_44100",
    };
    const data = unwrapData(
      await this.transport.request({ method: "POST", path: "/api/v1/voice/estimate", body }, opts),
    );
    return camelize<VoiceEstimate>(data);
  }

  /** Wallet balance and pricing for voice generation. */
  async usage(opts: RequestOptions = {}): Promise<VoiceUsage> {
    const data = unwrapData(
      await this.transport.request({ method: "GET", path: "/api/v1/voice/usage" }, opts),
    );
    return camelize<VoiceUsage>(data);
  }
}

export class Clips {
  constructor(private readonly transport: Transport) {}

  /**
   * List generated clips. The returned value is both awaitable
   * (`const page = await clips.list()`) and async-iterable
   * (`for await (const clip of clips.list())` walks every page).
   */
  list(params: ClipListParams = {}, opts: RequestOptions = {}): CursorPagePromise<AddisClip> {
    const fetchPage = async (cursor?: string): Promise<Page<AddisClip>> => {
      const query: Record<string, unknown> = {
        limit: params.limit,
        cursor,
        language: params.language,
        voice_id: params.voiceId,
      };
      const body = await this.transport.request<{ data: Record<string, unknown>[]; meta?: { next_cursor?: string | null; limit?: number } }>(
        { method: "GET", path: "/api/v1/voice/clips", query },
        opts,
      );
      return {
        data: (body.data ?? []).map((c) => new AddisClip(mapClip(c), this.transport.fetch)),
        nextCursor: body.meta?.next_cursor ?? null,
        limit: body.meta?.limit ?? null,
      };
    };
    return new CursorPagePromise(async () => {
      const first = await fetchPage(params.cursor);
      return new CursorPage(first, (cursor) => fetchPage(cursor));
    });
  }

  /** Fetch one clip by ID. */
  async get(clipId: string, opts: RequestOptions = {}): Promise<AddisClip> {
    const data = unwrapData<Record<string, unknown>>(
      await this.transport.request({ method: "GET", path: `/api/v1/voice/clips/${encodeURIComponent(clipId)}` }, opts),
    );
    return new AddisClip(mapClip(data), this.transport.fetch);
  }

  /** Download the audio bytes for a clip. */
  async download(clipId: string, opts: RequestOptions = {}): Promise<ArrayBuffer> {
    const clip = await this.get(clipId, opts);
    return clip.arrayBuffer();
  }

  /** Delete a clip. */
  async delete(clipId: string, opts: RequestOptions = {}): Promise<void> {
    await this.transport.request<Response>(
      { method: "DELETE", path: `/api/v1/voice/clips/${encodeURIComponent(clipId)}`, raw: true },
      opts,
    );
  }
}

/** Whitelist-map the backend clip object to the public, camelCase ClipData. */
function mapClip(raw: Record<string, any>): ClipData {
  return {
    id: raw.id,
    text: raw.text ?? raw.text_preview ?? "",
    textPreview: raw.text_preview ?? "",
    voiceId: raw.voice_id,
    voiceName: raw.voice_name,
    voiceDescriptor: raw.voice_descriptor,
    language: raw.language,
    outputFormat: raw.output_format,
    audioUrl: raw.audio_url ?? raw.playback?.url ?? "",
    mimeType: raw.mime_type,
    durationSeconds: raw.duration_seconds ?? null,
    characterCount: raw.character_count ?? 0,
    billableCharacters: raw.billable_characters ?? 0,
    downloadName: raw.download_name ?? "",
    createdAt: raw.created_at,
    usage: raw.usage
      ? {
          pricingUnit: raw.usage.pricing_unit ?? "character",
          pricePer1000Characters: raw.usage.price_per_1000_characters ?? 0,
          creditsUsed: raw.usage.credits_used ?? null,
          creditsRemaining: raw.usage.credits_remaining ?? null,
          currency: raw.usage.currency ?? "ETB",
        }
      : undefined,
    meta: raw.meta
      ? {
          ignoredVoiceSettings: raw.meta.ignored_voice_settings ?? [],
          idempotentReplay: Boolean(raw.meta.idempotent_replay),
        }
      : undefined,
  };
}
