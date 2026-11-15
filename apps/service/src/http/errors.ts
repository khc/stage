import { requestIdOf } from "@stage/http/request-id";
import { Elysia } from "elysia";

import { DependencyError } from "../errors";
import { recordRequestError } from "./telemetry";

// Register this first in createApp: onError only covers what is added after it.
export const errorHandler = () =>
  new Elysia({ name: "http.errors" }).onError(
    { as: "global" },
    ({ code, error, request, status }) => {
      const id = requestIdOf(request);
      if (code !== "VALIDATION" && code !== "PARSE" && code !== "NOT_FOUND")
        recordRequestError(request, error);
      if (error instanceof DependencyError) {
        console.error(`[${id}]`, error.cause ?? error);
        return status(502, { error: error.code });
      }
      if (code === "VALIDATION") {
        // A response that breaks its schema is a bug in the service, not a bad request.
        if (error.type === "response") {
          console.error(`[${id}]`, error);
          return status(502, { error: "internal_error" });
        }
        // Only where and why it failed: the schema and the offending value (which may be a
        // 10,000-character prompt) stay out of the response.
        const details = error.all.map(({ path, summary }) => ({ path, message: summary }));
        return status(400, { error: "invalid_request", details });
      }
      // A body that claims to be JSON but is not is the caller's mistake, not a server error.
      if (code === "PARSE") return status(400, { error: "invalid_request" });
      if (code === "NOT_FOUND") return status(404, { error: "not_found" });
      console.error(`[${id}]`, error);
      return status(502, { error: "internal_error" });
    },
  );
