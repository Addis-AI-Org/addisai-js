// Secret redaction helpers. API keys and Authorization headers must never be
// printed in logs, errors, or debug output.

export function redactApiKey(key: string | undefined | null): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-2)}`;
}

const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "apikey", "cookie"]);

/** Return a copy of headers with sensitive values masked, for safe logging. */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries as Iterable<[string, string]>) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? "••••" : value;
  }
  return out;
}
