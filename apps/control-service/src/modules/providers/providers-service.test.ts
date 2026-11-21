import { describe, expect, mock, test } from "bun:test";

import { DependencyError } from "../../errors";
import type { ProviderSummary } from "./providers-model";
import {
  createProvidersService,
  type DnsResolver,
  type ProvidersFetcher,
} from "./providers-service";
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

const setup = (
  overrides: Partial<ProvidersStore> = {},
  fetcher?: ProvidersFetcher,
  options: { resolver?: DnsResolver; allowLocalBaseUrl?: boolean } = {},
) => {
  const create = mock(async () => sample);
  const list = mock(async () => [sample]);
  const get = mock(async () => sample);
  const getCredentials = mock(async () => ({
    kind: "openai" as const,
    apiKey: "sk-saved-key-1234",
  }));
  const update = mock(async () => sample);
  const remove = mock(async () => true);
  const store: ProvidersStore = {
    create,
    list,
    get,
    getCredentials,
    update,
    delete: remove,
    ...overrides,
  };
  return {
    service: createProvidersService({ providersStore: store, fetcher, ...options }),
    create,
    update,
    remove,
  };
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

  test("keeps only disabled models that are in the model list, trimmed and deduplicated", async () => {
    const { service, create, update } = setup();
    await service.create({
      name: "OpenAI",
      kind: "openai",
      models: ["gpt-4o", "gpt-4o-mini"],
      disabledModels: [" gpt-4o-mini ", "gpt-4o-mini", "gpt-5", "   "],
    });
    expect(create).toHaveBeenCalledWith({
      name: "OpenAI",
      kind: "openai",
      models: ["gpt-4o", "gpt-4o-mini"],
      disabledModels: ["gpt-4o-mini"],
    });

    await service.update(sample.providerId, {
      models: ["gpt-4o"],
      disabledModels: ["gpt-4o", "gpt-4o-mini"],
    });
    expect(update).toHaveBeenCalledWith(sample.providerId, {
      models: ["gpt-4o"],
      disabledModels: ["gpt-4o"],
    });

    await service.update(sample.providerId, { disabledModels: null });
    expect(update).toHaveBeenLastCalledWith(sample.providerId, { disabledModels: null });
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

  test("fetches and filters Google models via x-goog-api-key", async () => {
    const calls: { url: string; headers: HeadersInit | undefined }[] = [];
    const fetcher: ProvidersFetcher = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return Response.json({
        models: [
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    };

    const { service } = setup({}, fetcher);
    expect(await service.fetchModels({ kind: "google", apiKey: "  AIza-test  " })).toEqual({
      status: "ok",
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    });
    expect(calls).toEqual([
      {
        url: "https://generativelanguage.googleapis.com/v1beta/models",
        headers: { "x-goog-api-key": "AIza-test" },
      },
    ]);
  });

  test("Google Express lists its documented models without calling Google or needing a key", async () => {
    let called = false;
    const fetcher: ProvidersFetcher = async () => {
      called = true;
      return Response.json({});
    };
    const { service } = setup({}, fetcher);
    const result = await service.fetchModels({ kind: "google-express" });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.models).toContain("gemini-2.5-flash");
    expect(result.status === "ok" && result.models).toEqual(
      [...(result.status === "ok" ? result.models : [])].toSorted(),
    );
    expect(called).toBe(false);
  });

  test("fetches OpenAI-compatible models with custom baseUrl and saved provider credentials", async () => {
    const calls: { url: string; headers: HeadersInit | undefined }[] = [];
    const fetcher: ProvidersFetcher = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return Response.json({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] });
    };

    const { service } = setup(
      {
        getCredentials: async (id) =>
          id === sample.providerId
            ? { kind: "openai", apiKey: "sk-saved-1234", baseUrl: "http://127.0.0.1:8000" }
            : undefined,
      },
      fetcher,
      { allowLocalBaseUrl: true },
    );
    expect(
      await service.fetchModels({
        kind: "openai",
        providerId: sample.providerId.toUpperCase(),
      }),
    ).toEqual({
      status: "ok",
      models: ["gpt-4o", "gpt-4o-mini"],
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8000/v1/models",
        headers: { authorization: "Bearer sk-saved-1234" },
      },
    ]);
  });

  test("supports Google nextPageToken pagination and filters oversized/control-char IDs", async () => {
    const urls: string[] = [];
    let page = 0;
    const fetcher: ProvidersFetcher = async (url) => {
      urls.push(url);
      page += 1;
      if (page === 1) {
        return Response.json({
          models: [
            { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
            { name: `models/${"x".repeat(205)}`, supportedGenerationMethods: ["generateContent"] },
          ],
          nextPageToken: "page-2",
        });
      }
      return Response.json({
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    };

    const { service } = setup({}, fetcher);
    expect(await service.fetchModels({ kind: "google", apiKey: "AIza-test" })).toEqual({
      status: "ok",
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    });
    expect(urls).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models",
      "https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-2",
    ]);
  });

  test("never sends saved apiKey to a modified baseUrl, cleared baseUrl, or mismatched kind", async () => {
    const fetcher = mock(async () => Response.json({ data: [{ id: "gpt-4o" }] }));
    const { service } = setup(
      {
        getCredentials: async () => ({
          kind: "openai",
          apiKey: "sk-saved-secret",
          baseUrl: "https://proxy.example.com/v1",
        }),
      },
      fetcher,
    );

    expect(
      await service.fetchModels({
        kind: "openai",
        providerId: sample.providerId,
        baseUrl: "https://evil.example.com/v1",
      }),
    ).toEqual({ status: "api_key_required" });

    expect(
      await service.fetchModels({
        kind: "openai",
        providerId: sample.providerId,
        baseUrl: null,
      }),
    ).toEqual({ status: "api_key_required" });

    expect(
      await service.fetchModels({
        kind: "google",
        providerId: sample.providerId,
      }),
    ).toEqual({ status: "api_key_required" });

    expect(fetcher).not.toHaveBeenCalled();

    // Clearing baseUrl while supplying a fresh key calls the default endpoint, not saved.baseUrl.
    const calledUrls: string[] = [];
    const { service: freshService } = setup(
      {
        getCredentials: async () => ({
          kind: "openai",
          apiKey: "sk-saved-secret",
          baseUrl: "https://proxy.example.com/v1",
        }),
      },
      async (url) => {
        calledUrls.push(url);
        return Response.json({ data: [{ id: "gpt-4o" }] });
      },
    );
    expect(
      await freshService.fetchModels({
        kind: "openai",
        providerId: sample.providerId,
        apiKey: "sk-fresh-key",
        baseUrl: null,
      }),
    ).toEqual({ status: "ok", models: ["gpt-4o"] });
    expect(calledUrls).toEqual(["https://api.openai.com/v1/models"]);
  });

  test("rejects SSRF bypasses (IPv6 mapped, private/loopback, trailing dots, DNS to private IP, remote HTTP), control chars, and oversized bodies", async () => {
    const fetcher = mock(async () => new Response("x".repeat(2_100_000), { status: 200 }));
    const { service } = setup({ getCredentials: async () => undefined }, fetcher, {
      resolver: async (host) =>
        host === "rebind.example.com"
          ? [{ address: "169.254.169.254", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }],
    });

    for (const badUrl of [
      "http://api.openai.com/v1",
      "http://127.0.0.1:8000",
      "http://localhost:11434/v1",
      "https://metadata.google.internal.",
      "https://[::ffff:169.254.169.254]/latest",
      "https://[::1]:8000",
      "https://[fe80::1]/",
      "https://[fc00::1]/",
      "https://10.0.0.1/v1",
      "https://172.16.0.1/v1",
      "https://192.168.1.1/v1",
      "https://100.64.0.1/v1",
      "https://rebind.example.com/v1",
    ]) {
      expect(await service.fetchModels({ kind: "openai", baseUrl: badUrl })).toEqual({
        status: "invalid_base_url",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();

    expect(await service.fetchModels({ kind: "openai", apiKey: "sk-bad\u0000key" })).toEqual({
      status: "invalid_api_key",
    });

    const tooLargeErr = await service.fetchModels({ kind: "openai", apiKey: "sk-valid-key" }).then(
      () => undefined,
      (e) => e,
    );
    expect(tooLargeErr).toBeInstanceOf(DependencyError);
    expect((tooLargeErr as DependencyError).code).toBe("provider_models_error");
  });

  test("rejects missing apiKey on default endpoint, metadata hosts, and wraps upstream errors", async () => {
    const fetcher: ProvidersFetcher = async () => new Response("unauthorized", { status: 401 });
    const { service } = setup({ getCredentials: async () => undefined }, fetcher);
    expect(await service.fetchModels({ kind: "openai" })).toEqual({ status: "api_key_required" });
    expect(await service.fetchModels({ kind: "openai", providerId: sample.providerId })).toEqual({
      status: "provider_not_found",
    });
    expect(
      await service.fetchModels({
        kind: "openai",
        baseUrl: "http://169.254.169.254/latest/meta-data",
      }),
    ).toEqual({ status: "invalid_base_url" });
    const err = await service.fetchModels({ kind: "openai", apiKey: "sk-bad" }).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).code).toBe("provider_models_error");
  });
});
