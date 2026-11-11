import { z } from "zod";
import {
  resumeSchema,
  taskSchema,
  taskParamSchema,
  sessionParamSchema,
} from "./schemas";

// Generate input schemas from the same validators used by the HTTP routes.
const schema = (value: z.ZodType) => {
  const { $schema, ...result } = z.toJSONSchema(value, { io: "input" });
  return result;
};
const json = <T>(value: T) => ({ "application/json": { schema: value } });
const response = (description: string, value: unknown) => ({
  description,
  content: json(value),
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const error = (...codes: string[]) =>
  schema(z.object({ error: z.enum(codes as [string, ...string[]]) }));
const invalid = {
  description:
    "Invalid parameters or JSON input; returns validation error details.",
};
const body = (validator: z.ZodType) => ({
  required: true,
  content: json(schema(validator)),
});
const taskId = {
  name: "taskId",
  in: "path",
  required: true,
  description: "Task UUID; normalized to lowercase.",
  schema: schema(taskParamSchema.shape.taskId),
};
const sessionId = {
  name: "sessionId",
  in: "path",
  required: true,
  description: "Exact session ID (case sensitive).",
  schema: schema(sessionParamSchema.shape.sessionId),
};
const taskFailure = response("Firestore failure", error("task_error"));
const missingTask = response("Task not found", error("task_not_found"));
const sessionResponses = {
  400: invalid,
  404: response(
    "Task or session not found, or session belongs to another task",
    error("task_not_found", "session_not_found"),
  ),
  502: response("Task or session storage failure", error("session_error")),
};
const summaryFields = {
  id: { type: "string" },
  taskId: { type: "string", format: "uuid" },
  appName: { type: "string" },
  userId: { type: "string" },
  lastUpdateTime: { type: "number" },
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Agent Jobs API",
    version: "1.0.0",
    description: "Save tasks, start Cloud Run jobs, and inspect task sessions.",
  },
  servers: [{ url: "/" }],
  paths: {
    "/health": {
      get: {
        operationId: "health",
        summary: "Check service health",
        responses: {
          200: response(
            "Healthy",
            schema(z.object({ status: z.literal("ok") })),
          ),
        },
      },
    },
    "/jobs": {
      get: {
        operationId: "listJobs",
        summary: "List Cloud Run jobs",
        description:
          "Returns jobs in the configured project and region, collecting all upstream pages.",
        responses: {
          200: response("Cloud Run job resources", {
            type: "object",
            required: ["jobs"],
            properties: {
              jobs: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          }),
          502: response("Cloud Run failure", error("job_error")),
        },
      },
    },
    "/tasks": {
      post: {
        operationId: "createTask",
        summary: "Save a task",
        description:
          "Saves prompt and jobName without executing. Prompt is trimmed to 1–10,000 characters; extra fields are ignored.",
        requestBody: body(taskSchema),
        responses: {
          201: response("Saved task", ref("CreatedTask")),
          400: invalid,
          502: taskFailure,
        },
      },
      get: {
        operationId: "listTasks",
        summary: "List saved tasks",
        description: "Unpaginated; order is unspecified.",
        responses: {
          200: response("Tasks, including an empty array when none exist", {
            type: "object",
            required: ["tasks"],
            properties: { tasks: { type: "array", items: ref("Task") } },
          }),
          502: taskFailure,
        },
      },
    },
    "/tasks/{taskId}": {
      get: {
        operationId: "getTask",
        summary: "Get a task",
        parameters: [taskId],
        responses: {
          200: response("Saved task", ref("Task")),
          400: invalid,
          404: missingTask,
          502: taskFailure,
        },
      },
    },
    "/tasks/{taskId}/run": {
      post: {
        operationId: "runTask",
        summary: "Start a task execution",
        description:
          "Without a body, selects the stored jobName and starts a new session from the stored prompt (sends only TASK_ID). With sessionId and message, resumes that task session with the message as the next turn. Other body fields are ignored. Acknowledges submission, not agent completion. Repeated requests may start separate executions.",
        parameters: [taskId],
        requestBody: { required: false, content: json(schema(resumeSchema)) },
        responses: {
          202: response(
            "Cloud Run submission accepted",
            schema(z.object({ operation: z.string() })),
          ),
          400: invalid,
          404: response(
            "Task or session not found",
            error("task_not_found", "session_not_found"),
          ),
          409: response(
            "Stored jobName is missing or invalid",
            error("task_not_executable"),
          ),
          502: response(
            "Firestore lookup or Cloud Run submission failure",
            error("task_error", "session_error", "job_error"),
          ),
        },
      },
    },
    "/tasks/{taskId}/sessions": {
      get: {
        operationId: "listTaskSessions",
        summary: "List task session summaries",
        description:
          "Only sessions linked to this task; unpaginated with unspecified order. State and events are omitted.",
        parameters: [taskId],
        responses: {
          200: response("Session summaries", {
            type: "object",
            required: ["sessions"],
            properties: {
              sessions: { type: "array", items: ref("SessionSummary") },
            },
          }),
          ...sessionResponses,
          404: missingTask,
        },
      },
    },
    "/tasks/{taskId}/sessions/{sessionId}": {
      get: {
        operationId: "getTaskSession",
        summary: "Get a task session with state and ordered events",
        parameters: [taskId, sessionId],
        responses: {
          200: response("Full session", ref("Session")),
          ...sessionResponses,
        },
      },
    },
  },
  components: {
    schemas: {
      Task: schema(
        z.object({
          taskId: z.uuid(),
          prompt: z.string(),
          jobName: z.string().optional(),
        }),
      ),
      CreatedTask: schema(
        z.object({ taskId: z.uuid(), prompt: z.string(), jobName: z.string() }),
      ),
      SessionSummary: {
        type: "object",
        required: Object.keys(summaryFields),
        properties: summaryFields,
      },
      Session: {
        type: "object",
        required: [...Object.keys(summaryFields), "state", "events"],
        properties: {
          ...summaryFields,
          state: { type: "object", additionalProperties: true },
          events: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  },
};
