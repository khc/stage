import { Firestore } from "@google-cloud/firestore";
import { Runner, isFinalResponse, stringifyContent, type BaseLlm } from "@google/adk";
import { annotateJob } from "@stage/http/otel";

import { publisherFromEnv, type PublishEvent } from "./event-publisher";
import { runWithModel } from "./model";
import { FirestoreSessionService, toSessionName } from "./session-service";
import { checkInput, type AgentSet } from "./spec";

// Finds the model the run uses; called once the run has started, so a model that cannot be used
// fails the run on its session. No model means the job default.
export type ResolveRunModel = () => Promise<BaseLlm | undefined>;

export type RunAgent = (
  message: string,
  taskId?: string,
  sessionId?: string,
  agentName?: string,
  resolveModel?: ResolveRunModel,
) => Promise<string>;
type RunnerLike = Pick<Runner, "runAsync"> & {
  sessionService: Pick<
    FirestoreSessionService,
    "createSession" | "getSession" | "startRun" | "finishRun"
  >;
};

export const appName = "stage";
export const userId = "user";
// Who a session belongs to: new sessions use the defaults, an existing one keeps its own.
export type Owner = { appName: string; userId: string };
const defaultOwner: Owner = { appName, userId };

const resumeSession = async (
  service: RunnerLike["sessionService"],
  owner: Owner,
  sessionId: string,
  taskId?: string,
) => {
  const session = await service.getSession({ ...owner, sessionId });
  if (!session || session.taskId !== taskId) throw new Error("Session not found for this task");
  return session;
};

const runSession = async (
  runner: RunnerLike,
  owner: Owner,
  sessionId: string,
  message: string,
  taskId?: string,
  publish?: PublishEvent,
) => {
  let reply = "";
  for await (const event of runner.runAsync({
    userId: owner.userId,
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
  (
    runner: RunnerLike,
    publish?: PublishEvent,
    owner: Owner = defaultOwner,
    validateFirstTurn?: (message: string) => void,
  ): RunAgent =>
  async (message, taskId, sessionId, _agentName, resolveModel) => {
    let session;
    if (sessionId) {
      session = await resumeSession(runner.sessionService, owner, sessionId, taskId);
      if ((session.events?.length ?? 0) === 0) validateFirstTurn?.(message);
    } else {
      validateFirstTurn?.(message);
      const name = toSessionName(message);
      session = await runner.sessionService.createSession({
        ...owner,
        ...(taskId !== undefined && { taskId }),
        ...(name !== undefined && { name }),
      });
    }
    const key = { ...owner, sessionId: session.id };
    // ADK and MLflow read these to group traces by session.
    annotateJob({
      "gcp.vertex.agent.session_id": session.id,
      "gen_ai.conversation.id": session.id,
    });
    await runner.sessionService.startRun(key);
    let reply: string;
    try {
      const llm = await resolveModel?.();
      const run = () => runSession(runner, owner, session.id, message, taskId, publish);
      reply = await (llm ? runWithModel(llm, run) : run());
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
  sessionService.onUserEvent = async (event, { id, taskId }) =>
    publish?.(event, { sessionId: id, taskId });
  return async (message, taskId, sessionId, agentName, resolveModel) => {
    const spec = agents[agentName ?? defaultAgent];
    if (!spec) throw new Error(`Unknown agent: ${agentName}`);
    const { agent } = spec;
    // A session created under another app name (before the rename) is resumed under its own.
    const owner = (sessionId && (await sessionService.findOwner(sessionId))) || defaultOwner;
    const runner = new Runner({ appName: owner.appName, agent, sessionService });
    const runAsync = runner.runAsync.bind(runner);
    // Turn 1 validates against `inputSchema` (even on pre-created empty sessions); follow-ups are free text.
    return createTaskAgent({ sessionService, runAsync }, publish, owner, (text) =>
      checkInput(spec, text),
    )(message, taskId, sessionId, agentName, resolveModel);
  };
};
