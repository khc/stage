import { FieldValue, type DocumentData, type Firestore } from "@google-cloud/firestore";

import type { ProviderKind, ProviderSummary } from "./providers-model";

export type NewProvider = {
  name: string;
  kind: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  enabled?: boolean;
};

export type ProviderPatch = {
  name?: string;
  kind?: ProviderKind;
  apiKey?: string | null;
  baseUrl?: string | null;
  defaultModel?: string | null;
  models?: string[] | null;
  enabled?: boolean;
};

export type ProvidersStore = {
  create: (input: NewProvider) => Promise<ProviderSummary>;
  list: () => Promise<ProviderSummary[]>;
  get: (providerId: string) => Promise<ProviderSummary | undefined>;
  // Internal lookup for outbound provider calls (e.g. listing models); never serialized over HTTP.
  getCredentials: (
    providerId: string,
  ) => Promise<{ kind: ProviderKind; apiKey?: string; baseUrl?: string } | undefined>;
  update: (providerId: string, patch: ProviderPatch) => Promise<ProviderSummary | undefined>;
  // False when there was no such provider.
  delete: (providerId: string) => Promise<boolean>;
};

const toApiKeyHint = (apiKey: string) =>
  apiKey.length >= 12 ? `••••${apiKey.slice(-4)}` : "••••";

const toProviderSummary = (providerId: string, data: DocumentData): ProviderSummary => {
  const apiKey = typeof data.apiKey === "string" && data.apiKey.length > 0 ? data.apiKey : undefined;
  return {
    providerId,
    name: data.name as string,
    kind: data.kind as ProviderKind,
    ...(typeof data.baseUrl === "string" && { baseUrl: data.baseUrl }),
    ...(typeof data.defaultModel === "string" && { defaultModel: data.defaultModel }),
    ...(Array.isArray(data.models) && { models: data.models as string[] }),
    enabled: data.enabled !== false,
    hasApiKey: apiKey !== undefined,
    ...(apiKey !== undefined && { apiKeyHint: toApiKeyHint(apiKey) }),
    createdAt: data.createdAt as number,
    updatedAt: data.updatedAt as number,
  };
};

const CLEARABLE_FIELDS = ["apiKey", "baseUrl", "defaultModel", "models"] as const;

export const createProvidersStore = (
  firestore: Pick<Firestore, "collection" | "runTransaction">,
): ProvidersStore => {
  const providers = firestore.collection("providers");
  return {
    async create(input) {
      const now = Date.now();
      const providerId = crypto.randomUUID();
      const record: DocumentData = {
        providerId,
        name: input.name,
        kind: input.kind,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
        ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
        ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
        ...(input.defaultModel !== undefined && { defaultModel: input.defaultModel }),
        ...(input.models !== undefined && { models: input.models }),
      };
      await providers.doc(providerId).create(record);
      return toProviderSummary(providerId, record);
    },
    async list() {
      const snapshot = await providers.get();
      return snapshot.docs
        .map((doc) => toProviderSummary(doc.id, doc.data()))
        .toSorted((a, b) => a.createdAt - b.createdAt || a.providerId.localeCompare(b.providerId));
    },
    async get(providerId) {
      const doc = await providers.doc(providerId).get();
      return doc.exists ? toProviderSummary(doc.id, doc.data()!) : undefined;
    },
    async getCredentials(providerId) {
      const doc = await providers.doc(providerId).get();
      if (!doc.exists) return undefined;
      const data = doc.data()!;
      const apiKey =
        typeof data.apiKey === "string" && data.apiKey.length > 0 ? data.apiKey : undefined;
      const baseUrl = typeof data.baseUrl === "string" ? data.baseUrl : undefined;
      return {
        kind: data.kind as ProviderKind,
        ...(apiKey !== undefined && { apiKey }),
        ...(baseUrl !== undefined && { baseUrl }),
      };
    },
    async update(providerId, patch) {
      const ref = providers.doc(providerId);
      return firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return undefined;

        const existing = snapshot.data()!;
        const nextKind = patch.kind ?? (existing.kind as ProviderKind);
        const existingBaseUrl = typeof existing.baseUrl === "string" ? existing.baseUrl : undefined;
        const nextBaseUrl =
          patch.baseUrl === undefined
            ? existingBaseUrl
            : patch.baseUrl === null
              ? undefined
              : patch.baseUrl;
        // Clear any saved apiKey when the provider protocol or endpoint changes without a new key
        // so an existing credential is never redirected to a different host or protocol.
        const endpointChanged = nextKind !== existing.kind || nextBaseUrl !== existingBaseUrl;
        const effectivePatch =
          endpointChanged && patch.apiKey === undefined ? { ...patch, apiKey: null } : patch;

        const now = Date.now();
        const nextRecord: DocumentData = { ...existing, updatedAt: now };
        const updates: DocumentData = { updatedAt: now };

        if (effectivePatch.name !== undefined) {
          nextRecord.name = effectivePatch.name;
          updates.name = effectivePatch.name;
        }
        if (effectivePatch.kind !== undefined) {
          nextRecord.kind = effectivePatch.kind;
          updates.kind = effectivePatch.kind;
        }
        if (effectivePatch.enabled !== undefined) {
          nextRecord.enabled = effectivePatch.enabled;
          updates.enabled = effectivePatch.enabled;
        }
        for (const field of CLEARABLE_FIELDS) {
          const value = effectivePatch[field];
          if (value === null) {
            delete nextRecord[field];
            updates[field] = FieldValue.delete();
          } else if (value !== undefined) {
            nextRecord[field] = value;
            updates[field] = value;
          }
        }

        tx.update(ref, updates);
        return toProviderSummary(providerId, nextRecord);
      });
    },
    async delete(providerId) {
      const ref = providers.doc(providerId);
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    },
  };
};
