import { AddisAIError } from "../core/errors.js";

/** Languages supported for speech generation (`voice.generate`, `voice.estimate`, batches, the voice catalog). */
export type Language = "am" | "om" | "ti" | "sw" | "ha" | "sid" | "wal";
export const VOICE_LANGUAGES: readonly Language[] = ["am", "om", "ti", "sw", "ha", "sid", "wal"];

/** Languages supported for streamed speech (`voice.stream`) and real-time sessions (`realtime`): since 0.14.0 the same seven as `Language`. */
export type RealtimeLanguage = Language;
export const REALTIME_LANGUAGES: readonly RealtimeLanguage[] = ["am", "om", "ti", "sw", "ha", "sid", "wal"];

/** Languages supported by the deprecated legacy audio endpoint (`legacy.audio`). */
export type LegacyLanguage = "am" | "om" | "ti";
const LEGACY_LANGUAGES: readonly LegacyLanguage[] = ["am", "om", "ti"];

/**
 * The public voices of each language, default first. The API is the source of truth (`voices.list`); this mirror
 * lets you check an ID offline. Every ID is `<language>-<name>`.
 */
export const VOICES: Readonly<Record<Language, readonly string[]>> = {
  am: ["am-hamen", "am-simon", "am-yohanes-calm", "am-tesfa", "am-muaz", "am-roba", "am-nejat", "am-loza", "am-nahom",
    "am-amanuel", "am-tewodros", "am-kaleb", "am-dawit", "am-meron", "am-makda", "am-feven", "am-melat", "am-dibora", "am-sara"],
  om: ["om-bikila", "om-ayyaantuu", "om-leensaa", "om-hawi", "om-diriba", "om-leta", "om-ebba", "om-chala", "om-obse"],
  ti: ["ti-berhane", "ti-senait", "ti-haben", "ti-rahel", "ti-filimon", "ti-danait", "ti-yonas"],
  sw: ["sw-rashid", "sw-neema", "sw-hassan", "sw-bakari", "sw-amina", "sw-juma", "sw-zainab"],
  ha: ["ha-mustapha", "ha-sani", "ha-usman", "ha-musa"],
  sid: ["sid-tigist", "sid-desta", "sid-bereket", "sid-selam", "sid-alemu"],
  wal: ["wal-tona", "wal-almaz", "wal-amado", "wal-gobe", "wal-hiwot"],
};

/** The default voice of each language. */
export const DEFAULT_VOICES = Object.fromEntries(
  Object.entries(VOICES).map(([language, voices]) => [language, voices[0]]),
) as Readonly<Record<Language, string>>;

const NAMES: Record<string, string> = { am: "am (Amharic)", om: "om (Afaan Oromo)", ti: "ti (Tigrinya)", sw: "sw (Swahili)",
  ha: "ha (Hausa)", sid: "sid (Sidama)", wal: "wal (Wolaytta)" };
const VOICE_ID = /^[a-z]{2,3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function choices(codes: readonly string[]): string {
  const names = codes.map((code) => NAMES[code]);
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

export function isVoiceLanguage(value: unknown): value is Language {
  return (VOICE_LANGUAGES as readonly unknown[]).includes(value);
}

/** Runtime validation also protects JavaScript callers without TypeScript. */
export function assertVoiceLanguage(value: unknown): asserts value is Language {
  if (!isVoiceLanguage(value)) throw new AddisAIError(`Voice language must be ${choices(VOICE_LANGUAGES)}.`);
}

export function assertRealtimeLanguage(value: unknown): asserts value is RealtimeLanguage {
  if (!(REALTIME_LANGUAGES as readonly unknown[]).includes(value)) {
    throw new AddisAIError(`Streamed and real-time voice language must be ${choices(REALTIME_LANGUAGES)}.`);
  }
}

export function assertLegacyLanguage(value: unknown): asserts value is LegacyLanguage {
  if (!(LEGACY_LANGUAGES as readonly unknown[]).includes(value)) {
    throw new AddisAIError(`Legacy audio language must be ${choices(LEGACY_LANGUAGES)}. Use voice.generate for other languages.`);
  }
}

/**
 * A voice ID is `<language>-<name>` and must belong to the request's language (`sid-tigist` with `language: "sid"`).
 * IDs that are not in `VOICES` (new or private voices) still pass; the API decides.
 */
export function assertVoiceId(voiceId: unknown, language: string): void {
  if (typeof voiceId !== "string" || !VOICE_ID.test(voiceId)) {
    throw new AddisAIError('voiceId must look like "<language>-<name>", for example "ti-berhane".');
  }
  if (voiceId.split("-", 1)[0] !== language) {
    const example = DEFAULT_VOICES[language as Language] ?? language;
    throw new AddisAIError(`voiceId "${voiceId}" is not a ${language} voice. Use a "${language}-" voice such as "${example}".`);
  }
}

/** Languages supported for chat, including multimodal inputs. */
export type ChatLanguage = "am" | "om" | "ti";

/** Languages supported for speech-to-text. */
export type SttLanguage = "am" | "om" | "en" | "ha" | "sw" | "ti";

/** Languages supported for translation. */
export type TranslateLanguage = "am" | "om" | "en" | "ti";

/** TTS output formats. `pcm_16000` is delivered as a WAV container. */
export type OutputFormat = "mp3_44100" | "wav_44100" | "pcm_16000";
