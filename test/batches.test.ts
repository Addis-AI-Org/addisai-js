import { describe, expect, it, vi } from "vitest";
import AddisAI, { AddisAIError, toBatchJsonl } from "../src/index.js";

const BATCH_ID = "batch_0123456789abcdef0123456789abcdef";
const FILE_ID = "file_0123456789abcdef0123456789abcdef";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

function clientWith(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: any, init: any = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  const addis = new AddisAI({ apiKey: "sk_test_123", fetch: fetch as any, maxRetries: 0 });
  return { addis, calls };
}

function header(call: Call, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    object: "batch",
    endpoint: "/v1/voice/generations",
    input_file_id: FILE_ID,
    completion_window: "24h",
    status: "validating",
    status_reason: null,
    output_file_id: null,
    error_file_id: null,
    created_at: "2026-10-16T09:00:00Z",
    expires_at: "2026-10-17T09:00:00Z",
    request_counts: { total: 2, succeeded: 0, failed: 0, expired: 0, cancelled: 0, pending: 2 },
    pricing: { tier: "batch", currency: "ETB", unit: "audio_minute", unit_price: 2.5, list_unit_price: 5 },
    estimated_cost: 5,
    charged_cost: 0,
    metadata: { project_name: "ch3" },
    ...overrides,
  };
}

describe("batches", () => {
  it("creates a batch with a generated idempotency key and camelCase fields", async () => {
    const { addis, calls } = clientWith(() => json(batch(), { status: 201 }));
    const created = await addis.batches.create({ inputFileId: FILE_ID, metadata: { project_name: "ch3" } });

    expect(calls[0]!.url).toBe("https://api.addisassistant.com/api/v1/batches");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      input_file_id: FILE_ID,
      endpoint: "/v1/voice/generations",
      completion_window: "24h",
      metadata: { project_name: "ch3" },
    });
    expect(header(calls[0]!, "idempotency-key")).toMatch(/^[0-9A-Z]{26}$/);
    expect(header(calls[0]!, "x-api-key")).toBe("sk_test_123");
    expect(created.inputFileId).toBe(FILE_ID);
    expect(created.pricing.unitPrice).toBe(2.5);
    expect(created.requestCounts.pending).toBe(2);
    // The caller's metadata keys are not rewritten.
    expect(created.metadata).toEqual({ project_name: "ch3" });
  });

  it("reuses one idempotency key across automatic retries", async () => {
    const calls: Call[] = [];
    const fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? json({ error: { code: "internal_error", message: "x" } }, { status: 503, headers: { "retry-after": "0" } })
        : json(batch(), { status: 201 });
    });
    const addis = new AddisAI({ apiKey: "sk_test_123", fetch: fetch as any, maxRetries: 1 });
    await addis.batches.create({ inputFileId: FILE_ID });
    expect(calls).toHaveLength(2);
    expect(header(calls[0]!, "idempotency-key")).toBe(header(calls[1]!, "idempotency-key"));
  });

  it("builds JSONL from requests, uploads it, then creates the batch", async () => {
    const { addis, calls } = clientWith((call) =>
      call.url.endsWith("/api/v1/files")
        ? json({ id: FILE_ID, object: "file", purpose: "batch_input", status: "ready", bytes: 10, filename: "batch.jsonl" }, { status: 201 })
        : json(batch(), { status: 201 }),
    );
    await addis.batches.createFromRequests({
      requests: [
        { customId: "a", text: "ሰላም", voiceId: "selam-warm", language: "am" },
        { customId: "b", text: "Akkam", voiceId: "ayana", language: "om", outputFormat: "wav_44100", voiceSettings: { speed: 60 } },
      ],
    });

    const form = calls[0]!.init.body as FormData;
    expect(form.get("purpose")).toBe("batch_input");
    const file = form.get("file") as File;
    expect(file.name).toBe("batch.jsonl");
    const lines = (await file.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { custom_id: "a", body: { text: "ሰላም", voice_id: "selam-warm", language: "am", output_format: "mp3_44100" } },
      { custom_id: "b", body: { text: "Akkam", voice_id: "ayana", language: "om", output_format: "wav_44100", voice_settings: { speed: 60 } } },
    ]);
    expect(JSON.parse(String(calls[1]!.init.body)).input_file_id).toBe(FILE_ID);
  });

  it("sends a Tigrinya batch with every native Tigrinya voice", async () => {
    const voices = ["ti-berhane", "ti-senait", "ti-haben", "ti-rahel", "ti-filimon", "ti-danait", "ti-yonas"];
    const { addis, calls } = clientWith((call) =>
      call.url.endsWith("/api/v1/files")
        ? json({ id: FILE_ID, object: "file", purpose: "batch_input", status: "ready", bytes: 10, filename: "batch.jsonl" }, { status: 201 })
        : json(batch(), { status: 201 }),
    );
    await addis.batches.createFromRequests({
      requests: voices.map((voiceId, i) => ({ customId: `ti-${i}`, text: "ሎሚ ጽቡቕ መዓልቲ እዩ።", voiceId, language: "ti" as const })),
    });
    const lines = (await ((calls[0]!.init.body as FormData).get("file") as File).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.body.language, l.body.voice_id])).toEqual(voices.map((v) => ["ti", v]));
    expect(lines[0].body.text).toBe("ሎሚ ጽቡቕ መዓልቲ እዩ።");
  });

  it.each(["sid", "wal", "ha", "sw", "en", "fr", "", "unknown"])(
    "rejects batch language %s locally before any upload",
    async (language) => {
      const { addis, calls } = clientWith(() => json({}));
      await expect(
        addis.batches.createFromRequests({
          // Deliberately bypass TypeScript, as plain JavaScript callers can do.
          requests: [{ customId: "a", text: "x", voiceId: "v", language: language as "am" }],
        }),
      ).rejects.toThrow(/am \(Amharic\), om \(Afaan Oromo\), or ti \(Tigrinya\)/);
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects duplicate custom ids and empty batches before any request", async () => {
    expect(() =>
      toBatchJsonl([
        { customId: "a", text: "x", voiceId: "v", language: "am" },
        { customId: "a", text: "y", voiceId: "v", language: "am" },
      ]),
    ).toThrow(/used twice/);
    const { addis, calls } = clientWith(() => json({}));
    await expect(addis.batches.createFromRequests({ requests: [] })).rejects.toBeInstanceOf(AddisAIError);
    expect(calls).toHaveLength(0);
  });

  it("lists across pages using last_id", async () => {
    const second = "batch_ffffffffffffffffffffffffffffffff";
    const { addis, calls } = clientWith((_call, index) =>
      index === 0
        ? json({ object: "list", data: [batch()], has_more: true, last_id: BATCH_ID })
        : json({ object: "list", data: [batch({ id: second })], has_more: false, last_id: second }),
    );
    const ids: string[] = [];
    for await (const item of addis.batches.list({ limit: 1 })) ids.push(item.id);
    expect(ids).toEqual([BATCH_ID, second]);
    expect(calls[1]!.url).toBe(`https://api.addisassistant.com/api/v1/batches?limit=1&after=${BATCH_ID}`);
  });

  it("pages requests by line number", async () => {
    const { addis, calls } = clientWith((_call, index) =>
      index === 0
        ? json({ data: [{ custom_id: "a", line: 1, status: "failed", error: { code: "voice_not_found", message: "m" }, result: null, cost: null }], has_more: true })
        : json({ data: [], has_more: false }),
    );
    const rows = [];
    for await (const row of addis.batches.requests(BATCH_ID, { status: "failed" })) rows.push(row);
    expect(rows[0]).toMatchObject({ customId: "a", status: "failed", error: { code: "voice_not_found" } });
    expect(calls[1]!.url).toContain("status=failed");
    expect(calls[1]!.url).toContain("after=1");
  });

  it("downloads results through the signed URL without sending the API key", async () => {
    const output = '{"custom_id":"a","line":1,"status":"succeeded","response":{"audio_file_id":"file_x","duration_seconds":4.2}}\n';
    const errors = '{"custom_id":"b","line":2,"status":"failed","error":{"code":"voice_not_found","message":"m"}}\n';
    const { addis, calls } = clientWith((call) => {
      if (call.url.endsWith(`/batches/${BATCH_ID}`)) {
        return json(batch({ status: "completed", output_file_id: "file_out", error_file_id: "file_err" }));
      }
      if (call.url.includes("/files/file_out/content")) {
        return new Response(null, { status: 302, headers: { location: "https://storage.test/out?sig=1" } });
      }
      if (call.url.includes("/files/file_err/content")) {
        return new Response(null, { status: 302, headers: { location: "https://storage.test/err?sig=1" } });
      }
      return new Response(call.url.includes("/out") ? output : errors);
    });

    const results = [];
    for await (const result of addis.batches.results(BATCH_ID)) results.push(result);
    expect(results).toEqual([
      { customId: "a", line: 1, status: "succeeded", response: { audioFileId: "file_x", durationSeconds: 4.2 } },
      { customId: "b", line: 2, status: "failed", error: { code: "voice_not_found", message: "m" } },
    ]);

    const contentCall = calls.find((c) => c.url.includes("/files/file_out/content"))!;
    expect(contentCall.init.redirect).toBe("manual");
    const storageCall = calls.find((c) => c.url.startsWith("https://storage.test/out"))!;
    expect(header(storageCall, "x-api-key")).toBeNull();
    expect(header(storageCall, "authorization")).toBeNull();
  });

  it("waits until the batch reaches a final status", async () => {
    vi.useFakeTimers();
    try {
      const { addis, calls } = clientWith((_call, index) =>
        json(batch({ status: index === 0 ? "in_progress" : "completed" })),
      );
      const pending = addis.batches.waitFor(BATCH_ID, { pollIntervalMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      const done = await pending;
      expect(done.status).toBe("completed");
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels", async () => {
    const { addis, calls } = clientWith(() => json(batch({ status: "cancelling" })));
    const result = await addis.batches.cancel(BATCH_ID);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://api.addisassistant.com/api/v1/batches/${BATCH_ID}/cancel`);
    expect(result.status).toBe("cancelling");
  });
});

describe("files", () => {
  it("uses a signed upload for files over 25 MB", async () => {
    const { addis, calls } = clientWith((call) => {
      if (call.url.endsWith("/api/v1/files")) {
        return json(
          {
            id: FILE_ID, object: "file", purpose: "batch_input", status: "pending", bytes: 26 * 1024 * 1024, filename: "big.jsonl",
            upload: { method: "PUT", url: "https://storage.test/put?sig=1", headers: { "content-type": "application/jsonl" }, expires_at: "2026-10-16T10:00:00Z" },
          },
          { status: 201 },
        );
      }
      if (call.url.startsWith("https://storage.test/put")) return new Response(null, { status: 200 });
      return json({ id: FILE_ID, object: "file", status: "ready", bytes: 26 * 1024 * 1024, filename: "big.jsonl" });
    });

    const big = new Blob([new Uint8Array(26 * 1024 * 1024)], { type: "application/jsonl" });
    const file = await addis.files.upload({ data: big, filename: "big.jsonl" });

    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ purpose: "batch_input", filename: "big.jsonl", bytes: 26 * 1024 * 1024 });
    expect(calls[1]!.init.method).toBe("PUT");
    expect(header(calls[1]!, "x-api-key")).toBeNull();
    expect(calls[2]!.url).toBe(`https://api.addisassistant.com/api/v1/files/${FILE_ID}/complete`);
    expect(file.status).toBe("ready");
  });

  it("refuses files over 100 MB locally", async () => {
    const { addis, calls } = clientWith(() => json({}));
    const huge = { data: new Uint8Array(1), filename: "x.jsonl" };
    Object.defineProperty(huge, "data", { value: new Blob([new Uint8Array(100 * 1024 * 1024 + 1)]) });
    await expect(addis.files.upload(huge)).rejects.toThrow(/100 MB/);
    expect(calls).toHaveLength(0);
  });

  it("returns the signed content URL", async () => {
    const { addis } = clientWith(() =>
      new Response(null, { status: 302, headers: { location: "https://storage.test/a.mp3?sig=1" } }),
    );
    await expect(addis.files.contentUrl("file_audio")).resolves.toBe("https://storage.test/a.mp3?sig=1");
  });
});
