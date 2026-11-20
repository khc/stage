import type { AgentCard, Message } from "@a2a-js/sdk";
import {
  A2AError,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { isFinalResponse, stringifyContent } from "@google/adk";
import { A2A_PARENT_KEY, parentRefSchema, type ParentRef } from "@stage/agents/parent-ref";
import { promptSchema } from "@stage/agents/task-contract";

import { guard } from "../../errors";
import type { AgentsService } from "../agents/agents-service";
import type { SessionsStore } from "../tasks/sessions/sessions-store";
import type { TasksService } from "../tasks/tasks-service";
import {
  A2A_CARD_VERSION,
  A2A_MAX_IN_FLIGHT,
  A2A_PROTOCOL_VERSION,
  A2A_STREAMING_METHODS,
  A2A_TASKS_KEPT,
  WEB_SEARCH_PREFIX,
} from "./a2a-model";
import { createBoundedTaskStore } from "./a2a-task-store";

export type A2aServiceDeps = {
  agentsService: Pick<AgentsService, "agentCard">;
  tasksService: Pick<TasksService, "create" | "run" | "get">;
  sessionsStore: Pick<SessionsStore, "get" | "list">;
  // The jobs that are served; undefined serves any.
  allowedJobs?: ReadonlySet<string>;
};

export type A2aConfig = {
  // How often a delegated run is checked, and how long the gateway waits for it. Keep the wait below
  // the service's own request timeout, or the platform cuts the request before the gateway answers.
  pollMs?: number;
  timeoutMs?: number;
  // Delegated runs waited for at once; one more is refused.
  maxInFlight?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// The A2A face of the registered agents. A message becomes an ordinary task and session, run by the
// agent's job, so a delegated run shows up like any other run.
export type A2aService = {
  // The A2A Agent Card of a served agent; undefined when the job is not served or has no such agent.
  card: (jobName: string, agentName: string, baseUrl: string) => Promise<AgentCard | undefined>;
  // Answers one JSON-RPC request to the agent's endpoint with a plain JSON-RPC response; undefined
  // for an agent that is not served.
  handle: (
    jobName: string,
    agentName: string,
    baseUrl: string,
    body: unknown,
  ) => Promise<unknown | undefined>;
};

const textOf = (message: Message) => {
  const parts = message.parts;
  if (!parts.every((part) => part.kind === "text")) return undefined;
  return parts.map((part) => part.text).join("\n");
};

const lastReply = (events: Parameters<typeof isFinalResponse>[0][] = []) => {
  const final = events.findLast((event) => isFinalResponse(event) && event.content?.parts?.length);
  return final ? stringifyContent(final).trim() : "";
};

const status = (state: "submitted" | "working" | "completed" | "failed", note?: string) => ({
  state,
  timestamp: new Date().toISOString(),
  ...(note && {
    message: {
      kind: "message" as const,
      messageId: crypto.randomUUID(),
      role: "agent" as const,
      parts: [{ kind: "text" as const, text: note }],
    },
  }),
});

export const createA2aService = (
  { agentsService, tasksService, sessionsStore, allowedJobs }: A2aServiceDeps,
  {
    pollMs = 2_000,
    timeoutMs = 240_000,
    maxInFlight = A2A_MAX_IN_FLIGHT,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: A2aConfig = {},
): A2aService => {
  // The task and session an agent says it is calling from. The claim comes from an unauthenticated caller,
  // so it counts only for a task that exists and a session that is still running; otherwise the task is
  // created without a parent.
  const parentOf = async (metadata: Message["metadata"]): Promise<ParentRef | undefined> => {
    if (!metadata || !(A2A_PARENT_KEY in metadata)) return undefined;
    const ref = parentRefSchema.safeParse(metadata[A2A_PARENT_KEY]);
    if (ref.success) {
      // The summaries carry the run state without the session's events, which can be long.
      const [task, sessions] = await Promise.all([
        tasksService.get(ref.data.taskId),
        sessionsStore.list(ref.data.taskId),
      ]);
      const session = sessions.find(({ id }) => id === ref.data.sessionId);
      if (task && session?.run?.status === "running") return ref.data;
    }
    console.warn("A2A parent reference ignored");
    return undefined;
  };

  let inFlight = 0;
  // One bounded store for every agent: the gateway needs a task only while it answers.
  const taskStore = createBoundedTaskStore(A2A_TASKS_KEPT);
  const executorFor = (jobName: string, agentName: string): AgentExecutor => ({
    async execute(
      { userMessage, taskId, contextId, task }: RequestContext,
      bus: ExecutionEventBus,
    ) {
      const finish = (state: "completed" | "failed", note?: string) => {
        bus.publish({
          kind: "status-update",
          taskId,
          contextId,
          final: true,
          status: status(state, note),
        });
        bus.finished();
      };

      const text = textOf(userMessage);
      const prompt = text === undefined ? undefined : promptSchema.safeParse(text);
      // A message is kept in the task's history only once it is accepted.
      if (!task)
        bus.publish({
          kind: "task",
          id: taskId,
          contextId,
          status: status("submitted"),
          ...(prompt?.success && { history: [userMessage] }),
        });
      bus.publish({
        kind: "status-update",
        taskId,
        contextId,
        final: false,
        status: status("working"),
      });

      if (!prompt) return finish("failed", "Only text parts are supported.");
      if (!prompt.success)
        return finish("failed", "The message must have 1 to 10000 characters of text.");
      if (inFlight >= maxInFlight)
        return finish("failed", "Too many delegated runs are in flight; try again later.");
      // Text another agent wrote must not start with the discovery agent's explicit-query line.
      const message = prompt.data.replace(WEB_SEARCH_PREFIX, "Web search -");

      inFlight++;
      try {
        const parent = await parentOf(userMessage.metadata);
        const created = await tasksService.create({
          name: `a2a: ${message.slice(0, 60)}`,
          prompt: message,
          jobName,
          agentName,
          ...(parent && { parentTaskId: parent.taskId, parentSessionId: parent.sessionId }),
        });
        if (created.status !== "created")
          return finish("failed", `Cannot run the agent: ${created.status}.`);
        const { taskId: platformTaskId } = created.task;
        const started = await tasksService.run(platformTaskId, { message });
        if (started.status !== "started" || !started.sessionId)
          return finish("failed", `Cannot run the agent: ${started.status}.`);

        const deadline = now() + timeoutMs;
        for (;;) {
          const session = await sessionsStore.get(platformTaskId, started.sessionId);
          if (session?.run?.status === "failed") {
            // The detail stays in the logs and the sessions API; the caller gets a fixed message.
            console.error("A2A delegated run failed", {
              taskId: platformTaskId,
              error: session.run.error,
            });
            return finish("failed", "The agent run failed.");
          }
          if (session?.run?.status === "succeeded") {
            const reply = lastReply(session.events);
            if (!reply) return finish("failed", "The agent returned no final response.");
            bus.publish({
              kind: "artifact-update",
              taskId,
              contextId,
              artifact: {
                artifactId: crypto.randomUUID(),
                name: "reply",
                parts: [{ kind: "text", text: reply }],
              },
            });
            return finish("completed");
          }
          if (now() >= deadline) return finish("failed", "The agent run timed out.");
          await sleep(pollMs);
        }
      } catch (err) {
        console.error("A2A delegated run failed", err);
        return finish("failed", "The platform could not run the agent.");
      } finally {
        inFlight--;
      }
    },
    // A run cannot be stopped from here; the job finishes on its own.
    async cancelTask(taskId) {
      throw A2AError.taskNotCancelable(taskId);
    },
  });

  const card = async (jobName: string, agentName: string, baseUrl: string) => {
    if (allowedJobs && !allowedJobs.has(jobName)) return undefined;
    const base = await agentsService.agentCard(jobName, agentName);
    if (!base) return undefined;
    return {
      ...base,
      url: `${baseUrl}/a2a/${jobName}/${agentName}`,
      protocolVersion: A2A_PROTOCOL_VERSION,
      version: A2A_CARD_VERSION,
      preferredTransport: "JSONRPC",
      capabilities: { streaming: false, pushNotifications: false },
    } satisfies AgentCard;
  };

  // One handler per agent, built with the card of the first request; the card's url only matters to
  // a client that asks the handler for it, which this gateway does not offer.
  const handlers = new Map<string, JsonRpcTransportHandler>();
  const handlerFor = async (jobName: string, agentName: string, baseUrl: string) => {
    // The registry decides on every request, so an agent that is removed stops being served.
    const agentCard = await card(jobName, agentName, baseUrl);
    if (!agentCard) return undefined;
    const key = `${jobName}/${agentName}`;
    const cached = handlers.get(key);
    if (cached) return cached;
    const handler = new JsonRpcTransportHandler(
      new DefaultRequestHandler(agentCard, taskStore, executorFor(jobName, agentName)),
    );
    handlers.set(key, handler);
    return handler;
  };

  return {
    card: (jobName, agentName, baseUrl) =>
      guard("a2a_error", () => card(jobName, agentName, baseUrl)),
    async handle(jobName, agentName, baseUrl, body) {
      const handler = await guard("a2a_error", () => handlerFor(jobName, agentName, baseUrl));
      if (!handler) return undefined;
      const request = (body ?? {}) as { id?: unknown; method?: unknown };
      if (typeof request.method === "string" && A2A_STREAMING_METHODS.has(request.method))
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: A2AError.unsupportedOperation(request.method).toJSONRPCError(),
        };
      const result = await handler.handle(body);
      // Streaming methods are refused above, so a stream here is a gateway bug, not a client error.
      if (Symbol.asyncIterator in Object(result))
        throw new Error("Unexpected streaming response from the A2A handler");
      return result;
    },
  };
};
