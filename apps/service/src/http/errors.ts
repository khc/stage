import { errorHandler as httpErrorHandler } from "@stage/http/errors";

import { DependencyError } from "../errors";

// The shared handler, with the service's own error: a failing dependency is a 502 that carries
// only its short code, and an unexpected error is a 502 too, since the failures are mostly the
// dependencies'. Register it first in createApp.
export const errorHandler = () =>
  httpErrorHandler({
    unexpectedStatus: 502,
    map: (error) =>
      error instanceof DependencyError
        ? { status: 502, body: { error: error.code }, log: error.cause ?? error }
        : undefined,
  });
