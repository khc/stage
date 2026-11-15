import { setupTelemetry } from "@stage/http/otel";

// Loaded with `bun --preload` (see package.json and Dockerfile.service) so the tracer provider
// exists before `@google/adk` loads: ADK creates its tracer on import, and one created earlier
// never records. Traces go out only when an OTEL_EXPORTER_OTLP_*ENDPOINT is set.
setupTelemetry({
  ...process.env,
  OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || "stage-service",
});
