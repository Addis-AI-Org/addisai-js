import { describe, expect, it } from "vitest";
import AddisAI, { connectRealtime, type RealtimeSocket, type RealtimeSession } from "../src/index.js";

function frame(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 4);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4); return out;
}
function streamResponse(truncate = false): Response {
  const audio = frame(new Uint8Array([1, 2, 3]));
  const terminal = new TextEncoder().encode('\u0000\u0000\u0000\u0000{"data":{"id":"clip","usage":{"credits_used":1}}}');
  const bytes = new Uint8Array(audio.length + (truncate ? 0 : terminal.length));
  bytes.set(audio); if (!truncate) bytes.set(terminal, audio.length);
  let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i < bytes.length) c.enqueue(bytes.slice(i, ++i)); else c.close(); } }), {
    headers: { "Content-Type": "text/event-stream", "X-Addis-Audio-Protocol": "mp3-frames-v1" },
  });
}

describe("billed HTTP voice streaming", () => {
  it("decodes split frames and excludes metadata from the audio", async () => {
    let body: any;
    const addis = new AddisAI({ apiKey: "secret", fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return streamResponse(); } });
    const stream = await addis.voice.stream({ voiceId: "ti-berhane", language: "ti", text: "ሰላም፣ ከመይ ኣለኹም፧", clientRequestId: "stable-turn" });
    expect([...new Uint8Array(await stream.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(stream.metadata).toEqual({ id: "clip", usage: { credits_used: 1 } });
    expect(body.client_request_id).toBe("stable-turn");
    expect(stream.clientRequestId).toBe("stable-turn");
  });
  it("rejects a stream that ends before billing confirmation", async () => {
    const addis = new AddisAI({ apiKey: "secret", fetch: async () => streamResponse(true) });
    const stream = await addis.voice.stream({ voiceId: "am-loza", language: "am", text: "A complete sentence." });
    await expect(stream.arrayBuffer()).rejects.toThrow(/billing confirmation/);
  });
  it("downloads the already-paid clip on replay", async () => {
    const calls: string[] = [];
    const addis = new AddisAI({ apiKey: "secret", fetch: async (url) => {
      calls.push(String(url));
      return calls.length === 1
        ? Response.json({ data: { id: "saved", audio_url: "https://cdn.addisassistant.com/audio/clips/saved.mp3?token=scoped" } })
        : new Response(new Uint8Array([7, 8]), { headers: { "Content-Type": "audio/mpeg" } });
    } });
    const stream = await addis.voice.stream({ voiceId: "am-loza", language: "am", text: "A complete sentence.", clientRequestId: "stable" });
    expect([...new Uint8Array(await stream.arrayBuffer())]).toEqual([7, 8]);
    expect(stream.metadata?.id).toBe("saved");
    expect(calls).toHaveLength(2);
  });
});

class Socket implements RealtimeSocket {
  handlers: Record<string, Array<(event: any) => void>> = {};
  sent: any[] = [];
  constructor() { queueMicrotask(() => this.emit("open", {})); }
  addEventListener(type: string, cb: (event: any) => void) { (this.handlers[type] ??= []).push(cb); }
  emit(type: string, event: any) { for (const cb of this.handlers[type] ?? []) cb(event); }
  event(data: unknown) { this.emit("message", { data: JSON.stringify(data) }); }
  send(text: string) {
    const event = JSON.parse(text); this.sent.push(event);
    if (event.type === "session.authenticate") this.event({ type: "session.created", session_id: "session" });
    if (event.type === "speech.create") {
      this.event({ type: "speech.started", request_id: event.request_id });
      this.event({ type: "audio.delta", request_id: event.request_id, sequence: 0, format: "mp3", audio: "AQID" });
      this.event({ type: "speech.completed", request_id: event.request_id, data: { id: "clip" } });
    }
  }
  close(code = 1000) { this.emit("close", { code }); }
}
const ticket: RealtimeSession = { id: "session", token: "ephemeral", websocketUrl: "wss://api.addisassistant.com/api/v1/realtime/voice", expiresAt: 9999999999, sessionTtlSeconds: 600, voiceId: "am-loza", language: "am", audioFormat: "mp3", maxTextCharacters: 5000 };

describe("realtime sockets", () => {
  it("authenticates with a ticket and supports repeated spoken turns", async () => {
    const socket = new Socket();
    const connection = await connectRealtime(ticket, { webSocketFactory: (url) => { expect(url).not.toContain("ephemeral"); return socket; } });
    const bytes = [];
    for await (const chunk of connection.speak("A complete sentence.", "turn-1")) bytes.push(...chunk);
    expect(bytes).toEqual([1, 2, 3]);
    for await (const _chunk of connection.speak("Another complete sentence.", "turn-2")) { /* consume */ }
    expect(connection.lastCompletion?.id).toBe("clip");
    expect(socket.sent[0]).toEqual({ type: "session.authenticate", token: "ephemeral" });
    connection.close();
  });
  it("creates scoped sessions without automatic issuance retries", async () => {
    let captured: any;
    const addis = new AddisAI({ apiKey: "secret", fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return Response.json({ data: { id: "session", token: "ephemeral", websocket_url: ticket.websocketUrl, expires_at: 99999 } });
    } });
    const session = await addis.realtime.createSession({ voiceId: "am-loza", language: "am", maxTextCharacters: 100 });
    expect(captured).toEqual({ voice_id: "am-loza", language: "am", audio_format: "mp3", max_text_characters: 100 });
    expect(session.websocketUrl).toBe(ticket.websocketUrl);
  });
  it("rejects query-string credentials before opening a socket", async () => {
    await expect(connectRealtime({ ...ticket, websocketUrl: ticket.websocketUrl + "?token=secret" })).rejects.toThrow(/without credentials/);
  });
});


it("sends the explicit v2 audio ceiling while keeping legacy default requests compatible", async () => {
  let captured: any;
  const addis = new AddisAI({apiKey:"secret",fetch:async(_url,init)=>{captured=JSON.parse(String(init?.body));return Response.json({data:{id:"session",token:"ticket",websocket_url:ticket.websocketUrl}});}});
  await addis.realtime.createSession({voiceId:"ti-berhane",language:"ti",maxAudioSeconds:30});
  expect(captured.max_audio_seconds).toBe(30);
});
