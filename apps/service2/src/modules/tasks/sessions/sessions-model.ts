import { t } from "elysia";

const taskId = t.String({ format: "uuid" });
const sessionId = t.String({ minLength: 1, maxLength: 1500 });

export const SessionsModel = {
  taskParams: t.Object({ taskId }),
  params: t.Object({ taskId, sessionId }),
} as const;

export type SessionsModel = {
  [K in keyof typeof SessionsModel]: (typeof SessionsModel)[K]["static"];
};
