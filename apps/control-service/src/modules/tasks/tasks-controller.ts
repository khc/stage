import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Elysia, t } from "elysia";

import { doc, errors } from "../../http/openapi";
import { documentsController } from "./documents/documents-controller";
import type { DocumentsService } from "./documents/documents-service";
import { sessionsController } from "./sessions/sessions-controller";
import type { SessionsService } from "./sessions/sessions-service";
import { TasksModel } from "./tasks-model";
import type { Resume, TasksService } from "./tasks-service";

const isResume = TypeCompiler.Compile(TasksModel.resume);
const tag = "Tasks";
// Quick runs await up to QUICK_BUDGET_MS (up to 240 s), longer than Elysia's 30 s idle timeout;
// match A2A's 255 s Bun per-request timeout so the socket is not reset mid-run.
const QUICK_REQUEST_TIMEOUT_SECONDS = 255;

export type TasksControllerDeps = {
  tasksService: TasksService;
  sessionsService: SessionsService;
  documentsService?: DocumentsService;
};

// Mounted at /tasks, with the sessions and documents of a task under it. Task ids are matched
// case-insensitively and stored lowercase.
export const tasksController = ({
  tasksService,
  sessionsService,
  documentsService,
}: TasksControllerDeps) =>
  new Elysia({ prefix: "/tasks" })
    .post(
      "",
      async ({ body, status }) => {
        // Named one by one: only the A2A gateway sets a parent, whatever else the body carries.
        const { name, prompt, jobName, agentName, defaultModel } = body;
        const result = await tasksService.create({
          name: name.trim(),
          prompt: prompt.trim(),
          jobName,
          ...(agentName !== undefined && { agentName }),
          ...(defaultModel !== undefined && { defaultModel }),
        });
        if (result.status !== "created") return status(400, { error: result.status });
        return status(201, result.task);
      },
      {
        body: TasksModel.createBody,
        ...doc(tag, "Create a task", {
          201: { description: "The created task.", schema: TasksModel.task },
          400: "Invalid input, a job that is not allowed (`unknown_job`), or the job has registered agents and this one is not among them (`unknown_agent`), or a default model that is not selectable (`unknown_model`).",
          502: errors.dependency,
        }),
      },
    )
    .get("", async () => ({ tasks: await tasksService.list() }), {
      ...doc(tag, "List the tasks", {
        200: { description: "The tasks.", schema: t.Object({ tasks: t.Array(TasksModel.task) }) },
        502: errors.dependency,
      }),
    })
    .get(
      "/:taskId",
      async ({ params, status }) =>
        (await tasksService.get(params.taskId.toLowerCase())) ??
        status(404, { error: "task_not_found" }),
      {
        params: TasksModel.params,
        ...doc(tag, "Get a task", {
          200: { description: "The task.", schema: TasksModel.task },
          400: errors.invalid,
          404: errors.taskNotFound,
          502: errors.dependency,
        }),
      },
    )
    .post(
      "/:taskId/run",
      async ({ params, query, request, server, status }) => {
        // No body is a plain run; a body that is not JSON is refused, not taken for a plain run.
        const text = await request.text();
        let raw: Record<string, unknown> | undefined;
        try {
          raw = text.trim() ? JSON.parse(text) : undefined;
        } catch {
          return status(400, { error: "invalid_request" });
        }
        let resume: Resume | undefined;
        if (raw !== undefined) {
          if (!isResume.Check(raw)) return status(400, { success: false, error: "invalid_resume" });
          resume = {
            ...(raw.sessionId !== undefined && { sessionId: raw.sessionId }),
            message: raw.message.trim(),
            ...(raw.model !== undefined && { model: raw.model }),
          };
        }
        if (query.mode === "quick") server?.timeout(request, QUICK_REQUEST_TIMEOUT_SECONDS);
        const result =
          query.mode === "quick"
            ? await tasksService.run(
                params.taskId.toLowerCase(),
                resume,
                query.mode,
                request.signal,
              )
            : await tasksService.run(params.taskId.toLowerCase(), resume, query.mode);
        switch (result.status) {
          case "started":
            return status(202, {
              operation: result.operation,
              ...(result.sessionId && { sessionId: result.sessionId }),
            });
          case "task_not_found":
          case "session_not_found":
            return status(404, { error: result.status });
          case "unknown_model":
            return status(400, { error: result.status });
          case "too_many_quick_runs":
            return status(429, { error: result.status });
          case "quick_timeout":
            return status(504, {
              error: result.status,
              ...(result.sessionId && { sessionId: result.sessionId }),
            });
          default:
            return status(409, { error: result.status });
        }
      },
      {
        params: TasksModel.params,
        query: TasksModel.runQuery,
        // An empty body is a plain run, which Elysia would not accept with a body schema, so the
        // handler reads the body itself; a body that is not JSON is answered 400 there.
        parse: "none",
        ...doc(tag, "Run a task, start a session with a message, or resume a session", {
          202: {
            description: "The Cloud Run execution was started (or completed in `quick` mode).",
            schema: TasksModel.operation,
          },
          400: "A body that is not JSON (`invalid_request`), or one without a non-blank `message` or valid `sessionId` (`invalid_resume`), or an invalid `mode`, or a `model` that is not selectable (`unknown_model`).",
          404: "No such task or session (`task_not_found`, `session_not_found`).",
          409: "The task cannot run now (`task_not_executable`, `run_in_progress`, `message_pending`, `quick_unavailable`).",
          429: "Too many quick service runs are already in flight (`too_many_quick_runs`).",
          502: errors.dependency,
          504: "The quick service run exceeded its time budget and may still finish (`quick_timeout`).",
        }),
      },
    )
    .delete(
      "/:taskId",
      async ({ params, status }) => {
        const result = await tasksService.delete(params.taskId.toLowerCase());
        if (result === "deleted") return status(204, undefined);
        if (result === "too_many_subtasks") return status(409, { error: "too_many_subtasks" });
        return status(404, { error: "task_not_found" });
      },
      {
        params: TasksModel.params,
        ...doc(tag, "Delete a task with its sub-tasks and sessions", {
          204: "Deleted with its sub-tasks, and theirs; their unused documents are released.",
          404: errors.taskNotFound,
          409: {
            description:
              "The task has more than 500 sub-tasks and nothing was deleted (`too_many_subtasks`).",
            schema: errors.invalid.schema,
          },
          502: errors.dependency,
        }),
      },
    )
    .use(sessionsController({ tasksService, sessionsService }))
    .use(documentsController({ tasksService, documentsService }));
