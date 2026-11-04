import type { Language, RealtimeLanguage, RealtimeSessionParams, VoiceGenerateParams, VoiceStreamParams } from "../src/index.js";

// These assignments fail typecheck if a public voice union changes.
declare const language: Language;
const voice: "am" | "om" | "ti" | "sw" | "ha" | "sid" | "wal" = language;
declare const realtimeLanguage: RealtimeLanguage;
const realtime: "am" | "om" | "ti" | "sw" | "ha" | "sid" | "wal" = realtimeLanguage;
declare const session: RealtimeSessionParams;
declare const generate: VoiceGenerateParams;
declare const stream: VoiceStreamParams;
const sessionLanguage: typeof realtime = session.language;
const streamLanguage: typeof realtime = stream.language;
const generationLanguage: typeof voice = generate.language;
// Sidama streams since 0.14.0.
const sidamaStream: VoiceStreamParams = { voiceId: "sid-tigist", text: "x", language: "sid" };
void sessionLanguage;
void streamLanguage;
void generationLanguage;
void sidamaStream;
