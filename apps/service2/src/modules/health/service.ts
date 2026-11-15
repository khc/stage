import type { HealthModel } from "./model";

export type HealthService = {
  check: () => HealthModel["ok"];
};

export const createHealthService = (): HealthService => ({
  check: () => ({ status: "ok" }),
});
