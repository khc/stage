import { t } from "elysia";

const taskId = t.String({ format: "uuid" });
const sessionId = t.String({ minLength: 1, maxLength: 1500 });

export const SessionsModel = {
  taskParams: t.Object({ taskId }),
  params: t.Object({ taskId, sessionId }),
  // Response shapes, used only to document the API.
  summary: t.Object({
    id: t.String(),
    taskId: t.String(),
    name: t.Optional(t.String()),
    appName: t.String(),
    userId: t.String(),
    lastUpdateTime: t.Number(),
    run: t.Optional(
      t.Object(
        {
          status: t.String(),
          mode: t.Optional(t.Union([t.Literal("quick"), t.Literal("workflow")])),
        },
        { additionalProperties: true },
      ),
    ),
  }),
  stats: t.Object({
    events: t.Number(),
    llmCalls: t.Number(),
    tokens: t.Object({
      prompt: t.Number(),
      candidates: t.Number(),
      thoughts: t.Number(),
      toolUsePrompt: t.Number(),
      cached: t.Number(),
      total: t.Number(),
    }),
  }),
} as const;

export type SessionsModel = {
  [K in keyof typeof SessionsModel]: (typeof SessionsModel)[K]["static"];
};
