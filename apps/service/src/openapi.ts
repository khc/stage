import { z } from "zod";

import {
  documentParamSchema,
  jobParamSchema,
  resumeSchema,
  taskSchema,
  taskParamSchema,
  sessionParamSchema,
} from "./schemas";

// Generate input schemas from the same validators used by the HTTP routes.
const schema = (value: z.ZodType) => {
  const { $schema: _schema, ...result } = z.toJSONSchema(value, { io: "input" });
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
  description: "Invalid parameters or JSON input; returns validation error details.",
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
const jobName = {
  name: "jobName",
  in: "path",
  required: true,
  description: "Short Cloud Run job name.",
  schema: schema(jobParamSchema.shape.jobName),
};
const sessionId = {
  name: "sessionId",
  in: "path",
  required: true,
  description: "Exact session ID (case sensitive).",
  schema: schema(sessionParamSchema.shape.sessionId),
};
const documentId = {
  name: "documentId",
  in: "path",
  required: true,
  description: "SHA-256 checksum of the uploaded file (lowercase hex).",
  schema: schema(documentParamSchema.shape.documentId),
};
const documentFailure = response("Storage or extraction service failure", error("document_error"));
const noDocuments = response("Not configured (EXTRACT_URL unset)", error("not_supported"));
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
  run: {
    type: "object",
    description: "The latest run of the session; absent when it never ran.",
    required: ["status", "startedAt"],
    properties: {
      status: { type: "string", enum: ["running", "succeeded", "failed"] },
      startedAt: { type: "number" },
      endedAt: { type: "number" },
      error: { type: "string" },
    },
  },
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
          200: response("Healthy", schema(z.object({ status: z.literal("ok") }))),
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
    "/jobs/{jobName}/agents": {
      get: {
        operationId: "listJobAgents",
        summary: "List the agents registered for a job",
        description:
          "Reads the registry written by the job's register execution: each agent's name, description and the JSON Schema of its input and output. Empty when the job has not been registered. The schemas describe the contract; the service does not enforce them.",
        parameters: [jobName],
        responses: {
          200: response("Registered agents", {
            type: "object",
            required: ["agents"],
            properties: {
              agents: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    inputSchema: {
                      type: "object",
                      additionalProperties: true,
                      description: "JSON Schema of the message a task sends to the agent.",
                    },
                    outputSchema: {
                      type: "object",
                      additionalProperties: true,
                      description: "JSON Schema of the agent's final reply.",
                    },
                  },
                },
              },
            },
          }),
          400: invalid,
          502: response("Registry failure", error("agents_error")),
        },
      },
    },
    "/jobs/{jobName}/register": {
      post: {
        operationId: "registerJobAgents",
        summary: "Register the agents inside a job's container",
        description:
          "Starts the job in its register mode, which records the container's agents so tasks can be checked against them. Acknowledges submission, not completion; read the result from the agents route.",
        parameters: [jobName],
        responses: {
          202: response(
            "Cloud Run submission accepted",
            schema(z.object({ operation: z.string() })),
          ),
          400: invalid,
          501: response("Not configured", error("not_supported")),
          502: response("Cloud Run failure", error("job_error")),
        },
      },
    },
    "/tasks": {
      post: {
        operationId: "createTask",
        summary: "Save a task",
        description:
          "Saves prompt, jobName and an optional agentName without executing. agentName selects which agent in the job container runs the task (an identifier of at most 64 characters); omit it for the container's default agent. Prompt is trimmed to 1–10,000 characters; extra fields are ignored.",
        requestBody: body(taskSchema),
        responses: {
          201: response("Saved task", ref("CreatedTask")),
          400: {
            description:
              "Invalid JSON input (validation error details), or unknown_agent when the job has registered agents and agentName is not one of them.",
          },
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
      delete: {
        operationId: "deleteTask",
        summary: "Delete a task and its sessions",
        description:
          "Permanently removes the task and every session linked to it, with their events. Job executions already running are not stopped, and event streams already open for its sessions stay open until the client disconnects.",
        parameters: [taskId],
        responses: {
          204: { description: "Task deleted" },
          400: invalid,
          404: missingTask,
          501: response("Not configured", error("not_supported")),
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
          404: response("Task or session not found", error("task_not_found", "session_not_found")),
          409: response(
            "Stored jobName is missing or invalid, or the session being resumed is already running",
            error("task_not_executable", "run_in_progress"),
          ),
          502: response(
            "Firestore lookup or Cloud Run submission failure",
            error("task_error", "session_error", "job_error"),
          ),
        },
      },
    },
    "/tasks/{taskId}/documents": {
      get: {
        operationId: "listTaskDocuments",
        summary: "List the documents attached to a task",
        description: "Metadata only; fetch one document to read its extracted content.",
        parameters: [taskId],
        responses: {
          200: response("Attached documents", {
            type: "object",
            required: ["documents"],
            properties: { documents: { type: "array", items: ref("DocumentSummary") } },
          }),
          400: invalid,
          404: missingTask,
          501: noDocuments,
          502: documentFailure,
        },
      },
      post: {
        operationId: "uploadTaskDocument",
        summary: "Upload a file, extract its content and attach it to the task",
        description:
          "Multipart form data with one file field named file (max 25 MiB). The SHA-256 of the bytes is the documentId: a file already stored (by any task) is not extracted again, only attached. Attaching the same file twice is a no-op.",
        parameters: [taskId],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
        responses: {
          201: response("Attached document", ref("DocumentSummary")),
          400: response("Invalid task ID or missing file", error("file_required")),
          404: missingTask,
          413: response(
            "File or extracted text too large",
            error("file_too_large", "document_too_large"),
          ),
          422: response(
            "The extraction service could not read the file",
            error("extraction_failed"),
          ),
          501: noDocuments,
          502: documentFailure,
        },
      },
    },
    "/tasks/{taskId}/documents/{documentId}": {
      get: {
        operationId: "getTaskDocument",
        summary: "Get an attached document with its extracted content",
        parameters: [taskId, documentId],
        responses: {
          200: response("Document", ref("Document")),
          400: invalid,
          404: response(
            "Task or document not found",
            error("task_not_found", "document_not_found"),
          ),
          501: noDocuments,
          502: documentFailure,
        },
      },
      delete: {
        operationId: "deleteTaskDocument",
        summary: "Detach a document from the task",
        description:
          "Removes the document from this task. The stored document is deleted too once no other task references it.",
        parameters: [taskId, documentId],
        responses: {
          204: { description: "Document detached" },
          400: invalid,
          404: response(
            "Task or document not found",
            error("task_not_found", "document_not_found"),
          ),
          501: noDocuments,
          502: documentFailure,
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
      delete: {
        operationId: "deleteTaskSession",
        summary: "Delete a task session and its events",
        description:
          "Permanently removes the session and all its stored events. Only a session linked to this task can be deleted. The task and its other sessions are unchanged.",
        parameters: [taskId, sessionId],
        responses: {
          204: { description: "Session deleted" },
          ...sessionResponses,
        },
      },
    },
    "/tasks/{taskId}/sessions/{sessionId}/stats": {
      get: {
        operationId: "getTaskSessionStats",
        summary: "Get a session's event count and token usage",
        description:
          "Sums the model usage recorded on the session's stored events. cached is part of prompt; total is the model-reported total, which also covers thoughts and tool-use prompt tokens. Streaming partial events are not stored, so they are not counted.",
        parameters: [taskId, sessionId],
        responses: {
          200: response(
            "Session statistics",
            schema(
              z.object({
                events: z.number().int(),
                llmCalls: z.number().int(),
                tokens: z.object({
                  prompt: z.number().int(),
                  candidates: z.number().int(),
                  thoughts: z.number().int(),
                  toolUsePrompt: z.number().int(),
                  cached: z.number().int(),
                  total: z.number().int(),
                }),
              }),
            ),
          ),
          ...sessionResponses,
        },
      },
    },
    "/events": {
      get: {
        operationId: "streamPlatformEvents",
        summary: "Stream platform events (Server-Sent Events)",
        description:
          "Streams the lifecycle events published to PLATFORM_EVENTS_TOPIC (task.created, task.deleted, task.run_requested, document.added, document.removed, job.registration_requested) until the client disconnects. Each message has id = event ID and data = the event JSON. Events published while no client is connected are not replayed. A comment line is sent every 5 seconds to keep the connection open.",
        responses: {
          200: {
            description: "Event stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          501: response("PLATFORM_EVENTS_TOPIC is not set", error("not_supported")),
          502: response("Pub/Sub failure", error("events_error")),
        },
      },
    },
    "/tasks/{taskId}/sessions/{sessionId}/messages": {
      get: {
        operationId: "streamTaskSessionMessages",
        summary: "Stream session messages (Server-Sent Events)",
        description:
          "Replays the stored events in order, then streams new events published by the agent to Pub/Sub until the client disconnects. Each message has id = event ID and data = the event JSON; a duplicate event ID is sent once. Without PUBSUB_TOPIC only the stored events are sent and the connection stays open. A comment line is sent every 5 seconds to keep the connection open.",
        parameters: [taskId, sessionId],
        responses: {
          200: {
            description: "Event stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          400: invalid,
          404: sessionResponses[404],
          502: response("Firestore or Pub/Sub failure", error("events_error")),
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
          agentName: z.string().optional(),
          documents: z.array(z.object({ documentId: z.string() })).optional(),
        }),
      ),
      CreatedTask: schema(
        z.object({
          taskId: z.uuid(),
          prompt: z.string(),
          jobName: z.string(),
          agentName: z.string().optional(),
          documents: z.array(z.object({ documentId: z.string() })),
        }),
      ),
      DocumentSummary: schema(
        z.object({
          documentId: z.string(),
          filename: z.string(),
          checksum: z.string(),
          contentType: z.string(),
        }),
      ),
      Document: schema(
        z.object({
          documentId: z.string(),
          filename: z.string(),
          checksum: z.string(),
          contentType: z.string(),
          content: z.string(),
        }),
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
