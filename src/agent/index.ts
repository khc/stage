import { InMemoryRunner, isFinalResponse, stringifyContent } from "@google/adk";
import { rootAgent } from "./agent";

export type RunAgent = (message: string) => Promise<string>;
type Runner = Pick<InMemoryRunner, "sessionService" | "runAsync">;

const appName = "agent-jobs";
const userId = "user";

export const createRunAgent =
  (runner: Runner): RunAgent =>
  async (message) => {
    const session = await runner.sessionService.createSession({ appName, userId });

    try {
      let reply = "";

      for await (const event of runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: message }] },
      })) {
        if (isFinalResponse(event) && event.content?.parts?.length) {
          reply = stringifyContent(event).trim();
        }
      }

      if (!reply) throw new Error("Agent returned no final response");
      return reply;
    } finally {
      await runner.sessionService.deleteSession({
        appName,
        userId,
        sessionId: session.id,
      });
    }
  };

export const runAgent = createRunAgent(
  new InMemoryRunner({ agent: rootAgent, appName }),
);
