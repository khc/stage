import { Elysia } from "elysia";

import { createApp } from "./app";
import { loadConfig } from "./config";
import { MAX_EXTRACT_BYTES } from "./modules/extractions/extractions-model";
import { createExtractionsService } from "./modules/extractions/extractions-service";
import { createHealthService } from "./modules/health/health-service";
import { createXberg } from "./platform/xberg-client";

const config = loadConfig(process.env);

// Bun refuses a body over the cap before it is read; the route answers a declared oversize with a
// 413 JSON body.
const app = new Elysia({
  serve: { hostname: config.HOST, maxRequestBodySize: MAX_EXTRACT_BYTES + 1024 * 1024 },
})
  .use(
    createApp({
      healthService: createHealthService(),
      extractionsService: createExtractionsService({ xberg: createXberg() }),
    }),
  )
  .listen(config.PORT);

console.log(`Started server: http://${app.server?.hostname}:${app.server?.port}`);
