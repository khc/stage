import { describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { api, type Provider } from "@/lib/api";

import {
  buildCreatePayload,
  buildUpdatePayload,
  parseModelsInput,
  validateBaseUrl,
} from "./provider-dialog";
import { ProvidersPage, providerMatches } from "./providers-page";

const sample: Provider = {
  providerId: "6f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a11",
  name: "OpenAI Work",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4o",
  models: ["gpt-4o", "gpt-4o-mini"],
  enabled: true,
  hasApiKey: true,
  apiKeyHint: "••••9876",
  createdAt: 1,
  updatedAt: 1,
};

const renderPage = (providers: Provider[]) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["providers"], { providers });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProvidersPage />
    </QueryClientProvider>,
  );
};

describe("ProvidersPage", () => {
  test("renders the empty state when no providers are configured", () => {
    const html = renderPage([]);
    expect(html).toContain("No providers configured");
    expect(html).toContain("Add provider");
    expect(html).toContain("Refreshes every 15 seconds");
  });

  test("renders configured providers with masked apiKeyHint and no raw secrets", () => {
    const html = renderPage([
      sample,
      {
        providerId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
        name: "Gemini Dev",
        kind: "google",
        enabled: false,
        hasApiKey: false,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);
    expect(html).toContain("OpenAI Work");
    expect(html).toContain("••••9876");
    expect(html).toContain("gpt-4o");
    expect(html).toContain("2 models");
    expect(html).toContain("Gemini Dev");
    expect(html).toContain("Disabled");
    expect(html).toContain("Not set");
    expect(html).toContain("2 of 2 providers shown");
    expect(html).toContain("data-search");
    void api;
  });

  test("providerMatches filters by name, kind label, defaultModel, models, and baseUrl", () => {
    expect(providerMatches(sample, "openai")).toBe(true);
    expect(providerMatches(sample, "gpt-4o-mini")).toBe(true);
    expect(providerMatches(sample, "api.openai.com")).toBe(true);
    expect(providerMatches(sample, "anthropic")).toBe(false);
  });
});

describe("ProviderDialog payload helpers", () => {
  test("normalizes create payload and omits blank optional fields", () => {
    expect(
      buildCreatePayload({
        name: "  Google  ",
        kind: "google",
        apiKey: "   ",
        clearApiKey: false,
        baseUrl: "",
        defaultModel: "  gemini-2.5-flash  ",
        modelsText: "gemini-2.5-flash, gemini-2.5-pro\ngemini-2.5-flash",
        enabled: true,
      }),
    ).toEqual({
      name: "Google",
      kind: "google",
      defaultModel: "gemini-2.5-flash",
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
      enabled: true,
    });
  });

  test("preserves existing apiKey when blank on edit, clears when clearApiKey is checked, and sends null for cleared fields", () => {
    expect(
      buildUpdatePayload(sample, {
        name: "  OpenAI Renamed  ",
        kind: "openai",
        apiKey: "",
        clearApiKey: false,
        baseUrl: "",
        defaultModel: "",
        modelsText: "",
        enabled: false,
      }),
    ).toEqual({
      name: "OpenAI Renamed",
      kind: "openai",
      baseUrl: null,
      defaultModel: null,
      models: null,
      enabled: false,
    });

    expect(
      buildUpdatePayload(sample, {
        name: "OpenAI Work",
        kind: "openai",
        apiKey: "",
        clearApiKey: true,
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        modelsText: "gpt-4o",
        enabled: true,
      }),
    ).toMatchObject({ apiKey: null });
  });

  test("validates baseUrl and parses models", () => {
    expect(validateBaseUrl("")).toBeUndefined();
    expect(validateBaseUrl("https://api.openai.com/v1")).toBeUndefined();
    expect(validateBaseUrl("ftp://bad")).toContain("http://");
    expect(validateBaseUrl("https://user:pass@api.openai.com/v1")).toContain("credentials");
    expect(validateBaseUrl("not a url")).toContain("valid URL");
    expect(parseModelsInput(" a, b \n a , ")).toEqual(["a", "b"]);
  });
});
