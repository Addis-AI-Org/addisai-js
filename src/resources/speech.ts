import { type RequestOptions, type Transport, unwrapData } from "../core/request.js";
import { toBlob, type Uploadable } from "../core/uploads.js";
import type { SttLanguage } from "./shared.js";

export interface TranscribeParams {
  /** Audio input. Buffer/Blob/Uint8Array, or a FileInput descriptor. Max 25 MB / 120 s. */
  audio: Uploadable;
  /** Language of the audio: "am" | "om" | "en" | "ha" | "sw". */
  language: SttLanguage;
}

export interface Transcription {
  text: string;
  confidence: number | null;
  usage: unknown;
}

export class Speech {
  constructor(private readonly transport: Transport) {}

  /** Transcribe speech to text. */
  async transcribe(params: TranscribeParams, opts: RequestOptions = {}): Promise<Transcription> {
    const form = new FormData();
    const { blob, filename } = toBlob(params.audio, "audio/wav");
    form.append("audio", blob, filename || "audio.wav");
    form.append(
      "request_data",
      new Blob([JSON.stringify({ language_code: params.language })], { type: "application/json" }),
    );

    const data = unwrapData<{ transcription?: string; confidence?: number | null; usage_metadata?: unknown }>(
      await this.transport.request({ method: "POST", path: "/api/v2/stt", form }, opts),
    );
    return {
      text: data.transcription ?? "",
      confidence: data.confidence ?? null,
      usage: data.usage_metadata ?? null,
    };
  }
}
