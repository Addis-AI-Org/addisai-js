import { camelize } from "../core/camelize.js";
import { AddisAIError } from "../core/errors.js";
import { ulid } from "../core/idempotency.js";
import { type RequestOptions, type Transport, unwrapData } from "../core/request.js";
import { assertVoiceLanguage, type Language } from "./shared.js";

export interface RealtimeSessionParams {
  voiceId: string;
  language: Language;
  /** mp3 (default), or wav_mp3 for early WAV pieces followed by MP3 phrases. */
  audioFormat?: "mp3" | "wav_mp3";
  /** Cumulative text budget for the ephemeral client. Default and maximum 5000. */
  maxTextCharacters?: number;
}
export interface RealtimeSession {
  id: string;
  token: string;
  websocketUrl: string;
  expiresAt: number;
  sessionTtlSeconds: number;
  voiceId: string;
  language: Language;
  audioFormat: "mp3" | "wav_mp3";
  maxTextCharacters: number;
}
export type RealtimeEvent =
  | { type: "session.created"; session_id: string; voice_id: string; language: Language; audio_format: "mp3" | "wav_mp3"; max_text_characters: number }
  | { type: "speech.started"; request_id: string }
  | { type: "audio.delta"; request_id: string; sequence: number; format: "mp3" | "wav"; audio: string }
  | { type: "speech.completed" | "speech.cancelled"; request_id: string; data: Record<string, unknown>; idempotent_replay?: boolean }
  | { type: "error"; request_id?: string; status?: number; error: { code: string; message: string } }
  | { type: "text.appended"; characters: number }
  | { type: "pong" };
export type RealtimeInput =
  | { type: "speech.create"; text: string; request_id: string }
  | { type: "text.append"; text: string }
  | { type: "text.commit"; request_id: string }
  | { type: "speech.cancel" }
  | { type: "ping" };

export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export interface RealtimeConnectOptions {
  /** Inject a WebSocket constructor adapter for React Native or custom runtimes. */
  webSocketFactory?: (url: string) => RealtimeSocket;
  timeout?: number;
}

export class Realtime {
  constructor(private readonly transport: Transport) {}

  /** Call on your server; return only this scoped, one-use ticket to the browser. */
  async createSession(params: RealtimeSessionParams, opts: RequestOptions = {}): Promise<RealtimeSession> {
    assertVoiceLanguage(params.language);
    const data = unwrapData(await this.transport.request({ method: "POST", path: "/api/v1/realtime/sessions",
      body: { voice_id: params.voiceId, language: params.language, audio_format: params.audioFormat ?? "mp3",
        max_text_characters: params.maxTextCharacters ?? 5000 } }, { ...opts, maxRetries: opts.maxRetries ?? 0 }));
    return camelize<RealtimeSession>(data);
  }

  /** Server-side shortcut: create a ticket and open its socket. */
  async connect(params: RealtimeSessionParams, opts: RequestOptions & RealtimeConnectOptions = {}): Promise<RealtimeConnection> {
    return connectRealtime(await this.createSession(params, opts), opts);
  }
}

/** Browser-safe connection helper. Needs only a ticket returned by your server. */
export async function connectRealtime(session: RealtimeSession, options: RealtimeConnectOptions = {}): Promise<RealtimeConnection> {
  assertVoiceLanguage(session.language);
  const url = new URL(session.websocketUrl);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new AddisAIError("Realtime WebSocket URL must use wss without credentials or query parameters.");
  }
  let factory = options.webSocketFactory;
  if (!factory) {
    if (typeof globalThis.WebSocket !== "undefined") factory = (value) => new globalThis.WebSocket(value);
    else {
      const { default: WebSocket } = await import("ws");
      factory = (value) => new WebSocket(value) as unknown as RealtimeSocket;
    }
  }
  const connection = new RealtimeConnection(factory(url.toString()), session.token, options.timeout ?? 10_000);
  await connection.ready;
  return connection;
}

export class RealtimeConnection implements AsyncIterable<RealtimeEvent> {
  readonly ready: Promise<void>;
  /** Final clip and billing metadata from the latest completed speech. */
  lastCompletion: Record<string, unknown> | null = null;
  private queue: Array<{ event: RealtimeEvent; size: number }> = [];
  private queuedBytes = 0;
  private wake?: () => void;
  private ended = false;
  private failure?: Error;
  private reading = false;

  constructor(private readonly socket: RealtimeSocket, token: string, timeout: number) {
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    let authenticated = false;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timer = setTimeout(() => fail(new AddisAIError("Realtime authentication timed out.")), timeout);
    const fail = (err: Error) => {
      clearTimeout(timer);
      this.failure = err; this.ended = true;
      rejectReady(err); this.wake?.();
      socket.close(1000);
    };
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "session.authenticate", token })));
    socket.addEventListener("message", (message) => {
      try {
        const text = typeof message.data === "string" ? message.data : String(message.data);
        if (text.length > 3 * 1024 * 1024 || this.queuedBytes + text.length > 8 * 1024 * 1024) {
          fail(new AddisAIError("Realtime consumer is too slow. Consume events as they arrive.")); return;
        }
        const event = JSON.parse(text) as RealtimeEvent;
        if (!event || typeof event.type !== "string") throw new Error("Invalid event");
        if (event.type === "session.created") {
          authenticated = true; clearTimeout(timer); resolveReady();
        }
        if (event.type === "speech.completed" || event.type === "speech.cancelled") this.lastCompletion = event.data;
        this.queue.push({ event, size: text.length }); this.queuedBytes += text.length; this.wake?.();
      } catch { fail(new AddisAIError("Invalid realtime event.")); }
    });
    socket.addEventListener("error", () => fail(new AddisAIError("Realtime connection failed.")));
    socket.addEventListener("close", (event) => {
      clearTimeout(timer); this.ended = true;
      if (!authenticated) rejectReady(new AddisAIError("Realtime session was rejected or expired."));
      else if (event.code !== 1000) this.failure = new AddisAIError("Realtime connection interrupted. Recover with the same request_id in a new session.");
      this.wake?.();
    });
  }

  send(event: RealtimeInput): void {
    if (this.ended) throw this.failure ?? new AddisAIError("Realtime connection is closed.");
    this.socket.send(JSON.stringify(event));
  }
  append(text: string): void { this.send({ type: "text.append", text }); }
  commit(requestId = ulid()): string { this.send({ type: "text.commit", request_id: requestId }); return requestId; }
  cancel(): void { this.send({ type: "speech.cancel" }); }
  close(): void { this.socket.close(1000); }

  async *[Symbol.asyncIterator](): AsyncGenerator<RealtimeEvent> {
    if (this.reading) throw new AddisAIError("Only one realtime event consumer is allowed.");
    this.reading = true;
    try {
      while (true) {
        const item = this.queue.shift();
        if (item) { this.queuedBytes -= item.size; yield item.event; continue; }
        if (this.failure) throw this.failure;
        if (this.ended) return;
        await new Promise<void>((resolve) => { this.wake = resolve; });
        this.wake = undefined;
      }
    } finally { this.reading = false; }
  }

  /** One MP3 turn. Consume fully to receive the final wallet charge and clip. */
  async *speak(text: string, requestId = ulid()): AsyncGenerator<Uint8Array> {
    if (this.reading) throw new AddisAIError("Another consumer is reading realtime events.");
    this.send({ type: "speech.create", text, request_id: requestId });
    for await (const event of this) {
      if (event.type === "error" && (!event.request_id || event.request_id === requestId)) throw new AddisAIError(`${event.error.code}: ${event.error.message}`);
      if ("request_id" in event && event.request_id === requestId) {
        if (event.type === "audio.delta") {
          if (event.format !== "mp3") throw new AddisAIError("speak requires an mp3 session. Consume audio.delta events to play mixed WAV/MP3.");
          yield decodeRealtimeAudio(event);
        }
        if (event.type === "speech.completed" || event.type === "speech.cancelled") return;
      }
    }
    throw new AddisAIError("Realtime speech ended before completion.");
  }
}

export function decodeRealtimeAudio(event: Extract<RealtimeEvent, { type: "audio.delta" }>): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(event.audio, "base64"));
  return Uint8Array.from(atob(event.audio), (char) => char.charCodeAt(0));
}
