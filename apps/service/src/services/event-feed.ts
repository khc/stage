export type FeedItem = { id: string; data: string };
// "idle" means nothing arrived for the idle interval; a transport may use it as a keepalive.
export type FeedEntry = FeedItem | "idle";

const noop = () => {};

// Turns events that are pushed one by one into an async sequence. An id is
// delivered once (delivery from Pub/Sub is at least once), `prepend` puts
// older events in front of anything already waiting, and the sequence ends
// when the signal aborts.
export const createEventFeed = (options: {
  signal: AbortSignal;
  idleMs: number;
  // Remember only the latest N ids, for streams that never end.
  seenLimit?: number;
}) => {
  const { signal, idleMs, seenLimit } = options;
  const waiting: FeedItem[] = [];
  const seen = new Set<string>();
  let wake = noop;
  signal.addEventListener("abort", () => wake(), { once: true });

  async function* entries(): AsyncGenerator<FeedEntry> {
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
        wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      if (!arrived && !signal.aborted) yield "idle";
    }
  }

  return {
    push(id: string, data: string) {
      waiting.push({ id, data });
      wake();
    },
    prepend(items: FeedItem[]) {
      waiting.unshift(...items);
    },
    entries: entries(),
  };
};
