import type { Firestore } from "@google-cloud/firestore";
import { Gemini, type BaseLlm } from "@google/adk";

import { VertexExpressGemini } from "./model";
import { isSelectableModel, type ModelRef } from "./model-ref";

// A chosen model cannot be used: its provider is gone, disabled or unsupported, or it was switched off.
// The message names the provider and model only, never a key.
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export type ResolveModel = (ref: ModelRef) => Promise<BaseLlm>;

// ADK's Gemini has no base URL option, so only the default Gemini API address can be honored.
const GOOGLE_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const isDefaultBase = (url: string) => url.replace(/\/+$/, "") === GOOGLE_DEFAULT_BASE;

// Builds the model of a saved provider. The key is read here, from one provider document by id, and
// goes only into the model that is returned.
export const createModelResolver =
  (db: Pick<Firestore, "collection">): ResolveModel =>
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
    const apiKey = doc.get("apiKey");
    if (typeof apiKey !== "string" || !apiKey)
      throw new ModelUnavailableError(`Provider "${name}" has no API key`);

    if (kind === "google-express") return new VertexExpressGemini({ model, apiKey });
    const baseUrl = doc.get("baseUrl");
    if (typeof baseUrl === "string" && baseUrl && !isDefaultBase(baseUrl))
      throw new ModelUnavailableError(
        `Provider "${name}" has a custom Base URL, which Gemini models cannot use`,
      );
    // Explicit, because ADK otherwise reads GOOGLE_GENAI_USE_VERTEXAI from the environment.
    return new Gemini({ model, apiKey, vertexai: false });
  };
