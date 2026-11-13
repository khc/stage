import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { DependencyError } from "../errors";
import type { PlatformStream } from "../platform/platform-stream";
import { KEEPALIVE_MS, noop } from "./shared";

const SEEN_LIMIT = 1_000;

// GET /events: the platform events (task created, run requested, ...) as Server-Sent Events.
export const eventRoute = (platformStream?: PlatformStream) =>
  new Hono().get("/events", async (c) => {
    if (!platformStream) return c.json({ error: "not_supported" }, 501);
    const pending: [string, string][] = [];
    let wake = noop;
    let unsubscribe = noop;
    try {
      unsubscribe = await platformStream((id, json) => {
        pending.push([id, json]);
        wake();
      });
    } catch (err) {
      throw new DependencyError("events_error", err);
    }
    return streamSSE(c, async (stream) => {
      const seen = new Set<string>();
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          for (const [id, data] of pending.splice(0)) {
            if (seen.has(id)) continue;
            seen.add(id);
            if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
            await stream.writeSSE({ id, data });
          }
          if (pending.length) continue;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, KEEPALIVE_MS);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          if (!pending.length) await stream.write(": keepalive\n\n");
        }
      } finally {
        unsubscribe();
      }
    });
  });
