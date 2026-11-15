import { t } from "elysia";

export const HealthModel = {
  ok: t.Object({ status: t.Literal("ok") }),
} as const;

export type HealthModel = { [K in keyof typeof HealthModel]: (typeof HealthModel)[K]["static"] };
