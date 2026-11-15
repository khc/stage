import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

type Env = Record<string, string | undefined>;

let provider: NodeTracerProvider | undefined;

// Registers an OTLP trace exporter when OTEL_EXPORTER_OTLP_ENDPOINT (or the traces-specific
// endpoint) is set, and does nothing otherwise. The exporter reads its URL and headers from
// the standard OTEL_EXPORTER_OTLP_* variables.
//
// This must run before `@google/adk` is imported: ADK creates its tracer when it loads, and
// a tracer created before a provider is registered never records. (ADK's own
// `maybeSetOtelProviders` lives inside ADK, so it can only run after that import.)
export const setupTelemetry = (env: Env = process.env) => {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME || env.CLOUD_RUN_JOB || env.JOB_NAME || "stage-agents",
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
};

// Jobs end with process.exit, which would drop batched spans: flush first.
export const flushTelemetry = () =>
  provider?.forceFlush().catch((err) => console.error("Failed to flush telemetry", err));

// Runs a job as the root span of one trace, so the Firestore calls around ADK's own
// `invocation` span (task lookup, session setup, run bookkeeping) join it instead of each
// starting a trace. A non-zero exit code or a throw marks the span as failed.
export const traceJob = (name: string, run: () => Promise<number>): Promise<number> =>
  trace.getTracer("stage").startActiveSpan(name, async (span) => {
    try {
      const code = await run();
      if (code !== 0) span.setStatus({ code: SpanStatusCode.ERROR, message: `exit code ${code}` });
      return code;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });

// Adds attributes to the running job span; a no-op when there is none.
export const annotateJob = (attributes: Attributes) =>
  trace.getActiveSpan()?.setAttributes(attributes);
