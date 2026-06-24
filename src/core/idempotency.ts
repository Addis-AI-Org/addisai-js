// ULID generator (Crockford base32, lexicographically sortable) for idempotency
// keys on paid mutations. No external dependency.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const c = (globalThis as any).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(buf);
    return buf;
  }
  // Extremely defensive fallback; supported runtimes all provide WebCrypto.
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod]! + out;
    now = (now - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[bytes[i]! % 32]!;
  }
  return out;
}

/** Generate a new ULID, e.g. "01JZ900QK3GZTY2VJ9ZQ5A96M5". */
export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}
