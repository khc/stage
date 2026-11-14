import { setupTelemetry } from "./telemetry";

// Imported first by the CLI so the provider exists before ADK loads (see setupTelemetry).
setupTelemetry();
