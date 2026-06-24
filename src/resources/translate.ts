import { type RequestOptions, type Transport, unwrapData } from "../core/request.js";
import type { TranslateLanguage } from "./shared.js";

export interface TranslateParams {
  text: string;
  /** Target language: "am" | "om" | "en". */
  to: TranslateLanguage;
  /** Source language. Must differ from `to`. */
  from: TranslateLanguage;
}

export interface Translation {
  text: string;
  sourceLanguage: TranslateLanguage;
  targetLanguage: TranslateLanguage;
  quality: "high" | "medium" | "low" | null;
  usage: unknown;
}

export class Translate {
  constructor(private readonly transport: Transport) {}

  /** Translate text between Amharic, Afan Oromo, and English. */
  async create(params: TranslateParams, opts: RequestOptions = {}): Promise<Translation> {
    const body = {
      text: params.text,
      source_language: params.from,
      target_language: params.to,
    };
    const data = unwrapData<{
      translation?: string;
      source_language?: TranslateLanguage;
      target_language?: TranslateLanguage;
      quality?: "high" | "medium" | "low" | null;
      usage_metadata?: unknown;
    }>(await this.transport.request({ method: "POST", path: "/api/v1/translate", body }, opts));
    return {
      text: data.translation ?? "",
      sourceLanguage: data.source_language ?? params.from,
      targetLanguage: data.target_language ?? params.to,
      quality: data.quality ?? null,
      usage: data.usage_metadata ?? null,
    };
  }
}
