import { t } from "elysia";

export const HealthModel = {
  ok: t.Object({ ok: t.Literal(true) }),
} as const;

export type HealthModel = { [K in keyof typeof HealthModel]: (typeof HealthModel)[K]["static"] };
