import type { Firestore } from "@google-cloud/firestore";
import type { Session } from "@google/adk";
import { FirestoreSessionService } from "@agent-jobs/agent/session-service";

export type SessionSummary = Pick<
  Session,
  "id" | "appName" | "userId" | "lastUpdateTime"
> & { taskId: string };
export type TaskSessions = {
  list: (taskId: string) => Promise<SessionSummary[]>;
  get: (
    taskId: string,
    sessionId: string,
  ) => Promise<(Session & { taskId?: string }) | undefined>;
};

export const createTaskSessions = (db: Firestore): TaskSessions => {
  const service = new FirestoreSessionService(db);
  return {
    async list(taskId) {
      const snapshot = await db
        .collection("sessions")
        .where("taskId", "==", taskId)
        .get();
      return snapshot.docs.map((doc) => ({
        id: doc.get("sessionId"),
        taskId,
        appName: doc.get("appName"),
        userId: doc.get("userId"),
        lastUpdateTime: doc.get("lastUpdateTime"),
      }));
    },
    async get(taskId, sessionId) {
      const snapshot = await db
        .collection("sessions")
        .where("taskId", "==", taskId)
        .where("sessionId", "==", sessionId)
        .limit(1)
        .get();
      const doc = snapshot.docs[0];
      if (!doc) return undefined;
      const session = await service.getSession({
        appName: doc.get("appName"),
        userId: doc.get("userId"),
        sessionId,
      });
      return session?.taskId === taskId ? session : undefined;
    },
  };
};
