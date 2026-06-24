// Unified error hierarchy. Normalizes the three backend error envelope shapes:
//   1. Voice routes:   { error: { code, message, details } }   + semantic HTTP
//   2. Native routes:  { status: "error", error: { code, message } }
//   3. OpenAI route:   { error: { message, type, param, code } }

export interface ErrorDetail {
  field?: string;
  code?: string;
  message?: string;
}

export class AddisAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain for transpiled targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a capability exists in the SDK surface but is not yet enabled. */
export class NotSupportedError extends AddisAIError {}

/** Network-level failure (DNS, TLS, socket, fetch rejection). */
export class APIConnectionError extends AddisAIError {
  readonly cause?: unknown;
  constructor(message = "Connection error.", cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Request exceeded the configured timeout / was aborted by timeout. */
export class APIConnectionTimeoutError extends APIConnectionError {
  constructor(message = "Request timed out.") {
    super(message);
  }
}

/** Any non-2xx HTTP response. */
export class APIError extends AddisAIError {
  readonly status: number;
  readonly code: string | null;
  readonly details: ErrorDetail[];
  readonly requestId: string | null;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    opts: {
      code?: string | null;
      details?: ErrorDetail[];
      requestId?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.status = status;
    this.code = opts.code ?? null;
    this.details = opts.details ?? [];
    this.requestId = opts.requestId ?? null;
    this.headers = opts.headers ?? {};
  }
}

export class BadRequestError extends APIError {} // 400
export class AuthenticationError extends APIError {} // 401
export class InsufficientCreditsError extends APIError { // 402
  get availableBalance(): number | null {
    return numericDetail(this, "balance_too_low") ?? null;
  }
}
export class PermissionDeniedError extends APIError {} // 403
export class NotFoundError extends APIError {} // 404
export class ConflictError extends APIError {} // 409
export class IdempotencyConflictError extends ConflictError {} // 409 IDEMPOTENCY_CONFLICT
export class GenerationInProgressError extends ConflictError { // 409 GENERATION_IN_PROGRESS
  get retryAfter(): number | null {
    return headerNumber(this.headers, "retry-after");
  }
}
export class UnprocessableEntityError extends APIError {} // 422
export class RateLimitError extends APIError { // 429
  get retryAfter(): number | null {
    return headerNumber(this.headers, "retry-after");
  }
  get limit(): number | null {
    return headerNumber(this.headers, "x-ratelimit-limit");
  }
  get remaining(): number | null {
    return headerNumber(this.headers, "x-ratelimit-remaining");
  }
  get reset(): number | null {
    return headerNumber(this.headers, "x-ratelimit-reset");
  }
}
export class InternalServerError extends APIError {} // >= 500

function headerNumber(headers: Record<string, string>, name: string): number | null {
  const raw = headers[name.toLowerCase()];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function numericDetail(err: APIError, code: string): number | null {
  const detail = err.details.find((d) => d.code === code);
  const match = detail?.message?.match(/([\d]+(?:\.\d+)?)/g);
  if (!match) return null;
  const n = Number(match[match.length - 1]);
  return Number.isFinite(n) ? n : null;
}

interface ParsedEnvelope {
  message: string;
  code: string | null;
  details: ErrorDetail[];
}

/** Pull a normalized { message, code, details } out of any backend body. */
function parseEnvelope(status: number, body: unknown, rawText: string): ParsedEnvelope {
  if (body && typeof body === "object") {
    const obj = body as Record<string, any>;
    const err = obj.error;
    if (err && typeof err === "object") {
      return {
        message: typeof err.message === "string" && err.message
          ? err.message
          : `Request failed with status ${status}.`,
        code: typeof err.code === "string"
          ? err.code
          : (typeof err.type === "string" ? err.type : null),
        details: Array.isArray(err.details) ? err.details : [],
      };
    }
    if (typeof obj.message === "string" && obj.message) {
      return { message: obj.message, code: typeof obj.code === "string" ? obj.code : null, details: [] };
    }
  }
  return {
    message: rawText?.slice(0, 500) || `Request failed with status ${status}.`,
    code: null,
    details: [],
  };
}

/** Build the most specific error class for an HTTP failure. */
export function makeAPIError(
  status: number,
  body: unknown,
  rawText: string,
  headers: Record<string, string>,
): APIError {
  const { message, code, details } = parseEnvelope(status, body, rawText);
  const requestId = headers["x-request-id"] ?? headers["cf-ray"] ?? null;
  const opts = { code, details, requestId, headers };
  const upper = (code ?? "").toUpperCase();

  switch (status) {
    case 400:
      return new BadRequestError(status, message, opts);
    case 401:
      return new AuthenticationError(status, message, opts);
    case 402:
      return new InsufficientCreditsError(status, message, opts);
    case 403:
      return new PermissionDeniedError(status, message, opts);
    case 404:
      return new NotFoundError(status, message, opts);
    case 409:
      if (upper === "IDEMPOTENCY_CONFLICT") return new IdempotencyConflictError(status, message, opts);
      if (upper === "GENERATION_IN_PROGRESS") return new GenerationInProgressError(status, message, opts);
      return new ConflictError(status, message, opts);
    case 413:
    case 422:
      return new UnprocessableEntityError(status, message, opts);
    case 429:
      return new RateLimitError(status, message, opts);
    default:
      if (status >= 500) return new InternalServerError(status, message, opts);
      return new APIError(status, message, opts);
  }
}
