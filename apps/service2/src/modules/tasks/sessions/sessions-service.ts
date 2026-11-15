import { guard } from "../../../errors";
import type { SessionSummary, SessionsStore } from "./sessions-store";

export type SessionsServiceDeps = { sessionsStore: SessionsStore };

type Session = NonNullable<Awaited<ReturnType<SessionsStore["get"]>>>;

// Operations on the sessions of a task, which the caller has already checked exists.
// A failing dependency throws a DependencyError.
export type SessionsService = {
  list: (taskId: string) => Promise<SessionSummary[]>;
  get: (taskId: string, sessionId: string) => Promise<Session | undefined>;
  // False when there was no such session in the task.
  delete: (taskId: string, sessionId: string) => Promise<boolean>;
};

export const createSessionsService = ({ sessionsStore }: SessionsServiceDeps): SessionsService => ({
  list: (taskId) => guard("session_error", () => sessionsStore.list(taskId)),
  get: (taskId, sessionId) => guard("session_error", () => sessionsStore.get(taskId, sessionId)),
  delete: (taskId, sessionId) =>
    guard("session_error", () => sessionsStore.delete(taskId, sessionId)),
});
