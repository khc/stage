import { DependencyError } from "../errors";
import type { SessionEventStream } from "../platform/session-event-stream";
import type { SessionStore } from "../stores/session-store";
import type { TaskStore } from "../stores/task-store";
import { createEventFeed, type FeedEntry } from "./event-feed";

const noop = () => {};

export type SessionServiceDeps = {
  tasks: Pick<TaskStore, "get">;
  sessions: SessionStore;
  sessionEventStream?: SessionEventStream;
};

export type MessageStream =
  | { status: "ok"; entries: AsyncIterable<FeedEntry> }
  | { status: "task_not_found" | "session_not_found" };

// Operations on the sessions of a task. Expected outcomes are statuses; a
// failing dependency throws a DependencyError.
export type SessionService = {
  // The events of a session: the stored ones first, then the live ones, each id
  // once, until the signal aborts. `idleMs` sets how often "idle" is reported.
  messages: (
    taskId: string,
    sessionId: string,
    options: { signal: AbortSignal; idleMs: number },
  ) => Promise<MessageStream>;
};

export const createSessionService = ({
  tasks,
  sessions,
  sessionEventStream,
}: SessionServiceDeps): SessionService => ({
  async messages(taskId, sessionId, { signal, idleMs }) {
    const feed = createEventFeed({ signal, idleMs });
    let unsubscribe = noop;
    try {
      if (!(await tasks.get(taskId))) return { status: "task_not_found" };
      // Subscribe before reading history so no event falls in the gap.
      unsubscribe = (await sessionEventStream?.(taskId, sessionId, feed.push)) ?? unsubscribe;
      const session = await sessions.get(taskId, sessionId);
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
