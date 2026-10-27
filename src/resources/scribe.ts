import { camelize } from "../core/camelize.js";
import { AddisAIError, APIConnectionError, APIError, makeAPIError } from "../core/errors.js";
import { ulid } from "../core/idempotency.js";
import { type RequestOptions, type Transport, unwrapData } from "../core/request.js";
import { toBlob, type Uploadable } from "../core/uploads.js";

const PATH = "/api/v1/scribe";
const MAX_EVENT = 512 * 1024;
/** Default live session limit; the server's session.created carries the real one. */
const LIVE_SECONDS = 900;
const POLL_MS = 5_000;
const POLL_LIMIT_MS = 3_600_000;
/** One-request upload limit (`/transcribe` and `jobs.upload`); larger files are declared and sent in parts. */
const MAX_UPLOAD = 95 * 1024 * 1024;
/** Longest a job is waited for by default: three hours of audio plus queueing. */
const JOB_WAIT_MS = 4 * 3_600_000;
const PART_ATTEMPTS = 3;
/** Inference backend; both bill the same character rate. */
export type ScribeBackend = "standard" | "turbo";
export type ScribeChunk = "320ms" | "1120ms";
/** Timestamp detail for completed uploads; `"word"` adds `words` and `segments`. */
export type ScribeTimestamps = "none" | "word";
/** One recognized word, in seconds from the start of the file. */
export interface ScribeWord {
  text: string; start: number; end: number;
  /** Speaker number (1-based, by first appearance); `null` if it could not be attributed. Present only with `speakers: true`. */
  speaker?: number | null;
}
/** One caption cue (single line of text), in seconds from the start of the file. */
export interface ScribeSegment {
  text: string; start: number; end: number;
  /** Speaker number (1-based, by first appearance) or `null`. Present only with `speakers: true`; `toSrt`/`toVtt` label cues with it. */
  speaker?: number | null;
}
export interface ScribeParams {
  /** Inference backend. Defaults to `"turbo"` (since 0.7.0): faster, many requests at once, same price per character. */
  backend?: ScribeBackend;
  /** Decoder chunk size. Defaults to `"1120ms"` for uploads and `"320ms"` for live sessions. */
  chunk?: ScribeChunk;
  /** Stable ID used for recovery and idempotency. Defaults to a new ULID. */
  requestId?: string;
}
export interface ScribeTranscribeParams extends ScribeParams {
  audio: Uploadable;
  /** Word timestamps and caption segments (`transcribe` only). Defaults to `"none"`; sent only when set. */
  timestamps?: ScribeTimestamps;
  /**
   * Speaker labels on words and segments (`transcribe` only). Defaults to `false`; sent as `speakers=true` only when true.
   * Turbo only: requires `backend: "turbo"`. Turns on word timestamps.
   */
  speakers?: boolean;
}
export interface ScribeUsage {
  recordId: string; characters: number; pricePer1000Characters: number;
  creditsUsed: number; creditsRemaining: number; currency: "ETB"; settled: true;
}
export interface ScribeTranscription {
  text: string; requestId: string; seconds: number; computeMs: number;
  backend: ScribeBackend; chunk: ScribeChunk; mode: "offline" | "live" | "upload_stream" | "job";
  model: string; usage: ScribeUsage; idempotentReplay?: boolean;
  /** Number of pieces a long file was cut into; present for jobs (`mode: "job"`). */
  chunks?: number;
  /** Word timings; present when transcribed with `timestamps: "word"`. */
  words?: ScribeWord[];
  /** Caption cues; present when transcribed with `timestamps: "word"`. Format with `toSrt`/`toVtt`. */
  segments?: ScribeSegment[];
  /** Number of distinct speakers; present when transcribed with `speakers: true`. */
  speakers?: number;
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
  /** Long-audio jobs (`transcribeLong`, `jobs`); absent when jobs are off. */
  jobs?: ScribeJobCapabilities;
}
export interface ScribeJobCapabilities {
  backends: ScribeBackend[];
  /** Largest declared upload (parts). */
  maxBytes: number;
  /** Longest decoded audio, in seconds. */
  maxSeconds: number;
  /** One-request size; above it, declare the job and send parts. */
  maxUploadBytes: number;
  partBytes: number; chunkSeconds: number; overlapSeconds: number;
  timestamps: ScribeTimestamps[]; formats: string[];
  defaults: { backend: ScribeBackend; chunk: ScribeChunk; timestamps: ScribeTimestamps; speakers: boolean };
}
export type ScribeJobState = "uploading" | "queued" | "processing" | "completed" | "failed";
/** A job's state, from `jobs.status`, every `jobs` call that does not return the result, and `onProgress`. */
export interface ScribeJobStatus {
  requestId: string; status: ScribeJobState;
  /** Upload state: part indexes stored so far, part count and part size (one part for a one-request job). */
  received?: number[]; parts?: number; partBytes?: number;
  /** Decoded length in seconds, once decoded; `null` before. */
  audioSeconds?: number | null;
  /** Audio transcribed so far, in seconds. */
  processedSeconds?: number;
  /** Pieces cut and finished, once the file is cut. */
  chunks?: { total: number; done: number };
  /** Where the result is read (`/requests/{id}`), once the upload is complete. */
  pollUrl?: string; jobUrl?: string;
  /** Why the job failed (nothing was charged); present when `status` is `"failed"`. */
  error?: { code: string; message: string };
  /**
   * Unix time at which an unfinished upload expires: 30 minutes after its last new part (or the declaration), moved
   * forward each time a new part is stored, and never more than 24 hours after the declaration. Status reads, a new
   * declaration and a resent part do not move it. Once it passes, the job is gone (`404 NOT_FOUND`), it no longer
   * counts toward the account's two long files, and its request ID is free again.
   */
  expiresAt?: number;
}
/** Receipt for one stored part. */
export interface ScribeJobPart { index: number; received: number[] }
/** `jobs.cancel`: what the cancel did. Nothing is charged for a cancelled job. */
export interface ScribeJobCancellation {
  requestId: string; status: "cancelled";
  /** The job's state when it was cancelled: an upload or a queued job is removed; a processing one is stopped. */
  was: "uploading" | "queued" | "processing";
  /** True when the request ID may be used again at once (a removed upload or queued job). */
  requestIdReusable: boolean;
}
/** `jobs.create`: declare a file to be sent in parts. */
export interface ScribeJobParams extends ScribeParams {
  /** Exact size of the file in bytes. */
  bytes: number;
  /** Defaults to `"word"` for jobs on the server; sent only when set. */
  timestamps?: ScribeTimestamps;
  /** Speaker labels over the whole file; sent only when true. */
  speakers?: boolean;
}
export interface ScribeJobWaitOptions {
  /** Called with each `queued`/`processing` answer while polling. */
  onProgress?: (progress: ScribeJobStatus) => void;
  /** Delay between polls when the server sends no `Retry-After`. Defaults to 5 seconds. */
  pollMs?: number;
  /** Give up waiting (the job keeps running; `recover` later). Defaults to four hours. */
  timeoutMs?: number;
}
export interface ScribeTranscribeLongParams extends ScribeTranscribeParams {
  /** Called with each `queued`/`processing` answer while the job runs. */
  onProgress?: (progress: ScribeJobStatus) => void;
}
export type ScribeEvent =
  | { type: "session.created"; requestId: string; backend: ScribeBackend; chunk: ScribeChunk; sampleRate: number; format: "pcm_s16le"; maxAudioSeconds: number }
  | { type: "transcript.partial"; text: string; requestId: string }
  | { type: "transcript.completed"; data: ScribeTranscription };

function parameters(params: ScribeParams, chunk: ScribeChunk) {
  const backend = params.backend ?? "turbo";
  const chosenChunk = params.chunk ?? chunk;
  const requestId = params.requestId ?? ulid();
  if (!["standard", "turbo"].includes(backend) || !["320ms", "1120ms"].includes(chosenChunk)) throw new AddisAIError("Invalid Scribe backend or chunk.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new AddisAIError("Scribe requestId must contain 1–128 letters, digits, underscores or hyphens.");
  return { backend, chunk: chosenChunk, request_id: requestId };
}
function timestampsQuery(value: ScribeTimestamps | undefined): { timestamps?: ScribeTimestamps } {
  if (value === undefined) return {};
  if (value !== "none" && value !== "word") throw new AddisAIError('Scribe timestamps must be "none" or "word".');
  return { timestamps: value };
}
function speakersQuery(params: Pick<ScribeTranscribeParams, "backend" | "speakers">): { speakers?: "true" } {
  const value = params.speakers;
  if (value === undefined || value === false) return {};
  if (value !== true) throw new AddisAIError("Scribe speakers must be true or false.");
  if ((params.backend ?? "turbo") !== "turbo") throw new AddisAIError('Scribe speaker labels are available on the turbo backend; pass backend: "turbo" with speakers: true.');
  return { speakers: "true" };
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
  /** Long audio as jobs: one request or parts, status and polling. `transcribeLong` does all of it in one call. */
  readonly jobs: ScribeJobs;
  constructor(private readonly transport: Transport) { this.jobs = new ScribeJobs(transport); }
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
  /**
   * Amharic file transcription; retries are disabled. Pass `timestamps: "word"` for words and caption segments,
   * or `speakers: true` with `backend: "turbo"` for speaker-labelled words and segments.
   */
  async transcribe(params: ScribeTranscribeParams, opts: RequestOptions = {}): Promise<ScribeTranscription> {
    const query = { ...parameters(params, "1120ms"), ...timestampsQuery(params.timestamps), ...speakersQuery(params) };
    const data = unwrapData(await this.transport.request({ method: "POST", path: `${PATH}/transcribe`, query: { ...query, stream: false }, form: audioForm(params.audio), timeoutFloor: 600_000 }, { ...opts, maxRetries: 0 }));
    return completion(await this.settled(data, opts));
  }
  /** A long upload answers 202 with `status: "processing"`; poll its request until it is done. */
  private async settled(data: any, opts: RequestOptions): Promise<unknown> {
    if (!inProgress(data)) return data;
    const deadline = Date.now() + POLL_LIMIT_MS;
    while (true) {
      await sleep(POLL_MS);
      try {
        const latest = unwrapData<any>(await this.transport.request({ method: "GET", path: `${PATH}/requests/${data.request_id}` }, { ...opts, maxRetries: 0 }));
        if (!inProgress(latest) || Date.now() > deadline) return latest;
      } catch (error) {
        if (!(error instanceof APIError) || error.code !== "IN_PROGRESS" || Date.now() > deadline) throw error;
      }
    }
  }
  /**
   * Amharic recordings up to three hours: one job, one transcript, one speaker numbering, one bill. A file of at most
   * 95 MiB goes up in one request; a larger one is declared and sent in parts (resuming the parts the server already
   * has). Then the job is polled every 5 seconds (honouring `Retry-After`), `onProgress` is called with each answer, and
   * the settled result is returned in the same shape as `transcribe`. Paid steps are never retried; a part is resent
   * up to three times after a connection error. Interrupted callers recover with `recover(requestId)`.
   *
   * Aborting `opts.signal` before the upload is complete cancels the job (`jobs.cancel`), so an abandoned upload does
   * not hold one of the account's long-file slots. Once the job is queued, aborting only stops the waiting: the job
   * runs on and its result is read later with `recover(requestId)` (or call `jobs.cancel` yourself).
   */
  async transcribeLong(params: ScribeTranscribeLongParams, opts: RequestOptions = {}): Promise<ScribeTranscription> {
    const { onProgress, ...rest } = params;
    const requestId = parameters(rest, "1120ms").request_id;
    speakersQuery(rest); timestampsQuery(rest.timestamps);
    const source = audioSource(rest.audio);
    const settings = { ...rest, requestId };
    try { await this.uploadLong(source, settings, opts); }
    catch (error) {
      // An aborted upload cancels its own job (best effort: it may not exist yet) and rethrows the abort.
      if (opts.signal?.aborted) await this.jobs.cancel(requestId, { ...opts, signal: undefined, maxRetries: 0 }).catch(() => undefined);
      throw error;
    }
    return this.jobs.wait(requestId, { onProgress }, opts);
  }
  private async uploadLong(source: ReturnType<typeof audioSource>, settings: ScribeTranscribeLongParams & { requestId: string }, opts: RequestOptions): Promise<void> {
    const requestId = settings.requestId;
    if (source.size <= MAX_UPLOAD) {
      await this.jobs.upload(settings, opts);
    } else {
      const job = await this.jobs.create({ ...settings, bytes: source.size }, opts);
      if (job.status === "uploading") {
        const partBytes = job.partBytes ?? 0; const parts = job.parts ?? 0;
        if (!(partBytes > 0) || !(parts > 0)) throw new AddisAIError("Scribe job declaration is missing part_bytes or parts.");
        const received = new Set(job.received ?? []);
        for (let index = 0; index < parts; index++) {
          if (received.has(index)) continue;
          const bytes = await source.slice(index * partBytes, Math.min((index + 1) * partBytes, source.size));
          for (let attempt = 1; ; attempt++) {
            try { await this.jobs.putPart(requestId, index, bytes, opts); break; }
            catch (error) {
              if (!(error instanceof APIConnectionError) || attempt >= PART_ATTEMPTS) throw error;
              await sleep(500 * 2 ** (attempt - 1));
            }
          }
        }
        await this.jobs.complete(requestId, opts);
      }
    }
  }
  /** Upload a file and iterate provisional text, followed by settled completion. */
  async stream(params: ScribeTranscribeParams, opts: RequestOptions = {}): Promise<ScribeTranscriptStream> {
    if (params.speakers === true) throw new AddisAIError('Scribe speaker labels are available only for completed uploads; use transcribe() with backend: "turbo" and speakers: true instead of stream().');
    if (timestampsQuery(params.timestamps).timestamps === "word") throw new AddisAIError('Scribe timestamps are available only for completed uploads; use transcribe() with timestamps: "word" instead of stream().');
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
function audioForm(input: Uploadable, tooLarge = "Scribe audio must contain 1 byte to 95 MiB."): FormData {
  const { blob, filename } = toBlob(input, "audio/wav");
  if (!blob.size || blob.size > MAX_UPLOAD) throw new AddisAIError(tooLarge);
  const form = new FormData(); form.append("audio", blob, filename); return form;
}
function inProgress(data: any): boolean { return data?.status === "queued" || data?.status === "processing"; }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
/** The file's size and a way to read byte ranges of it: `Blob.slice` for Blobs, `subarray` for byte arrays. */
function audioSource(input: Uploadable): { size: number; slice: (start: number, end: number) => Promise<Uint8Array> } {
  const data = typeof input === "object" && input !== null && "data" in input && !(input instanceof Blob) ? input.data : input;
  if (data instanceof Blob) return { size: data.size, slice: async (start, end) => new Uint8Array(await data.slice(start, end).arrayBuffer()) };
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return { size: bytes.byteLength, slice: async (start, end) => bytes.subarray(start, end) };
}

/**
 * Long audio (up to three hours) as jobs. Every paid call (`upload`, `create`, `putPart`, `complete`) is sent once;
 * `status` and `wait` are free reads. Keep one `requestId` across every call of a job.
 */
export class ScribeJobs {
  constructor(private readonly transport: Transport) {}
  /** Create a job with the whole file in one request (at most 95 MiB); the job starts at once. */
  async upload(params: ScribeTranscribeParams, opts: RequestOptions = {}): Promise<ScribeJobStatus> {
    const query = { ...parameters(params, "1120ms"), ...timestampsQuery(params.timestamps), ...speakersQuery(params) };
    const form = audioForm(params.audio, "Scribe jobs.upload takes 1 byte to 95 MiB in one request; declare a larger file with jobs.create and send parts.");
    return camelize(unwrapData(await this.transport.request({ method: "POST", path: `${PATH}/jobs`, query, form, timeoutFloor: 600_000 }, { ...opts, maxRetries: 0 })));
  }
  /**
   * Declare a file of `bytes` bytes to be sent with `putPart`; the answer carries `partBytes`, `parts`, the parts already
   * `received` and `expiresAt`. An upload with no new part for 30 minutes expires; declare it again to start over.
   */
  async create(params: ScribeJobParams, opts: RequestOptions = {}): Promise<ScribeJobStatus> {
    const { bytes } = params;
    if (!Number.isInteger(bytes) || bytes < 1) throw new AddisAIError("Scribe jobs.create needs the file size in bytes (a positive integer).");
    const speakers = speakersQuery(params).speakers ? { speakers: true } : {};
    const body = { ...parameters(params, "1120ms"), bytes, ...timestampsQuery(params.timestamps), ...speakers };
    return camelize(unwrapData(await this.transport.request({ method: "POST", path: `${PATH}/jobs`, body }, { ...opts, maxRetries: 0 })));
  }
  /**
   * Send part `index`: bytes `[index × partBytes, …)` of the file; every part but the last is exactly `partBytes` long.
   * After `complete`, or for a job made with `upload`, the job takes no more parts: `409 UPLOAD_CLOSED`.
   */
  async putPart(requestId: string, index: number, bytes: Uint8Array, opts: RequestOptions = {}): Promise<ScribeJobPart> {
    parameters({ requestId }, "1120ms");
    if (!Number.isInteger(index) || index < 0) throw new AddisAIError("Scribe part index must be a non-negative integer.");
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new AddisAIError("Scribe part bytes must be a non-empty Uint8Array.");
    return camelize(unwrapData(await this.transport.request({ method: "PUT", path: `${PATH}/jobs/${requestId}/parts/${index}`, bytes, timeoutFloor: 600_000 }, { ...opts, maxRetries: 0 })));
  }
  /** Start the job once every part is there (`409 UPLOAD_INCOMPLETE` otherwise); returns its state, or the result when it is already done. */
  async complete(requestId: string, opts: RequestOptions = {}): Promise<ScribeJobStatus | ScribeTranscription> {
    parameters({ requestId }, "1120ms");
    return camelize(unwrapData(await this.transport.request({ method: "POST", path: `${PATH}/jobs/${requestId}/complete` }, { ...opts, maxRetries: 0 })));
  }
  /**
   * Cancel a job; nothing is charged. An upload or a queued job is removed and its request ID is free again; a
   * processing job is stopped and ends failed with `REQUEST_CANCELLED` (its request ID stays used). A finished job
   * throws `409 JOB_FINISHED`; an unknown one `404 NOT_FOUND`.
   */
  async cancel(requestId: string, opts: RequestOptions = {}): Promise<ScribeJobCancellation> {
    parameters({ requestId }, "1120ms");
    return camelize(unwrapData(await this.transport.request({ method: "DELETE", path: `${PATH}/jobs/${requestId}` }, opts)));
  }
  /** The job's state and progress. */
  async status(requestId: string, opts: RequestOptions = {}): Promise<ScribeJobStatus> {
    parameters({ requestId }, "1120ms");
    return camelize(unwrapData(await this.transport.request({ method: "GET", path: `${PATH}/jobs/${requestId}` }, opts)));
  }
  /**
   * Poll the job's result until it is settled. Each `queued`/`processing` answer goes to `onProgress`, then the SDK
   * sleeps `Retry-After` seconds (or `pollMs`). A failed job throws its own API error; nothing was charged.
   */
  async wait(requestId: string, { onProgress, pollMs = POLL_MS, timeoutMs = JOB_WAIT_MS }: ScribeJobWaitOptions = {}, opts: RequestOptions = {}): Promise<ScribeTranscription> {
    parameters({ requestId }, "1120ms");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const response = await this.transport.request<Response>({ method: "GET", path: `${PATH}/requests/${requestId}`, raw: true }, { ...opts, maxRetries: 0 });
      let body: unknown;
      try { body = await response.json(); } catch { throw new AddisAIError("Invalid Scribe JSON response."); }
      const data = unwrapData<any>(body);
      if (response.status !== 202 && !inProgress(data)) return completion(data);
      onProgress?.(camelize<ScribeJobStatus>(data));
      if (Date.now() > deadline) throw new AddisAIError(`Scribe job ${requestId} is still running after ${Math.round(timeoutMs / 1000)} seconds. Recover the same requestId later.`);
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : pollMs);
    }
  }
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
  private maxAudioSeconds?: number;
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
        if (event.type === "session.created") { this.admitted = true; this.maxAudioSeconds = event.maxAudioSeconds; clearTimeout(timer); resolve(); }
        if (event.type === "transcript.completed") { this.completion = event.data; this.ended = true; clearTimeout(timer); resolve(); }
        this.queue.push({ event, size: text.length }); this.queuedBytes += text.length; this.wake?.();
      } catch (error) { fail(error instanceof Error ? error : new AddisAIError("Invalid Scribe event.")); }
    });
  }
  /** Send raw mono PCM16 little-endian at 16 kHz; a 100 ms frame contains 3,200 bytes. */
  sendAudio(audio: Uint8Array): void {
    if (!this.admitted || this.finishing || this.ended) throw new AddisAIError("Scribe session is not accepting audio.");
    const limit = this.maxAudioSeconds ?? LIVE_SECONDS;
    if (!audio.length || audio.length % 2 || audio.length > 64000 || this.audioBytes + audio.length > limit * 32000) throw new AddisAIError(`Scribe needs PCM16 frames up to two seconds and ${limit} seconds total.`);
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
