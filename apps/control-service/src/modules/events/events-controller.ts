import { Elysia, t } from "elysia";

import { doc, errors } from "../../http/openapi";
import { KEEPALIVE_MS, toSse } from "../../utils/sse";
import type { EventsService } from "./events-service";

// GET /events: the platform events (task created, run requested, ...) as Server-Sent Events.
// Undefined service when PLATFORM_EVENTS_TOPIC is not set: the route answers 501.
export const eventsController = (eventsService?: EventsService) =>
  new Elysia().get(
    "/events",
    async function* ({ request, status }) {
      if (!eventsService) return status(501, { error: "not_supported" });
      const controller = new AbortController();
      // A disconnect aborts the feed at once, which also unsubscribes from Pub/Sub.
      request.signal.addEventListener("abort", () => controller.abort(), { once: true });
      const entries = await eventsService.stream({
        signal: controller.signal,
        idleMs: KEEPALIVE_MS,
      });
      try {
        // Elysia sends the response headers with the first chunk, so say something at once: a stream with
        // nothing to replay would otherwise hold the response (and a browser's `onopen`) until the first idle tick.
        yield toSse("idle");
        for await (const entry of entries) yield toSse(entry);
      } finally {
        controller.abort();
      }
    },
    {
      ...doc("Events", "Stream the platform events", {
        200: {
          description:
            "Server-Sent Events: `task.created`, `task.deleted`, `task.run_requested`, `document.added`, `document.removed` and `job.registration_requested`, each with its id; a `keepalive` event every 5 seconds when idle.",
          schema: t.String(),
          contentType: "text/event-stream",
        },
        501: errors.notSupported,
        502: errors.dependency,
      }),
    },
  );
