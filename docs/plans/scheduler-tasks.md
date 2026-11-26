# Task schedules: work plan

Breaks [scheduler-plan.md](scheduler-plan.md) into tasks. Each task is one reviewable change with its own check. Tick a box when its check passes.

Checks use `bun test <path>`, `bun check` and, for infra, `task tf:apply`. Infra changes go through Terraform only (AGENTS.md).

Dependencies: T1 → T2 → T3 → T4 → T5 → T6 → T7. T8 needs T5 (the routes must be mounted for the Eden types), T9 needs T6.

## T1. Terraform and config

- [x] `infra/envs/gcp/main.tf`: add Cloud Scheduler to `google_project_service.apis`; a service account for Scheduler; add it to the service's invokers (`service_invokers` / the `service_invoker` IAM member).
- [x] `infra/envs/gcp/main.tf`: permission for the service's account to manage Scheduler jobs (a custom role like `service_pubsub`, not `cloudscheduler.admin`) and `iam.serviceAccountUser` on the Scheduler account.
- [x] `infra/modules/stage`: pass the Scheduler settings (location, target base URL, invoker account) to the service through `service_extra_env`. The target base URL is a variable; the service cannot read its own `uri` in its own env (cycle).
- [x] `infra/envs/local`: nothing to add. Floci ignores IAM and APIs, and a Floci-hosted service has no stable address for Floci's Scheduler to call (the revision container name and published port change), so locally the service runs on the host with `SCHEDULER_TARGET_URL=http://host.docker.internal:3000` in `.env`. Documented in `infra/README.md`.
- [x] Service config (`apps/control-service/src/config.ts`, via `createConfigLoader`): Scheduler location, target base URL, invoker account, all optional. With none set the service starts and the schedule routes answer 501.
- Check: `terraform validate` passes for `gcp`; `bun test apps/control-service/src/config.test.ts` and `bun check` pass. Done. Not run: a `gcp` plan (no project/credentials here), and the Scheduler permission names (`cloudscheduler.jobs.create/get/update/delete`) are unchecked against a real project.

## T2. Cloud Scheduler platform client

- [ ] Throwaway script against Floci with `@google-cloud/scheduler` in REST fallback: `createJob`, `getJob`, a duplicate `createJob`, `deleteJob`. Print `err.code` and `err.message`.
- [ ] Decide library or plain `fetch` from the result (see the plan). Add the dependency with `bun install` if the library is used.
- [ ] `apps/control-service/src/platform/cloud-scheduler-client.ts`: `CloudScheduler` type, `createCloudScheduler(client, config)` with `get`, `create`, `update`, `delete`, and an emulator branch like `createJobsClient`.
- [ ] Return `undefined` from `get` for a missing job and `false` from `delete`; map `ALREADY_EXISTS` and `INVALID_ARGUMENT` to typed results or errors.
- [ ] `cloud-scheduler-client.test.ts` with a fake client: job name `task-<taskId>`, HTTP target built from config (URL `…/tasks/<taskId>/run`, `POST`, no body, OIDC with the invoker account), update changes the schedule, the time zone and the HTTP target (so a re-save repairs a changed URL), error mapping, and `toSchedule` (protobuf `{ seconds, nanos }` to ISO strings, last attempt `status` only when it failed, all four `state` values).
- Check: `bun test apps/control-service/src/platform/cloud-scheduler-client.test.ts`; `bun check`.

## T3. Schedules model

- [ ] `modules/tasks/schedules/schedules-model.ts` (TypeBox): request `{ cron, timeZone }`, response `{ cron, timeZone, state, scheduleTime, lastAttemptTime, status? }` with `state` one of `ENABLED`, `PAUSED`, `DISABLED`, `UPDATE_FAILED`, and the error bodies.
- [ ] Validation helpers: five-field cron check; time zone check against `Intl.supportedValuesOf("timeZone")` with `UTC` allowed (Floci accepts any zone, and `Intl.DateTimeFormat` alone can accept offsets such as `+01:00` that Scheduler rejects).
- Check: a model test with valid and invalid crons and zones; `bun check`.

## T4. Schedules service

- [ ] `schedules-service.ts`: `createSchedulesService({ cloudScheduler, ... })` with `get`, `create`, `update`, `delete`; a status for every expected outcome (`schedule_not_found`, `schedule_exists`, `invalid_schedule`, `task_not_executable`), `DependencyError` for failures.
- [ ] Export a small executability function from the tasks service module (task and `allowedJobs` in, boolean out) and use it in both `TasksService.run` and the schedules service. Existing `run` tests must still pass.
- [ ] `schedules-service.test.ts` with a fake `CloudScheduler`: every status, `POST` on a non-executable task, `PUT` on a missing schedule, dependency failure wrapped in `DependencyError`.
- Check: `bun test apps/control-service/src/modules/tasks/schedules`; `bun check`.

## T5. Schedules controller and wiring

- [ ] `schedules-controller.ts`: an Elysia instance taking `tasksService` and the schedules service, using `tasksGuard(tasksService)`. Routes `GET`, `POST`, `PUT`, `DELETE` on `/schedule` with the statuses from the plan's API table and `doc(...)` entries.
- [ ] Add `schedulesService?` to `AppDeps` (undefined when the Scheduler config is not set, like `documentsService`) and have `index.ts` build it. Mount the controller from the tasks controller (`.use(...)` next to sessions and documents), keeping `createApp` one unbroken chain.
- [ ] Route tests in `app.test.ts` through `createApp` with a fake `CloudScheduler`: each route and status, unknown task gives `task_not_found`, no service gives 501.
- Check: `bun test apps/control-service/src/app.test.ts`; `bun check`; the OpenAPI document lists the four routes.

## T6. Delete the schedule with the task

- [ ] Add an optional `cloudScheduler` to `TasksServiceDeps` (skipped when undefined, like `documentsStore`); in `delete`, remove the schedule **before** sessions and the task. A missing schedule counts as success; any other failure throws `DependencyError` and leaves the task in place.
- [ ] Tests in `tasks-service.test.ts`: schedule deleted first; a failing scheduler leaves the task and sessions; a task with no schedule still deletes.
- Check: `bun test apps/control-service/src/modules/tasks/tasks-service.test.ts`; `bun check`.

## T7. End-to-end check on Floci

- [ ] Pick the service's local form first, because Scheduler's tick comes from inside Floci's container: a service run with `bun` on the host needs a target URL of `http://host.docker.internal:<port>`; the service that Floci runs as its own container needs that container's address instead. Set the config accordingly.
- [ ] Run the service and Floci (`docker-compose.yml`), create a task, `POST` a `* * * * *` schedule, watch a tick call `/tasks/<id>/run` and start the job (a session appears), `PUT` a new cron, `GET` the state, `DELETE`.
- [ ] Delete a task with a schedule and confirm the Scheduler job is gone (`GET` the job in Floci returns 404).
- [ ] Note: Floci ignores OIDC and retries, so those are checked later on real GCP.
- Check: the steps above pass; Floci's job list is empty afterwards. No hand-made Floci resources are left behind.

## T8. UI

- [ ] `apps/ui/src/lib/api.ts`: `schedule`, `createSchedule`, `updateSchedule`, `deleteSchedule` on `task(id).schedule`; `Schedule` type (types come from `import type { App }`, no generation step); messages for `schedule_exists`, `schedule_not_found`, `invalid_schedule` and the dependency error. The view shows the last attempt's failure `status` and any of the four `state` values.
- [ ] `features/tasks/task-schedule.tsx` and the Schedule tab in `task-sheet.tsx`: query `["schedule", taskId]` enabled only while the tab is open, with a 404 mapped to "no schedule"; empty, view and form states; presets; time zone select; mutations with toasts; Add disabled without a `jobName`; refresh button.
- [ ] `task-sheet.tsx` also does `removeQueries(["schedule", taskId])` on task deletion.
- [ ] Tests in `api.test.ts` (schedule calls, 404 to none) and for the cron and time zone validation helper.
- Check: `bun run typecheck` and the tests in `apps/ui`; try the tab in `bun run dev:ui` against Floci (create, edit, delete, error on a bad cron).

## T9. Docs

- [ ] Update [apps/control-service/PLAN.md](../../apps/control-service/PLAN.md) and the README for the new routes and config.
- [ ] Check `apps/ui/nginx.conf.template` routes `/tasks/:id/schedule` to the service in the deployed setup.
- [ ] Mark the plan's status as implemented and move answered open questions into the plan's decisions.

## Later: real GCP

- [ ] Verify OIDC (Scheduler's token accepted by Cloud Run IAM) and the retry config on a real project.
- [ ] Decide the open questions in the plan: overlap guard, session retention, public vs IAM-only service.
