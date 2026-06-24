import { camelize } from "../core/camelize.js";
import { type RequestOptions, type Transport, unwrapData } from "../core/request.js";
import type { Language } from "./shared.js";

export interface VoiceCatalogEntry {
  id: string;
  name: string;
  descriptor: string;
  language: Language;
  gender: string;
  style: string;
  scriptChip: string;
  tags: string[];
  previewAudioUrl: string | null;
  previewMimeType: string | null;
  previewDurationSeconds: number | null;
  isDefault: boolean;
  isAvailable: boolean;
  sortOrder: number;
}

export interface VoiceListParams {
  language?: Language;
  gender?: "female" | "male";
  search?: string;
  includeUnavailable?: boolean;
}

export interface VoicePreview {
  voiceId: string;
  audioUrl: string | null;
  audio: string | null;
  mimeType: string | null;
  durationSeconds: number | null;
  downloadName: string;
}

export class Voices {
  constructor(private readonly transport: Transport) {}

  /** List the voice catalog. */
  async list(params: VoiceListParams = {}, opts: RequestOptions = {}): Promise<VoiceCatalogEntry[]> {
    const query: Record<string, unknown> = {
      language: params.language,
      gender: params.gender,
      search: params.search,
      include_unavailable: params.includeUnavailable,
    };
    const data = unwrapData<unknown[]>(
      await this.transport.request({ method: "GET", path: "/api/v1/voice/voices", query }, opts),
    );
    return camelize<VoiceCatalogEntry[]>(data);
  }

  /** Fetch a single voice's preview clip metadata. */
  async preview(voiceId: string, opts: RequestOptions = {}): Promise<VoicePreview> {
    const data = unwrapData(
      await this.transport.request(
        { method: "GET", path: `/api/v1/voice/voices/${encodeURIComponent(voiceId)}/preview` },
        opts,
      ),
    );
    return camelize<VoicePreview>(data);
  }
}
