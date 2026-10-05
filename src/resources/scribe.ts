import { camelize } from "../core/camelize.js";
import { AddisAIError, makeAPIError } from "../core/errors.js";
import { ulid } from "../core/idempotency.js";
import { type RequestOptions, type Transport, unwrapData } from "../core/request.js";
import { toBlob, type Uploadable } from "../core/uploads.js";

const PATH = "/api/v1/scribe";
const MAX_EVENT = 512 * 1024;
export type ScribeBackend = "cpu" | "gpu";
export type ScribeChunk = "320ms" | "1120ms";
export interface ScribeParams { backend?: ScribeBackend; chunk?: ScribeChunk; requestId?: string }
export interface ScribeTranscribeParams extends ScribeParams { audio: Uploadable }
export interface ScribeUsage {
  recordId: string; characters: number; pricePer1000Characters: number;
  creditsUsed: number; creditsRemaining: number; currency: "ETB"; settled: true;
}
export interface ScribeTranscription {
  text: string; requestId: string; seconds: number; computeMs: number;
  backend: ScribeBackend; chunk: ScribeChunk; mode: "offline" | "live" | "upload_stream";
  model: string; usage: ScribeUsage; idempotentReplay?: boolean;
}
export interface ScribeSession {
  token: string; expiresAt: number; websocketUrl: string; maxAudioSeconds: number;
  requestId: string; backend: ScribeBackend; chunk: ScribeChunk;
}
export interface ScribeAccountUsage {
  balance: number; currency: "ETB";
  pricing: { unit: "character"; pricePer1000Characters: number };
}
export interface ScribeCapabilities {
  model: string; language: "am"; backends: ScribeBackend[]; transports: string[];
  sampleRate: number; format: "pcm_s16le"; maxAudioSeconds: number;
  maxUploadBytes: number; websocketUrl: string;
  chunks?: ScribeChunk[]; defaults?: { backend: ScribeBackend; httpChunk: ScribeChunk; websocketChunk: ScribeChunk };
  ticketTtlSeconds?: number; resultRetentionSeconds?: number;
  billing?: { unit: "character"; characterEncoding: "utf-16"; rateEndpoint: string; partialsBillable: false };
}
export type ScribeEvent =
  | { type: "session.created"; requestId: string; backend: ScribeBackend; chunk: ScribeChunk; sampleRate: number; format: "pcm_s16le"; maxAudioSeconds: number }
  | { type: "transcript.partial"; text: string; requestId: string }
  | { type: "transcript.completed"; data: ScribeTranscription };

function parameters(params: ScribeParams, chunk: ScribeChunk) {
  const backend = params.backend ?? "cpu";
  const chosenChunk = params.chunk ?? chunk;
  const requestId = params.requestId ?? ulid();
  if (!["cpu", "gpu"].includes(backend) || !["320ms", "1120ms"].includes(chosenChunk)) throw new AddisAIError("Invalid Scribe backend or chunk.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new AddisAIError("Scribe requestId must contain 1–128 letters, digits, underscores or hyphens.");
  return { backend, chunk: chosenChunk, request_id: requestId };
}
function completion(value: unknown): ScribeTranscription {
  const data = camelize<ScribeTranscription>(value);
  if (typeof data?.text !== "string" || data.usage?.settled !== true) throw new AddisAIError("Scribe ended without settled billing. Recover the same requestId before retrying.");
  return data;
}
function eventFrom(value: unknown): ScribeEvent {
  const event = camelize<any>(value);
  if (event?.type === "error") throw makeAPIError(event.status ?? 503, event, "", {});
  if (event?.type === "transcript.completed") return { type: event.type, data: completion(event.data) };
  if (event?.type === "transcript.partial" && typeof event.text === "string") return event;
  if (event?.type === "session.created" && event.sampleRate === 16000 && event.format === "pcm_s16le") return event;
  throw new AddisAIError("Invalid Scribe event.");
}
function parseEvent(text: string): ScribeEvent {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AddisAIError("Invalid Scribe JSON event."); }
  return eventFrom(value);
}

export class Scribe {
  constructor(private readonly transport: Transport) {}
  async capabilities(opts: RequestOptions = {}): Promise<ScribeCapabilities> {
    return camelize(unwrapData(await this.transport.request({ method: "GET", path: PATH }, opts)));
  }
  async usage(opts: RequestOptions = {}): Promise<ScribeAccountUsage> {
    return camelize(unwrapData(await this.transport.request({ method: "GET", path: `${PATH}/usage` }, opts)));
  }
  async recover(requestId: string, opts: RequestOptions = {}): Promise<ScribeTranscription> {
    parameters({ requestId }, "1120ms");
    return completion(unwrapData(await this.transport.request({ method: "GET", path: `${PATH}/requests/${requestId}` }, { ...opts, maxRetries: 0 })));
  }
  /** Amharic file transcription; retries are disabled. Recover requestId after interruptions. */
  async transcribe(params: ScribeTranscribeParams, opts: RequestOptions = {}): Promise<ScribeTranscription> {
    const query = parameters(params, "1120ms");
    return completion(unwrapData(await this.transport.request({ method: "POST", path: `${PATH}/transcribe`, query: { ...query, stream: false }, form: audioForm(params.audio), timeoutFloor: 600_000 }, { ...opts, maxRetries: 0 })));
  }
  /** Upload a file and iterate provisional text, followed by settled completion. */
  async stream(params: ScribeTranscribeParams, opts: RequestOptions = {}): Promise<ScribeTranscriptStream> {
    const query = parameters(params, "1120ms");
    const { response, controller } = await this.transport.openStream({ method: "POST", path: `${PATH}/transcribe`, query: { ...query, stream: true }, form: audioForm(params.audio) }, { timeout: 600_000, ...opts });
    return new ScribeTranscriptStream(response, controller, query.request_id);
  }
  /** Create a one-use ticket on your server; return only the ticket to a browser. */
  async createSession(params: ScribeParams = {}, opts: RequestOptions = {}): Promise<ScribeSession> {
    return camelize(unwrapData(await this.transport.request({ method: "POST", path: `${PATH}/sessions`, body: parameters(params, "320ms") }, { ...opts, maxRetries: 0 })));
  }
  async connect(params: ScribeParams = {}, opts: RequestOptions & ScribeConnectOptions = {}): Promise<ScribeConnection> {
    return connectScribe(await this.createSession(params, opts), opts);
  }
}
function audioForm(input: Uploadable): FormData {
  const { blob, filename } = toBlob(input, "audio/wav");
  if (!blob.size || blob.size > 25 * 1024 * 1024) throw new AddisAIError("Scribe audio must contain 1 byte to 25 MiB.");
  const form = new FormData(); form.append("audio", blob, filename); return form;
}

export class ScribeTranscriptStream implements AsyncIterable<ScribeEvent> {
  completion: ScribeTranscription | null = null;
  private consumed = false;
  constructor(private response: Response, private controller: AbortController, readonly requestId: string) {}
  /** Stops reading. Accepted audio can still be transcribed and billed; use recover(). */
  close(): void { this.controller.abort(); }
  async read(): Promise<ScribeTranscription> { for await (const _event of this) { /* consume */ } return this.completion!; }
  async *[Symbol.asyncIterator](): AsyncIterator<ScribeEvent> {
    if (this.consumed) throw new AddisAIError("A Scribe stream can only be consumed once.");
    this.consumed = true;
    if (this.response.headers.get("content-type")?.includes("application/json")) {
      this.completion = completion(unwrapData(await this.response.json()));
      yield { type: "transcript.completed", data: this.completion }; return;
    }
    if (!this.response.body) throw new AddisAIError("Missing Scribe response stream.");
    const reader = this.response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true }); let pending = "";
    try {
      while (true) {
        const { value, done } = await reader.read(); pending += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line.length > MAX_EVENT) throw new AddisAIError("Scribe event exceeds the limit.");
          if (!line.trim()) continue;
          const event = parseEvent(line);
          if (event.type === "transcript.completed") this.completion = event.data;
          yield event;
          if (this.completion) return;
        }
        if (pending.length > MAX_EVENT) throw new AddisAIError("Scribe event exceeds the limit.");
        if (done) break;
      }
      if (pending.trim()) {
        const event = parseEvent(pending); if (event.type === "transcript.completed") this.completion = event.data; yield event;
      }
      if (!this.completion) throw new AddisAIError("Scribe ended before billing confirmation. Recover the same requestId.");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); this.close(); }
  }
}

export interface ScribeSocket {
  send(data: string | Uint8Array): void; close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  readonly bufferedAmount?: number;
}
export interface ScribeConnectOptions { webSocketFactory?: (url: string) => ScribeSocket; timeout?: number }
/** Browser-safe helper using a scoped ticket. Sends no account credentials to the socket. */
export async function connectScribe(session: ScribeSession, options: ScribeConnectOptions = {}): Promise<ScribeConnection> {
  const url = new URL(session.websocketUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== `${PATH}/stream` ||
      (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new AddisAIError("Scribe WebSocket URL must use wss without credentials or query parameters.");
  let factory = options.webSocketFactory;
  if (!factory) {
    if (globalThis.WebSocket) factory = value => new globalThis.WebSocket(value);
    else { const { default: WebSocket } = await import("ws"); factory = value => new WebSocket(value) as unknown as ScribeSocket; }
  }
  const connection = new ScribeConnection(factory(url.toString()), session, options.timeout ?? 10_000);
  await connection.ready; return connection;
}
export class ScribeConnection implements AsyncIterable<ScribeEvent> {
  readonly ready: Promise<void>;
  readonly requestId: string;
  completion: ScribeTranscription | null = null;
  private queue: Array<{ event: ScribeEvent; size: number }> = [];
  private queuedBytes = 0; private audioBytes = 0; private finishing = false; private ended = false; private reading = false;
  private failure?: Error; private wake?: () => void; private admitted = false;
  constructor(private socket: ScribeSocket, session: ScribeSession, timeout: number) {
    this.requestId = session.requestId;
    let resolve!: () => void; let reject!: (error: Error) => void;
    this.ready = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => fail(new AddisAIError("Scribe authentication timed out.")), timeout);
    const fail = (error: Error) => { if (this.ended) return; clearTimeout(timer); this.failure = error; this.ended = true; reject(error); this.wake?.(); socket.close(); };
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "session.authenticate", token: session.token })));
    socket.addEventListener("error", () => fail(new AddisAIError("Scribe connection failed. Recover the same requestId.")));
    socket.addEventListener("close", () => { if (!this.ended) fail(new AddisAIError("Scribe closed before billing confirmation. Recover the same requestId.")); });
    socket.addEventListener("message", message => {
      if (this.ended) return;
      try {
        const text = String(message.data); if (text.length > MAX_EVENT) throw new AddisAIError("Scribe event exceeds the limit.");
        const event = parseEvent(text);
        if (this.queue.length >= 512 || this.queuedBytes + text.length > 1024 * 1024) throw new AddisAIError("Scribe consumer cannot keep up with transcript events.");
        if (event.type === "session.created") { this.admitted = true; clearTimeout(timer); resolve(); }
        if (event.type === "transcript.completed") { this.completion = event.data; this.ended = true; clearTimeout(timer); resolve(); }
        this.queue.push({ event, size: text.length }); this.queuedBytes += text.length; this.wake?.();
      } catch (error) { fail(error instanceof Error ? error : new AddisAIError("Invalid Scribe event.")); }
    });
  }
  /** Send raw mono PCM16 little-endian at 16 kHz; a 100 ms frame contains 3,200 bytes. */
  sendAudio(audio: Uint8Array): void {
    if (!this.admitted || this.finishing || this.ended) throw new AddisAIError("Scribe session is not accepting audio.");
    if (!audio.length || audio.length % 2 || audio.length > 64000 || this.audioBytes + audio.length > 180 * 32000) throw new AddisAIError("Scribe needs PCM16 frames up to two seconds and 180 seconds total.");
    if ((this.socket.bufferedAmount ?? 0) > 256000) throw new AddisAIError("Scribe socket cannot keep up with audio. Recover accepted audio before retrying.");
    this.socket.send(audio); this.audioBytes += audio.length;
  }
  finish(): void { if (!this.finishing && !this.ended) { this.socket.send(JSON.stringify({ type: "audio.finish" })); this.finishing = true; } }
  /** Closing after sending audio still permits settlement on the server. */
  close(): void { this.ended = true; this.wake?.(); this.socket.close(); }
  async *[Symbol.asyncIterator](): AsyncIterator<ScribeEvent> {
    if (this.reading) throw new AddisAIError("Only one Scribe event consumer is allowed."); this.reading = true;
    try {
      while (true) {
        if (this.failure) throw this.failure;
        const item = this.queue.shift();
        if (item) { this.queuedBytes -= item.size; yield item.event; continue; }
        if (this.ended) { if (!this.completion) throw new AddisAIError("Scribe ended before billing confirmation. Recover the same requestId."); return; }
        await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined;
      }
    } finally { this.reading = false; }
  }
}
