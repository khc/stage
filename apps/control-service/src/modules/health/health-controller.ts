import { Elysia } from "elysia";

import { doc } from "../../http/openapi";
import { HealthModel } from "./health-model";
import type { HealthService } from "./health-service";

export const healthController = (healthService: HealthService) =>
  new Elysia().get("/health", () => healthService.check(), {
    response: HealthModel.ok,
    ...doc("Health", "Liveness probe", {
      200: { description: "The service is up.", schema: HealthModel.ok },
    }),
  });
