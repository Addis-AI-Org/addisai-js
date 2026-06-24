import { AddisAIError } from "../core/errors.js";
import { type RequestOptions, type Transport } from "../core/request.js";
import { ChatStream } from "../lib/chat-stream.js";
import { toBlob, type Uploadable } from "../core/uploads.js";
import type { Language } from "./shared.js";

/** Public model identifier surfaced to developers. Never the underlying model. */
export const ADDIS_CHAT_MODEL = "addis-1-alef";

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Opaque provider state. Managed by the SDK; echo it back unchanged. */
  addis_tool_state?: string;
}

export interface ChatCompletionMessage {
  role: ChatRole;
  content?: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** A tool whose implementation the SDK will execute during `chat.runTools`. */
export interface RunnableTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /** Local implementation invoked with the parsed arguments. */
    function: (args: any) => unknown | Promise<unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatAttachment {
  /** A field name used for the multipart upload (defaults to "attachment_N"). */
  name?: string;
  file: Uploadable;
}

export interface ChatCompletionCreateParams {
  /** Accepted for OpenAI compatibility. Addis selects the model internally. */
  model?: string;
  messages: ChatCompletionMessage[];
  /** Target language. "am" (Amharic) or "om" (Afan Oromo). Default "am". */
  language?: Language;
  /** Extra behaviour instructions (tone/format). Does not change identity. */
  system?: string;
  /** Replaces the assistant identity for branded apps. */
  persona?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  /** Beta: stream tokens. Not available with tools. */
  stream?: boolean;
  /** Files/images/documents to attach to the final user message. */
  attachments?: ChatAttachment[];
  /** Audio voice-command input; transcribed server-side. */
  audio?: Uploadable;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string | null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatUsage;
  /** Present when audio input was transcribed. */
  transcription?: { raw?: string; clean?: string };
  /** Uploaded attachment URIs to reuse in later turns. */
  uploaded_attachments?: { fileUri: string; mimeType: string }[];
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }>;
}

export class Chat {
  readonly completions: Completions;

  constructor(private readonly transport: Transport) {
    this.completions = new Completions(transport);
  }

  /**
   * Run an automatic tool-calling loop: the model requests tools, the SDK
   * executes your local implementations, feeds results back, and repeats until
   * the model produces a final answer.
   */
  async runTools(
    params: Omit<ChatCompletionCreateParams, "tools" | "stream"> & {
      tools: RunnableTool[];
      maxToolRoundtrips?: number;
    },
    opts?: RequestOptions,
  ): Promise<ChatCompletion> {
    const { maxToolRoundtrips = 5, tools, ...rest } = params;
    const impls = new Map<string, (args: any) => unknown | Promise<unknown>>();
    const wireTools: FunctionTool[] = tools.map((t) => {
      impls.set(t.function.name, t.function.function);
      return { type: "function", function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } };
    });

    const messages: ChatCompletionMessage[] = [...rest.messages];
    for (let i = 0; i <= maxToolRoundtrips; i++) {
      const completion = await this.completions.create(
        { ...rest, messages, tools: wireTools, stream: false },
        opts,
      );
      const choice = completion.choices[0];
      const calls = choice?.message.tool_calls ?? [];
      if (!calls.length || choice?.finish_reason !== "tool_calls") {
        return completion;
      }
      if (i === maxToolRoundtrips) {
        throw new AddisAIError(
          `runTools exceeded maxToolRoundtrips (${maxToolRoundtrips}) without a final answer.`,
        );
      }
      messages.push(choice!.message);
      for (const call of calls) {
        const impl = impls.get(call.function.name);
        if (!impl) {
          throw new AddisAIError(`No implementation provided for tool "${call.function.name}".`);
        }
        let args: unknown = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // pass raw string if not JSON
          args = call.function.arguments;
        }
        const result = await impl(args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
    }
    // Unreachable, but satisfies the type checker.
    throw new AddisAIError("runTools terminated unexpectedly.");
  }
}

class Completions {
  constructor(private readonly transport: Transport) {}

  create(params: ChatCompletionCreateParams & { stream: true }, opts?: RequestOptions): Promise<ChatStream>;
  create(params: ChatCompletionCreateParams & { stream?: false }, opts?: RequestOptions): Promise<ChatCompletion>;
  async create(
    params: ChatCompletionCreateParams,
    opts: RequestOptions = {},
  ): Promise<ChatCompletion | ChatStream> {
    const hasTools = Boolean(params.tools?.length) || params.messages.some((m) => m.role === "tool" || m.tool_calls);
    const language = params.language ?? "am";

    if (params.stream) {
      if (hasTools) {
        throw new AddisAIError("Streaming is not supported with tool calling. Use non-streaming mode for tools.");
      }
      return this.createStream(params, language, opts);
    }

    if (params.attachments?.length || params.audio) {
      return this.createMultipart(params, language, opts);
    }

    // The model is selected by the backend and is intentionally not forwarded:
    // an arbitrary id would break generation and could leak the underlying model.
    const envelope = await this.transport.request<{ status?: string; data: NativeChatData }>(
      { method: "POST", path: "/api/v1/chat_generate", body: buildNativeBody(params, language) },
      opts,
    );
    return nativeToOpenAICompletion(envelope.data);
  }

  private async createStream(
    params: ChatCompletionCreateParams,
    language: Language,
    opts: RequestOptions,
  ): Promise<ChatStream> {
    const { response, controller } = await this.transport.openStream(
      { method: "POST", path: "/api/v1/chat_generate", body: buildNativeBody(params, language, { stream: true }) },
      opts,
    );
    return new ChatStream(response, controller);
  }

  private async createMultipart(
    params: ChatCompletionCreateParams,
    language: Language,
    opts: RequestOptions,
  ): Promise<ChatCompletion> {
    const form = new FormData();
    const attachmentFieldNames: string[] = [];
    (params.attachments ?? []).forEach((att, i) => {
      const field = att.name ?? `attachment_${i}`;
      const { blob, filename } = toBlob(att.file);
      form.append(field, blob, filename);
      attachmentFieldNames.push(field);
    });
    if (params.audio) {
      const { blob, filename } = toBlob(params.audio, "audio/wav");
      form.append("chat_audio_input", blob, filename || "audio.wav");
    }

    const requestData = buildNativeBody(params, language);
    if (attachmentFieldNames.length) requestData.attachment_field_names = attachmentFieldNames;

    form.append(
      "request_data",
      new Blob([JSON.stringify(requestData)], { type: "application/json" }),
    );

    const envelope = await this.transport.request<{ status?: string; data: NativeChatData }>(
      { method: "POST", path: "/api/v1/chat_generate", form },
      opts,
    );
    return nativeToOpenAICompletion(envelope.data);
  }
}

/**
 * Convert OpenAI-style messages into the backend's native chat request
 * (`prompt` + `conversation_history` + folded `system`). The deployed backend
 * reads `prompt`/`conversation_history`, not a `messages` array.
 */
function buildNativeBody(
  params: ChatCompletionCreateParams,
  language: Language,
  opts: { stream?: boolean } = {},
): Record<string, unknown> {
  const systemParts: string[] = [];
  if (params.system) systemParts.push(params.system);
  const nonSystem: ChatCompletionMessage[] = [];
  for (const m of params.messages) {
    if (m.role === "system" || m.role === "developer") {
      if (typeof m.content === "string" && m.content.trim()) systemParts.push(m.content);
    } else {
      nonSystem.push(m);
    }
  }

  let lastUser = -1;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const m = nonSystem[i]!;
    if (m.role === "user" && typeof m.content === "string" && m.content.trim()) {
      lastUser = i;
      break;
    }
  }

  const prompt = lastUser >= 0 ? (nonSystem[lastUser]!.content as string) : undefined;
  const historySource = lastUser >= 0 ? nonSystem.slice(0, lastUser) : nonSystem;
  const conversationHistory = historySource
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : "",
    }))
    .filter((m) => m.content);

  const body: Record<string, unknown> = { target_language: language };
  if (prompt !== undefined) body.prompt = prompt;
  if (conversationHistory.length) body.conversation_history = conversationHistory;
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (params.persona) body.persona = params.persona;
  if (params.tools) body.tools = params.tools;
  if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;

  const gen: Record<string, unknown> = {};
  if (params.temperature !== undefined) gen.temperature = params.temperature;
  if (params.max_tokens !== undefined) gen.maxOutputTokens = params.max_tokens;
  if (opts.stream) gen.stream = true;
  if (Object.keys(gen).length) body.generation_config = gen;
  return body;
}

interface NativeChatData {
  response_text?: string;
  finish_reason?: string | null;
  usage_metadata?: {
    prompt_token_count?: number;
    candidates_token_count?: number;
    total_token_count?: number;
  } | null;
  tool_calls?: ToolCall[];
  uploaded_attachments?: { fileUri: string; mimeType: string }[];
  transcription_raw?: string;
  transcription_clean?: string;
}

function nativeToOpenAICompletion(data: NativeChatData): ChatCompletion {
  const toolCalls = data.tool_calls?.length ? data.tool_calls : undefined;
  const message: ChatCompletionMessage = toolCalls
    ? { role: "assistant", content: data.response_text || null, tool_calls: toolCalls }
    : { role: "assistant", content: data.response_text ?? "" };
  const completion: ChatCompletion = {
    id: `chatcmpl-${cryptoRandom()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ADDIS_CHAT_MODEL,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls ? "tool_calls" : normalizeFinishReason(data.finish_reason),
      },
    ],
    usage: data.usage_metadata
      ? {
          prompt_tokens: data.usage_metadata.prompt_token_count ?? 0,
          completion_tokens: data.usage_metadata.candidates_token_count ?? 0,
          total_tokens: data.usage_metadata.total_token_count ?? 0,
        }
      : undefined,
  };
  if (data.transcription_raw || data.transcription_clean) {
    completion.transcription = { raw: data.transcription_raw, clean: data.transcription_clean };
  }
  if (data.uploaded_attachments?.length) {
    completion.uploaded_attachments = data.uploaded_attachments;
  }
  return completion;
}

function normalizeFinishReason(reason: unknown): string {
  if (typeof reason !== "string" || !reason) return "stop";
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
