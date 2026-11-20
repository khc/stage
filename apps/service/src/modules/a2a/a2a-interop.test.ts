import { afterAll, expect, test } from "bun:test";

import { InMemoryRunner, createEvent, isFinalResponse, stringifyContent } from "@google/adk";
import { RemoteA2AAgent } from "@google/adk/a2a";
import { toAgentCard } from "@stage/agents/agent-registry";
import { Elysia } from "elysia";

import { createApp } from "../../app";
import { createA2aService } from "./a2a-service";

// ADK's own A2A client against the real gateway routes, served over loopback HTTP.
const run = { status: "succeeded" };
const gateway = new Elysia()
  .use(
    createApp({
      healthService: { check: () => ({ status: "ok" }) },
      tasksService: {} as never,
      sessionsService: {} as never,
      agentsService: {} as never,
      a2aService: createA2aService(
        {
          agentsService: {
            agentCard: async (jobName, agentName) =>
              agentName === "haiku-poet"
                ? toAgentCard(jobName, { name: agentName, description: "Writes haiku" })
                : undefined,
          },
          tasksService: {
            create: async (input) => ({ status: "created", task: { taskId: "t-1", ...input } }),
            run: async () => ({ status: "started", operation: "op", sessionId: "s-1" }),
          },
          sessionsStore: {
            get: async () =>
              ({
                run,
                events: [
                  createEvent({
                    author: "haiku-poet",
                    content: { role: "model", parts: [{ text: "an old pond" }] },
                  }),
                ],
              }) as never,
          },
        },
        { pollMs: 1 },
      ),
    }),
  )
  .listen({ port: 0, hostname: "127.0.0.1" });
afterAll(() => gateway.stop(true));

const ask = async (card: string, message: string) => {
  const runner = new InMemoryRunner({
    agent: new RemoteA2AAgent({
      name: "haiku_poet",
      agentCard: card,
      messageSendConfig: { blocking: true },
    }),
    appName: "interop-test",
  });
  const session = await runner.sessionService.createSession({
    appName: "interop-test",
    userId: "u",
  });
  let reply = "";
  for await (const event of runner.runAsync({
    userId: "u",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: message }] },
  }))
    if (isFinalResponse(event) && event.content?.parts?.length) reply = stringifyContent(event);
  return reply;
};

test("ADK's RemoteA2AAgent resolves the card and gets the agent's reply from the gateway", async () => {
  const origin = `http://127.0.0.1:${gateway.server?.port}`;
  expect(await ask(`${origin}/a2a/poet-agents/haiku-poet/`, "a haiku about a pond")).toBe(
    "an old pond",
  );
});
