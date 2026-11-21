import type { Firestore } from "@google-cloud/firestore";
import type { Session } from "@google/adk";
import type { ModelRef } from "@stage/agents/model-ref";
import type { RunMode } from "@stage/agents/run-mode";
import { appName, userId } from "@stage/agents/runtime";
import {
  FirestoreSessionService,
  RunInProgressError,
  runFields,
  runState,
  type RunState,
} from "@stage/agents/session-service";

export type SessionSummary = Pick<Session, "id" | "appName" | "userId" | "lastUpdateTime"> & {
  taskId: string;
  name?: string;
  run?: RunState;
};

// A thin adapter over the session service in @stage/agents, which the agent jobs use too
// (leases, run state, queued messages), so the service and the jobs share one implementation.
export type SessionsStore = {
  create: (taskId: string, name?: string) => Promise<string>;
  list: (taskId: string) => Promise<SessionSummary[]>;
  get: (
    taskId: string,
    sessionId: string,
  ) => Promise<(Session & { taskId?: string; name?: string; run?: RunState }) | undefined>;
  // False when there was no such session in the task.
  delete: (taskId: string, sessionId: string) => Promise<boolean>;
  // Stores the next message for the job that resumes the session; false when the session is not the task's.
  queueMessage: (
    taskId: string,
    sessionId: string,
    message: string,
    model?: ModelRef,
  ) => Promise<boolean>;
  clearMessage: (taskId: string, sessionId: string) => Promise<void>;
  // Records a failed run on a session whose run never started, so its event stream shows why. A session
  // another run holds is left alone.
  failRun: (taskId: string, sessionId: string, message: string, mode?: RunMode) => Promise<void>;
};

const keyOf = (doc: { get: (field: string) => unknown }, sessionId: string) => ({
  appName: doc.get("appName") as string,
  userId: doc.get("userId") as string,
  sessionId,
});

const toSessionSummary = (
  taskId: string,
  doc: { get: (field: string) => unknown },
): SessionSummary => {
  const name = doc.get("name") as string | undefined;
  const summary: SessionSummary = {
    id: doc.get("sessionId") as string,
    taskId,
    ...(name !== undefined && { name }),
    appName: doc.get("appName") as string,
    userId: doc.get("userId") as string,
    lastUpdateTime: doc.get("lastUpdateTime") as number,
  };
  const run = runState(runFields(doc));
  if (run) summary.run = run;
  return summary;
};

export const createSessionsStore = (firestore: Firestore): SessionsStore => {
  const sessionService = new FirestoreSessionService(firestore);
  const find = async (taskId: string, sessionId: string) =>
    (
      await firestore
        .collection("sessions")
        .where("taskId", "==", taskId)
        .where("sessionId", "==", sessionId)
        .limit(1)
        .get()
    ).docs[0];
  return {
    async create(taskId, name) {
      const session = await sessionService.createSession({
        appName,
        userId,
        taskId,
        ...(name !== undefined && { name }),
      });
      return session.id;
    },
    async list(taskId) {
      const snapshot = await firestore.collection("sessions").where("taskId", "==", taskId).get();
      return snapshot.docs.map((doc) => toSessionSummary(taskId, doc));
    },
    async get(taskId, sessionId) {
      const doc = await find(taskId, sessionId);
      if (!doc) return undefined;
      const session = await sessionService.getSession(keyOf(doc, sessionId));
      return session?.taskId === taskId ? session : undefined;
    },
    async queueMessage(taskId, sessionId, message, model) {
      const doc = await find(taskId, sessionId);
      if (!doc) return false;
      await sessionService.queueMessage(keyOf(doc, sessionId), message, { model });
      return true;
    },
    async clearMessage(taskId, sessionId) {
      const doc = await find(taskId, sessionId);
      if (doc) await sessionService.clearMessage(keyOf(doc, sessionId));
    },
    async failRun(taskId, sessionId, message, mode) {
      const doc = await find(taskId, sessionId);
      if (!doc) return;
      const key = keyOf(doc, sessionId);
      try {
        await sessionService.startRun(key, { mode });
      } catch (err) {
        if (err instanceof RunInProgressError) return;
        throw err;
      }
      await sessionService.finishRun(key, message);
    },
    async delete(taskId, sessionId) {
      const doc = await find(taskId, sessionId);
      if (!doc) return false;
      await sessionService.deleteSession(keyOf(doc, sessionId));
      return true;
    },
  };
};
