// Core HTTP transport: header assembly, serialization, timeout, abort,
// automatic retries with backoff, and error normalization.

import { VERSION } from "../version.js";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  makeAPIError,
} from "./errors.js";
import { detectRuntime } from "./env.js";

export type FetchLike = typeof fetch;

export interface TransportConfig {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
  defaultHeaders: Record<string, string>;
  defaultQuery: Record<string, string>;
  fetch: FetchLike;
  logLevel: LogLevel;
}

export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

/** Per-request options accepted by every resource method. */
export interface RequestOptions {
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
}

export interface InternalRequest {
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH" | "HEAD";
  path: string;
  query?: Record<string, unknown>;
  /** JSON body (mutually exclusive with `form`). */
  body?: unknown;
  /** multipart/form-data body (mutually exclusive with `body`). */
  form?: FormData;
  /** Return the raw Response (for streaming or binary) instead of parsed JSON. */
  raw?: boolean;
  /** Minimum effective timeout in ms (e.g. paid synthesis budget). */
  timeoutFloor?: number;
}

const LOG_ORDER: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export class Transport {
  constructor(private readonly config: TransportConfig) {}

  /** The configured fetch implementation, for direct asset downloads. */
  get fetch(): FetchLike {
    return this.config.fetch;
  }

  private log(level: Exclude<LogLevel, "off">, ...args: unknown[]): void {
    if (LOG_ORDER[this.config.logLevel] >= LOG_ORDER[level]) {
      // eslint-disable-next-line no-console
      (console as any)[level === "debug" ? "log" : level]("[addisai]", ...args);
    }
  }

  private buildURL(path: string, query?: Record<string, unknown>): string {
    const url = new URL(this.config.baseURL + path);
    const merged = { ...this.config.defaultQuery, ...(query ?? {}) };
    for (const [key, value] of Object.entries(merged)) {
      if (value == null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private buildHeaders(req: InternalRequest, opts: RequestOptions): Headers {
    const headers = new Headers();
    headers.set("Accept", "application/json");
    headers.set("User-Agent", `addisai-node/${VERSION} (${detectRuntime()})`);
    headers.set("X-Addis-Client", `addisai-node/${VERSION}`);
    // Auth: API keys go in x-api-key. A Supabase JWT goes in Authorization.
    // Never send both — the voice function rejects a non-JWT bearer token.
    if (looksLikeJwt(this.config.apiKey)) {
      headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    } else {
      headers.set("x-api-key", this.config.apiKey);
    }

    for (const [k, v] of Object.entries(this.config.defaultHeaders)) headers.set(k, v);
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

    if (opts.idempotencyKey) headers.set("Idempotency-Key", opts.idempotencyKey);
    if (req.body !== undefined && !req.form) headers.set("Content-Type", "application/json");
    return headers;
  }

  private isRetryable(status: number, headers: Headers): boolean {
    if (status === 408 || status === 425 || status === 429) return true;
    // 409 is only retried when the server tells us to (GENERATION_IN_PROGRESS),
    // never for IDEMPOTENCY_CONFLICT.
    if (status === 409) return headers.has("retry-after");
    return status >= 500;
  }

  private retryDelayMs(attempt: number, headers: Headers): number {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
    }
    const base = Math.min(500 * 2 ** attempt, 8_000);
    return base * (0.5 + Math.random() * 0.5); // jitter 50–100%
  }

  async request<T>(req: InternalRequest, opts: RequestOptions = {}): Promise<T> {
    const maxRetries = opts.maxRetries ?? this.config.maxRetries;
    let timeout = opts.timeout ?? this.config.timeout;
    if (req.timeoutFloor && timeout < req.timeoutFloor && opts.timeout === undefined) {
      timeout = req.timeoutFloor;
    }

    const url = this.buildURL(req.path, { ...req.query, ...opts.query });
    const headers = this.buildHeaders(req, opts);
    const bodyInit: BodyInit | undefined = req.form
      ? req.form
      : req.body !== undefined
        ? JSON.stringify(req.body)
        : undefined;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort((opts.signal as any)?.reason);
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort((opts.signal as any).reason);
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(new DOMExceptionLike("timeout")), timeout);

      let response: Response;
      try {
        this.log("debug", `${req.method} ${url} (attempt ${attempt + 1}/${maxRetries + 1})`);
        response = await this.config.fetch(url, {
          method: req.method,
          headers,
          body: bodyInit,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        // Distinguish user-abort, timeout, and network failure.
        if (opts.signal?.aborted) throw err;
        const timedOut = isAbortError(err);
        lastError = timedOut
          ? new APIConnectionTimeoutError(`Request timed out after ${timeout}ms.`)
          : new APIConnectionError("Connection error.", err);
        if (attempt < maxRetries) {
          await sleep(this.retryDelayMs(attempt, new Headers()));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }

      if (response.ok) {
        if (req.raw) return response as unknown as T;
        return (await this.parseJSON(response)) as T;
      }

      // Non-2xx: decide whether to retry.
      if (attempt < maxRetries && this.isRetryable(response.status, response.headers)) {
        const delay = this.retryDelayMs(attempt, response.headers);
        this.log("warn", `Retrying after ${Math.round(delay)}ms (status ${response.status}).`);
        await sleep(delay);
        continue;
      }
      throw await this.toError(response);
    }
    throw lastError instanceof Error ? lastError : new APIConnectionError();
  }

  /**
   * Open a streaming request: a single fetch (streams are not retried once
   * started), with the timeout guarding only the initial response. The returned
   * controller stays live so the caller can cancel the body mid-stream.
   */
  async openStream(
    req: InternalRequest,
    opts: RequestOptions = {},
  ): Promise<{ response: Response; controller: AbortController }> {
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort((opts.signal as any).reason);
      else opts.signal.addEventListener("abort", () => controller.abort((opts.signal as any)?.reason), { once: true });
    }

    const timeout = opts.timeout ?? this.config.timeout;
    const url = this.buildURL(req.path, { ...req.query, ...opts.query });
    const headers = this.buildHeaders(req, opts);
    const bodyInit: BodyInit | undefined = req.form
      ? req.form
      : req.body !== undefined
        ? JSON.stringify(req.body)
        : undefined;

    const timer = setTimeout(() => controller.abort(new DOMExceptionLike("timeout")), timeout);
    let response: Response;
    try {
      response = await this.config.fetch(url, {
        method: req.method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (opts.signal?.aborted) throw err;
      throw isAbortError(err)
        ? new APIConnectionTimeoutError(`Request timed out after ${timeout}ms.`)
        : new APIConnectionError("Connection error.", err);
    }
    clearTimeout(timer); // body cancellation now goes through `controller`
    if (!response.ok) throw await this.toError(response);
    return { response, controller };
  }

  private async parseJSON(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  private async toError(response: Response): Promise<APIError> {
    const text = await response.text().catch(() => "");
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    return makeAPIError(response.status, body, text, headers);
  }
}

class DOMExceptionLike extends Error {
  constructor(public override readonly name: string) {
    super(name);
  }
}

function looksLikeJwt(key: string): boolean {
  return key.startsWith("ey") && key.split(".").length === 3;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "timeout" || err.name === "TimeoutError")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Native success envelopes wrap the payload as `{ status, data }` or `{ data }`.
 * The OpenAI route returns the payload directly. This unwraps `.data` when
 * present and otherwise returns the body as-is.
 */
export function unwrapData<T>(body: unknown): T {
  if (body && typeof body === "object" && "data" in (body as any)) {
    return (body as any).data as T;
  }
  return body as T;
}
