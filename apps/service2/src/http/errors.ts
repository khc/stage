import { Elysia } from "elysia";

import { DependencyError } from "../errors";

// Register this first in createApp: onError only covers what is added after it.
export const errorHandler = () =>
  new Elysia({ name: "http.errors" }).onError({ as: "global" }, ({ code, error, status }) => {
    if (error instanceof DependencyError) {
      console.error(error.cause ?? error);
      return status(502, { error: error.code });
    }
    if (code === "VALIDATION") return status(400, { error: "invalid_request", details: error.all });
    if (code === "NOT_FOUND") return status(404, { error: "not_found" });
    console.error(error);
    return status(502, { error: "internal_error" });
  });
