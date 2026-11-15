import { createApp } from "./app";
import { loadConfig } from "./config";
import { createHealthService } from "./modules/health/service";

const config = loadConfig(process.env);
const app = createApp({ healthService: createHealthService() }).listen(config.PORT);

console.log(`Started server: http://${app.server?.hostname}:${app.server?.port}`);
