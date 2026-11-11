import { Firestore } from "@google-cloud/firestore";
import { Runner, isFinalResponse, stringifyContent } from "@google/adk";
import { rootAgent } from "./agent";
import { FirestoreSessionService } from "./session-service";
import { publisherFromEnv, type PublishEvent } from "./event-publisher";

export { FirestoreSessionService } from "./session-service";
export {
  createGetTask,
  type GetTask,
  type TaskContract,
} from "./task-contract";

export type RunAgent = (
  message: string,
  taskId?: string,
  sessionId?: string,
) => Promise<string>;
type RunnerLike = Pick<Runner, "runAsync"> & {
  sessionService: Pick<FirestoreSessionService, "createSession" | "getSession">;
};

const appName = "agent-jobs";
const userId = "user";

const resumeSession = async (
  service: RunnerLike["sessionService"],
  sessionId: string,
  taskId?: string,
) => {
  const session = await service.getSession({ appName, userId, sessionId });
  if (!session || session.taskId !== taskId)
    throw new Error("Session not found for this task");
  return session;
};

export const createTaskAgent =
  (runner: RunnerLike, publish?: PublishEvent): RunAgent =>
  async (message, taskId, sessionId) => {
    const session = sessionId
      ? await resumeSession(runner.sessionService, sessionId, taskId)
      : await runner.sessionService.createSession({
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
      await publish?.(event, { sessionId: session.id, taskId }).catch((err) =>
        console.error("Failed to publish event", err),
      );
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
  publisherFromEnv(process.env),
);
