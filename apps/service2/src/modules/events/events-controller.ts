import { Elysia } from "elysia";

import { KEEPALIVE_MS, toSse } from "../../utils/sse";
import type { EventsService } from "./events-service";

// GET /events: the platform events (task created, run requested, ...) as Server-Sent Events.
// Undefined service when PLATFORM_EVENTS_TOPIC is not set: the route answers 501.
export const eventsController = (eventsService?: EventsService) =>
  new Elysia().get("/events", async function* ({ request, status }) {
    if (!eventsService) return status(501, { error: "not_supported" });
    const controller = new AbortController();
    // A disconnect aborts the feed at once, which also unsubscribes from Pub/Sub.
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const entries = await eventsService.stream({ signal: controller.signal, idleMs: KEEPALIVE_MS });
    try {
      for await (const entry of entries) yield toSse(entry);
    } finally {
      controller.abort();
    }
  });
