import { t } from "elysia";

const providerKind = t.Union([t.Literal("google"), t.Literal("openai")]);
const nonBlank = (maxLength: number) => t.String({ pattern: "\\S", maxLength });

export const ProvidersModel = {
  kind: providerKind,
  params: t.Object({ providerId: t.String({ format: "uuid" }) }),
  createBody: t.Object({
    name: nonBlank(200),
    kind: providerKind,
    apiKey: t.Optional(nonBlank(1000)),
    baseUrl: t.Optional(nonBlank(500)),
    defaultModel: t.Optional(nonBlank(200)),
    models: t.Optional(t.Array(nonBlank(200), { maxItems: 100 })),
    enabled: t.Optional(t.Boolean()),
  }),
  updateBody: t.Object({
    name: t.Optional(nonBlank(200)),
    kind: t.Optional(providerKind),
    apiKey: t.Optional(t.Union([nonBlank(1000), t.Null()])),
    baseUrl: t.Optional(t.Union([nonBlank(500), t.Null()])),
    defaultModel: t.Optional(t.Union([nonBlank(200), t.Null()])),
    models: t.Optional(t.Union([t.Array(nonBlank(200), { maxItems: 100 }), t.Null()])),
    enabled: t.Optional(t.Boolean()),
  }),
  // Response shape: apiKey is write-only and never serialized out of the service.
  provider: t.Object({
    providerId: t.String({ format: "uuid" }),
    name: t.String(),
    kind: providerKind,
    baseUrl: t.Optional(t.String()),
    defaultModel: t.Optional(t.String()),
    models: t.Optional(t.Array(t.String())),
    enabled: t.Boolean(),
    hasApiKey: t.Boolean(),
    apiKeyHint: t.Optional(t.String()),
    createdAt: t.Number(),
    updatedAt: t.Number(),
  }),
} as const;

export type ProvidersModel = {
  [K in keyof typeof ProvidersModel]: (typeof ProvidersModel)[K]["static"];
};
export type ProviderKind = ProvidersModel["kind"];
export type ProviderSummary = ProvidersModel["provider"];
