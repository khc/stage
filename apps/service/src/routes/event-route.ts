import { Hono } from "hono";

import type { PlatformEventService } from "../services/platform-event-service";
import { KEEPALIVE_MS, sseResponse } from "./shared";

// GET /events: the platform events (task created, run requested, ...) as Server-Sent Events.
export const eventRoute = (service?: PlatformEventService) =>
  new Hono().get("/events", async (c) => {
    if (!service) return c.json({ error: "not_supported" }, 501);
    const controller = new AbortController();
    const entries = await service.stream({ signal: controller.signal, idleMs: KEEPALIVE_MS });
    return sseResponse(c, controller, entries);
  });
