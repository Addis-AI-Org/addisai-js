import {
  API_KEY_ENV_VAR,
  detectRuntime,
  isBrowserLike,
  readEnv,
  resolveBaseURL,
} from "./core/env.js";
import { AddisAIError } from "./core/errors.js";
import { type FetchLike, type LogLevel, Transport } from "./core/request.js";
import { redactApiKey } from "./core/redact.js";
import { Chat } from "./resources/chat.js";
import { Voice } from "./resources/voice.js";
import { Voices } from "./resources/voices.js";
import { Speech } from "./resources/speech.js";
import { Translate } from "./resources/translate.js";
import { TextToSpeech } from "./resources/text-to-speech.js";
import { Legacy } from "./resources/legacy.js";

export interface ClientOptions {
  /** Addis AI API key. Defaults to `process.env.ADDIS_API_KEY`. */
  apiKey?: string;
  /** Override the API base URL. Defaults to the Addis AI Cloudflare endpoint. */
  baseURL?: string;
  /** Request timeout in milliseconds. Default 60000. */
  timeout?: number;
  /** Maximum automatic retries for transient failures. Default 2. */
  maxRetries?: number;
  /** Headers merged into every request. */
  defaultHeaders?: Record<string, string>;
  /** Query params merged into every request. */
  defaultQuery?: Record<string, string>;
  /** Inject a custom fetch implementation. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Allow running in a browser. API keys are secrets — keep this false. */
  dangerouslyAllowBrowser?: boolean;
  /** Logging verbosity. Secrets are never logged at any level. Default "warn". */
  logLevel?: LogLevel;
}

export class AddisAI {
  readonly chat: Chat;
  readonly voice: Voice;
  readonly voices: Voices;
  readonly speech: Speech;
  readonly translate: Translate;
  /** ElevenLabs-style alias over `voice.*` for developers migrating. */
  readonly textToSpeech: TextToSpeech;
  /** @deprecated Legacy endpoints retained for backward compatibility. Use `voice`. */
  readonly legacy: Legacy;

  /** @internal */
  readonly _transport: Transport;
  private readonly _apiKey: string;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv(API_KEY_ENV_VAR);
    if (!apiKey) {
      throw new AddisAIError(
        `Missing API key. Pass { apiKey } or set the ${API_KEY_ENV_VAR} environment variable.`,
      );
    }

    if (isBrowserLike() && !options.dangerouslyAllowBrowser) {
      throw new AddisAIError(
        "It looks like you're running in a browser. Exposing an Addis AI API key " +
          "in client-side code is a security risk. Call the SDK from your server, " +
          "or pass { dangerouslyAllowBrowser: true } if you understand the risk.",
      );
    }

    const resolvedFetch = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!resolvedFetch) {
      throw new AddisAIError(
        `No fetch implementation found in this runtime (${detectRuntime()}). ` +
          "Upgrade to Node 18+ or pass a custom fetch via { fetch }.",
      );
    }

    this._apiKey = apiKey;
    this._transport = new Transport({
      apiKey,
      baseURL: resolveBaseURL(options.baseURL),
      timeout: options.timeout ?? 60_000,
      maxRetries: options.maxRetries ?? 3,
      defaultHeaders: options.defaultHeaders ?? {},
      defaultQuery: options.defaultQuery ?? {},
      fetch: resolvedFetch,
      logLevel: options.logLevel ?? "warn",
    });

    this.chat = new Chat(this._transport);
    this.voice = new Voice(this._transport);
    this.voices = new Voices(this._transport);
    this.speech = new Speech(this._transport);
    this.translate = new Translate(this._transport);
    this.textToSpeech = new TextToSpeech(this.voice);
    this.legacy = new Legacy(this._transport);
  }

  /** Redacted representation; never exposes the API key. */
  toString(): string {
    return `AddisAI { apiKey: "${redactApiKey(this._apiKey)}" }`;
  }
}
