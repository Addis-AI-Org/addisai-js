# Changelog

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
