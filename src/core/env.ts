// Environment, runtime detection, and security guards.

export const DEFAULT_BASE_URL = "https://api.addisassistant.com";
export const API_KEY_ENV_VAR = "ADDIS_API_KEY";

/** Read an environment variable across Node / Deno / Bun without crashing. */
export function readEnv(name: string): string | undefined {
  // Node / Bun
  if (typeof process !== "undefined" && process.env && name in process.env) {
    const value = process.env[name];
    return value == null || value === "" ? undefined : value;
  }
  // Deno
  const deno = (globalThis as any).Deno;
  if (deno?.env?.get) {
    try {
      const value = deno.env.get(name);
      return value ? value : undefined;
    } catch {
      // permission denied — treat as unset
      return undefined;
    }
  }
  return undefined;
}

/** True when we appear to be running inside a browser-like environment. */
export function isBrowserLike(): boolean {
  return (
    typeof (globalThis as any).window !== "undefined" &&
    typeof (globalThis as any).document !== "undefined"
  );
}

const BLOCKED_HOST_SUFFIXES = [".supabase.co", ".supabase.in"];

/**
 * Validate and normalize the base URL.
 *
 * The SDK must only ever talk to the Cloudflare-wrapped API. Pointing it at a
 * raw Supabase Functions/Storage host is rejected, and plain http:// is refused
 * except for localhost (local testing).
 */
export function resolveBaseURL(baseURL: string | undefined): string {
  const raw = (baseURL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`addisai: invalid baseURL "${raw}".`);
  }

  const host = url.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";

  if (url.protocol !== "https:" && !isLocal) {
    throw new Error(
      `addisai: baseURL must use https (got "${url.protocol}//${host}").`,
    );
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(
      "addisai: pointing the SDK at a raw *.supabase.co host is not allowed. " +
        `Use the Addis AI API at ${DEFAULT_BASE_URL}.`,
    );
  }

  return raw;
}

/** Runtime descriptor used in the User-Agent header (no sensitive data). */
export function detectRuntime(): string {
  const g = globalThis as any;
  if (g.Deno?.version?.deno) return `Deno/${g.Deno.version.deno}`;
  if (g.Bun?.version) return `Bun/${g.Bun.version}`;
  if (typeof process !== "undefined" && process.versions?.node) {
    return `Node/${process.versions.node}`;
  }
  if (isBrowserLike()) return "Browser";
  return "Unknown";
}
