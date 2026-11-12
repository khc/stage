import { Firestore } from "@google-cloud/firestore";
import { z } from "zod";
import { createGetTask, type GetTask } from "./task-contract";
import {
  createRegisterAgents,
  type AgentInfo,
  type RegisterAgents,
} from "./agent-registry";
import { createRunAgent, type RunAgent } from "./runtime";
import { describeAgents, type AgentSet } from "./spec";

const taskIdSchema = z.uuid().transform((id) => id.toLowerCase());
const promptSchema = z.string().trim().min(1).max(10_000);

export const main = async (
  env: Record<string, string | undefined>,
  run: RunAgent,
  getTask: GetTask,
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
    const message = sessionId ? env.MESSAGE : contract.prompt;
    if (!promptSchema.safeParse(message).success)
      throw new Error("MESSAGE is required to resume a session");
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
  register: RegisterAgents,
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
export const runCli = async (
  set: AgentSet,
  argv = process.argv,
  env = process.env,
) => {
  const db = new Firestore();
  process.exit(
    argv[2] === "register"
      ? await registerMain(
          env,
          createRegisterAgents(db),
          describeAgents(set.agents),
        )
      : await main(env, createRunAgent(set, { db }), createGetTask(db)),
  );
};
