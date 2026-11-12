import { GoogleGenAI } from "@google/genai";
import { Gemini } from "@google/adk";

const DEFAULT_MODEL = "gemini-2.5-flash";

// ADK's own Vertex AI mode needs a project, a location and Google Cloud
// credentials and cannot use an API key. Vertex AI express mode accepts a key,
// so this builds that client instead. ADK is told it is a plain API-key
// `Gemini`; only its public `apiClient` getter is replaced.
export class VertexExpressGemini extends Gemini {
  readonly #apiKey: string;
  #client?: GoogleGenAI;

  constructor({ model, apiKey }: { model: string; apiKey: string }) {
    super({ model, apiKey, vertexai: false });
    this.#apiKey = apiKey;
  }

  override get apiClient(): GoogleGenAI {
    return (this.#client ??= new GoogleGenAI({
      vertexai: true,
      apiKey: this.#apiKey,
      httpOptions: this.getHttpOptions(),
    }));
  }
}

const isEnabled = (value?: string) =>
  value !== undefined && ["true", "1"].includes(value.toLowerCase());

export const createModel = (
  env: Record<string, string | undefined>,
): string | Gemini => {
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  const apiKey =
    env.GOOGLE_GENAI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_API_KEY;

  return isEnabled(env.GOOGLE_GENAI_USE_VERTEXAI) && apiKey
    ? new VertexExpressGemini({ model, apiKey })
    : model;
};
