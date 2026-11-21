import { guard } from "../../errors";
import type { ProviderSummary } from "./providers-model";
import type { NewProvider, ProviderPatch, ProvidersStore } from "./providers-store";

export type ProvidersServiceDeps = {
  providersStore: ProvidersStore;
};

export type CreateProviderResult =
  | { status: "created"; provider: ProviderSummary }
  | { status: "invalid_base_url" };

export type UpdateProviderResult =
  | { status: "updated"; provider: ProviderSummary }
  | { status: "not_found" | "invalid_base_url" };

export type ProvidersService = {
  list: () => Promise<ProviderSummary[]>;
  get: (providerId: string) => Promise<ProviderSummary | undefined>;
  create: (input: NewProvider) => Promise<CreateProviderResult>;
  update: (providerId: string, patch: ProviderPatch) => Promise<UpdateProviderResult>;
  delete: (providerId: string) => Promise<boolean>;
};

const isValidHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
};

const cleanModels = (models: string[]) => [...new Set(models.map((m) => m.trim()).filter(Boolean))];

const cleanNullable = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : value.trim();

export const createProvidersService = ({
  providersStore,
}: ProvidersServiceDeps): ProvidersService => ({
  list: () => guard("provider_error", providersStore.list),
  get: (providerId) => guard("provider_error", () => providersStore.get(providerId)),
  async create(input) {
    const baseUrl = input.baseUrl?.trim();
    if (baseUrl !== undefined && !isValidHttpUrl(baseUrl)) return { status: "invalid_base_url" };
    const clean: NewProvider = {
      name: input.name.trim(),
      kind: input.kind,
      ...(input.apiKey !== undefined && { apiKey: input.apiKey.trim() }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(input.defaultModel !== undefined && { defaultModel: input.defaultModel.trim() }),
      ...(input.models !== undefined && { models: cleanModels(input.models) }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    };
    return {
      status: "created",
      provider: await guard("provider_error", () => providersStore.create(clean)),
    };
  },
  async update(providerId, patch) {
    const baseUrl = cleanNullable(patch.baseUrl);
    if (typeof baseUrl === "string" && !isValidHttpUrl(baseUrl))
      return { status: "invalid_base_url" };

    const apiKey = cleanNullable(patch.apiKey);
    const defaultModel = cleanNullable(patch.defaultModel);
    const models =
      patch.models === undefined
        ? undefined
        : patch.models === null
          ? null
          : cleanModels(patch.models);

    const clean: ProviderPatch = {
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(apiKey !== undefined && { apiKey }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(defaultModel !== undefined && { defaultModel }),
      ...(models !== undefined && { models }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    };
    const updated = await guard("provider_error", () => providersStore.update(providerId, clean));
    return updated ? { status: "updated", provider: updated } : { status: "not_found" };
  },
  delete: (providerId) => guard("provider_error", () => providersStore.delete(providerId)),
});
