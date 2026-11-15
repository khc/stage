import { createAgentRegistry } from "@stage/agents/agent-registry";

import { createApp } from "./app";
import { loadConfig } from "./config";
import { createHealthService } from "./modules/health/health-service";
import { MAX_UPLOAD_BYTES } from "./modules/tasks/documents/documents-model";
import { createDocumentsService } from "./modules/tasks/documents/documents-service";
import { createDocumentsStore } from "./modules/tasks/documents/documents-store";
import { createSessionsService } from "./modules/tasks/sessions/sessions-service";
import { createSessionsStore } from "./modules/tasks/sessions/sessions-store";
import { createTasksService } from "./modules/tasks/tasks-service";
import { createTasksStore } from "./modules/tasks/tasks-store";
import { createExtractClient } from "./platform/extract-client";
import { createFirestoreClient } from "./platform/firestore-client";

const config = loadConfig(process.env);
const firestore = createFirestoreClient();

const sessionsStore = createSessionsStore(firestore);
const documentsStore = config.EXTRACT_URL
  ? createDocumentsStore({ firestore, extractClient: createExtractClient(config.EXTRACT_URL) })
  : undefined;

const app = createApp({
  healthService: createHealthService(),
  tasksService: createTasksService({
    tasksStore: createTasksStore(firestore),
    agentRegistry: createAgentRegistry(firestore),
    sessionsStore,
    documentsStore,
  }),
  sessionsService: createSessionsService({ sessionsStore }),
  documentsService: documentsStore && createDocumentsService({ documentsStore }),
}).listen({
  hostname: config.HOST,
  port: config.PORT,
  maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
});

console.log(`Started server: http://${app.server?.hostname}:${app.server?.port}`);
