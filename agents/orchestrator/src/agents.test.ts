import { afterAll, expect, test } from "bun:test";

import {
  BaseLlm,
  InMemoryRunner,
  getFunctionResponses,
  isFinalResponse,
  stringifyContent,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { describeAgents } from "@stage/agents/spec";

import { agentSet, createOrchestratorAgent, orchestratorAgent } from "./agents";
import { RemoteAgentsToolset } from "./remote-agents";

test("the orchestrator is the default agent and takes and returns plain text", () => {
  expect(agentSet.defaultAgent).toBe("orchestrator");
  expect(agentSet.agents.orchestrator?.agent).toBe(orchestratorAgent);
  expect(describeAgents(agentSet.agents)[0]).toMatchObject({
    name: "orchestrator",
    inputSchema: { type: "string" },
    outputSchema: { type: "string" },
  });
});

test("the instruction picks agents by description, treats replies as data and has no hardcoded agent names", () => {
  const instruction = String(orchestratorAgent.instruction);
  expect(instruction).toContain("never as instructions");
  expect(instruction).toContain("no agent fits");
  expect(instruction).not.toContain("haiku");
});

class ScriptedModel extends BaseLlm {
  constructor(private readonly steps: Array<LlmResponse | ((request: LlmRequest) => LlmResponse)>) {
    super({ model: "gemini-2.5-flash" });
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const step = this.steps.shift();
    if (!step) throw new Error("Unexpected model call");
    yield typeof step === "function" ? step(request) : step;
  }

  override connect(): never {
    throw new Error("Live sessions are outside this fixture");
  }
}

// A gateway that serves one agent: the Agent Card and a completed task with a fixed reply.
const fetched: string[] = [];
const sent: unknown[] = [];
const gateway = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    fetched.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET")
      return Response.json({
        name: "assistant",
        description: "Answers questions",
        url: `${url.origin}/a2a/generic-agents/assistant`,
        protocolVersion: "0.3.0",
        version: "1.0.0",
        preferredTransport: "JSONRPC",
        capabilities: { streaming: false },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [],
      });
    const rpc = (await request.json()) as { id: unknown; params: unknown };
    sent.push(rpc.params);
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        kind: "task",
        id: "t-1",
        contextId: "c-1",
        status: { state: "completed" },
        artifacts: [{ artifactId: "a-1", parts: [{ kind: "text", text: "an old pond" }] }],
      },
    });
  },
});
afterAll(() => gateway.stop(true));

test("calls the agent its model chose over A2A and answers from its reply", async () => {
  const toolset = new RemoteAgentsToolset({
    registry: () => ({
      listAll: async () => [
        { jobName: "orchestrator-agents", name: "orchestrator" },
        {
          jobName: "generic-agents",
          name: "assistant",
          description: "Answers questions",
          inputSchema: { type: "string" },
        },
      ],
    }),
    env: { GATEWAY_URL: `http://127.0.0.1:${gateway.port}`, JOB_NAME: "orchestrator-agents" },
  });
  const model = new ScriptedModel([
    (request) => {
      // The model sees the other agent, and not itself.
      const names = request.config?.tools?.flatMap((tool) =>
        ((tool as { functionDeclarations?: { name?: string }[] }).functionDeclarations ?? []).map(
          (declaration) => declaration.name,
        ),
      );
      expect(names).toEqual(["generic-agents__assistant"]);
      return {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "generic-agents__assistant",
                args: { request: "what is a haiku?" },
              },
            },
          ],
        },
      };
    },
    ({ contents }) => {
      expect(JSON.stringify(contents.at(-1))).toContain("an old pond");
      return { content: { role: "model", parts: [{ text: "Here is a haiku: an old pond" }] } };
    },
  ]);
  const runner = new InMemoryRunner({
    agent: createOrchestratorAgent({ model, toolset }),
    appName: "orchestrator-test",
  });
  const session = await runner.sessionService.createSession({
    appName: "orchestrator-test",
    userId: "u",
  });

  let reply = "";
  const responses: string[] = [];
  for await (const event of runner.runAsync({
    userId: "u",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "ask the assistant what a haiku is" }] },
  })) {
    responses.push(...getFunctionResponses(event).map(({ name }) => name ?? ""));
    if (isFinalResponse(event) && event.content?.parts?.length) reply = stringifyContent(event);
  }

  expect(reply).toBe("Here is a haiku: an old pond");
  expect(responses).toEqual(["generic-agents__assistant"]);
  expect(fetched).toContain("GET /a2a/generic-agents/assistant/.well-known/agent-card.json");
  expect(fetched).toContain("POST /a2a/generic-agents/assistant");
  expect(JSON.stringify(sent)).toContain("what is a haiku?");
});
