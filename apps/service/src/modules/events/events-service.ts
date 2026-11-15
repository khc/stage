import { DependencyError } from "../../errors";
import type { PlatformEventStream } from "../../platform/platform-event-stream";
import { createEventFeed, type FeedEntry } from "../../utils/event-feed";

// Only the latest ids are remembered, because this stream never ends.
const SEEN_LIMIT = 1_000;

export type EventsServiceDeps = { platformEventStream: PlatformEventStream };

// The service's own events (task created, run requested, ...).
export type EventsService = {
  // Events as they happen, each id once, until the signal aborts. `idleMs` sets how often "idle" is reported.
  stream: (options: { signal: AbortSignal; idleMs: number }) => Promise<AsyncIterable<FeedEntry>>;
};

export const createEventsService = ({ platformEventStream }: EventsServiceDeps): EventsService => ({
  async stream({ signal, idleMs }) {
    const feed = createEventFeed({ signal, idleMs, seenLimit: SEEN_LIMIT });
    let unsubscribe: () => void;
    try {
      unsubscribe = await platformEventStream(feed.push);
    } catch (err) {
      throw new DependencyError("events_error", err);
    }
    if (signal.aborted) unsubscribe();
    else signal.addEventListener("abort", unsubscribe, { once: true });
    return feed.entries;
  },
});
