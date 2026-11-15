import { Elysia } from "elysia";

import type { TasksService } from "./tasks-service";

// Each child module of /tasks/:taskId/... uses this itself. It answers 404 task_not_found
// before the handler runs, and hands the handler the (canonical, lowercase-id) task.
// Elysia runs it once per request, however many times it is used (same `name`).
export const tasksGuard = (tasksService: Pick<TasksService, "get">) =>
  new Elysia({ name: "tasks.guard" }).resolve({ as: "scoped" }, async ({ params, status }) => {
    const { taskId } = params as { taskId: string };
    const task = await tasksService.get(taskId.toLowerCase());
    if (!task) return status(404, { error: "task_not_found" });
    return { task };
  });
