import {
  FirestoreSessionService,
  runFields,
  runState,
  type RunState,
} from "@stage/agents/session-service";
import type { Firestore } from "@google-cloud/firestore";
import type { Session } from "@google/adk";

export type SessionSummary = Pick<Session, "id" | "appName" | "userId" | "lastUpdateTime"> & {
  taskId: string;
  run?: RunState;
};
export type TaskSessions = {
  list: (taskId: string) => Promise<SessionSummary[]>;
  get: (
    taskId: string,
    sessionId: string,
  ) => Promise<(Session & { taskId?: string; run?: RunState }) | undefined>;
  delete: (taskId: string, sessionId: string) => Promise<boolean>;
  // Stores the next message for the job that resumes the session; false when the session is not the task's.
  queueMessage: (taskId: string, sessionId: string, message: string) => Promise<boolean>;
  clearMessage: (taskId: string, sessionId: string) => Promise<void>;
};

const keyOf = (doc: { get: (field: string) => unknown }, sessionId: string) => ({
  appName: doc.get("appName") as string,
  userId: doc.get("userId") as string,
  sessionId,
});
const withRun = (run?: RunState) => (run ? { run } : {});

export const createTaskSessions = (db: Firestore): TaskSessions => {
  const service = new FirestoreSessionService(db);
  const find = async (taskId: string, sessionId: string) =>
    (
      await db
        .collection("sessions")
        .where("taskId", "==", taskId)
        .where("sessionId", "==", sessionId)
        .limit(1)
        .get()
    ).docs[0];
  return {
    async list(taskId) {
      const snapshot = await db.collection("sessions").where("taskId", "==", taskId).get();
      return snapshot.docs.map((doc) => ({
        id: doc.get("sessionId"),
        taskId,
        appName: doc.get("appName"),
        userId: doc.get("userId"),
        lastUpdateTime: doc.get("lastUpdateTime"),
        ...withRun(runState(runFields(doc))),
      }));
    },
    async get(taskId, sessionId) {
      const doc = await find(taskId, sessionId);
      if (!doc) return undefined;
      const session = await service.getSession({
        appName: doc.get("appName"),
        userId: doc.get("userId"),
        sessionId,
      });
      return session?.taskId === taskId ? session : undefined;
    },
    async queueMessage(taskId, sessionId, message) {
      const doc = await find(taskId, sessionId);
      if (!doc) return false;
      await service.queueMessage(keyOf(doc, sessionId), message);
      return true;
    },
    async clearMessage(taskId, sessionId) {
      const doc = await find(taskId, sessionId);
      if (doc) await service.clearMessage(keyOf(doc, sessionId));
    },
    async delete(taskId, sessionId) {
      const doc = await find(taskId, sessionId);
      if (!doc) return false;
      await service.deleteSession({
        appName: doc.get("appName"),
        userId: doc.get("userId"),
        sessionId,
      });
      return true;
    },
  };
};
