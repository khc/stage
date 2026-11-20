import { setupTelemetry } from "@stage/http/otel";

// Loaded with `bun --preload` (see package.json and docker/Dockerfile.extract-service). Traces go out only
// when an OTEL_EXPORTER_OTLP_*ENDPOINT is set.
setupTelemetry({
  ...process.env,
  OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || "stage-extract",
});
