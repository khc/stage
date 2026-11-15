import { Elysia } from "elysia";

// Register this first in createApp: onError only covers what is added after it.
export const errorHandler = () =>
  new Elysia({ name: "http.errors" }).onError({ as: "global" }, ({ code, error, status }) => {
    // A body that claims to be multipart but is not is the caller's mistake, not a server error.
    if (code === "PARSE" || code === "VALIDATION") return status(400, { error: "invalid_request" });
    if (code === "NOT_FOUND") return status(404, { error: "not_found" });
    console.error(error);
    return status(500, { error: "internal_error" });
  });
