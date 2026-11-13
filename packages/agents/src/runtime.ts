import { Firestore } from "@google-cloud/firestore";
import { Runner, isFinalResponse, stringifyContent } from "@google/adk";

import { publisherFromEnv, type PublishEvent } from "./event-publisher";
import { FirestoreSessionService } from "./session-service";
import { checkInput, type AgentSet } from "./spec";

export type RunAgent = (
  message: string,
  taskId?: string,
  sessionId?: string,
  agentName?: string,
) => Promise<string>;
type RunnerLike = Pick<Runner, "runAsync"> & {
  sessionService: Pick<
    FirestoreSessionService,
    "createSession" | "getSession" | "startRun" | "finishRun"
  >;
};

export const appName = "stage";
export const userId = "user";

const resumeSession = async (
  service: RunnerLike["sessionService"],
  sessionId: string,
  taskId?: string,
) => {
  const session = await service.getSession({ appName, userId, sessionId });
  if (!session || session.taskId !== taskId) throw new Error("Session not found for this task");
  return session;
};

const runSession = async (
  runner: RunnerLike,
  sessionId: string,
  message: string,
  taskId?: string,
  publish?: PublishEvent,
) => {
  let reply = "";
  for await (const event of runner.runAsync({
    userId,
    sessionId,
    newMessage: { role: "user", parts: [{ text: message }] },
  })) {
    await publish?.(event, { sessionId, taskId }).catch((err) =>
      console.error("Failed to publish event", err),
    );
    if (isFinalResponse(event) && event.content?.parts?.length) {
      reply = stringifyContent(event).trim();
    }
  }
  if (!reply) throw new Error("Agent returned no final response");
  return reply;
};

export const createTaskAgent =
  (runner: RunnerLike, publish?: PublishEvent): RunAgent =>
  async (message, taskId, sessionId) => {
    const session = sessionId
      ? await resumeSession(runner.sessionService, sessionId, taskId)
      : await runner.sessionService.createSession({
          appName,
          userId,
          ...(taskId !== undefined && { taskId }),
        });
    const key = { appName, userId, sessionId: session.id };
    await runner.sessionService.startRun(key);
    let reply: string;
    try {
      reply = await runSession(runner, session.id, message, taskId, publish);
    } catch (err) {
      await runner.sessionService
        .finishRun(key, err instanceof Error ? err.message : String(err))
        .catch((finishErr) => console.error("Failed to record run failure", finishErr));
      throw err;
    }
    // The answer exists; failing to record that must not fail the job.
    await runner.sessionService
      .finishRun(key)
      .catch((finishErr) => console.error("Failed to record run success", finishErr));
    return reply;
  };

// Runs the named agent of a job image's agent set, or its default agent.
export const createRunAgent = (
  { agents, defaultAgent }: AgentSet,
  {
    db = new Firestore(),
    publish = publisherFromEnv(process.env),
  }: { db?: Firestore; publish?: PublishEvent } = {},
): RunAgent => {
  const sessionService = new FirestoreSessionService(db);
  return async (message, taskId, sessionId, agentName) => {
    const spec = agents[agentName ?? defaultAgent];
    if (!spec) throw new Error(`Unknown agent: ${agentName}`);
    checkInput(spec, message);
    const { agent } = spec;
    const runner = new Runner({ appName, agent, sessionService });
    const runAsync = runner.runAsync.bind(runner);
    return createTaskAgent({ sessionService, runAsync }, publish)(message, taskId, sessionId);
  };
};
