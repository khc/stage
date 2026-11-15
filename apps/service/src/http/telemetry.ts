import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { requestIdOf } from "@stage/http/request-id";
import { Elysia } from "elysia";

type Active = { span: Span; ctx: Context };

// One server span per request. Without a tracer provider (OTEL_* unset) these are no-op spans.
const spans = new WeakMap<Request, Active>();

// Adds a failure to the request's span (the error handler calls this).
export const recordRequestError = (request: Request, error: unknown) =>
  spans.get(request)?.span.recordException(error instanceof Error ? error : String(error));

// Annotates the span with the request id, and ends it after the response with the route and
// status. Use it together with `inRequestSpan` below, which starts the span.
export const requestTelemetry = () =>
  new Elysia({ name: "http.telemetry" })
    .onRequest(({ request }) => {
      const id = requestIdOf(request);
      if (id) spans.get(request)?.span.setAttribute("request.id", id);
    })
    .onAfterResponse({ as: "global" }, ({ request, route, set }) => {
      const entry = spans.get(request);
      if (!entry) return;
      const status = typeof set.status === "number" ? set.status : 200;
      entry.span.setAttribute("http.response.status_code", status);
      if (route) {
        entry.span.updateName(`${request.method} ${route}`);
        entry.span.setAttribute("http.route", route);
      }
      if (status >= 500) entry.span.setStatus({ code: SpanStatusCode.ERROR });
      entry.span.end();
    });

// Wraps the whole request pipeline of Elysia: it starts the server span, continuing the caller's
// W3C `traceparent`, and runs everything after it inside that span, so the Firestore and Cloud
// Run calls the handlers make become children of the request span. Elysia applies `wrap` only on
// the instance it is called on (not from a plugin), so createApp calls `.wrap(inRequestSpan)`.
export const inRequestSpan = <T extends (...args: never[]) => unknown>(
  fn: T,
  request: Request,
): T => {
  const parent = propagation.extract(ROOT_CONTEXT, Object.fromEntries(request.headers));
  const span = trace.getTracer("stage-service").startSpan(
    request.method,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": request.method,
        "url.path": new URL(request.url).pathname,
      },
    },
    parent,
  );
  const ctx = trace.setSpan(parent, span);
  spans.set(request, { span, ctx });
  return ((...args: never[]) => context.with(ctx, () => fn(...args))) as T;
};
