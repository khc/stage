import type { AgentRegistry } from "@stage/agents/agent-registry";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { DependencyError } from "./errors";
import type { CloudRunJobs } from "./platform/cloud-run-jobs";
import type { PlatformEventStream } from "./platform/platform-event-stream";
import type { SessionEventStream } from "./platform/session-event-stream";
import { documentRoute } from "./routes/document-route";
import { eventRoute } from "./routes/event-route";
import { jobRoute } from "./routes/job-route";
import { metaRoute } from "./routes/meta-route";
import { sessionRoute } from "./routes/session-route";
import { taskRoute } from "./routes/task-route";
import { createPlatformEventService } from "./services/platform-event-service";
import { createSessionService } from "./services/session-service";
import { createTaskService } from "./services/task-service";
import type { DocumentStore } from "./stores/document-store";
import type { SessionStore } from "./stores/session-store";
import type { TaskStore } from "./stores/task-store";

// What the service needs from the outside. The optional ones are features that
// are only on when configured: their routes answer 501 (or stream nothing) without them.
export type Deps = {
  jobs: CloudRunJobs;
  tasks: TaskStore;
  sessions: SessionStore;
  registry: Pick<AgentRegistry, "list">;
  documents?: DocumentStore;
  sessionEventStream?: SessionEventStream;
  platformEventStream?: PlatformEventStream;
};

// The routes live in ./routes, one Hono app per feature, mounted here.
export const createApp = (deps: Deps) =>
  new Hono()
    .route("/", metaRoute())
    .route(
      "/",
      eventRoute(deps.platformEventStream && createPlatformEventService(deps.platformEventStream)),
    )
    .route("/jobs", jobRoute(deps.jobs, deps.registry))
    .route("/tasks", taskRoute({ tasks: deps.tasks, service: createTaskService(deps) }))
    .route("/tasks", documentRoute(deps.tasks, deps.documents))
    .route("/tasks", sessionRoute(deps.tasks, deps.sessions, createSessionService(deps)))
    .onError((err, c) => {
      if (err instanceof HTTPException) return err.getResponse();
      if (err instanceof DependencyError) {
        console.error(err.cause ?? err);
        return c.json({ error: err.code }, 502);
      }
      console.error(err);
      return c.json({ error: "internal_error" }, 502);
    });
