import { Elysia } from "elysia";

import { requestIdOf } from "./request-id";
import { recordRequestError } from "./telemetry";

// What an app's own errors become: the status and body the caller sees, and what to log
// (the error itself when `log` is left out).
export type MappedError = { status: number; body: { error: string }; log?: unknown };

export type ErrorHandlerOptions = {
  // Maps an app's own errors (a failing dependency, say); returns undefined for any other error.
  map?: (error: unknown) => MappedError | undefined;
  // The status of a failure that is the service's own fault: 500 by default, 502 for a service
  // whose failures are mostly its dependencies'.
  unexpectedStatus?: number;
};

// Register this first in createApp: onError only covers what is added after it. Every error
// answers with a short `{ error: code }` body and nothing else of the error leaves the service;
// failures the caller did not cause are logged with the request id and recorded on its span.
export const errorHandler = ({ map, unexpectedStatus = 500 }: ErrorHandlerOptions = {}) =>
  new Elysia({ name: "http.errors" }).onError(
    { as: "global" },
    ({ code, error, request, status }) => {
      const id = requestIdOf(request);
      const fail = (httpStatus: number, body: { error: string }, log: unknown = error) => {
        console.error(`[${id}]`, log);
        return status(httpStatus as 500, body);
      };
      if (code !== "VALIDATION" && code !== "PARSE" && code !== "NOT_FOUND")
        recordRequestError(request, error);
      const mapped = map?.(error);
      if (mapped) return fail(mapped.status, mapped.body, mapped.log);
      if (code === "VALIDATION") {
        // A response that breaks its schema is a bug in the service, not a bad request.
        if (error.type === "response") return fail(unexpectedStatus, { error: "internal_error" });
        // Only where and why it failed: the schema and the offending value (which may be a
        // 10,000-character prompt) stay out of the response.
        const details = error.all.map(({ path, summary }) => ({ path, message: summary }));
        return status(400, { error: "invalid_request", details });
      }
      // A body that claims to be JSON (or multipart) but is not is the caller's mistake.
      if (code === "PARSE") return status(400, { error: "invalid_request" });
      if (code === "NOT_FOUND") return status(404, { error: "not_found" });
      return fail(unexpectedStatus, { error: "internal_error" });
    },
  );
