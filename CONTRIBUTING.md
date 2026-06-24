# Contributing to the Addis AI Node SDK

Thanks for helping improve `addisai`. This package lives in `sdk/node/` of the
API monorepo.

## Prerequisites

- Node.js 18+ (CI tests 18, 20, 22)
- npm

## Setup

```bash
cd sdk/node
npm install
```

## Workflow

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsup -> dist (ESM + CJS + d.ts)
npm test            # vitest (unit + mocked-fetch integration)
npm run test:watch  # watch mode
npm run dev         # build in watch mode
```

All four (`typecheck`, `build`, `test`, and a clean `git status`) must pass
before a PR is merged. CI runs them on every push and PR that touches
`sdk/node/**`.

## Project layout

```
src/
  client.ts          AddisAI client (config, auth, resource wiring)
  core/              transport, errors, retries, streaming, pagination,
                     idempotency, uploads, env guards, redaction, camelize
  resources/         chat, voice, voices, speech, translate, legacy, text-to-speech
  lib/               AddisClip, play()
  index.ts           public exports
test/                vitest specs
examples/            runnable .mjs examples
```

## Non-negotiable design rules

These reflect the SDK's security and product guarantees — PRs that break them
will not be merged:

1. **Cloudflare-only transport.** Never address a raw `*.supabase.co` host. The
   base URL guard in `core/env.ts` must stay intact.
2. **No internal leakage.** Do not surface provider hostnames/ports, checkpoint
   paths, infra node names, or the underlying model name in types, errors, docs,
   or runtime values. The only model id exposed is `addis-1-alef`. (See how
   `chat.ts` strips `model` and `voice.ts`/`clip.ts` drop provider settings.)
3. **Secrets never logged.** API keys come only from `apiKey` or `ADDIS_API_KEY`
   and must be redacted everywhere (`core/redact.ts`).
4. **Idempotent paid mutations.** `voice.generate` must keep generating/reusing a
   stable `client_request_id` across retries so a retry is never double-billed.
5. **Errors stay normalized.** New endpoints map into the single hierarchy in
   `core/errors.ts`.

## Adding a resource

1. Add `src/resources/<name>.ts` exporting a class constructed with the
   `Transport`.
2. Map snake_case request/response fields to the SDK's camelCase surface
   (`core/camelize.ts` for simple cases; whitelist-map anything that could carry
   sensitive fields).
3. Wire it into `client.ts` and export its public types from `index.ts`.
4. Add a mocked-fetch test in `test/`.
5. Document it in `README.md`.

## Coding style

- TypeScript strict mode; no `any` in public types.
- Match the existing file's conventions and comment density.
- Keep runtime dependencies at zero — use built-in `fetch`, web streams, and
  WebCrypto so the SDK stays runtime-agnostic.

## Commits & releases

- Conventional, imperative commit messages.
- Releases: bump `version` in `package.json` and `src/version.ts`, tag
  `addisai-node-v<version>`, and publish a GitHub release. The
  `sdk-node-publish` workflow builds, tests, and publishes to npm with
  provenance (requires the `NPM_TOKEN` secret).
