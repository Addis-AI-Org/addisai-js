# Changelog

## 0.3.1

- Present Amharic, Afaan Oromo, and Tigrinya together with real catalog voices:
  Hamen, Bikila, and Berhane, and their matching voice IDs.
- Place real-time streaming under Voice and keep License as the final section.
- Choose an available voice matching the requested language in the runnable
  real-time example when no voice ID is supplied.
- SDK methods, dependencies, and billing behavior are unchanged.

## 0.3.0

- Enable billed `voice.stream()` and `textToSpeech.stream()` with MP3 phrase
  decoding, clip/usage metadata, truncation errors, and idempotent clip recovery.
- Add `realtime.createSession()`, `realtime.connect()`, and browser-safe
  `connectRealtime()` with scoped, short-lived WebSocket tickets.
- Add typed text/audio events, text buffering, cancellation, and MP3 `speak()`.
- Expand TTS language types for catalog-backed voice selection; document
  Amharic, Afaan Oromo, and Tigrigna for real-time voice integration.
- Add Tigrigna to chat, speech-to-text, and translation language types without
  changing their request or billing behavior.
- Add the patched `ws` 8.22.0 dependency for Node 18 compatibility.

## 0.2.0

- **Voice 2 billing:** align estimate, usage, and clip types with the production
  minute-based billing contract while preserving legacy character-priced clips.
- **Voice examples:** use the production `am-hamen` voice ID.

## 0.1.2

- **Docs:** correct the homepage/brand link to `https://addisassistant.com`
  (was a placeholder domain). No code changes.

## 0.1.1

- **Build hygiene:** stop shipping source maps (`.js.map` / `.cjs.map`) in the npm
  package. They embedded the full TypeScript source (`sourcesContent`) and bloated
  the tarball by ~265 kB for no consumer benefit — the source is public on GitHub.
  A CI guard now fails the publish if any `.map` with embedded source ever reappears.
  (No API or behavior changes.)

## 0.1.0 — Developer preview

Initial release of the official Addis AI SDK for Node.js.

- **Voice (TTS):** `voice.generate`, `voices.list/preview`, `voice.estimate`,
  `voice.usage`, `voice.clips.*`, `AddisClip` helpers, ElevenLabs-style
  `textToSpeech.convert` alias.
- **Chat / LLM:** OpenAI-compatible `chat.completions.create` with `system`,
  `persona`, tools/function calling, attachments, audio input; `chat.runTools`
  agent loop; beta SSE streaming via `ChatStream`.
- **Speech-to-text:** `speech.transcribe`. **Translation:** `translate.create`.
- **Reliability/security:** automatic retries with backoff, idempotent paid
  calls, normalized error hierarchy, secret redaction, Cloudflare-only transport,
  `dangerouslyAllowBrowser` off by default.
- Dual ESM + CJS, full types, zero runtime dependencies.

> Persona, system prompts, and function calling depend on a backend rollout; they
> are verified and ready in the SDK and activate as the server side ships.
