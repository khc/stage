import { DependencyError, guard } from "../../../errors";
import type { SessionEventStream } from "../../../platform/session-event-stream";
import { createEventFeed, type FeedEntry } from "../../../utils/event-feed";
import { sessionStats, type SessionStats } from "./sessions-stats";
import type { SessionSummary, SessionsStore } from "./sessions-store";

const noop = () => {};
// A client that stalls must not grow the queue without bound.
const MAX_QUEUED = 10_000;

export type SessionsServiceDeps = {
  sessionsStore: SessionsStore;
  // Undefined when PUBSUB_TOPIC is not set: messages then serve only the stored events.
  sessionEventStream?: SessionEventStream;
};

type Session = NonNullable<Awaited<ReturnType<SessionsStore["get"]>>>;

export type MessageStream =
  | { status: "ok"; entries: AsyncIterable<FeedEntry> }
  | { status: "session_not_found" };

// Operations on the sessions of a task, which the caller has already checked exists.
// Expected outcomes are statuses; a failing dependency throws a DependencyError.
export type SessionsService = {
  list: (taskId: string) => Promise<SessionSummary[]>;
  get: (taskId: string, sessionId: string) => Promise<Session | undefined>;
  stats: (taskId: string, sessionId: string) => Promise<SessionStats | undefined>;
  // False when there was no such session in the task.
  delete: (taskId: string, sessionId: string) => Promise<boolean>;
  // The events of a session: the stored ones first, then the live ones, each id once, until
  // the signal aborts. `idleMs` sets how often "idle" is reported.
  messages: (
    taskId: string,
    sessionId: string,
    options: { signal: AbortSignal; idleMs: number },
  ) => Promise<MessageStream>;
};

export const createSessionsService = ({
  sessionsStore,
  sessionEventStream,
}: SessionsServiceDeps): SessionsService => ({
  list: (taskId) => guard("session_error", () => sessionsStore.list(taskId)),
  get: (taskId, sessionId) => guard("session_error", () => sessionsStore.get(taskId, sessionId)),
  stats: (taskId, sessionId) =>
    guard("session_error", async () => {
      const session = await sessionsStore.get(taskId, sessionId);
      return session && sessionStats(session);
    }),
  delete: (taskId, sessionId) =>
    guard("session_error", () => sessionsStore.delete(taskId, sessionId)),
  async messages(taskId, sessionId, { signal, idleMs }) {
    const feed = createEventFeed({
      signal,
      idleMs,
      maxQueued: MAX_QUEUED,
    });
    let unsubscribe = noop;
    try {
      // Subscribe before reading history so no event falls in the gap.
      unsubscribe = (await sessionEventStream?.(taskId, sessionId, feed.push)) ?? unsubscribe;
      const session = await sessionsStore.get(taskId, sessionId);
      if (!session) {
        unsubscribe();
        return { status: "session_not_found" };
      }
      feed.prepend(session.events.map((event) => ({ id: event.id, data: JSON.stringify(event) })));
      if (signal.aborted) unsubscribe();
      else signal.addEventListener("abort", unsubscribe, { once: true });
      return { status: "ok", entries: feed.entries };
    } catch (err) {
      unsubscribe();
      throw new DependencyError("events_error", err);
    }
  },
});
