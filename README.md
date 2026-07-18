# addisai

The official [Addis AI](https://addisassistant.com) SDK for Node.js — voice (text‑to‑speech), chat/LLM with system prompts, personas and function calling, speech‑to‑text, and translation for **Amharic (`am`)** and **Afan Oromo (`om`)**.

Designed to feel familiar if you've used the OpenAI, Anthropic, or ElevenLabs SDKs.

```bash
npm install addisai
```

Requires Node.js 18+ (also runs on Deno, Bun, Cloudflare Workers, and Vercel Edge).

## Quickstart

```ts
import AddisAI from "addisai";

const addis = new AddisAI({ apiKey: process.env.ADDIS_API_KEY });

// Text-to-speech
const clip = await addis.voice.generate({
  voiceId: "am-hamen",
  text: "ሰላም፣ እንኳን ወደ አዲስ ኤአይ በደህና መጡ።",
  language: "am",
});
await clip.toFile("welcome.mp3");

// Chat
const res = await addis.chat.completions.create({
  language: "am",
  messages: [{ role: "user", content: "ስለ አዲስ አበባ ንገረኝ" }],
});
console.log(res.choices[0].message.content);
```

CommonJS:

```js
const { AddisAI } = require("addisai");
```

## Configuration

```ts
const addis = new AddisAI({
  apiKey: process.env.ADDIS_API_KEY, // or set ADDIS_API_KEY
  timeout: 60_000,                    // ms (voice.generate raises this to ≥95s automatically)
  maxRetries: 2,                      // automatic backoff on 408/409/425/429/5xx
  defaultHeaders: {},
  logLevel: "warn",                   // "off" | "error" | "warn" | "info" | "debug" (never logs secrets)
});
```

The API key is read from the `apiKey` option or the `ADDIS_API_KEY` environment variable. It is never logged and is redacted from errors. The SDK refuses to run in a browser unless you pass `dangerouslyAllowBrowser: true` — keep your key server‑side.

## Voice (text‑to‑speech)

```ts
const clip = await addis.voice.generate({
  voiceId: "am-hamen",
  text: "ሰላም ለዓለም።",
  language: "am",                 // must match the voice
  outputFormat: "mp3_44100",      // "mp3_44100" | "wav_44100" | "pcm_16000"
  voiceSettings: { speed: 50, stability: 50, similarity: 50, style: 0 }, // 0–100
});

clip.id;               // "clip_…"
clip.audioUrl;         // short-lived signed playback URL
clip.durationSeconds;
clip.usage;            // { creditsUsed, creditsRemaining, currency: "ETB", … }

const bytes = await clip.arrayBuffer(); // fetch audio into memory
await clip.toFile("out.mp3");           // …or write to disk

import { play } from "addisai";
await play(clip);                       // local playback (needs ffmpeg/mpv)
```

**Idempotent billing.** `voice.generate` requires an idempotency key. The SDK generates one automatically and reuses it across retries, so a network retry is never billed twice. Pass your own for full control:

```ts
await addis.voice.generate({ voiceId: "am-hamen", text, language: "am", clientRequestId: myId });
```

Reusing a key with the *same* inputs replays the existing clip (`clip.meta.idempotentReplay === true`, no new charge); reusing it with *changed* inputs throws `IdempotencyConflictError`.

### Voice catalog, estimates, usage, history

```ts
const voices = await addis.voices.list({ language: "am", gender: "female" });
const preview = await addis.voices.preview("am-hamen");

const est = await addis.voice.estimate({ voiceId: "am-hamen", text, language: "am" });
if (!est.canGenerate) console.log("Top up:", est.estimatedCost, est.currency);

const wallet = await addis.voice.usage();

for await (const c of addis.voice.clips.list({ language: "am" })) {
  console.log(c.id, c.text); // auto-paginates
}
await addis.voice.clips.delete("clip_123");
```

### Migrating from ElevenLabs

```ts
const clip = await addis.textToSpeech.convert("am-hamen", { text: "ሰላም", language: "am" });
```

## Chat / LLM

Drop‑in OpenAI‑compatible chat, plus Addis extensions for language, system prompts, personas, and function calling.

```ts
const res = await addis.chat.completions.create({
  language: "am",                                  // "am" | "om"
  system: "Answer in concise bullet points.",      // behaviour; does not change identity
  persona: "You are RecipeBot by AcmeCorp.",        // optional branded identity
  messages: [{ role: "user", content: "የእንጀራ አሰራር አስተምረኝ" }],
  temperature: 0.7,
  max_tokens: 1200,
});
console.log(res.choices[0].message.content);
```

> The model is selected by Addis AI; the response reports the model id `addis-1-alef`.

### Function calling (tools)

```ts
const res = await addis.chat.completions.create({
  language: "am",
  messages: [{ role: "user", content: "Check order 123 and summarize it." }],
  tools: [{
    type: "function",
    function: {
      name: "get_order_status",
      description: "Fetch order status by order ID.",
      parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
    },
  }],
  tool_choice: "auto",
});

if (res.choices[0].finish_reason === "tool_calls") {
  // execute res.choices[0].message.tool_calls, append a { role: "tool" } result, call again
}
```

Or let the SDK run the loop for you:

```ts
const final = await addis.chat.runTools({
  language: "am",
  messages: [{ role: "user", content: "Check order 123 and summarize it." }],
  tools: [{
    type: "function",
    function: {
      name: "get_order_status",
      description: "Fetch order status by order ID.",
      parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
      function: async ({ order_id }) => db.getOrder(order_id), // ← your implementation
    },
  }],
  maxToolRoundtrips: 5,
});
```

### Attachments & audio input

```ts
import { fileFromPath } from "addisai";

const res = await addis.chat.completions.create({
  language: "am",
  messages: [{ role: "user", content: "Describe this image." }],
  attachments: [{ file: await fileFromPath("photo.jpg") }],
});

const voiceCmd = await addis.chat.completions.create({
  language: "am",
  messages: [{ role: "user", content: "" }],
  audio: await fileFromPath("command.wav"),
});
voiceCmd.transcription?.clean; // the transcript
```

### Streaming (beta)

`stream: true` returns a `ChatStream` — an async‑iterable of OpenAI‑style chunks with accumulators and cancellation:

```ts
const stream = await addis.chat.completions.create({ language: "am", messages, stream: true });

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}

// or, instead of iterating:
const text = await stream.finalText();              // concatenated text
const completion = await stream.finalCompletion();  // assembled ChatCompletion (with usage)
stream.transcription;                                // present if audio input was sent
stream.abort();                                      // cancel mid-stream
stream.toReadableStream();                            // re-encode as an SSE byte stream
```

Pass `signal` to cancel via your own `AbortController`:

```ts
const ac = new AbortController();
const stream = await addis.chat.completions.create({ language: "am", messages, stream: true }, { signal: ac.signal });
```

Streaming is beta and not available with tools; non‑streaming is recommended for production.

## Speech‑to‑text & translation

```ts
import { fileFromPath } from "addisai";

const t = await addis.speech.transcribe({ audio: await fileFromPath("call.wav"), language: "am" });
console.log(t.text);

const out = await addis.translate.create({ text: "Hello, how are you?", from: "en", to: "am" });
console.log(out.text);
```

STT supports `am | om | en | ha | sw` (max 25 MB / 120 s). Translation supports `am | om | en`.

## Legacy audio (deprecated)

The old `/audio` endpoint is exposed only as a migration bridge. Prefer `voice.generate`.

```ts
// ⚠️ deprecated — use addis.voice.generate instead
const out = await addis.legacy.audio.generate({ text: "ሰላም", language: "am" });
await out.toFile("legacy.wav"); // base64 audio, decoded for you
```

It logs a one‑time deprecation warning, is capped at 1500 characters, and lacks the durable clips, signed URLs, and idempotent billing of `voice.generate`.

The legacy endpoint also streams audio. `stream()` returns an `AudioStream` — an async‑iterable of `Uint8Array` chunks that normalizes both legacy encodings into one byte stream:

```ts
const audio = await addis.legacy.audio.stream({ text: "ሰላም", language: "am" });
for await (const chunk of audio) { /* Uint8Array */ }
// or:
await audio.toFile("legacy.wav");
const bytes = await audio.arrayBuffer();
```

(`addis.voice.stream(...)` exists with the same `AudioStream` shape and will work once the API enables streaming synthesis; today it raises `NotSupportedError`.)

## Errors

```ts
import {
  AddisAIError, APIError, AuthenticationError, RateLimitError,
  InsufficientCreditsError, IdempotencyConflictError, NotFoundError,
} from "addisai";

try {
  await addis.voice.generate({ voiceId: "am-hamen", text, language: "am" });
} catch (err) {
  if (err instanceof InsufficientCreditsError) showTopUp(err.availableBalance);
  else if (err instanceof RateLimitError) await wait(err.retryAfter ?? 1);
  else if (err instanceof APIError) console.error(err.status, err.code, err.message, err.details);
}
```

| Class | HTTP | Notes |
| --- | --- | --- |
| `BadRequestError` | 400 | |
| `AuthenticationError` | 401 | |
| `InsufficientCreditsError` | 402 | `.availableBalance` |
| `PermissionDeniedError` | 403 | |
| `NotFoundError` | 404 | |
| `ConflictError` / `IdempotencyConflictError` / `GenerationInProgressError` | 409 | `.retryAfter` |
| `UnprocessableEntityError` | 422 | `.details[]` |
| `RateLimitError` | 429 | `.retryAfter` `.limit` `.remaining` `.reset` |
| `InternalServerError` | ≥500 | |
| `APIConnectionError` / `APIConnectionTimeoutError` | — | network / timeout |

## Per‑request options

Every method accepts a final options argument:

```ts
await addis.voice.generate(params, {
  timeout: 120_000,
  maxRetries: 0,
  signal: controller.signal,
  idempotencyKey: "my-key",
  headers: { "x-trace-id": traceId },
});
```

## License

MIT
