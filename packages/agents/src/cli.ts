import { Firestore } from "@google-cloud/firestore";
import { z } from "zod";

import { createAgentRegistry, type AgentInfo, type AgentRegistry } from "./agent-registry";
import { appName, createRunAgent, userId, type RunAgent } from "./runtime";
import { FirestoreSessionService } from "./session-service";
import { describeAgents, type AgentSet } from "./spec";
import { createGetTask, type GetTask } from "./task-contract";

// The next message of a session being resumed; the service queues it in Firestore.
export type GetMessage = (taskId: string, sessionId: string) => Promise<string | undefined>;

export const createGetMessage =
  (sessions: Pick<FirestoreSessionService, "findOwner" | "pendingMessage">): GetMessage =>
  async (_taskId, sessionId) =>
    sessions.pendingMessage({
      ...((await sessions.findOwner(sessionId)) ?? { appName, userId }),
      sessionId,
    });

const taskIdSchema = z.uuid().transform((id) => id.toLowerCase());
const promptSchema = z.string().trim().min(1).max(10_000);

export const main = async (
  env: Record<string, string | undefined>,
  run: RunAgent,
  getTask: GetTask,
  getMessage: GetMessage,
): Promise<number> => {
  const id = taskIdSchema.safeParse(env.TASK_ID);
  if (!id.success) {
    console.error("TASK_ID is required and must be a UUID");
    return 1;
  }
  try {
    const contract = await getTask(id.data);
    if (!contract) throw new Error("Task contract not found");
    if (!promptSchema.safeParse(contract.prompt).success)
      throw new Error("Task contract has an invalid prompt");
    const sessionId = env.SESSION_ID || undefined;
    const message = sessionId ? await getMessage(id.data, sessionId) : contract.prompt;
    if (!promptSchema.safeParse(message).success)
      throw new Error("No queued message to resume this session");
    console.log(await run(message!, id.data, sessionId, contract.agentName));
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
  process.exit(
    argv[2] === "register"
      ? await registerMain(env, createAgentRegistry(db).register, describeAgents(set.agents))
      : await main(env, createRunAgent(set, { db }), createGetTask(db), createGetMessage(sessions)),
  );
};
