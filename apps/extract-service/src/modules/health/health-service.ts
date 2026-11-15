import type { HealthModel } from "./health-model";

export type HealthService = {
  check: () => HealthModel["ok"];
};

export const createHealthService = (): HealthService => ({
  check: () => ({ ok: true }),
});
