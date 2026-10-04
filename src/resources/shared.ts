/** Languages supported for speech generation. */
export type Language = "am" | "om" | "ti" | "sid" | "wal" | "ha" | "sw" | "en" | "fr";

/** Languages supported for chat, including multimodal inputs. */
export type ChatLanguage = "am" | "om" | "ti";

/** Languages supported for speech-to-text. */
export type SttLanguage = "am" | "om" | "en" | "ha" | "sw" | "ti";

/** Languages supported for translation. */
export type TranslateLanguage = "am" | "om" | "en" | "ti";

/** TTS output formats. `pcm_16000` is delivered as a WAV container. */
export type OutputFormat = "mp3_44100" | "wav_44100" | "pcm_16000";
