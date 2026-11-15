import { sse } from "elysia";

import type { FeedEntry } from "./event-feed";

export const KEEPALIVE_MS = 5_000;

// One feed entry as a Server-Sent Event for an Elysia generator route: an event with its id,
// and a named `keepalive` event when the feed is idle, which keeps the connection open.
// A browser EventSource that listens for `message` events never sees the keepalives.
export const toSse = (entry: FeedEntry) =>
  entry === "idle"
    ? sse({ event: "keepalive", data: "" })
    : sse({ id: entry.id, data: entry.data });
