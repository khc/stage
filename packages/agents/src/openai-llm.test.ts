import { describe, expect, test } from "bun:test";

import {
  FunctionTool,
  InMemorySessionService,
  LlmAgent,
  Runner,
  isBaseLlm,
  type Event,
  type LlmRequest,
} from "@google/adk";
import { FinishReason, Type } from "@google/genai";
import { z } from "zod";

import { createRoutedLlm, runWithModel } from "./model";
import { OpenAiLlm, chatCompletionsUrlFor, toJsonSchema } from "./openai-llm";

const sseResponse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(enc.encode(`data: ${chunk}\n\n`));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

describe("OpenAiLlm URL and schema helpers", () => {
  test("chatCompletionsUrlFor appends /v1 for empty paths and preserves query strings", () => {
    expect(chatCompletionsUrlFor()).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatCompletionsUrlFor("https://proxy.example.com")).toBe(
      "https://proxy.example.com/v1/chat/completions",
    );
    expect(chatCompletionsUrlFor("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(
      chatCompletionsUrlFor(
        "https://my.openai.azure.com/openai/deployments/gpt4?api-version=2024-02-01",
      ),
    ).toBe(
      "https://my.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01",
    );
  });

  test("toJsonSchema recursively converts Gemini Type enums including NULL and drops TYPE_UNSPECIFIED", () => {
    expect(
      toJsonSchema({
        type: Type.OBJECT,
        propertyOrdering: ["a", "b"],
        properties: {
          a: { type: Type.STRING },
          b: { type: Type.ARRAY, items: { type: Type.NULL } },
          c: { anyOf: [{ type: Type.INTEGER }, { type: Type.TYPE_UNSPECIFIED }] },
        },
        required: ["a"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "array", items: { type: "null" } },
        c: { anyOf: [{ type: "integer" }, {}] },
      },
      required: ["a"],
    });
  });
});

describe("OpenAiLlm", () => {
  test("is a BaseLlm, omits Authorization when apiKey is absent, and forwards system/history/images/tools/response_format", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};

    const llm = new OpenAiLlm({
      model: "llama3.2",
      baseUrl: "https://ollama.example.com/v1",
      fetcher: async (url, init) => {
        seenUrl = url;
        seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          choices: [
            {
              message: {
                reasoning_content: "thinking step",
                content: '{"answer":"done"}',
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 4 },
          },
        });
      },
    });
    expect(isBaseLlm(llm)).toBe(true);

    const request = {
      model: "llama3.2",
      contents: [
        {
          role: "user",
          parts: [
            { text: "Look at this" },
            { inlineData: { mimeType: "image/png", data: "AAAA" } },
          ],
        },
        {
          role: "model",
          parts: [
            { text: "hidden reasoning", thought: true },
            { functionCall: { name: "ping", args: {} } },
          ],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "ping", response: { ok: true } } }],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
      config: {
        systemInstruction: "Be terse.",
        temperature: 0.2,
        maxOutputTokens: 256,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: { answer: { type: Type.STRING } },
          required: ["answer"],
        },
        tools: [
          {
            functionDeclarations: [{ name: "ping", description: "Zero-arg tool" }],
          },
        ],
      },
    } as unknown as LlmRequest;

    const responses = [];
    for await (const res of llm.generateContentAsync(request, false)) {
      responses.push(res);
    }

    expect(seenUrl).toBe("https://ollama.example.com/v1/chat/completions");
    expect(seenHeaders.authorization).toBeUndefined();
    expect(seenBody.messages).toEqual([
      { role: "system", content: "Be terse." },
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
    ]);
    expect(seenBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "ping",
          description: "Zero-arg tool",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(seenBody.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    });
    expect(seenBody.temperature).toBe(0.2);
    expect(seenBody.max_tokens).toBe(256);

    expect(responses).toEqual([
      {
        content: {
          role: "model",
          parts: [{ text: "thinking step", thought: true }, { text: '{"answer":"done"}' }],
        },
        finishReason: FinishReason.STOP,
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 8,
          totalTokenCount: 20,
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 4,
        },
      },
    ]);
  });

  test("assembles SSE streaming deltas including indexed parallel tool calls", async () => {
    const llm = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-test-secret",
      fetcher: async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { reasoning: "plan " } }] }),
          JSON.stringify({ choices: [{ delta: { content: "Checking" } }] }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "tc_a", function: { name: "first", arguments: '{"x":' } },
                    { index: 1, id: "tc_b", function: { name: "second", arguments: '{"y":2}' } },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
          }),
        ]),
    });

    const out = [];
    for await (const chunk of llm.generateContentAsync(
      {
        contents: [{ role: "user", parts: [{ text: "go" }] }],
        toolsDict: {},
        liveConnectConfig: {},
      } as LlmRequest,
      true,
    )) {
      out.push(chunk);
    }

    expect(out.slice(0, 2)).toEqual([
      {
        content: { role: "model", parts: [{ text: "plan ", thought: true }] },
        partial: true,
        turnComplete: false,
      },
      {
        content: { role: "model", parts: [{ text: "Checking" }] },
        partial: true,
        turnComplete: false,
      },
    ]);
    expect(out.at(-1)).toEqual({
      content: {
        role: "model",
        parts: [
          { text: "plan ", thought: true },
          { text: "Checking" },
          { functionCall: { id: "tc_a", name: "first", args: { x: 1 } } },
          { functionCall: { id: "tc_b", name: "second", args: { y: 2 } } },
        ],
      },
      partial: false,
      turnComplete: true,
      finishReason: FinishReason.STOP,
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 },
    });
  });

  test("rejects private DNS targets, malformed tool JSON, live connect, and redacts apiKey from errors", async () => {
    const blocked = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-never-leak-this",
      baseUrl: "https://rebind.example.com/v1",
      resolver: async () => [{ address: "169.254.169.254", family: 4 }],
      fetcher: async () => Response.json({}),
    });
    const req = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolsDict: {},
      liveConnectConfig: {},
    } as LlmRequest;
    await expect(blocked.generateContentAsync(req).next()).rejects.toThrow("Blocked OpenAI");

    const badJson = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-never-leak-this",
      fetcher: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "1", function: { name: "broken", arguments: "{oops" } }],
              },
            },
          ],
        }),
    });
    await expect(badJson.generateContentAsync(req).next()).rejects.toThrow(
      'Invalid JSON arguments for tool "broken"',
    );

    const failing = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-super-secret-value",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: `Incorrect key sk-super-secret-value provided ${"x".repeat(400)}`,
            },
          }),
          { status: 401 },
        ),
    });
    const err = await failing
      .generateContentAsync(req)
      .next()
      .then(
        () => undefined,
        (e) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("OpenAI request failed (401): Incorrect key [REDACTED]");
    expect(err?.message).not.toContain("sk-super-secret-value");
    expect(err!.message.length).toBeLessThanOrEqual(340);

    const boundedJson = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-limit",
      maxResponseBytes: 50,
      fetcher: async () => Response.json({ choices: [{ message: { content: "x".repeat(200) } }] }),
    });
    await expect(boundedJson.generateContentAsync(req, false).next()).rejects.toThrow("size limit");

    let cancelled = false;
    const boundedStream = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-limit",
      maxResponseBytes: 40,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(80)}\n\n`));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await expect(boundedStream.generateContentAsync(req, true).next()).rejects.toThrow(
      "size limit",
    );
    expect(cancelled).toBe(true);

    let earlyCancelled = false;
    const earlyAbortStream = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-early",
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
                ),
              );
            },
            cancel() {
              earlyCancelled = true;
            },
          }),
        ),
    });
    const iter = earlyAbortStream.generateContentAsync(req, true);
    expect((await iter.next()).value?.content?.parts?.[0]?.text).toBe("hi");
    await iter.return();
    expect(earlyCancelled).toBe(true);

    await expect(failing.connect(req)).rejects.toThrow("do not support live connections");
  });

  test("executes a full ADK Runner turn with tools and outputSchema via RunModelLlm", async () => {
    const requests: Array<{ tools?: unknown[]; messages?: ChatMessage[] }> = [];
    let turn = 0;
    const openai = new OpenAiLlm({
      model: "gpt-4o",
      apiKey: "sk-runner-test",
      fetcher: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools?: unknown[];
          messages?: ChatMessage[];
        };
        requests.push(body);
        turn += 1;
        if (turn === 1) {
          return Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "tc_1", function: { name: "lookup", arguments: '{"q":"sky"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
        }
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "tc_2",
                    function: { name: "set_model_response", arguments: '{"answer":"blue"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      },
    });

    const lookupTool = new FunctionTool({
      name: "lookup",
      description: "Look up a fact",
      parameters: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ result: `${q} is blue` }),
    });
    const agent = new LlmAgent({
      name: "helper",
      model: createRoutedLlm("gemini-2.5-flash", () => {
        throw new Error("should not call fallback");
      }),
      tools: [lookupTool],
      outputSchema: z.object({ answer: z.string() }),
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({ appName: "app", userId: "u1" });
    const runner = new Runner({ appName: "app", agent, sessionService });
    const events: Event[] = [];
    await runWithModel(openai, async () => {
      for await (const event of runner.runAsync({
        userId: "u1",
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: "What color is the sky?" }] },
      })) {
        events.push(event);
      }
    });

    expect(requests).toHaveLength(2);
    const toolNames = (requests[0]!.tools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(toolNames).toContain("lookup");
    expect(toolNames).toContain("set_model_response");
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe('{"answer":"blue"}');
  });
});

type ChatMessage = { role: string; content: unknown };
