import { camelize } from "../core/camelize.js";
import { AddisAIError } from "../core/errors.js";
import { ulid } from "../core/idempotency.js";
import { CursorPage, CursorPagePromise, type Page } from "../core/pagination.js";
import type { RequestOptions, Transport } from "../core/request.js";
import type { Files } from "./files.js";
import type { OutputFormat } from "./shared.js";
import type { VoiceSettings } from "./voice.js";

export type BatchEndpoint = "/v1/voice/generations" | "/v1/scribe/transcribe";

export type BatchStatus =
  | "validating"
  | "queued"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

const TERMINAL: ReadonlySet<BatchStatus> = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

export interface Batch {
  id: string;
  object: "batch";
  endpoint: BatchEndpoint;
  inputFileId: string;
  completionWindow: "24h";
  status: BatchStatus;
  statusReason: string | null;
  outputFileId: string | null;
  errorFileId: string | null;
  createdAt: string;
  validatedAt: string | null;
  inProgressAt: string | null;
  finalizingAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  expiredAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
  requestCounts: {
    total: number;
    succeeded: number;
    failed: number;
    expired: number;
    cancelled: number;
    pending: number;
  };
  pricing: {
    tier: "batch";
    currency: string;
    unit: string;
    unitPrice: number;
    listUnitPrice: number;
  };
  estimatedCost: number;
  chargedCost: number;
  /** Your own key/value strings, returned exactly as sent. */
  metadata: Record<string, string>;
}

export interface BatchCreateParams {
  inputFileId: string;
  /** Default "/v1/voice/generations". */
  endpoint?: BatchEndpoint;
  /** Only "24h" is supported. */
  completionWindow?: "24h";
  metadata?: Record<string, string>;
}

/** One text to speech request in a batch: the Voice Lab generation body. */
export interface BatchSpeechRequest {
  customId: string;
  text: string;
  voiceId: string;
  language: string;
  /** Default "mp3_44100". */
  outputFormat?: OutputFormat;
  voiceSettings?: Pick<VoiceSettings, "speed">;
}

export interface BatchCreateFromRequestsParams {
  requests: BatchSpeechRequest[];
  metadata?: Record<string, string>;
  /** Name of the uploaded input file. Default "batch.jsonl". */
  filename?: string;
}

export interface BatchListParams {
  limit?: number;
  after?: string;
}

export type BatchRequestStatus =
  | "queued"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export interface BatchRequestRecord {
  customId: string | null;
  line: number;
  status: BatchRequestStatus;
  error: { code: string; message: string } | null;
  result: BatchSpeechResult | null;
  cost: number | null;
}

export interface BatchSpeechResult {
  audioFileId: string;
  contentType: string;
  durationSeconds: number;
  billableSeconds: number;
  cost: number;
  currency: string;
}

/** One line of a batch's results or errors file. */
export interface BatchResult {
  customId: string | null;
  line: number;
  status: "succeeded" | "failed" | "expired" | "cancelled";
  response?: BatchSpeechResult;
  error?: { code: string; message: string };
}

export interface BatchWaitOptions extends RequestOptions {
  /** Poll interval. Default 30 s; at least 5 s. */
  pollIntervalMs?: number;
  /** Give up after this long. Default: no limit (batches end within 24 h). */
  waitTimeoutMs?: number;
}

export class Batches {
  constructor(
    private readonly transport: Transport,
    private readonly files: Files,
  ) {}

  /**
   * Create a batch from an uploaded JSONL file. An idempotency key is generated
   * when you do not pass one, and reused across automatic retries, so a retry
   * never creates a second batch.
   */
  async create(params: BatchCreateParams, opts: RequestOptions = {}): Promise<Batch> {
    const body = await this.transport.request<Record<string, unknown>>(
      {
        method: "POST",
        path: "/api/v1/batches",
        body: {
          input_file_id: params.inputFileId,
          endpoint: params.endpoint ?? "/v1/voice/generations",
          completion_window: params.completionWindow ?? "24h",
          metadata: params.metadata ?? {},
        },
      },
      { ...opts, idempotencyKey: opts.idempotencyKey ?? ulid() },
    );
    return toBatch(body);
  }

  /** Write the requests as JSONL, upload them, and create the batch. */
  async createFromRequests(
    params: BatchCreateFromRequestsParams,
    opts: RequestOptions = {},
  ): Promise<Batch> {
    if (params.requests.length === 0) {
      throw new AddisAIError("A batch needs at least one request.");
    }
    const jsonl = toBatchJsonl(params.requests);
    const file = await this.files.upload(
      { data: new TextEncoder().encode(jsonl), filename: params.filename ?? "batch.jsonl", contentType: "application/jsonl" },
      {},
      opts,
    );
    return this.create({ inputFileId: file.id, metadata: params.metadata }, opts);
  }

  async retrieve(batchId: string, opts: RequestOptions = {}): Promise<Batch> {
    const body = await this.transport.request<Record<string, unknown>>(
      { method: "GET", path: `/api/v1/batches/${encodeURIComponent(batchId)}` },
      opts,
    );
    return toBatch(body);
  }

  /** Newest first. Awaitable for one page, or `for await` across all pages. */
  list(params: BatchListParams = {}, opts: RequestOptions = {}): CursorPagePromise<Batch> {
    const fetchPage = async (after?: string): Promise<Page<Batch>> => {
      const body = await this.transport.request<{
        data?: Record<string, unknown>[];
        has_more?: boolean;
        last_id?: string | null;
      }>(
        { method: "GET", path: "/api/v1/batches", query: { limit: params.limit, after } },
        opts,
      );
      return {
        data: (body.data ?? []).map(toBatch),
        nextCursor: body.has_more ? (body.last_id ?? null) : null,
        limit: params.limit ?? null,
      };
    };
    return new CursorPagePromise(async () => {
      const first = await fetchPage(params.after);
      return new CursorPage(first, (cursor) => fetchPage(cursor));
    });
  }

  /** Queued requests stop; running ones finish and are billed. */
  async cancel(batchId: string, opts: RequestOptions = {}): Promise<Batch> {
    const body = await this.transport.request<Record<string, unknown>>(
      { method: "POST", path: `/api/v1/batches/${encodeURIComponent(batchId)}/cancel` },
      opts,
    );
    return toBatch(body);
  }

  /** Per-request status, ordered by input line. */
  requests(
    batchId: string,
    params: { status?: BatchRequestStatus; limit?: number } = {},
    opts: RequestOptions = {},
  ): CursorPagePromise<BatchRequestRecord> {
    const fetchPage = async (after?: string): Promise<Page<BatchRequestRecord>> => {
      const body = await this.transport.request<{
        data?: Record<string, unknown>[];
        has_more?: boolean;
      }>(
        {
          method: "GET",
          path: `/api/v1/batches/${encodeURIComponent(batchId)}/requests`,
          query: { status: params.status, limit: params.limit, after },
        },
        opts,
      );
      const data = camelize<BatchRequestRecord[]>(body.data ?? []);
      const last = data.at(-1);
      return {
        data,
        nextCursor: body.has_more && last ? String(last.line) : null,
        limit: params.limit ?? null,
      };
    };
    return new CursorPagePromise(async () => {
      const first = await fetchPage();
      return new CursorPage(first, (cursor) => fetchPage(cursor));
    });
  }

  /**
   * Every result line (successes, then failures), parsed. Empty until the
   * batch has finished and written its files.
   */
  async *results(batchId: string, opts: RequestOptions = {}): AsyncGenerator<BatchResult> {
    const batch = await this.retrieve(batchId, opts);
    for (const fileId of [batch.outputFileId, batch.errorFileId]) {
      if (!fileId) continue;
      const text = new TextDecoder().decode(await this.files.content(fileId, opts));
      for (const line of text.split("\n")) {
        if (line.trim()) yield camelize<BatchResult>(JSON.parse(line));
      }
    }
  }

  /** Poll until the batch is completed, failed, expired or cancelled. */
  async waitFor(batchId: string, options: BatchWaitOptions = {}): Promise<Batch> {
    const { pollIntervalMs = 30_000, waitTimeoutMs, ...opts } = options;
    const interval = Math.max(pollIntervalMs, 5_000);
    const deadline = waitTimeoutMs ? Date.now() + waitTimeoutMs : Infinity;
    while (true) {
      const batch = await this.retrieve(batchId, opts);
      if (TERMINAL.has(batch.status)) return batch;
      if (Date.now() + interval > deadline) {
        throw new AddisAIError(`Batch ${batchId} is still ${batch.status}.`);
      }
      await sleep(interval, opts.signal);
    }
  }
}

/** JSONL body for a text to speech batch (one request per line). */
export function toBatchJsonl(requests: BatchSpeechRequest[]): string {
  const seen = new Set<string>();
  return (
    requests
      .map((request) => {
        if (seen.has(request.customId)) {
          throw new AddisAIError(`customId "${request.customId}" is used twice.`);
        }
        seen.add(request.customId);
        return JSON.stringify({
          custom_id: request.customId,
          body: {
            text: request.text,
            voice_id: request.voiceId,
            language: request.language,
            output_format: request.outputFormat ?? "mp3_44100",
            ...(request.voiceSettings ? { voice_settings: request.voiceSettings } : {}),
          },
        });
      })
      .join("\n") + "\n"
  );
}

function toBatch(raw: Record<string, unknown>): Batch {
  const { metadata, ...rest } = raw;
  // metadata keys are the caller's own: keep them exactly as sent.
  return { ...camelize<Omit<Batch, "metadata">>(rest), metadata: (metadata ?? {}) as Record<string, string> };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
