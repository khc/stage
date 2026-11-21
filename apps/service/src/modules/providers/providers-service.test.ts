import { describe, expect, mock, test } from "bun:test";

import { DependencyError } from "../../errors";
import type { ProviderSummary } from "./providers-model";
import { createProvidersService } from "./providers-service";
import type { ProvidersStore } from "./providers-store";

const sample: ProviderSummary = {
  providerId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
  name: "OpenAI",
  kind: "openai",
  enabled: true,
  hasApiKey: true,
  apiKeyHint: "••••1234",
  createdAt: 1,
  updatedAt: 1,
};

const setup = (overrides: Partial<ProvidersStore> = {}) => {
  const create = mock(async () => sample);
  const list = mock(async () => [sample]);
  const get = mock(async () => sample);
  const update = mock(async () => sample);
  const remove = mock(async () => true);
  const store: ProvidersStore = {
    create,
    list,
    get,
    update,
    delete: remove,
    ...overrides,
  };
  return { service: createProvidersService({ providersStore: store }), create, update, remove };
};

describe("providers service", () => {
  test("trims inputs and deduplicates models on create", async () => {
    const { service, create } = setup();
    const result = await service.create({
      name: "  OpenAI Prod  ",
      kind: "openai",
      apiKey: "  sk-1234  ",
      baseUrl: "  https://api.openai.com/v1  ",
      defaultModel: "  gpt-4o  ",
      models: [" gpt-4o ", "gpt-4o-mini", "gpt-4o", "   "],
    });

    expect(result).toEqual({ status: "created", provider: sample });
    expect(create).toHaveBeenCalledWith({
      name: "OpenAI Prod",
      kind: "openai",
      apiKey: "sk-1234",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o",
      models: ["gpt-4o", "gpt-4o-mini"],
    });
  });

  test("rejects non-http(s), malformed, or credential-bearing baseUrl on create and update without touching the store", async () => {
    const { service, create, update } = setup();
    for (const bad of [
      "not-a-url",
      "ftp://example.com",
      "javascript:alert(1)",
      "https://user:pass@api.openai.com/v1",
      "https://token@api.openai.com/v1",
    ]) {
      expect(await service.create({ name: "X", kind: "openai", baseUrl: bad })).toEqual({
        status: "invalid_base_url",
      });
      expect(await service.update(sample.providerId, { baseUrl: bad })).toEqual({
        status: "invalid_base_url",
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test("preserves null clearing on update and maps missing provider to not_found", async () => {
    const { service, update } = setup({ update: async () => undefined });
    expect(await service.update(sample.providerId, { baseUrl: null })).toEqual({
      status: "not_found",
    });

    const ok = setup();
    await ok.service.update(sample.providerId, {
      name: "  Renamed  ",
      apiKey: null,
      baseUrl: null,
      defaultModel: "  gemini-2.5-pro ",
      models: [" gemini-2.5-pro ", "gemini-2.5-pro"],
    });
    expect(ok.update).toHaveBeenCalledWith(sample.providerId, {
      name: "Renamed",
      apiKey: null,
      baseUrl: null,
      defaultModel: "gemini-2.5-pro",
      models: ["gemini-2.5-pro"],
    });
    void update;
  });

  test("wraps store failures in DependencyError('provider_error')", async () => {
    const { service } = setup({
      list: async () => {
        throw new Error("firestore down");
      },
      create: async () => {
        throw new Error("firestore down");
      },
      update: async () => {
        throw new Error("firestore down");
      },
      delete: async () => {
        throw new Error("firestore down");
      },
    });
    for (const call of [
      () => service.list(),
      () => service.create({ name: "A", kind: "google" }),
      () => service.update(sample.providerId, { name: "B" }),
      () => service.delete(sample.providerId),
    ]) {
      const err = await call().then(
        () => undefined,
        (e) => e,
      );
      expect(err).toBeInstanceOf(DependencyError);
      expect((err as DependencyError).code).toBe("provider_error");
    }
  });
});
