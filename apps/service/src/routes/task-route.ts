import { zValidator } from "@hono/zod-validator";
import type { AgentRegistry } from "@stage/agents/agent-registry";
import { Hono } from "hono";

import { guard } from "../errors";
import type { CloudRunJobs } from "../platform/cloud-run-jobs";
import { taskParamSchema, taskSchema } from "../schemas";
import type { DocumentStore } from "../stores/document-store";
import type { SessionStore } from "../stores/session-store";
import type { TaskStore } from "../stores/task-store";
import { deleteTaskWithSessions } from "../usecases/delete-task";
import { runTask } from "../usecases/run-task";

export type TaskRouteDeps = {
  jobs: Pick<CloudRunJobs, "run">;
  tasks: TaskStore;
  sessions: SessionStore;
  documents?: DocumentStore;
  registry: Pick<AgentRegistry, "list">;
};

// Mounted under /tasks: create, read, delete and run a task.
export const taskRoute = ({ jobs, tasks, sessions, documents, registry }: TaskRouteDeps) =>
  new Hono()
    .post("/", zValidator("json", taskSchema), async (c) => {
      const input = c.req.valid("json");
      return guard("task_error", async () => {
        // A job with registered agents only accepts those; a job without a
        // registration cannot be verified and keeps accepting any valid name.
        if (input.agentName !== undefined) {
          const known = await registry.list(input.jobName);
          if (known.length && !known.some((a) => a.name === input.agentName))
            return c.json({ error: "unknown_agent" }, 400);
        }
        return c.json(await tasks.create(input), 201);
      });
    })
    .get("/", async (c) => c.json({ tasks: await guard("task_error", tasks.list) }))
    .get("/:taskId", zValidator("param", taskParamSchema), async (c) => {
      const contract = await guard("task_error", () => tasks.get(c.req.valid("param").taskId));
      if (!contract) return c.json({ error: "task_not_found" }, 404);
      return c.json(contract);
    })
    .delete("/:taskId", zValidator("param", taskParamSchema), async (c) => {
      const { taskId } = c.req.valid("param");
      const outcome = await deleteTaskWithSessions({ tasks, sessions, documents }, taskId);
      if (outcome === "not_found") return c.json({ error: "task_not_found" }, 404);
      return c.body(null, 204);
    })
    .post("/:taskId/run", zValidator("param", taskParamSchema), async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const result = await runTask({ tasks, jobs, sessions }, c.req.valid("param").taskId, body);
      switch (result.status) {
        case "started":
          return c.json({ operation: result.operation }, 202);
        case "task_not_found":
        case "session_not_found":
          return c.json({ error: result.status }, 404);
        case "invalid_resume":
          return c.json({ success: false, error: result.error }, 400);
        default:
          return c.json({ error: result.status }, 409);
      }
    });
