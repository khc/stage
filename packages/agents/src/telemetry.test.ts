import { afterEach, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";

import { annotateJob, flushTelemetry, setupTelemetry, traceJob } from "./telemetry";

afterEach(() => trace.disable());

test("without an endpoint nothing is registered and flushing is a no-op", async () => {
  setupTelemetry({});
  expect(trace.getTracerProvider().constructor.name).toBe("ProxyTracerProvider");
  expect(await flushTelemetry()).toBeUndefined();
});

test("a traces endpoint registers a recording tracer provider", () => {
  setupTelemetry({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:1/v1/traces" });
  expect(trace.getTracer("t").startSpan("s").isRecording()).toBe(true);
});

test("traceJob returns the exit code and runs without a provider", async () => {
  expect(await traceJob("job", async () => 3)).toBe(3);
  await expect(
    traceJob("job", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(annotateJob({ a: 1 })).toBeUndefined();
});
