import { AddisAI } from "./client.js";

export default AddisAI;
export { AddisAI };
export type { ClientOptions } from "./client.js";

// Errors
export {
  AddisAIError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  GenerationInProgressError,
  IdempotencyConflictError,
  InsufficientCreditsError,
  InternalServerError,
  NotFoundError,
  NotSupportedError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "./core/errors.js";
export type { ErrorDetail } from "./core/errors.js";

// Request/runtime types
export type { LogLevel, RequestOptions } from "./core/request.js";
export { CursorPage } from "./core/pagination.js";

// Helpers
export { play } from "./lib/play.js";
export { fileFromPath } from "./core/uploads.js";
export type { FileInput, Uploadable } from "./core/uploads.js";
export { ulid } from "./core/idempotency.js";

// Clip & streaming
export { AddisClip } from "./lib/clip.js";
export type { ClipData, ClipMeta, ClipUsage } from "./lib/clip.js";
export { ChatStream } from "./lib/chat-stream.js";
export { AudioStream } from "./lib/audio-stream.js";

// Shared
export type {
  Language,
  OutputFormat,
  SttLanguage,
  TranslateLanguage,
} from "./resources/shared.js";

// Chat
export { ADDIS_CHAT_MODEL } from "./resources/chat.js";
export type {
  ChatAttachment,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionChoice,
  ChatCompletionCreateParams,
  ChatCompletionMessage,
  ChatRole,
  ChatUsage,
  FunctionTool,
  ToolCall,
  ToolChoice,
} from "./resources/chat.js";

// Voice
export type {
  ClipListParams,
  VoiceEstimate,
  VoiceEstimateParams,
  VoiceGenerateParams,
  VoiceSettings,
  VoiceUsage,
} from "./resources/voice.js";

// Voices
export type {
  VoiceCatalogEntry,
  VoiceListParams,
  VoicePreview,
} from "./resources/voices.js";

// Speech & Translate
export type { TranscribeParams, Transcription } from "./resources/speech.js";
export type { TranslateParams, Translation } from "./resources/translate.js";
export type { ConvertParams } from "./resources/text-to-speech.js";

// Legacy (deprecated)
export { LegacyAudio } from "./resources/legacy.js";
export type { LegacyAudioParams } from "./resources/legacy.js";
