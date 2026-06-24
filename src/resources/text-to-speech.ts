import type { RequestOptions } from "../core/request.js";
import type { AddisClip } from "../lib/clip.js";
import type { Voice, VoiceSettings } from "./voice.js";
import type { Language, OutputFormat } from "./shared.js";

/**
 * ElevenLabs-style alias over `voice.*`, for developers migrating from
 * ElevenLabs. `client.textToSpeech.convert(voiceId, { text, language })`.
 */
export interface ConvertParams {
  text: string;
  language: Language;
  outputFormat?: OutputFormat;
  voiceSettings?: VoiceSettings;
  clientRequestId?: string;
}

export class TextToSpeech {
  constructor(private readonly voice: Voice) {}

  /** Synthesize speech for a voice. Mirrors ElevenLabs `textToSpeech.convert`. */
  convert(voiceId: string, params: ConvertParams, opts?: RequestOptions): Promise<AddisClip> {
    return this.voice.generate({ voiceId, ...params }, opts);
  }
}
