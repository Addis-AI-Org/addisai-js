// Server-Sent Events parser. Accumulates `event:` / `data:` fields into events
// terminated by a blank line, and yields { event, data } blocks. Robust to
// chunk boundaries that split mid-line or mid-event.

export interface SSEEvent {
  event: string | null;
  data: string;
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];

  const flush = (): SSEEvent | null => {
    if (dataLines.length === 0 && eventName === null) return null;
    const evt: SSEEvent = { event: eventName, data: dataLines.join("\n") };
    eventName = null;
    dataLines = [];
    return evt;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          const evt = flush();
          if (evt) yield evt;
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);

        if (field === "event") eventName = val;
        else if (field === "data") dataLines.push(val);
      }
    }
    const evt = flush();
    if (evt) yield evt;
  } finally {
    reader.releaseLock();
  }
}

/** Parse line-delimited JSON (ndjson). Yields parsed objects. */
export async function* parseNDJSON(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<any, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield safeParse(line);
      }
    }
    const tail = buffer.trim();
    if (tail) yield safeParse(tail);
  } finally {
    reader.releaseLock();
  }
}

function safeParse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
