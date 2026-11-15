import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Elysia, t } from "elysia";

import { DependencyError } from "../errors";
import { errorHandler } from "./errors";
import { requestId } from "./request-id";
import { inRequestSpan, requestTelemetry } from "./telemetry";

const exporter = new InMemorySpanExporter();
const app = new Elysia()
  .use(requestId())
  .use(requestTelemetry())
  .wrap(inRequestSpan)
  .use(errorHandler())
  .get("/ok", async () => {
    await Bun.sleep(1);
    // As the Firestore client would: no explicit parent.
    trace.getTracer("downstream").startSpan("firestore.get").end();
    return { ok: true };
  })
  .get("/dependency", () => {
    throw new DependencyError("task_error", new Error("down"));
  })
  .get("/bug", () => {
    throw new Error("bug");
  })
  .get("/valid/:n", ({ params }) => params, { params: t.Object({ n: t.Numeric() }) });

// The span ends after the response, so give the hook a moment.
const spansOf = async (path: string, headers: Record<string, string> = {}) => {
  exporter.reset();
  const res = await app.handle(new Request(`http://localhost${path}`, { headers }));
  await Bun.sleep(10);
  return { res, spans: exporter.getFinishedSpans() };
};
const serverSpan = (spans: ReturnType<typeof exporter.getFinishedSpans>) =>
  spans.find((s) => s.kind === SpanKind.SERVER)!;

let provider: NodeTracerProvider;
beforeAll(() => {
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});
beforeEach(() => exporter.reset());

describe("request telemetry", () => {
  test("a request is one server span named after its route, with method, path, status and request id", async () => {
    const { res, spans } = await spansOf("/ok");
    const span = serverSpan(spans);
    expect(span.name).toBe("GET /ok");
    expect(span.attributes).toMatchObject({
      "http.request.method": "GET",
      "url.path": "/ok",
      "http.route": "/ok",
      "http.response.status_code": 200,
      "request.id": res.headers.get("x-request-id"),
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("calls made inside the handler are children of the request span", async () => {
    const { spans } = await spansOf("/ok");
    const child = spans.find((s) => s.name === "firestore.get")!;
    expect(child.parentSpanContext?.spanId).toBe(serverSpan(spans).spanContext().spanId);
    expect(child.spanContext().traceId).toBe(serverSpan(spans).spanContext().traceId);
  });

  test("a caller's traceparent is continued", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentId = "00f067aa0ba902b7";
    const { spans } = await spansOf("/ok", { traceparent: `00-${traceId}-${parentId}-01` });
    const span = serverSpan(spans);
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanContext?.spanId).toBe(parentId);
  });

  test("a dependency failure marks the span failed and records the exception", async () => {
    const { res, spans } = await spansOf("/dependency");
    const span = serverSpan(spans);
    expect(res.status).toBe(502);
    expect(span.attributes["http.response.status_code"]).toBe(502);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.map((e) => e.name)).toContain("exception");
  });

  test("an unexpected error is recorded too", async () => {
    const { spans } = await spansOf("/bug");
    expect(serverSpan(spans).events.map((e) => e.name)).toContain("exception");
  });

  test("a client error is not a failed span and records no exception", async () => {
    const { res, spans } = await spansOf("/valid/abc");
    const span = serverSpan(spans);
    expect(res.status).toBe(400);
    expect(span.attributes["http.response.status_code"]).toBe(400);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.events).toEqual([]);
  });

  test("an unknown route still gets a span, named by its method", async () => {
    const { res, spans } = await spansOf("/nope");
    const span = serverSpan(spans);
    expect(res.status).toBe(404);
    expect(span.name).toBe("GET");
    expect(span.attributes["http.response.status_code"]).toBe(404);
  });
});
