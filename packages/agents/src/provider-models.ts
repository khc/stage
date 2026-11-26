import type { Firestore } from "@google-cloud/firestore";
import { Gemini, type BaseLlm } from "@google/adk";
import {
  hasControlChars,
  isValidHttpUrl,
  type DnsResolver,
  type OutboundFetcher,
} from "@stage/http/outbound-url";

import { VertexExpressGemini } from "./model";
import { isSelectableModel, type ModelRef } from "./model-ref";
import { OpenAiLlm } from "./openai-llm";

// A chosen model cannot be used: its provider is gone, disabled or unsupported, or it was switched off.
// The message names the provider and model only, never a key.
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export type ResolveModel = (ref: ModelRef) => Promise<BaseLlm>;

export type CreateModelResolverOptions = {
  fetcher?: OutboundFetcher;
  resolver?: DnsResolver;
  allowLocalBaseUrl?: boolean;
};

// ADK's Gemini has no base URL option, so only the default Gemini API address can be honored.
const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const isDefaultBase = (url: string) => url.replace(/\/+$/, "") === GOOGLE_DEFAULT_BASE;

// Builds the model of a saved provider. The key is read here, from one provider document by id, and
// goes only into the model that is returned.
export const createModelResolver =
  (
    db: Pick<Firestore, "collection">,
    { fetcher, resolver, allowLocalBaseUrl = false }: CreateModelResolverOptions = {},
  ): ResolveModel =>
  async ({ providerId, model }) => {
    const doc = await db.collection("providers").doc(providerId).get();
    if (!doc.exists) throw new ModelUnavailableError(`Provider ${providerId} no longer exists`);
    const name = String(doc.get("name") ?? providerId);
    const kind = String(doc.get("kind"));
    const provider = {
      enabled: doc.get("enabled") !== false,
      kind,
      models: doc.get("models") as string[] | undefined,
      disabledModels: doc.get("disabledModels") as string[] | undefined,
    };
    if (!isSelectableModel(provider, model))
      throw new ModelUnavailableError(`Model ${model} is not available on provider "${name}"`);

    const rawApiKey = doc.get("apiKey");
    if (typeof rawApiKey === "string" && hasControlChars(rawApiKey))
      throw new ModelUnavailableError(`Provider "${name}" has an invalid API key`);
    const apiKey = typeof rawApiKey === "string" ? rawApiKey.trim() || undefined : undefined;

    const rawBaseUrl = doc.get("baseUrl");
    const baseUrl = typeof rawBaseUrl === "string" ? rawBaseUrl.trim() || undefined : undefined;

    if (kind === "openai") {
      if (baseUrl !== undefined && !isValidHttpUrl(baseUrl, allowLocalBaseUrl))
        throw new ModelUnavailableError(`Provider "${name}" has an invalid Base URL`);
      if (!baseUrl && !apiKey) throw new ModelUnavailableError(`Provider "${name}" has no API key`);
      return new OpenAiLlm({
        model,
        ...(apiKey !== undefined && { apiKey }),
        ...(baseUrl !== undefined && { baseUrl }),
        fetcher,
        resolver,
        allowLocalBaseUrl,
      });
    }

    if (!apiKey) throw new ModelUnavailableError(`Provider "${name}" has no API key`);
    if (kind === "google-express") return new VertexExpressGemini({ model, apiKey });
    if (baseUrl && !isDefaultBase(baseUrl))
      throw new ModelUnavailableError(
        `Provider "${name}" has a custom Base URL, which Gemini models cannot use`,
      );
    // Explicit, because ADK otherwise reads GOOGLE_GENAI_USE_VERTEXAI from the environment.
    return new Gemini({ model, apiKey, vertexai: false });
  };
