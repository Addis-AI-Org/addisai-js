// Deep snake_case -> camelCase key conversion for plain response objects.

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelize<T = any>(input: unknown): T {
  if (Array.isArray(input)) {
    return input.map((item) => camelize(item)) as unknown as T;
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[toCamel(key)] = camelize(value);
    }
    return out as T;
  }
  return input as T;
}
