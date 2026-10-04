import { AddisAIError } from "./errors.js";

/** Deployed phrase framing: uint32 length + MP3, then zero + final JSON. */
export async function* parseVoiceFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array | Record<string, unknown>> {
  const reader = body.getReader();
  let pending = new Uint8Array(0);
  let terminal = false;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(pending.length + value.length);
      joined.set(pending); joined.set(value, pending.length);
      pending = joined;
      if (terminal) {
        if (pending.length > 128 * 1024) throw new AddisAIError("Voice metadata exceeds the limit.");
        continue;
      }
      while (pending.length >= 4) {
        const size = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0);
        if (size === 0) { pending = pending.slice(4); terminal = true; break; }
        if (size > 2 * 1024 * 1024) throw new AddisAIError("Voice frame exceeds the limit.");
        if (pending.length < size + 4) break;
        total += size;
        if (total > 16 * 1024 * 1024) throw new AddisAIError("Voice audio exceeds the limit.");
        yield pending.slice(4, size + 4);
        pending = pending.slice(size + 4);
      }
      if (terminal && pending.length > 128 * 1024) throw new AddisAIError("Voice metadata exceeds the limit.");
    }
    if (!terminal) throw new AddisAIError("Voice stream ended before billing confirmation. Retry with the same clientRequestId.");
    let data: any;
    try { data = JSON.parse(new TextDecoder().decode(pending)); }
    catch { throw new AddisAIError("Invalid voice completion metadata."); }
    if (!data?.data || typeof data.data !== "object" || data.error) throw new AddisAIError("Voice generation did not complete.");
    yield data.data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
