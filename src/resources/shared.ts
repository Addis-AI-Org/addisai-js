/** Languages supported for generation/chat. */
export type Language = "am" | "om";

/** Languages supported for speech-to-text. */
export type SttLanguage = "am" | "om" | "en" | "ha" | "sw";

/** Languages supported for translation. */
export type TranslateLanguage = "am" | "om" | "en";

/** TTS output formats. `pcm_16000` is delivered as a WAV container. */
export type OutputFormat = "mp3_44100" | "wav_44100" | "pcm_16000";
