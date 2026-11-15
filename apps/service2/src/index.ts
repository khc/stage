import { createAgentRegistry } from "@stage/agents/agent-registry";

import { createApp } from "./app";
import { loadConfig } from "./config";
import { createHealthService } from "./modules/health/health-service";
import { createSessionsService } from "./modules/tasks/sessions/sessions-service";
import { createSessionsStore } from "./modules/tasks/sessions/sessions-store";
import { createTasksService } from "./modules/tasks/tasks-service";
import { createTasksStore } from "./modules/tasks/tasks-store";
import { createFirestoreClient } from "./platform/firestore-client";

const config = loadConfig(process.env);
const firestore = createFirestoreClient();

const app = createApp({
  healthService: createHealthService(),
  tasksService: createTasksService({
    tasksStore: createTasksStore(firestore),
    agentRegistry: createAgentRegistry(firestore),
  }),
  sessionsService: createSessionsService({ sessionsStore: createSessionsStore(firestore) }),
}).listen({ hostname: config.HOST, port: config.PORT });

console.log(`Started server: http://${app.server?.hostname}:${app.server?.port}`);
