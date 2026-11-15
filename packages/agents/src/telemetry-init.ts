import { setupTelemetry } from "@stage/http/otel";

// Loaded with `bun --preload` so the provider exists before ADK loads (see setupTelemetry).
setupTelemetry();
