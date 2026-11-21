import { Firestore } from "@google-cloud/firestore";
import { annotateJob, flushTelemetry, traceJob } from "@stage/http/otel";
import { z } from "zod";

import { createAgentRegistry, type AgentInfo, type AgentRegistry } from "./agent-registry";
import type { ModelRef } from "./model-ref";
import { ModelUnavailableError, createModelResolver, type ResolveModel } from "./provider-models";
import { appName, createRunAgent, userId, type ResolveRunModel, type RunAgent } from "./runtime";
import { FirestoreSessionService } from "./session-service";
import { describeAgents, type AgentSet } from "./spec";
import { createGetTask, promptSchema, type GetTask } from "./task-contract";

// The next message of a session being resumed; the service queues it in Firestore.
export type GetMessage = (taskId: string, sessionId: string) => Promise<string | undefined>;

export const createGetMessage =
  (sessions: Pick<FirestoreSessionService, "findOwner" | "pendingMessage">): GetMessage =>
  async (_taskId, sessionId) =>
    sessions.pendingMessage({
      ...((await sessions.findOwner(sessionId)) ?? { appName, userId }),
      sessionId,
    });

// The model queued with the next message of a session, if one was chosen for it.
export type GetMessageModel = (sessionId: string) => Promise<ModelRef | undefined>;

export const createGetMessageModel =
  (sessions: Pick<FirestoreSessionService, "findOwner" | "pendingModel">): GetMessageModel =>
  async (sessionId) =>
    sessions.pendingModel({
      ...((await sessions.findOwner(sessionId)) ?? { appName, userId }),
      sessionId,
    });

// The model of a run: the one chosen for the message, else the task's default, else none (the job
// default). A message model that cannot be used fails the run; a task default that cannot be used is
// skipped with a warning, since nobody chose it for this message.
const modelFor = (
  messageModel: ModelRef | undefined,
  defaultModel: ModelRef | undefined,
  resolve: ResolveModel,
): ResolveRunModel | undefined => {
  if (messageModel) return () => resolve(messageModel);
  if (!defaultModel) return undefined;
  return async () => {
    try {
      return await resolve(defaultModel);
    } catch (err) {
      if (!(err instanceof ModelUnavailableError)) throw err;
      console.warn(`Skipping the task's default model: ${err.message}`);
      return undefined;
    }
  };
};

const taskIdSchema = z.uuid().transform((id) => id.toLowerCase());

export const main = async (
  env: Record<string, string | undefined>,
  run: RunAgent,
  getTask: GetTask,
  getMessage: GetMessage,
  getMessageModel: GetMessageModel = async () => undefined,
  resolveModel?: ResolveModel,
): Promise<number> => {
  const id = taskIdSchema.safeParse(env.TASK_ID);
  if (!id.success) {
    console.error("TASK_ID is required and must be a UUID");
    return 1;
  }
  annotateJob({ "stage.task_id": id.data });
  try {
    const contract = await getTask(id.data);
    if (!contract) throw new Error("Task contract not found");
    if (!promptSchema.safeParse(contract.prompt).success)
      throw new Error("Task contract has an invalid prompt");
    const sessionId = env.SESSION_ID || undefined;
    const message = sessionId ? await getMessage(id.data, sessionId) : contract.prompt;
    if (!promptSchema.safeParse(message).success)
      throw new Error("No queued message to resume this session");
    const messageModel = sessionId ? await getMessageModel(sessionId) : undefined;
    const model = resolveModel && modelFor(messageModel, contract.defaultModel, resolveModel);
    console.log(
      await (model
        ? run(message!, id.data, sessionId, contract.agentName, model)
        : run(message!, id.data, sessionId, contract.agentName)),
    );
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  }
};

const jobNameSchema = z.string().min(1);

// `register` execution mode: records this container's agents for its job.
export const registerMain = async (
  env: Record<string, string | undefined>,
  register: AgentRegistry["register"],
  agents: AgentInfo[],
): Promise<number> => {
  const job = jobNameSchema.safeParse(env.JOB_NAME);
  if (!job.success) {
    console.error("JOB_NAME is required to register agents");
    return 1;
  }
  try {
    await register(job.data, agents);
    console.log(`Registered ${agents.map((a) => a.name).join(", ")}`);
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  }
};

// Entrypoint of a job image: runs a task, or with the `register` argument
// records the image's agents for its job.
export const runCli = async (set: AgentSet, argv = process.argv, env = process.env) => {
  const db = new Firestore();
  const sessions = new FirestoreSessionService(db);
  const register = argv[2] === "register";
  const code = await traceJob(register ? "register_agents" : "agent_job", async () =>
    register
      ? registerMain(env, createAgentRegistry(db).register, describeAgents(set.agents))
      : main(
          env,
          createRunAgent(set, { db }),
          createGetTask(db),
          createGetMessage(sessions),
          createGetMessageModel(sessions),
          createModelResolver(db),
        ),
  );
  await flushTelemetry();
  process.exit(code);
};
