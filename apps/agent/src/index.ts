import { Firestore } from "@google-cloud/firestore";
import { Runner, isFinalResponse, stringifyContent } from "@google/adk";
import { rootAgent } from "./agent";
import { FirestoreSessionService } from "./session-service";

export { FirestoreSessionService } from "./session-service";
export {
  createGetTask,
  type GetTask,
  type TaskContract,
} from "./task-contract";

export type RunAgent = (message: string, taskId?: string) => Promise<string>;
type RunnerLike = Pick<Runner, "runAsync"> & {
  sessionService: Pick<FirestoreSessionService, "createSession">;
};

const appName = "agent-jobs";
const userId = "user";

export const createTaskAgent =
  (runner: RunnerLike): RunAgent =>
  async (message, taskId) => {
    const session = await runner.sessionService.createSession({
      appName,
      userId,
      ...(taskId !== undefined && { taskId }),
    });
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

export const runAgent = createTaskAgent(
  new Runner({
    appName,
    agent: rootAgent,
    sessionService: new FirestoreSessionService(new Firestore()),
  }),
);
