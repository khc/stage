# Observability

Traces, request ids and usage numbers: how to see what the agents and the services did.

## Send traces to MLflow

MLflow runs in the compose stack (`docker compose up -d mlflow`) at <http://localhost:5001>. Host port 5001 avoids macOS's use of 5000. Its SQLite database and artifacts live on the volume `stage--mlflow--vol-lcl`, which `docker compose down -v` wipes.

1. Create an experiment in the MLflow UI and note its id (`0` is the default one).
2. Uncomment these lines in `.env`:

   ```dotenv
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:5001/v1/traces
   OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
   OTEL_EXPORTER_OTLP_TRACES_HEADERS=x-mlflow-experiment-id=0
   ```

3. Run `task tf:apply` so the jobs get the variables, and restart `bun run dev:service` for the service's own spans.

**You should see:** a trace per run in the experiment.

Use the `*_TRACES_*` variables, not `OTEL_EXPORTER_OTLP_ENDPOINT`: the generic one would also enable metric and log exporters, which are not supported. `task tf:apply` passes every `OTEL_*` variable from `.env` to the jobs (`otel_env` in `infra/envs/local`). The jobs reach MLflow through `host.docker.internal`. A job in Floci can reach `mlflow:5000` only if it shares MLflow's compose network.

Nothing is exported when no endpoint is set. Only traces are exported; metrics and logs are not.

## Agent job traces

- One job run is one trace. An `agent_job` root span (attributes `stage.task_id` and `gcp.vertex.agent.session_id`) wraps the task lookup, the session setup, ADK's `invocation` and the run bookkeeping.
- ADK adds its invocation, agent, LLM and tool spans, and the Firestore client adds its own.
- Spans are flushed before the job exits.
- `service.name` is `OTEL_SERVICE_NAME`, else `CLOUD_RUN_JOB` or `JOB_NAME`, else `stage-agents`.
- The provider is registered by `packages/agents/src/telemetry-init.ts` (it calls `setupTelemetry` from `@stage/http/otel`), which every agent launch command loads with `bun --preload`, before `@google/adk`. ADK creates its tracer when it loads, and a tracer created before the provider never records.
- Rebuild the job images (`task build:agents`) after changing the telemetry code.

## Service traces and request ids

`apps/control-service` and `apps/extract-service` export one server span per request, through the plugins in `@stage/http`.

- The span continues a caller's `traceparent`, is named after the route, and records the status and the request id. The Firestore and Cloud Run calls made while handling the request are its children.
- `service.name` is `OTEL_SERVICE_NAME`, else `stage-service` (`stage-extract` for the extract service).
- Every response carries an `x-request-id` header: the caller's, if it is a short plain id, else a new UUID. The error log and the span repeat it, so you can search for a failed request by id.
- Each app registers the provider in its own `src/telemetry-init.ts`, loaded with `bun --preload` in the `start` and `dev` scripts and in the image's entrypoint.

## Usage per session

`GET /tasks/:taskId/sessions/:sessionId/stats` sums the model usage stored on a session: events, model calls and tokens. The dashboard shows the totals at the top of an open session and updates them as events arrive. See [API](api.md#session-stats).

## See also

- [Configuration](configuration.md): the `OTEL_*` variables in context
- [Architecture](architecture.md): where each span comes from
- [Platform ideas](plans/platform-evolution.md): trace links in the UI and evals with MLflow
