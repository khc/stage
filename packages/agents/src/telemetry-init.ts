import { setupTelemetry } from "./telemetry";

// Loaded with `bun --preload` so the provider exists before ADK loads (see setupTelemetry).
setupTelemetry();
