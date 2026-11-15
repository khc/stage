export type FeedItem = { id: string; data: string };
// "idle" means nothing arrived for the idle interval; a transport may use it as a keepalive.
export type FeedEntry = FeedItem | "idle";

const noop = () => {};

export type EventFeedOptions = {
  signal: AbortSignal;
  idleMs: number;
  // Remember only the latest N ids, for streams that never end.
  seenLimit?: number;
};

// Turns events that are pushed one by one into an async sequence. An id is
// delivered once (delivery from Pub/Sub is at least once), `prepend` puts
// older events in front of anything already waiting, and the sequence ends
// when the signal aborts.
export class EventFeed {
  readonly entries: AsyncGenerator<FeedEntry>;
  private readonly waiting: FeedItem[] = [];
  private readonly seen = new Set<string>();
  private wake = noop;
  private readonly options: EventFeedOptions;

  constructor(options: EventFeedOptions) {
    this.options = options;
    options.signal.addEventListener("abort", () => this.wake(), { once: true });
    this.entries = this.generate();
  }

  // Arrow properties: `push` is handed to stream subscribers as a bare callback.
  push = (id: string, data: string) => {
    this.waiting.push({ id, data });
    this.wake();
  };

  prepend = (items: FeedItem[]) => {
    this.waiting.unshift(...items);
  };

  private async *generate(): AsyncGenerator<FeedEntry> {
    const { signal, idleMs, seenLimit } = this.options;
    const { waiting, seen } = this;
    while (!signal.aborted) {
      for (const item of waiting.splice(0)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (seenLimit && seen.size > seenLimit) seen.delete(seen.values().next().value!);
        yield item;
      }
      if (waiting.length) continue;
      const arrived = await new Promise<boolean>((resolve) => {
        // The signal may have aborted while the consumer was busy with the last entry.
        if (signal.aborted) return resolve(true);
        const timer = setTimeout(() => resolve(false), idleMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      if (!arrived && !signal.aborted) yield "idle";
    }
  }
}

export const createEventFeed = (options: EventFeedOptions) => new EventFeed(options);
