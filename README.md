# addisai

The official [Addis AI](https://addisassistant.com) SDK for Node.js — voice (text‑to‑speech), chat/LLM with system prompts, personas and function calling, speech‑to‑text, and translation, with examples for **Amharic (`am`)**, **Afaan Oromo (`om`)**, and **Tigrinya (`ti`)**.

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

## Languages

| Language | Code | Example voice | Voice ID |
| --- | --- | --- | --- |
| Amharic | `am` | Hamen | `am-hamen` |
| Afaan Oromo | `om` | Bikila | `om-bikila` |
| Tigrinya | `ti` | Berhane | `ti-berhane` |

Voice generation and real-time sessions support these three languages. Other
language codes are rejected locally before any API request or socket connection.
Use a matching language and voice ID. `voices.list` returns this three-language
catalog so you can choose another available voice.

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

### Real-time voice

`voice.stream()` yields MP3 phrases as they arrive and exposes final clip and
billing information as `audio.metadata` after the iterator completes.

```js
import { randomUUID } from "node:crypto";

// Select a matching pair from the Languages table.
const voiceId = "ti-berhane";
const language = "ti";
const text = "ሰላም፣ እንቋዕ ናብ ኣዲስ ኤኣይ ብደሓን መጻእኩም።";

const audio = await addis.voice.stream({
  voiceId, language, text, clientRequestId: randomUUID(),
});
await audio.toFile("speech.mp3");
console.log(audio.metadata?.usage);

const voice = await addis.realtime.connect({ voiceId, language });
try {
  for await (const bytes of voice.speak(text, randomUUID())) {
    // Feed each chunk to your MP3 player or writable stream.
  }
  console.log(voice.lastCompletion?.usage);
} finally { voice.close(); }
```

For browsers, call `realtime.createSession()` on your application server and
return the scoped ticket to your authenticated user. Connect with the exported
`connectRealtime(ticket)` helper; never put a developer key in browser code.
A ticket is one-use, valid for 60 seconds, scoped to a voice and language, with
a cumulative text budget. The socket lasts up to 10 minutes with one utterance
at a time. Use `append()` plus `commit()` to buffer generated text for one turn.
Cancellation mutes delivery; an already-started synthesis completes and is billed.

Use any matching voice and language pair from the Languages table.
HTTP streams support MP3 only. For early
WAV pieces, choose a `wav_mp3` socket session and consume `audio.delta` events
with `decodeRealtimeAudio(event)`, playing according to `event.format`.

See [examples/realtime.mjs](examples/realtime.mjs).

Run the same example with any of the documented languages:

```bash
ADDIS_VOICE_LANGUAGE=am ADDIS_VOICE_ID=am-hamen node examples/realtime.mjs "ሰላም፣ እንኳን ወደ አዲስ ኤአይ በደህና መጡ።"
ADDIS_VOICE_LANGUAGE=om ADDIS_VOICE_ID=om-bikila node examples/realtime.mjs "Nagaa, gara Addis AI baga nagaan dhuftan."
ADDIS_VOICE_LANGUAGE=ti ADDIS_VOICE_ID=ti-berhane node examples/realtime.mjs "ሰላም፣ እንቋዕ ናብ ኣዲስ ኤኣይ ብደሓን መጻእኩም።"
```

### Migrating from ElevenLabs

```ts
const clip = await addis.textToSpeech.convert("am-hamen", { text: "ሰላም", language: "am" });
```

## Chat / LLM

Drop‑in OpenAI‑compatible chat, plus Addis extensions for language, system prompts, personas, and function calling.

```ts
const res = await addis.chat.completions.create({
  language: "am",                                  // "am" | "om" | "ti"
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

## Addis Scribe

Scribe transcribes **Amharic**. Choose `backend: "standard"` (default) or
`backend: "turbo"`; both bill the same character rate.
Save a request ID before sending audio; recover it after an interrupted response.

```ts
const requestId = ulid();
const result = await addis.scribe.transcribe({
  audio: await fileFromPath("speech.wav"), backend: "standard", requestId,
});
console.log(result.text, result.usage.creditsUsed);
// Recovery returns the original settled result without another charge:
// const recovered = await addis.scribe.recover(requestId);

const stream = await addis.scribe.stream({
  audio: await fileFromPath("speech.wav"), requestId: ulid(),
});
for await (const event of stream) {
  if (event.type === "transcript.partial") console.log(event.text);
  if (event.type === "transcript.completed") console.log(event.data.usage);
}
```

### Word timestamps and captions

Pass `timestamps: "word"` to `transcribe()` to receive `words` and caption-ready
`segments` (times in seconds from the start of the file). Timestamps cost nothing
extra. `toSrt()` and `toVtt()` format the segments locally, without another API call,
wrapping each cue at 42 characters per line and at most 2 lines.

```ts
import { writeFile } from "node:fs/promises";
import { fileFromPath, toSrt, toVtt, ulid } from "addisai";

const result = await addis.scribe.transcribe({
  audio: await fileFromPath("speech.wav"), timestamps: "word", requestId: ulid(),
});
console.log(result.words?.[0]);    // { text: "ሰላም", start: 18.9, end: 19.52 }
await writeFile("speech.srt", toSrt(result));
await writeFile("speech.vtt", toVtt(result));
// 1
// 00:00:18,800 --> 00:00:21,800
// ሰላም ወዳጆቻችን እንዴት ከረማችሁ ዛሬ እንግዲህ እንግዳ አድርጌ
// ያቀረኩላችሁ
```

Timestamps are available for completed uploads only: `stream()` rejects
`timestamps: "word"` locally, and live sessions do not return timestamps.
`toSrt()`/`toVtt()` throw if the result has no `segments`; they also work on a
result from `recover()` when the original request used timestamps.

#### Speaker labels

Pass `speakers: true` with `backend: "turbo"` to label who is talking. It turns on
word timestamps, costs nothing extra, and adds a `speaker` number to every word and
segment plus a `speakers` count on the result. Speakers are numbered 1, 2, … in the
order they first talk; a word that could not be attributed has `speaker: null`.
A new caption cue starts whenever the speaker changes. `toSrt()` starts each labelled
cue with `Speaker N: `, and `toVtt()` marks it with a `<v Speaker N>` voice tag.

```ts
const result = await addis.scribe.transcribe({
  audio: await fileFromPath("interview.wav"), backend: "turbo", speakers: true,
  requestId: ulid(),
});
console.log(result.speakers);          // 2
await writeFile("interview.srt", toSrt(result));
// 1
// 00:00:00,600 --> 00:00:01,600
// Speaker 1: ሰላም ወዳጆቻችን
//
// 2
// 00:00:01,700 --> 00:00:03,000
// Speaker 2: እንዴት ናችሁ
```

Good to know:

- Speaker labels need `backend: "turbo"`; other backends fail locally before any
  request. `stream()` and live sessions do not support them.
- On simulated Amharic conversations, 97.8% of words got the right speaker.
- Labels work best with 2 to 4 people and get less accurate when people talk over
  each other.
- Labels are "Speaker 1", "Speaker 2" and so on, not names.

### Live audio

`addis.scribe.connect({ requestId })` opens live audio. Read its async event iterator
while calling `sendAudio(frame)` with **raw 16 kHz mono PCM16 little-endian**
(3,200 bytes per 100 ms), then call `finish()` and read the settled completion.
`completion` includes the final transcript and usage. Use `createSession` on your
server and exported `connectScribe(session)` for a browser; the first socket frame
contains only the scoped one-use ticket. Socket URLs contain no credentials.
Python uses equivalent snake_case names. `capabilities()` returns model limits and
`usage()` returns your wallet balance and current rate.

HTTP uploads accept 25 MiB / 180 seconds. File streams emit partials after upload;
WebSockets accept audio incrementally. HTTP defaults to standard/1120ms chunks; sockets
to standard/320ms. Tickets expire after 60 seconds. One request is admitted per wallet.
Only final transcript UTF-16 character units are billed; partials have no separate
charge. Paid requests/ticket creation are not automatically retried. Disconnecting
or closing a stream can still bill accepted audio. Recover settled results for 24
hours; pending settlement remains recoverable. New audio/settings need a new ID.

See the [Scribe guide](https://docs.addisassistant.com/docs/capabilities/speech-to-text)
for complete live PCM, recovery and billing examples.

## Speech‑to‑text & translation

```ts
import { fileFromPath } from "addisai";

const t = await addis.speech.transcribe({ audio: await fileFromPath("call.wav"), language: "am" });
console.log(t.text);

const out = await addis.translate.create({ text: "Hello, how are you?", from: "en", to: "am" });
console.log(out.text);
```

STT supports `am | om | ti | en | ha | sw` (max 25 MB / 120 s). Translation supports `am | om | ti | en`.
Speech recognition uses `/api/v2/stt`; confidence may be `null`.

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
