# Task schedules plan

Manage a run schedule per task through Cloud Scheduler, exposed as `/tasks/:taskId/schedule` (`GET`, `POST`, `PUT`, `DELETE`).

Status: proposal. Checked against `tasks-service.ts`, `tasks-controller.ts`, `tasks-guard.ts`, `app.ts`, `cross-site.ts` and the layout of `infra/`, and the Floci behaviour was tested in a spike. Work breakdown: [scheduler-tasks.md](scheduler-tasks.md).

## Design decisions

1. **The Scheduler job targets the stage service, not the Cloud Run job.** It makes an HTTP POST with no body to the existing `/tasks/:taskId/run`, which is a plain run.
   - Calling the job's `:run` endpoint directly would skip `TasksService.run` (the task and job checks) and would need a body with `overrides.containerOverrides[].env` carrying `TASK_ID`.
   - Cost: the service must be reachable from Scheduler. On GCP that means an OIDC token and `run.invoker` on the service. Locally, Floci's tick must reach the service (probably via `host.docker.internal`).
   - Cost: each Scheduler job stores the service base URL, so changing the URL means rewriting every job. `PUT` also rewrites the HTTP target, so re-saving a schedule repairs it.
   - Scheduler's request has no `Sec-Fetch-Site` header, so `rejectCrossSite` lets it through (it only blocks `cross-site`).
   - The base URL comes from config (a variable in Terraform). The service cannot read its own `uri` in its own Cloud Run env, which would be a Terraform cycle.
2. **One schedule per task, with a deterministic name.** The Scheduler job is named `task-<taskId>` (ids are lowercase UUIDs, valid in job names).
   - Scheduler is the source of truth, so no new Firestore collection is needed.
   - `PUT` and `DELETE` are idempotent.
3. **Each tick starts a new run and a new session.** A resume needs a queued message, which a schedule does not have.
4. **Overlapping runs are allowed in v1.** `TasksService.run` checks `run_in_progress` only when resuming a session; a plain run always starts a new execution. A run that outlasts the cron interval therefore overlaps the next one. A guard for plain runs would change manual runs too, so it is left out of this feature (see open questions).
5. **Only schedulable tasks get a schedule.** `POST` and `PUT` refuse a task that `run` would answer `task_not_executable` for (no valid `jobName`, or a job outside `allowedJobs`); otherwise every tick fails with 409.

## API

Request model: `{ cron, timeZone }`. Pause and resume are out of v1.

Response model: `{ cron, timeZone, state, scheduleTime, lastAttemptTime, status }`.

- `state` is Scheduler's own: `ENABLED`, `PAUSED`, `DISABLED` or `UPDATE_FAILED`.
- `scheduleTime` is the next run and `lastAttemptTime` the last tick, both as ISO strings. The Scheduler client returns protobuf `{ seconds, nanos }`, so a `toSchedule` converter maps the job to this shape.
- `status` is the last attempt's result, `{ code, message }`, present only when it failed. This is how a failed delivery shows up, since no session exists for it.

If no Scheduler config is set, the service still starts and the schedule routes answer 501, like the document and events routes. `TasksService.delete` then skips the schedule step.

| Method   | Success | Errors                                                                      |
| -------- | ------- | --------------------------------------------------------------------------- |
| `POST`   | 201     | 409 `schedule_exists`, 409 `task_not_executable`, 400 `invalid_schedule`    |
| `GET`    | 200     | 404 `schedule_not_found`                                                    |
| `PUT`    | 200     | 404 `schedule_not_found`, 409 `task_not_executable`, 400 `invalid_schedule` |
| `DELETE` | 204     | 404 `schedule_not_found`                                                    |

All routes return 404 `task_not_found` (from `tasksGuard`).

Validation and error mapping:

- Cron: a light 5-field check in the model; the API's `INVALID_ARGUMENT` maps to 400 `invalid_schedule`. No new dependency.
- Time zone: checked against `Intl.supportedValuesOf("timeZone")`, with `UTC` allowed explicitly. A try/catch around `Intl.DateTimeFormat` is too loose (it can accept offsets such as `+01:00`, which Scheduler rejects).
- `POST` relies on the API's `ALREADY_EXISTS` for 409 instead of get-then-create, which races. Floci returns Google-style JSON errors over HTTP with the status name in `error.status`, so map on that (confirmed by the spike).

## Code layout

- `apps/control-service/src/platform/cloud-scheduler-client.ts`: `CloudScheduler` type and `createCloudScheduler(client, config)` with `get`, `create`, `update`, `delete`. Same shape as `cloud-run-jobs-client.ts`, including an emulator branch with no auth.
  - Built on Google's `@google-cloud/scheduler` (`CloudSchedulerClient`), a GAPIC client like the `@google-cloud/run` one already used. The factory takes a `Pick<CloudSchedulerClient, "getJob" | "createJob" | "updateJob" | "deleteJob" | "locationPath" | "jobPath">`, so tests pass a plain fake. `pauseJob` and `resumeJob` are there for later.
  - Emulator: copy `createJobsClient` (`fallback: "rest"`, host and port from an env var, `protocol: "http"`, the `noAuth` stub). Not yet tried against Floci.
  - Errors: the client throws errors with a gRPC status `code` (5 `NOT_FOUND`, 6 `ALREADY_EXISTS`, 3 `INVALID_ARGUMENT`). In REST fallback mode it is unclear whether `err.code` is the gRPC number or the HTTP status. Before writing the client, run a throwaway script against Floci (`createJob`, `getJob`, a duplicate `createJob`) and print `err.code` and `err.message`. If REST fallback works and errors are mappable, use the library; otherwise a plain `fetch` to the REST API avoids the dependency but means hand-built paths and auth.
- `apps/control-service/src/modules/tasks/schedules/`: `schedules-model.ts`, `schedules-service.ts`, `schedules-controller.ts`.
  - The controller takes `tasksService` and uses `tasksGuard(tasksService)`, as `sessionsController` does; the handler gets the `task` from the guard.
  - The service takes `cloudScheduler` and the base URL and invoker account from config. It returns a status for every expected outcome and throws `DependencyError` on failure.
  - The executability check lives in the service, using the same `jobName` / `allowedJobs` rule as `TasksService.run`. Export a small function from the tasks service module that takes the task and `allowedJobs`, and have both `run` and the schedules service call it.
  - `toSchedule` converts the Scheduler job to the response model. `update` changes the schedule, the time zone and the HTTP target.
  - The schedules service is optional in `AppDeps` (like `documentsService`); the controller answers 501 when it is undefined.
- `TasksService` gets an optional `cloudScheduler` dependency, like `documentsStore`. `delete` removes the schedule **first**, treating "not found" as success; any other failure throws `DependencyError` and leaves the task in place to retry. The reverse order could leave an orphan cron.
- Config: Scheduler location, service base URL for the target, invoker service account.
- `createApp` stays one unbroken chain.

## Infrastructure (Terraform only)

Service accounts, IAM and the API list live in `infra/envs/gcp/main.tf`; `infra/modules/stage` holds the Cloud Run resources and env maps. The new pieces follow that split:

- `infra/envs/gcp`: add Cloud Scheduler to `google_project_service.apis`; a service account for Scheduler; that account added to the service's invokers (`service_invokers` and the `service_invoker` IAM member); permission for the service's account to manage Scheduler jobs plus `iam.serviceAccountUser` on the Scheduler account. `cloudscheduler.admin` works but is broad; a custom role (as `service_pubsub` already is) is better.
- `infra/modules/stage`: pass the Scheduler settings (location, target base URL, invoker account) into the service through `service_extra_env`. The target base URL is a variable, not the service's own `uri`.
- `infra/envs/local`: nothing for IAM or APIs, since Floci ignores them. Only the env values for the local service (target URL reachable from Floci's container, such as `http://host.docker.internal:3000`).
- Terraform declares no schedule jobs; the app creates them at runtime.
- Set the job retry config deliberately: a 502 from `/run` followed by a retry can start a second execution.

## UI (`apps/ui`)

A **Schedule** tab in the task details pane ([task-sheet.tsx](../../apps/ui/src/features/tasks/task-sheet.tsx)), after Documents. The UI's types come from the service through Eden, so this starts once the routes exist.

- **Tab and component.** Add `<PaneTab value="schedule">` (icon `CalendarClock`) and a `TabsContent` that renders a new `TaskSchedule` component in `features/tasks/task-schedule.tsx`. The tab has no count.
- **API client** ([api.ts](../../apps/ui/src/lib/api.ts)). Add `schedule(id)`, `createSchedule`, `updateSchedule` and `deleteSchedule` on `task(id).schedule`, plus `Schedule` as the type of the `GET` reply. Add messages for the new error codes: `schedule_exists`, `schedule_not_found`, `invalid_schedule` and a `schedule_error` for dependency failures.
- **Query.** Key `["schedule", taskId]`, enabled only while the Schedule tab is open, so opening a task does not call Cloud Scheduler. A 404 from `GET` means "no schedule", not an error: the query function turns an `ApiError` with status 404 into `null`, with `retry: false`. This is safe because the task is already loaded, so the 404 cannot be `task_not_found`.
- **States.**
  - Loading and error: the existing `Loading` and `ErrorBox`.
  - No schedule: `Empty` with an "Add schedule" button.
  - Schedule exists: cron, time zone, state badge (`ENABLED`, `PAUSED`, `DISABLED` or `UPDATE_FAILED`), next run (`scheduleTime`), last attempt (`lastAttemptTime`) with its failure `status` when there is one, and Edit and Delete (`ConfirmDelete`).
  - Form (create and edit): a cron input with a few presets (hourly, daily at 09:00, weekdays at 09:00) and a time zone select. The zone defaults to the browser's and the list comes from `Intl.supportedValuesOf("timeZone")`. The form validates the five cron fields the same way as the model, and shows a server `invalid_schedule` as an error.
- **Mutations** follow `useRunTask`: a toast on success and on error, then `invalidateQueries(["schedule", taskId])`. A `POST` that answers `schedule_exists` (409) refetches and shows the existing schedule.
- **Disabled case.** When the task has no `jobName`, the Add button is disabled with a hint, like Run task, since the service refuses it with `task_not_executable`.
- **Task deletion.** The service deletes the schedule with the task; the UI also does `removeQueries(["schedule", taskId])` next to the existing `removeQueries` calls.
- **Refresh.** A refresh button as on the sessions list; no polling.
- **Not in v1:** a human-readable cron description (needs a library such as `cronstrue`; presets give readable labels instead), pause and resume, and any marker on sessions started by a schedule.
- **Proxy.** `/tasks` is already proxied in [vite.config.ts](../../apps/ui/vite.config.ts), and `isSpaRoute` only matches `/tasks/:id`, so `/tasks/:id/schedule` goes to the service. [api-proxy.conf](../../apps/ui/api-proxy.conf) does not filter by path, but check `nginx.conf.template` for the deployed routes.
- **Tests.** The existing UI tests cover `lib/` only, so add `api.test.ts` cases for the schedule calls (including the 404-to-none query function) and a unit test for the cron and time zone validation helper.

## Order of work

1. ~~Floci spike~~ — done, see [Floci spike results](#floci-spike-results).
2. Terraform and config.
3. Platform client with unit tests using a fake client.
4. Model, service and controller with tests; route tests in `app.test.ts`.
5. Schedule deletion in `TasksService.delete`, with a test for the failure order.
6. UI: API client and messages, `TaskSchedule` and the tab, tests. The types need no generation step: they come from `import type { App }`, so this follows step 4 once the routes are mounted.
7. Update [apps/control-service/PLAN.md](../../apps/control-service/PLAN.md) and the README.

## Floci spike results

Run against `floci/floci-gcp:0.12.0` (compose), with `curl` against `http://localhost:4588/v1/projects/floci-local/locations/us-central1/jobs` and a throwaway listener on the host. The jobs were created by hand, outside Terraform, which AGENTS.md otherwise forbids; both were deleted afterwards and Floci's job list is empty again. The listener was never `/run`, so nothing started a Cloud Run job.

- **HTTP targets fire.** `:run` (run-now) delivered the request within about 50 ms, and the background tick delivered a `* * * * *` job on its own, a few seconds after the minute. The request is a `POST` with `content-length: 0` and `user-agent: Java-http-client/25.0.5`, sent over h2c upgrade.
- **Local reachability.** Floci (a container) reached a listener on the host through `http://host.docker.internal:<port>`. A service on the host therefore works as a target locally.
- **No OIDC locally.** The request carried no `Authorization` header, and the stored job dropped `oidcToken`. The auth settings are accepted and ignored, so token handling cannot be tested here.
- **Retry config.** Floci stores `retryConfig` with zero durations. It does not model retries, so retry behaviour is not testable locally.
- **Error shapes are Google-style JSON over HTTP**, with the gRPC status name in `error.status`:
  - create of an existing job: 409 `ALREADY_EXISTS`
  - invalid cron (`nope`): 400 `INVALID_ARGUMENT`
  - get or delete of a missing job: 404 `NOT_FOUND`
- **Time zones are not validated by Floci.** `Mars/Base` was accepted (200), whereas real Scheduler rejects it. The service's own `Intl` check is therefore required, not just a nicety.
- **Update.** `PATCH ...?updateMask=schedule` changed the schedule and returned the job with a new `scheduleTime`.
- **Response fields.** `state`, `scheduleTime` and `lastAttemptTime` are returned as planned.

Consequences for the plan: map errors from `error.status`, keep the time zone check in the service, and treat OIDC and retries as GCP-only behaviour verified on real GCP.

## Open questions

- Should overlapping ticks be prevented? That needs a run-in-progress guard on plain runs, affecting manual runs too.
- Sessions grow with every tick. Is retention needed?
- Is the service publicly reachable on GCP, or IAM-only? This decides the OIDC setup.
- Pause and resume: add later with `pause` / `resume` on the client (separate Scheduler calls, not an update)?
