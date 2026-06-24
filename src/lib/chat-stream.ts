import { AddisAIError } from "../core/errors.js";
import { parseSSE } from "../core/sse.js";
import type { ChatCompletion, ChatCompletionChunk, ChatUsage } from "../resources/chat.js";

export const ADDIS_CHAT_MODEL = "addis-1-alef";

/**
 * An OpenAI-style streaming chat response. It is async-iterable (`for await`),
 * and provides convenience accumulators and cancellation.
 */
export class ChatStream implements AsyncIterable<ChatCompletionChunk> {
  /** Transcription, if the request included audio input. */
  transcription?: { raw?: string; clean?: string };

  private readonly id = `chatcmpl-${cryptoRandom()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private consumed = false;
  private finalUsage: ChatUsage | undefined;

  constructor(
    private readonly response: Response,
    private readonly controller?: AbortController,
  ) {}

  /** Cancel the stream and underlying request. */
  abort(): void {
    this.controller?.abort();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
    if (this.consumed) {
      throw new AddisAIError("This stream has already been consumed.");
    }
    this.consumed = true;
    if (!this.response.body) return;

    for await (const evt of parseSSE(this.response.body)) {
      const raw = evt.data.trim();
      if (!raw || raw === "[DONE]") {
        if (raw === "[DONE]") return;
        continue;
      }
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        continue;
      }

      if (payload.type === "metadata") {
        this.transcription = {
          raw: payload.transcription_raw,
          clean: payload.transcription_clean,
        };
        continue;
      }

      const usage = payload.usage_metadata;
      if (usage) {
        this.finalUsage = {
          prompt_tokens: usage.prompt_token_count ?? usage.promptTokenCount ?? 0,
          completion_tokens: usage.candidates_token_count ?? usage.candidatesTokenCount ?? 0,
          total_tokens: usage.total_token_count ?? usage.totalTokenCount ?? 0,
        };
      }

      const content: string = payload.text ?? payload.response_text ?? payload.delta?.content ?? "";
      const finishReason = payload.finish_reason ?? (payload.is_last_chunk ? "stop" : null);
      if (!content && !finishReason) continue;

      yield {
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: ADDIS_CHAT_MODEL,
        choices: [{ index: 0, delta: { content }, finish_reason: normalizeFinish(finishReason) }],
      };
    }
  }

  /** Consume the stream and return the concatenated assistant text. */
  async finalText(): Promise<string> {
    let text = "";
    for await (const chunk of this) text += chunk.choices[0]?.delta?.content ?? "";
    return text;
  }

  /** Consume the stream and return an assembled non-streaming completion. */
  async finalCompletion(): Promise<ChatCompletion> {
    let content = "";
    let finishReason: string | null = "stop";
    for await (const chunk of this) {
      content += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }
    const completion: ChatCompletion = {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: ADDIS_CHAT_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: this.finalUsage,
    };
    if (this.transcription) completion.transcription = this.transcription;
    return completion;
  }

  /** Re-encode the stream as a byte ReadableStream of SSE chunks (for piping). */
  toReadableStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const iterator = this[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await iterator.next();
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      },
    });
  }
}

function normalizeFinish(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason.toUpperCase()) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    case "TOOL_CALLS":
      return "tool_calls";
    default:
      return reason.toLowerCase();
  }
}

function cryptoRandom(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Math.random().toString(36).slice(2);
}
