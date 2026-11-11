import { runAgent, type RunAgent } from "./index";

export const main = async (
  env: Record<string, string | undefined>,
  run: RunAgent,
): Promise<number> => {
  const message = env.AGENT_MESSAGE?.trim();

  if (!message) {
    console.error("AGENT_MESSAGE is required");
    return 1;
  }

  try {
    console.log(await run(message));
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  }
};

if (import.meta.main) process.exit(await main(process.env, runAgent));
