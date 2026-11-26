import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from "@google/adk";
import {
  FinishReason,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import {
  createPinnedFetcher,
  hasControlChars,
  isValidHttpUrl,
  readBoundedJson,
  readBoundedText,
  resolveSafeAddresses,
  type DnsResolver,
  type OutboundFetcher,
} from "@stage/http/outbound-url";

export type OpenAiLlmOptions = {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxErrorBytes?: number;
  fetcher?: OutboundFetcher;
  resolver?: DnsResolver;
  allowLocalBaseUrl?: boolean;
};

type ChatTextPart = { type: "text"; text: string };
type ChatImagePart = { type: "image_url"; image_url: { url: string } };
type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<ChatTextPart | ChatImagePart> }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

type OpenAiChoice = {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
};

type OpenAiChatCompletion = {
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage;
};

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ERROR_BYTES = 65_536;
const MAX_ERROR_DETAIL_CHARS = 300;

const SCHEMA_TYPES: Record<string, string> = {
  OBJECT: "object",
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  ARRAY: "array",
  NULL: "null",
};

export const chatCompletionsUrlFor = (baseUrl?: string): string => {
  const parsed = new URL((baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/+$/, ""));
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path === "" ? "/v1/chat/completions" : `${path}/chat/completions`;
  return parsed.toString();
};

export const toJsonSchema = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "object", properties: {} };
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "propertyOrdering" || value === undefined) continue;
    if (key === "type" && typeof value === "string") {
      if (value === "TYPE_UNSPECIFIED") continue;
      out.type = SCHEMA_TYPES[value] ?? value.toLowerCase();
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propKey, propSchema] of Object.entries(value)) {
        props[propKey] = toJsonSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if ((key === "items" || key === "additionalProperties") && value && typeof value === "object") {
      out[key] = toJsonSchema(value);
      continue;
    }
    if (
      (key === "anyOf" || key === "oneOf" || key === "allOf" || key === "prefixItems") &&
      Array.isArray(value)
    ) {
      out[key] = value.map((item) => toJsonSchema(item));
      continue;
    }
    out[key] = value;
  }
  if (out.type === "object" && out.properties === undefined) {
    out.properties = {};
  }
  return out;
};

const extractSystemInstruction = (
  instruction: GenerateContentConfig["systemInstruction"],
): string => {
  if (!instruction) return "";
  if (typeof instruction === "string") return instruction;
  if (Array.isArray(instruction)) {
    return instruction
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part && "text" in part
            ? (part.text ?? "")
            : "",
      )
      .filter(Boolean)
      .join("\n\n");
  }
  if ("parts" in instruction && Array.isArray(instruction.parts)) {
    return instruction.parts
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n\n");
  }
  if ("text" in instruction && typeof instruction.text === "string") {
    return instruction.text;
  }
  return "";
};

const toChatMessages = (contents: Content[], systemInstruction: string): ChatMessage[] => {
  const messages: ChatMessage[] = [];
  if (systemInstruction) {
    messages.push({ role: "system", content: systemInstruction });
  }

  let fallbackCounter = 0;
  const pendingIdsByName = new Map<string, string[]>();

  for (const content of contents) {
    const parts = content.parts ?? [];
    if (content.role === "model") {
      const texts: string[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const part of parts) {
        if (part.thought) continue;
        if (part.text) texts.push(part.text);
        if (part.functionCall?.name) {
          const id = part.functionCall.id || `call_${++fallbackCounter}`;
          const queue = pendingIdsByName.get(part.functionCall.name) ?? [];
          queue.push(id);
          pendingIdsByName.set(part.functionCall.name, queue);
          toolCalls.push({
            id,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          });
        }
      }
      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: texts.length > 0 ? texts.join("") : null,
          tool_calls: toolCalls,
        });
      } else if (texts.length > 0) {
        messages.push({ role: "assistant", content: texts.join("") });
      }
      continue;
    }

    const userParts: Array<ChatTextPart | ChatImagePart> = [];
    for (const part of parts) {
      if (part.thought) continue;
      if (part.functionResponse?.name) {
        const queue = pendingIdsByName.get(part.functionResponse.name);
        const queuedId = queue?.shift();
        const callId = part.functionResponse.id || queuedId || `call_${++fallbackCounter}`;
        const rawResp = part.functionResponse.response;
        const serialized = typeof rawResp === "string" ? rawResp : JSON.stringify(rawResp ?? {});
        messages.push({ role: "tool", tool_call_id: callId, content: serialized });
      } else if (part.text !== undefined) {
        userParts.push({ type: "text", text: part.text });
      } else if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("image/")) {
        userParts.push({
          type: "image_url",
          image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
        });
      }
    }
    if (userParts.length > 0) {
      const hasImages = userParts.some((p) => p.type === "image_url");
      messages.push({
        role: "user",
        content: hasImages ? userParts : userParts.map((p) => (p as ChatTextPart).text).join(""),
      });
    }
  }
  return messages;
};

const toOpenAiTools = (tools: GenerateContentConfig["tools"]) => {
  if (!Array.isArray(tools)) return undefined;
  const declarations: FunctionDeclaration[] = [];
  for (const tool of tools) {
    if (
      tool &&
      typeof tool === "object" &&
      "functionDeclarations" in tool &&
      Array.isArray(tool.functionDeclarations)
    ) {
      declarations.push(...(tool.functionDeclarations as FunctionDeclaration[]));
    }
  }
  if (declarations.length === 0) return undefined;
  return declarations.map((decl) => {
    const rawParams = decl.parametersJsonSchema ?? decl.parameters;
    return {
      type: "function" as const,
      function: {
        name: decl.name ?? "unnamed_tool",
        ...(decl.description && { description: decl.description }),
        parameters: rawParams ? toJsonSchema(rawParams) : { type: "object", properties: {} },
      },
    };
  });
};

const mapFinishReason = (reason: string | null | undefined): FinishReason | undefined => {
  if (!reason) return undefined;
  if (reason === "stop" || reason === "tool_calls" || reason === "function_call") {
    return FinishReason.STOP;
  }
  if (reason === "length") return FinishReason.MAX_TOKENS;
  if (reason === "content_filter") return FinishReason.SAFETY;
  return FinishReason.OTHER;
};

const mapUsage = (
  usage: OpenAiUsage | undefined,
): GenerateContentResponseUsageMetadata | undefined => {
  if (!usage) return undefined;
  return {
    ...(usage.prompt_tokens !== undefined && { promptTokenCount: usage.prompt_tokens }),
    ...(usage.completion_tokens !== undefined && {
      candidatesTokenCount: usage.completion_tokens,
    }),
    ...(usage.total_tokens !== undefined && { totalTokenCount: usage.total_tokens }),
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined && {
      cachedContentTokenCount: usage.prompt_tokens_details.cached_tokens,
    }),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined && {
      thoughtsTokenCount: usage.completion_tokens_details.reasoning_tokens,
    }),
  };
};

const parseToolArgs = (raw: string | undefined, toolName: string): Record<string, unknown> => {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON arguments for tool "${toolName}": ${reason}`, { cause: err });
  }
};

const parseErrorDetail = (text: string, apiKey?: string): string => {
  const scrub = (detail: string) =>
    (apiKey ? detail.replaceAll(apiKey, "[REDACTED]") : detail).slice(0, MAX_ERROR_DETAIL_CHARS);
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } | unknown };
    if (
      parsed.error &&
      typeof parsed.error === "object" &&
      typeof (parsed.error as { message?: unknown }).message === "string"
    ) {
      return `: ${scrub((parsed.error as { message: string }).message)}`;
    }
  } catch {
    // Plain-text upstream error body.
  }
  return `: ${scrub(trimmed)}`;
};

export class OpenAiLlm extends BaseLlm {
  readonly #apiKey?: string;
  readonly #baseUrl?: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxErrorBytes: number;
  readonly #fetcher?: OutboundFetcher;
  readonly #resolver?: DnsResolver;
  readonly #allowLocalBaseUrl: boolean;

  constructor({
    model,
    apiKey,
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxErrorBytes = DEFAULT_MAX_ERROR_BYTES,
    fetcher,
    resolver,
    allowLocalBaseUrl = false,
  }: OpenAiLlmOptions) {
    super({ model });
    if (apiKey !== undefined && hasControlChars(apiKey)) {
      throw new Error("OpenAI API key contains unsupported control characters");
    }
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#maxErrorBytes = maxErrorBytes;
    this.#fetcher = fetcher;
    this.#resolver = resolver;
    this.#allowLocalBaseUrl = allowLocalBaseUrl;
  }

  async #resolveFetcher(endpoint: string): Promise<OutboundFetcher> {
    if (!this.#fetcher || this.#resolver) {
      if (!isValidHttpUrl(endpoint, this.#allowLocalBaseUrl)) {
        throw new Error(`Invalid OpenAI provider base URL: ${endpoint}`);
      }
      const pinned = await resolveSafeAddresses(endpoint, {
        allowLocalBaseUrl: this.#allowLocalBaseUrl,
        resolver: this.#resolver,
      });
      if (!pinned) {
        throw new Error(`Blocked OpenAI provider base URL: ${endpoint}`);
      }
      return (
        this.#fetcher ?? createPinnedFetcher(pinned, { maxResponseBytes: this.#maxResponseBytes })
      );
    }
    return this.#fetcher;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);
    const endpoint = chatCompletionsUrlFor(this.#baseUrl);
    const activeFetcher = await this.#resolveFetcher(endpoint);

    const config = llmRequest.config;
    const systemInstruction = extractSystemInstruction(config?.systemInstruction);
    const messages = toChatMessages(llmRequest.contents, systemInstruction);
    const tools = toOpenAiTools(config?.tools);
    const responseFormat =
      config?.responseMimeType === "application/json" && config.responseSchema
        ? {
            type: "json_schema" as const,
            json_schema: {
              name: "response",
              schema: toJsonSchema(config.responseSchema),
            },
          }
        : undefined;

    const requestBody: Record<string, unknown> = {
      model: llmRequest.model ?? this.model,
      messages,
      stream,
      ...(tools && { tools }),
      ...(responseFormat && { response_format: responseFormat }),
      ...(config?.temperature !== undefined && { temperature: config.temperature }),
      ...(config?.maxOutputTokens !== undefined && { max_tokens: config.maxOutputTokens }),
      ...(config?.topP !== undefined && { top_p: config.topP }),
      ...(config?.stopSequences !== undefined && { stop: config.stopSequences }),
      ...(config?.seed !== undefined && { seed: config.seed }),
    };

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.#apiKey && { authorization: `Bearer ${this.#apiKey}` }),
    };

    const response = await activeFetcher(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      redirect: "error",
      signal,
    });

    if (!response.ok) {
      const errorText = await readBoundedText(response, this.#maxErrorBytes).catch(() => "");
      throw new Error(
        `OpenAI request failed (${response.status})${parseErrorDetail(errorText, this.#apiKey)}`,
      );
    }

    if (!stream) {
      const payload = (await readBoundedJson(
        response,
        this.#maxResponseBytes,
      )) as OpenAiChatCompletion;
      const choice = payload.choices?.[0];
      const msg = choice?.message;
      const parts: Part[] = [];
      const reasoning = msg?.reasoning_content ?? msg?.reasoning;
      if (reasoning) parts.push({ text: reasoning, thought: true });
      if (
        msg?.content !== undefined &&
        msg?.content !== null &&
        (msg.content.length > 0 || !msg.tool_calls?.length)
      ) {
        parts.push({ text: msg.content });
      }
      for (const [idx, tc] of (msg?.tool_calls ?? []).entries()) {
        const name = tc.function?.name;
        if (!name) continue;
        parts.push({
          functionCall: {
            id: tc.id || `call_${idx + 1}`,
            name,
            args: parseToolArgs(tc.function?.arguments, name),
          },
        });
      }
      const finishReason = mapFinishReason(choice?.finish_reason);
      const usageMetadata = mapUsage(payload.usage);
      yield {
        content: { role: "model", parts },
        ...(finishReason !== undefined && { finishReason }),
        ...(usageMetadata !== undefined && { usageMetadata }),
      };
      return;
    }

    if (!response.body) {
      throw new Error("OpenAI streaming response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reasoningAcc = "";
    let contentAcc = "";
    let finishReason: FinishReason | undefined;
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;
    const toolAcc = new Map<number, { id?: string; name: string; args: string }>();

    const processLine = (rawLine: string): { done: boolean; deltaParts: Part[] } => {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":") || !line.startsWith("data:")) {
        return { done: false, deltaParts: [] };
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { done: true, deltaParts: [] };
      const chunk = JSON.parse(data) as OpenAiChatCompletion;
      const chunkUsage = mapUsage(chunk.usage);
      if (chunkUsage) usageMetadata = chunkUsage;
      const choice = chunk.choices?.[0];
      if (!choice) return { done: false, deltaParts: [] };
      if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);

      const delta = choice.delta;
      const deltaParts: Part[] = [];
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoningDelta) {
        reasoningAcc += reasoningDelta;
        deltaParts.push({ text: reasoningDelta, thought: true });
      }
      if (delta?.content) {
        contentAcc += delta.content;
        deltaParts.push({ text: delta.content });
      }
      for (const [fallbackIndex, tc] of (delta?.tool_calls ?? []).entries()) {
        const index = tc.index ?? fallbackIndex;
        const entry = toolAcc.get(index) ?? { name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        toolAcc.set(index, entry);
      }
      return { done: false, deltaParts };
    };

    let done = false;
    let totalStreamBytes = 0;
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > this.#maxResponseBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("OpenAI streaming response exceeded size limit");
    }
    try {
      while (!done) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read in order
        const next = await reader.read();
        if (next.done) break;
        totalStreamBytes += next.value.byteLength;
        if (totalStreamBytes > this.#maxResponseBytes) {
          throw new Error("OpenAI streaming response exceeded size limit");
        }
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const result = processLine(line);
          if (result.deltaParts.length > 0) {
            yield {
              content: { role: "model", parts: result.deltaParts },
              partial: true,
              turnComplete: false,
            };
          }
          if (result.done) {
            done = true;
            // oxlint-disable-next-line eslint/no-await-in-loop -- the loop ends right after the cancel
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }
      buffer += decoder.decode();
      if (!done && buffer.trim()) {
        const result = processLine(buffer);
        if (result.deltaParts.length > 0) {
          yield {
            content: { role: "model", parts: result.deltaParts },
            partial: true,
            turnComplete: false,
          };
        }
      }
    } finally {
      if (!done) await reader.cancel().catch(() => {});
    }

    const finalParts: Part[] = [];
    if (reasoningAcc) finalParts.push({ text: reasoningAcc, thought: true });
    if (contentAcc || toolAcc.size === 0) finalParts.push({ text: contentAcc });
    for (const [index, entry] of [...toolAcc.entries()].toSorted((a, b) => a[0] - b[0])) {
      if (!entry.name) continue;
      finalParts.push({
        functionCall: {
          id: entry.id || `call_${index + 1}`,
          name: entry.name,
          args: parseToolArgs(entry.args, entry.name),
        },
      });
    }

    yield {
      content: { role: "model", parts: finalParts },
      partial: false,
      turnComplete: true,
      ...(finishReason !== undefined && { finishReason }),
      ...(usageMetadata !== undefined && { usageMetadata }),
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error("OpenAI models do not support live connections");
  }
}
