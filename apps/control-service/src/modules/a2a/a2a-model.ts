import { AgentsModel } from "../agents/agents-model";

// The A2A protocol version the gateway speaks and the version of the cards it serves.
export const A2A_PROTOCOL_VERSION = "0.3.0";
export const A2A_CARD_VERSION = "1.0.0";

// JSON-RPC methods that answer with a stream. v1 only supports the blocking `message/send`.
export const A2A_STREAMING_METHODS: ReadonlySet<string> = new Set([
  "message/stream",
  "tasks/resubscribe",
]);

// Bun lets a request idle for at most this many seconds (its maximum); a delegated run waits longer
// than Elysia's 30 s default, so the A2A route raises the limit. Keep A2A_TIMEOUT_MS below it.
export const A2A_REQUEST_TIMEOUT_SECONDS = 255;
// A2A messages are short text; a larger body is refused before it can be kept in memory.
export const A2A_MAX_BODY_BYTES = 64 * 1024;
// Delegated runs the gateway waits for at once, and finished tasks it remembers.
export const A2A_MAX_IN_FLIGHT = 8;
// Workflow runs the gateway starts per minute: they run in the background and are not waited for, so the
// in-flight cap does not bound them.
export const A2A_MAX_WORKFLOWS_PER_MINUTE = 20;
export const A2A_TASKS_KEPT = 200;
// The explicit-query line of the discovery agent. A message another agent wrote must not trigger it.
export const WEB_SEARCH_PREFIX = /^Web search:/;

export const A2aModel = { agentParams: AgentsModel.agentParams } as const;
