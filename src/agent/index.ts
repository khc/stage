import { Firestore } from "@google-cloud/firestore";
import { Runner, isFinalResponse, stringifyContent } from "@google/adk";
import { rootAgent } from "./agent";
import { FirestoreSessionService } from "./session-service";

export type RunAgent = (message: string) => Promise<string>;
type RunnerLike = Pick<Runner, "sessionService" | "runAsync">;

const appName = "agent-jobs";
const userId = "user";

export const createRunAgent =
  (runner: RunnerLike): RunAgent =>
  async (message) => {
    const session = await runner.sessionService.createSession({ appName, userId });
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
  };

export const runAgent = createRunAgent(
  new Runner({
    appName,
    agent: rootAgent,
    sessionService: new FirestoreSessionService(new Firestore()),
  }),
);
