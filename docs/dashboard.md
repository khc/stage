# Dashboard

The dashboard (`apps/ui`) is a React app served by Vite on <http://localhost:5173>. It talks to the control service only, so both must be running:

```bash
bun run dev:service     # port 3000
bun run dev:ui          # port 5173
```

The dev server proxies the API paths to `SERVICE_URL` (default `http://localhost:3000`), so the browser only talks to port 5173. See [Configuration](configuration.md#dashboard).

## Pages

| Page               | Path                  | What you do there                                                        |
| ------------------ | --------------------- | ------------------------------------------------------------------------ |
| Overview           | `/overview`           | See the state of the platform at a glance                                |
| Assistant          | `/assistant`          | Chat with an agent. Chats are saved as tasks, so they also show in Tasks |
| Tasks              | `/tasks`              | List, search, create, run and delete tasks                               |
| Task               | `/tasks/:taskId`      | Open a task: sessions, documents and output                              |
| Jobs               | `/jobs`               | See the Cloud Run jobs and their agents                                  |
| Providers          | `/settings/providers` | Add and manage model providers                                           |
| Assistant settings | `/settings/assistant` | Choose the agent, run mode and model the assistant uses                  |

The API reference stays at <http://localhost:3000/docs>.

## Work with tasks

- **Search** tasks by prompt, job or id. Press `/` to focus the search box.
- **Create** a task with **New task**: pick the job, then the agent (the list shows the job's registered agents, or only "Default agent" if none are registered), then the prompt. A structured agent shows a form built from its input schema. Saving does not run the task.
- **Run** from the task pane. The notice says the run was submitted; it does not claim the agent finished.
- **Sessions:** open one to see its summary, state and ordered events. The totals of tokens and model calls are at the top. An open session streams new events live (when the service has `PUBSUB_TOPIC`), its form continues the session with a new message, and the trash button deletes it after an inline confirmation.
- **Sub-tasks** started by the orchestrator appear indented under their parent.
- **Delete** a task with the trash button next to **Run task**. The confirmation names the number of sessions and sub-tasks that go with it.
- **Output tab:** a JSON reply is shown field by field.

Tasks, jobs and visible sessions refresh every 15 seconds. When the service has `PLATFORM_EVENTS_TOPIC`, the dashboard refreshes from [platform events](api.md#platform-events) instead and polls only while that stream is down.

## Work with jobs

Open a job card, or choose **Details**, to see a pane with three tabs:

- **Overview:** status, image, retries, timeout, CPU and memory, dates, execution count and the names of the environment variables. Values are never shown.
- **Agents:** each registered agent with its input and output.
- **Tasks:** the tasks that use the job.

**Register agents** on a card does the same as `POST /jobs/:jobName/register`. The card lists the job's agents and refreshes every 3 seconds for 30 seconds after you register.

## Appearance

Use the Light / Dark / System control in the top bar. System is the default and follows your device. The choice is saved in the browser and synchronised across tabs. If browser storage is unavailable, switching still works for the current page. The saved theme is applied before styles load, so the page does not flash.

## Build the image

```bash
task build:ui           # stage/ui:latest, nginx serving the build on port 8080
```

The image proxies the API paths, including `/docs` and `/openapi.json`, to the `SERVICE_URL` environment variable (a bare `scheme://host:port` with no path; default `http://host.docker.internal:3000`). The proxy adds no authentication or TLS. Publish the port on `127.0.0.1` (`-p 127.0.0.1:8080:8080`) or run the image behind an authenticated ingress.

`bun run --filter @stage/ui build` produces the static bundle in `apps/ui/dist`.

## For developers

Change `apps/ui` by the rules in [UI guidelines](ui-guidelines.md). Its API types come from the service (`import type { App } from "@stage/control-service/app"`), so a changed route is a type error in the UI.
