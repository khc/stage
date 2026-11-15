import { Elysia } from "elysia";

import { HealthModel } from "./model";
import type { HealthService } from "./service";

export const healthController = (healthService: HealthService) =>
  new Elysia().get("/health", () => healthService.check(), { response: HealthModel.ok });
