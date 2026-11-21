import { describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { Dialog } from "@/components/ui/dialog";
import { api, type Provider } from "@/lib/api";

import {
  addModel,
  buildCreatePayload,
  buildUpdatePayload,
  canFetchModels,
  ProviderForm,
  removeModel,
  toggleModel,
  validateBaseUrl,
} from "./provider-dialog";
import { kindLabel, ProvidersPage, providerMatches } from "./providers-page";

const sample: Provider = {
  providerId: "6f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a11",
  name: "OpenAI Work",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4o",
  models: ["gpt-4o", "gpt-4o-mini"],
  disabledModels: ["gpt-4o-mini"],
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
    expect(html).toContain("1 of 2 models enabled");
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
  test("renders Fetch models, a model picker with Add, and the added models with checkboxes", () => {
    const client = new QueryClient();
    const editHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Dialog open>
          <ProviderForm provider={sample} onClose={() => {}} />
        </Dialog>
      </QueryClientProvider>,
    );
    expect(editHtml).toContain("Fetch models");
    expect(editHtml).toContain("Add model");
    expect(editHtml).not.toContain("Default model");
    expect(editHtml).not.toContain("<textarea");
    // Both added models are listed; the disabled one is unchecked.
    expect(editHtml).toContain('aria-label="Enable gpt-4o"');
    expect(editHtml).toContain('aria-label="Enable gpt-4o-mini"');
    expect(editHtml).toContain('aria-label="Remove gpt-4o-mini"');
    expect(editHtml).toContain("1 of 2 enabled");

    const addHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Dialog open>
          <ProviderForm onClose={() => {}} />
        </Dialog>
      </QueryClientProvider>,
    );
    expect(addHtml).toContain("Fetch models");
    expect(addHtml).toContain("No models added yet");
    expect(addHtml).not.toContain("<textarea");
  });

  test("Google Express offers its models for typing or picking and has nothing to fetch", () => {
    const client = new QueryClient();
    client.setQueryData(["provider-models", "google-express"], {
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Dialog open>
          <ProviderForm
            provider={{ ...sample, kind: "google-express", baseUrl: undefined }}
            onClose={() => {}}
          />
        </Dialog>
      </QueryClientProvider>,
    );
    expect(html).toContain("Google Express");
    expect(html).toContain('list="provider-express-models"');
    expect(html).toContain("Add model");
    expect(html).toContain('<option value="gemini-2.5-flash"');
    expect(html).toContain("https://aiplatform.googleapis.com/v1");
    expect(html).not.toContain("Fetch models");
  });

  test("labels the Google Express type and finds it by that label", () => {
    expect(kindLabel("google-express")).toBe("Google Express");
    expect(providerMatches({ ...sample, kind: "google-express" }, "express")).toBe(true);
    expect(providerMatches({ ...sample, kind: "google" }, "express")).toBe(false);
  });

  test("adds, toggles and removes models in the form without duplicates", () => {
    const form = {
      name: "G",
      kind: "google" as const,
      apiKey: "",
      clearApiKey: false,
      baseUrl: "",
      models: ["a"],
      disabledModels: [],
      enabled: true,
    };
    const added = addModel(form, "  b ");
    expect(added.models).toEqual(["a", "b"]);
    expect(addModel(added, "b").models).toEqual(["a", "b"]);
    expect(addModel(added, "   ").models).toEqual(["a", "b"]);

    const off = toggleModel(added, "b");
    expect(off.disabledModels).toEqual(["b"]);
    expect(toggleModel(off, "b").disabledModels).toEqual([]);

    // Removing a model also drops its disabled mark.
    expect(removeModel(off, "b")).toMatchObject({ models: ["a"], disabledModels: [] });
  });

  test("normalizes create payload and omits blank optional fields", () => {
    expect(
      buildCreatePayload({
        name: "  Google  ",
        kind: "google",
        apiKey: "   ",
        clearApiKey: false,
        baseUrl: "",
        models: ["gemini-2.5-flash", "gemini-2.5-pro"],
        disabledModels: ["gemini-2.5-pro"],
        enabled: true,
      }),
    ).toEqual({
      name: "Google",
      kind: "google",
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
      disabledModels: ["gemini-2.5-pro"],
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
        models: [],
        disabledModels: [],
        enabled: false,
      }),
    ).toEqual({
      name: "OpenAI Renamed",
      kind: "openai",
      baseUrl: null,
      models: null,
      disabledModels: null,
      enabled: false,
    });

    expect(
      buildUpdatePayload(sample, {
        name: "OpenAI Work",
        kind: "openai",
        apiKey: "",
        clearApiKey: true,
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4o"],
        disabledModels: [],
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
        models: [],
        disabledModels: [],
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
          models: [],
          disabledModels: [],
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
          models: [],
          disabledModels: [],
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
          models: [],
          disabledModels: [],
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
          models: [],
          disabledModels: [],
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
          models: [],
          disabledModels: [],
          enabled: true,
        },
        { ...sample, baseUrl: undefined },
      ),
    ).toBe(false);
  });
});
