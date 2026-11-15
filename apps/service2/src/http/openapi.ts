import { openapi } from "@elysiajs/openapi";
import { t, type TSchema } from "elysia";

// The OpenAPI document at /openapi.json and the Scalar reference at /docs, generated from the
// routes' schemas and `detail` (the same paths as apps/service).
export const openapiDocs = () =>
  openapi({
    path: "/docs",
    specPath: "/openapi.json",
    provider: "scalar",
    documentation: { info: { title: "Agent Jobs API", version: "0.1.0" } },
  });

// The short error body every route answers with: a snake_case code.
export const ErrorBody = t.Object({ error: t.String() });

type Response = { description: string; schema?: TSchema; contentType?: string };

// A route's OpenAPI `detail`: documentation only, no runtime validation of the response.
// `responses` maps a status to its description and, optionally, its body schema.
export const doc = (
  tag: string,
  summary: string,
  responses: Record<number, string | Response>,
) => ({
  detail: {
    tags: [tag],
    summary,
    responses: Object.fromEntries(
      Object.entries(responses).map(([status, response]) => {
        const {
          description,
          schema,
          contentType = "application/json",
        } = typeof response === "string" ? ({ description: response } as Response) : response;
        return [status, { description, ...(schema && { content: { [contentType]: { schema } } }) }];
      }),
    ),
  },
});

// Shorthands for the error statuses the routes share.
export const errors = {
  invalid: { description: "The request is invalid.", schema: ErrorBody },
  taskNotFound: { description: "No such task (`task_not_found`).", schema: ErrorBody },
  dependency: {
    description:
      "A dependency (Firestore, Cloud Run, Pub/Sub) failed; only a short code is returned.",
    schema: ErrorBody,
  },
  notSupported: {
    description: "The feature is not configured (`not_supported`).",
    schema: ErrorBody,
  },
} satisfies Record<string, Response>;
