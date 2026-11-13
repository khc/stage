import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { FeedEntry } from "../services/event-feed";

export const KEEPALIVE_MS = 5_000;

// Sends a feed as Server-Sent Events: each event with its id, and a comment
// line when the feed is idle, which keeps the connection open. A client that
// disconnects aborts the controller, which ends the feed.
export const sseResponse = (
  c: Context,
  controller: AbortController,
  entries: AsyncIterable<FeedEntry>,
) =>
  streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    for await (const entry of entries) {
      if (entry === "idle") await stream.write(": keepalive\n\n");
      else await stream.writeSSE({ id: entry.id, data: entry.data });
    }
  });
