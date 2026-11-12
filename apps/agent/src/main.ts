import { Firestore } from "@google-cloud/firestore";
import { z } from "zod";
import { createGetTask, type GetTask } from "./task-contract";
import { runAgent, type RunAgent } from "./index";

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

if (import.meta.main)
  process.exit(
    await main(process.env, runAgent, createGetTask(new Firestore())),
  );
