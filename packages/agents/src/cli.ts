import { Firestore } from "@google-cloud/firestore";
import { annotateJob, flushTelemetry, traceJob } from "@stage/http/otel";
import { z } from "zod";

import { createAgentRegistry, type AgentInfo, type AgentRegistry } from "./agent-registry";
import type { ModelRef } from "./model-ref";
import type { RunMode } from "./run-mode";
import { ModelUnavailableError, createModelResolver, type ResolveModel } from "./provider-models";
import { appName, createRunAgent, userId, type ResolveRunModel, type RunAgent } from "./runtime";
import { createServeHandler, type RunTaskInput } from "./serve";
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

// Runs one task: loads its contract, picks the message (the stored prompt, or the queued one when
// resuming a session) and runs the agent. The job and the service both run tasks through it; it
// throws on any failure.
export const runTask = async (
  { taskId, sessionId }: RunTaskInput,
  run: RunAgent,
  getTask: GetTask,
  getMessage: GetMessage,
  getMessageModel: GetMessageModel = async () => undefined,
  resolveModel?: ResolveModel,
  signal?: AbortSignal,
): Promise<string> => {
  annotateJob({ "stage.task_id": taskId });
  const contract = await getTask(taskId);
  if (!contract) throw new Error("Task contract not found");
  if (!promptSchema.safeParse(contract.prompt).success)
    throw new Error("Task contract has an invalid prompt");
  const message = sessionId ? await getMessage(taskId, sessionId) : contract.prompt;
  if (!promptSchema.safeParse(message).success)
    throw new Error("No queued message to resume this session");
  const messageModel = sessionId ? await getMessageModel(sessionId) : undefined;
  const model = resolveModel && modelFor(messageModel, contract.defaultModel, resolveModel);
  const extra: [ResolveRunModel?, AbortSignal?] = signal ? [model, signal] : model ? [model] : [];
  return run(message!, taskId, sessionId, contract.agentName, ...extra);
};

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
  try {
    const sessionId = env.SESSION_ID || undefined;
    console.log(
      await runTask(
        { taskId: id.data, ...(sessionId && { sessionId }) },
        run,
        getTask,
        getMessage,
        getMessageModel,
        resolveModel,
      ),
    );
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  }
};

const jobNameSchema = z.string().min(1);

// An agent advertises `quick` only where its service is deployed: Terraform sets AGENT_QUICK on the
// job of such an app. Without it the mode is dropped, and an agent left with no modes is job only.
const withHostedModes = (env: Record<string, string | undefined>, agents: AgentInfo[]) =>
  env.AGENT_QUICK === "true"
    ? agents
    : agents.map(({ modes, ...agent }): AgentInfo => {
        const hosted = modes?.filter((mode) => mode !== "quick");
        return hosted?.length ? { ...agent, modes: hosted } : agent;
      });

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
    await register(job.data, withHostedModes(env, agents));
    console.log(`Registered ${agents.map((a) => a.name).join(", ")}`);
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  }
};

// How an execution mode hosts a run: `serve` is the quick service, any other mode the workflow job.
export const hostMode = (mode?: string): RunMode => (mode === "serve" ? "quick" : "workflow");

// `serve` execution mode: the HTTP host of the run path, listening on PORT (8080 by default).
// A run answers only when it has finished, so Bun's default idle timeout (10 s) would close the
// connection of any longer run: allow Bun's maximum. A run request is under 2 KB, so the body limit
// is far below Bun's default.
export const serveMain = (
  env: Record<string, string | undefined>,
  fetch: (req: Request) => Promise<Response>,
) =>
  Bun.serve({
    port: Number(env.PORT ?? 8080),
    hostname: "0.0.0.0",
    idleTimeout: 255,
    maxRequestBodySize: 16 * 1024,
    fetch,
  });

// Entrypoint of an agent image: runs a task, or with the `register` argument records the image's
// agents for its job, or with `serve` hosts the same run path over HTTP and keeps running.
export const runCli = async (set: AgentSet, argv = process.argv, env = process.env) => {
  const db = new Firestore();
  const sessions = new FirestoreSessionService(db);
  const mode = argv[2];
  const deps = () =>
    [
      createRunAgent(set, { db, mode: hostMode(mode) }),
      createGetTask(db),
      createGetMessage(sessions),
      createGetMessageModel(sessions),
      createModelResolver(db),
    ] as const;
  if (mode === "serve") {
    const [run, getTask, getMessage, getMessageModel, resolveModel] = deps();
    serveMain(
      env,
      createServeHandler((input, signal) =>
        runTask(input, run, getTask, getMessage, getMessageModel, resolveModel, signal),
      ),
    );
    return;
  }
  const register = mode === "register";
  const code = await traceJob(register ? "register_agents" : "agent_job", async () =>
    register
      ? registerMain(env, createAgentRegistry(db).register, describeAgents(set.agents))
      : main(env, ...deps()),
  );
  await flushTelemetry();
  process.exit(code);
};
