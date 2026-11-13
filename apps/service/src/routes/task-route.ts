import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { guard } from "../errors";
import { taskParamSchema, taskSchema } from "../schemas";
import type { TaskService } from "../services/task-service";
import type { TaskStore } from "../stores/task-store";

export type TaskRouteDeps = {
  tasks: Pick<TaskStore, "list" | "get">;
  service: TaskService;
};

// Mounted under /tasks: create, read, delete and run a task.
export const taskRoute = ({ tasks, service }: TaskRouteDeps) =>
  new Hono()
    .post("/", zValidator("json", taskSchema), async (c) => {
      const result = await service.create(c.req.valid("json"));
      if (result.status === "unknown_agent") return c.json({ error: "unknown_agent" }, 400);
      return c.json(result.task, 201);
    })
    .get("/", async (c) => c.json({ tasks: await guard("task_error", tasks.list) }))
    .get("/:taskId", zValidator("param", taskParamSchema), async (c) => {
      const contract = await guard("task_error", () => tasks.get(c.req.valid("param").taskId));
      if (!contract) return c.json({ error: "task_not_found" }, 404);
      return c.json(contract);
    })
    .delete("/:taskId", zValidator("param", taskParamSchema), async (c) => {
      const outcome = await service.delete(c.req.valid("param").taskId);
      if (outcome === "not_found") return c.json({ error: "task_not_found" }, 404);
      return c.body(null, 204);
    })
    .post("/:taskId/run", zValidator("param", taskParamSchema), async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const result = await service.run(c.req.valid("param").taskId, body);
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
