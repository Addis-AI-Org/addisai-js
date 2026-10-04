import type { Language, RealtimeSessionParams, VoiceGenerateParams } from "../src/index.js";

// These assignments fail typecheck if the public voice union widens again.
declare const language: Language;
const approved: "am" | "om" | "ti" = language;
declare const realtime: RealtimeSessionParams;
declare const generate: VoiceGenerateParams;
const sessionLanguage: typeof approved = realtime.language;
const generationLanguage: typeof approved = generate.language;
void sessionLanguage;
void generationLanguage;
