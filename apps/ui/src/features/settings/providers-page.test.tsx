import { describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { Dialog } from "@/components/ui/dialog";
import { api, type Provider } from "@/lib/api";

import {
  buildCreatePayload,
  buildUpdatePayload,
  canFetchModels,
  ProviderForm,
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

describe("ProviderForm", () => {
  test("renders Fetch models and Default model selector without a manual models textarea", () => {
    const client = new QueryClient();
    const editHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Dialog open>
          <ProviderForm provider={sample} onClose={() => {}} />
        </Dialog>
      </QueryClientProvider>,
    );
    expect(editHtml).toContain("Fetch models");
    expect(editHtml).toContain("Default model");
    expect(editHtml).not.toContain("<textarea");

    const addHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Dialog open>
          <ProviderForm onClose={() => {}} />
        </Dialog>
      </QueryClientProvider>,
    );
    expect(addHtml).toContain("Fetch models");
    expect(addHtml).toContain("Default model");
    expect(addHtml).not.toContain("<textarea");
  });

  test("normalizes create payload and omits blank optional fields", () => {
    expect(
      buildCreatePayload({
        name: "  Google  ",
        kind: "google",
        apiKey: "   ",
        clearApiKey: false,
        baseUrl: "",
        defaultModel: "gemini-2.5-flash",
        models: ["gemini-2.5-flash", "gemini-2.5-pro"],
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
        models: [],
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
        models: ["gpt-4o"],
        enabled: true,
      }),
    ).toMatchObject({ apiKey: null });
  });

  test("validates baseUrl and checks fetch readiness", () => {
    expect(validateBaseUrl("")).toBeUndefined();
    expect(validateBaseUrl("https://api.openai.com/v1")).toBeUndefined();
    expect(validateBaseUrl("ftp://bad")).toContain("http://");
    expect(validateBaseUrl("https://user:pass@api.openai.com/v1")).toContain("credentials");
    expect(validateBaseUrl("not a url")).toContain("valid URL");

    expect(
      canFetchModels({
        name: "",
        kind: "google",
        apiKey: "",
        clearApiKey: false,
        baseUrl: "",
        defaultModel: "",
        models: [],
        enabled: true,
      }),
    ).toBe(false);
    expect(
      canFetchModels(
        {
          name: "Saved",
          kind: "openai",
          apiKey: "",
          clearApiKey: false,
          baseUrl: sample.baseUrl!,
          defaultModel: "",
          models: [],
          enabled: true,
        },
        sample,
      ),
    ).toBe(true);
    // Clearing saved baseUrl or checking clearApiKey prevents reusing stored credentials.
    expect(
      canFetchModels(
        {
          name: "Saved",
          kind: "openai",
          apiKey: "",
          clearApiKey: true,
          baseUrl: sample.baseUrl!,
          defaultModel: "",
          models: [],
          enabled: true,
        },
        sample,
      ),
    ).toBe(true);
    expect(
      canFetchModels(
        {
          name: "Saved without baseUrl",
          kind: "google",
          apiKey: "",
          clearApiKey: true,
          baseUrl: "",
          defaultModel: "",
          models: [],
          enabled: true,
        },
        { ...sample, kind: "google", baseUrl: undefined },
      ),
    ).toBe(false);
    expect(
      canFetchModels(
        {
          name: "Changed baseUrl without key",
          kind: "openai",
          apiKey: "",
          clearApiKey: false,
          baseUrl: "",
          defaultModel: "",
          models: [],
          enabled: true,
        },
        sample,
      ),
    ).toBe(false);
    expect(
      canFetchModels(
        {
          name: "Changed kind without key",
          kind: "google",
          apiKey: "",
          clearApiKey: false,
          baseUrl: "",
          defaultModel: "",
          models: [],
          enabled: true,
        },
        { ...sample, baseUrl: undefined },
      ),
    ).toBe(false);
  });
});
