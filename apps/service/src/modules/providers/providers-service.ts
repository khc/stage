import {
  createPinnedFetcher,
  hasControlChars,
  isValidHttpUrl,
  readBoundedJson,
  resolveSafeAddresses,
  type DnsResolver,
  type OutboundFetcher,
} from "@stage/http/outbound-url";

import { guard } from "../../errors";
import {
  MAX_MODEL_ID_LENGTH,
  MAX_PROVIDER_MODELS,
  type ProviderKind,
  type ProviderSummary,
} from "./providers-model";
import type { NewProvider, ProviderPatch, ProvidersStore } from "./providers-store";

export type ProvidersFetcher = OutboundFetcher;
export type { DnsRecord, DnsResolver } from "@stage/http/outbound-url";

export type ProvidersServiceDeps = {
  providersStore: ProvidersStore;
  fetcher?: ProvidersFetcher;
  resolver?: DnsResolver;
  // Local/loopback URLs (http://127.0.0.1, http://localhost) stay blocked unless explicitly enabled.
  allowLocalBaseUrl?: boolean;
};

export type CreateProviderResult =
  | { status: "created"; provider: ProviderSummary }
  | { status: "invalid_base_url" | "invalid_api_key" };

export type UpdateProviderResult =
  | { status: "updated"; provider: ProviderSummary }
  | { status: "not_found" | "invalid_base_url" | "invalid_api_key" };

export type FetchModelsInput = {
  kind: ProviderKind;
  providerId?: string;
  apiKey?: string;
  baseUrl?: string | null;
};

export type FetchModelsResult =
  | { status: "ok"; models: string[] }
  | {
      status: "provider_not_found" | "invalid_base_url" | "invalid_api_key" | "api_key_required";
    };

export type ProvidersService = {
  list: () => Promise<ProviderSummary[]>;
  get: (providerId: string) => Promise<ProviderSummary | undefined>;
  create: (input: NewProvider) => Promise<CreateProviderResult>;
  update: (providerId: string, patch: ProviderPatch) => Promise<UpdateProviderResult>;
  delete: (providerId: string) => Promise<boolean>;
  fetchModels: (input: FetchModelsInput) => Promise<FetchModelsResult>;
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
// Express mode cannot list models, so these are the ones Google documents as supported:
// https://cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/overview
export const GOOGLE_EXPRESS_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3-pro-image",
  "gemini-3.1-flash-image",
  "gemini-3.1-pro-preview",
];

const hasValidApiKeyChars = (value: string) => value.length > 0 && !hasControlChars(value);

const modelsUrlFor = (kind: ProviderKind, baseUrl?: string) => {
  const fallback = kind === "google" ? GOOGLE_DEFAULT_BASE : OPENAI_DEFAULT_BASE;
  const parsed = new URL((baseUrl ?? fallback).replace(/\/+$/, ""));
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname =
    path === "" ? (kind === "google" ? "/v1beta/models" : "/v1/models") : `${path}/models`;
  return parsed.toString();
};

const parseProviderModels = (kind: ProviderKind, data: unknown): string[] => {
  if (!data || typeof data !== "object") return [];
  if (kind === "google") {
    const entries = (data as { models?: unknown }).models;
    if (!Array.isArray(entries)) return [];
    const ids = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as { name?: unknown; supportedGenerationMethods?: unknown };
      if (typeof item.name !== "string") return [];
      if (
        Array.isArray(item.supportedGenerationMethods) &&
        !item.supportedGenerationMethods.includes("generateContent")
      ) {
        return [];
      }
      const id = item.name.replace(/^models\//, "").trim();
      return id && id.length <= MAX_MODEL_ID_LENGTH && !hasControlChars(id) ? [id] : [];
    });
    return [...new Set(ids)].toSorted();
  }
  const entries = (data as { data?: unknown }).data;
  if (!Array.isArray(entries)) return [];
  const ids = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = (entry as { id?: unknown }).id;
    const trimmed = typeof id === "string" ? id.trim() : "";
    return trimmed && trimmed.length <= MAX_MODEL_ID_LENGTH && !hasControlChars(trimmed)
      ? [trimmed]
      : [];
  });
  return [...new Set(ids)].toSorted();
};

const cleanModels = (models: string[]) =>
  [...new Set(models.map((m) => m.trim()).filter((m) => hasValidApiKeyChars(m)))].slice(
    0,
    MAX_PROVIDER_MODELS,
  );

// The disabled models that are in the model list; with no list to check against, all of them.
const cleanDisabled = (disabled: string[], models?: string[]) => {
  const cleaned = cleanModels(disabled);
  return models ? cleaned.filter((model) => models.includes(model)) : cleaned;
};

const cleanNullable = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : value.trim();

export const createProvidersService = ({
  providersStore,
  fetcher,
  resolver,
  allowLocalBaseUrl = false,
}: ProvidersServiceDeps): ProvidersService => ({
  list: () => guard("provider_error", providersStore.list),
  get: (providerId) => guard("provider_error", () => providersStore.get(providerId)),
  async create(input) {
    const baseUrl = input.baseUrl?.trim();
    if (baseUrl !== undefined && !isValidHttpUrl(baseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };
    const apiKey = input.apiKey?.trim();
    if (apiKey !== undefined && !hasValidApiKeyChars(apiKey)) return { status: "invalid_api_key" };
    const models = input.models !== undefined ? cleanModels(input.models) : undefined;
    const disabledModels =
      input.disabledModels !== undefined ? cleanDisabled(input.disabledModels, models) : undefined;
    const clean: NewProvider = {
      name: input.name.trim(),
      kind: input.kind,
      ...(apiKey !== undefined && { apiKey }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(input.defaultModel !== undefined && { defaultModel: input.defaultModel.trim() }),
      ...(models !== undefined && { models }),
      ...(disabledModels !== undefined && { disabledModels }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    };
    return {
      status: "created",
      provider: await guard("provider_error", () => providersStore.create(clean)),
    };
  },
  async update(providerId, patch) {
    const baseUrl = cleanNullable(patch.baseUrl);
    if (typeof baseUrl === "string" && !isValidHttpUrl(baseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };

    const apiKey = cleanNullable(patch.apiKey);
    if (typeof apiKey === "string" && !hasValidApiKeyChars(apiKey))
      return { status: "invalid_api_key" };

    const defaultModel = cleanNullable(patch.defaultModel);
    const models =
      patch.models === undefined
        ? undefined
        : patch.models === null
          ? null
          : cleanModels(patch.models);
    // Clearing the model list clears what was switched off in it.
    const disabledModels =
      patch.disabledModels === undefined
        ? models === null
          ? null
          : undefined
        : patch.disabledModels === null
          ? null
          : cleanDisabled(patch.disabledModels, models ?? undefined);

    const clean: ProviderPatch = {
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(apiKey !== undefined && { apiKey }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(defaultModel !== undefined && { defaultModel }),
      ...(models !== undefined && { models }),
      ...(disabledModels !== undefined && { disabledModels }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    };
    const updated = await guard("provider_error", () => providersStore.update(providerId, clean));
    return updated ? { status: "updated", provider: updated } : { status: "not_found" };
  },
  delete: (providerId) => guard("provider_error", () => providersStore.delete(providerId)),
  async fetchModels(input) {
    if (input.kind === "google-express")
      return { status: "ok", models: [...GOOGLE_EXPRESS_MODELS] };
    const rawBaseUrl =
      input.baseUrl === null
        ? null
        : input.baseUrl === undefined
          ? undefined
          : input.baseUrl.trim();
    if (typeof rawBaseUrl === "string" && !isValidHttpUrl(rawBaseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };

    const rawApiKey = input.apiKey?.trim();
    if (rawApiKey !== undefined && !hasValidApiKeyChars(rawApiKey))
      return { status: "invalid_api_key" };

    let apiKey = rawApiKey;
    let baseUrl: string | undefined = typeof rawBaseUrl === "string" ? rawBaseUrl : undefined;
    if (input.providerId !== undefined) {
      const saved = await guard("provider_error", () =>
        providersStore.getCredentials(input.providerId!.toLowerCase()),
      );
      if (!saved) return { status: "provider_not_found" };

      const requestedBaseUrl =
        rawBaseUrl === null ? undefined : rawBaseUrl !== undefined ? rawBaseUrl : saved.baseUrl;
      const endpointMatchesSaved = input.kind === saved.kind && requestedBaseUrl === saved.baseUrl;

      // Never transmit a stored write-only apiKey to a different endpoint or protocol.
      if (!rawApiKey && !endpointMatchesSaved) return { status: "api_key_required" };

      apiKey ??= endpointMatchesSaved ? saved.apiKey : undefined;
      baseUrl = requestedBaseUrl;
    }

    if (baseUrl !== undefined && !isValidHttpUrl(baseUrl, allowLocalBaseUrl))
      return { status: "invalid_base_url" };
    if (!baseUrl && !apiKey) return { status: "api_key_required" };

    const baseEndpoint = modelsUrlFor(input.kind, baseUrl);
    const activeFetcher = await (async (): Promise<ProvidersFetcher | undefined> => {
      if (fetcher && !resolver) return fetcher;
      const resolved = await guard("provider_models_error", () =>
        resolveSafeAddresses(baseEndpoint, { allowLocalBaseUrl, resolver }),
      );
      if (!resolved) return undefined;
      return fetcher ?? createPinnedFetcher(resolved, { maxResponseBytes: MAX_RESPONSE_BYTES });
    })();
    if (!activeFetcher) return { status: "invalid_base_url" };
    const headers: Record<string, string> = {};
    if (apiKey) {
      if (input.kind === "google") headers["x-goog-api-key"] = apiKey;
      else headers.authorization = `Bearer ${apiKey}`;
    }

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const models = await guard("provider_models_error", async () => {
      const collected: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 5; page++) {
        const endpoint = new URL(baseEndpoint);
        if (pageToken) endpoint.searchParams.set("pageToken", pageToken);
        const response = await activeFetcher(endpoint.toString(), {
          headers,
          redirect: "error",
          signal,
        });
        if (!response.ok) throw new Error(`Provider models request failed (${response.status})`);
        const payload = (await readBoundedJson(response, MAX_RESPONSE_BYTES)) as {
          nextPageToken?: unknown;
        };
        collected.push(...parseProviderModels(input.kind, payload));
        pageToken =
          input.kind === "google" &&
          typeof payload?.nextPageToken === "string" &&
          payload.nextPageToken
            ? payload.nextPageToken
            : undefined;
        if (!pageToken) break;
      }
      return [...new Set(collected)].toSorted().slice(0, MAX_PROVIDER_MODELS);
    });
    return { status: "ok", models };
  },
});
