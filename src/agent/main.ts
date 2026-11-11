import { Firestore } from "@google-cloud/firestore";
import { z } from "zod";
import { createGetRun, type GetRun } from "../run-contract";
import { runAgent, type RunAgent } from "./index";

const runIdSchema = z.uuid().transform((id) => id.toLowerCase());
const promptSchema = z.string().trim().min(1).max(10_000);

export const main = async (
  env: Record<string, string | undefined>,
  run: RunAgent,
  getRun: GetRun,
): Promise<number> => {
  const id = runIdSchema.safeParse(env.RUN_ID);
  if (!id.success) {
    console.error("RUN_ID is required and must be a UUID");
    return 1;
  }
  try {
    const contract = await getRun(id.data);
    if (!contract) throw new Error("Run contract not found");
    if (!promptSchema.safeParse(contract.prompt).success)
      throw new Error("Run contract has an invalid prompt");
    console.log(await run(contract.prompt));
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  }
};

if (import.meta.main)
  process.exit(
    await main(process.env, runAgent, createGetRun(new Firestore())),
  );
