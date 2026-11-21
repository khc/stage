import { AsyncLocalStorage } from "node:async_hooks";

import {
  BaseLlm,
  Gemini,
  GoogleLLMVariant,
  LLMRegistry,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { GoogleGenAI } from "@google/genai";

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

// The model of the run in progress, set by the job before it runs the agent.
const runModel = new AsyncLocalStorage<BaseLlm>();
export const runWithModel = <T>(llm: BaseLlm, fn: () => T): T => runModel.run(llm, fn);

// ADK marks a Gemini model with this symbol and then reads `apiBackend` (to decide whether an
// output schema can be used with tools) and `useInteractionsApi` from it.
const GEMINI_MARK = Symbol.for("google.adk.geminiModel");

// The model an agent is given once, at load. Each call goes to the model chosen for the run in
// progress (`runWithModel`), or to the default model when there is none. ADK's own RoutedLlm picks
// from a fixed set of models, and a run's model is known only when the run starts.
class RunModelLlm extends BaseLlm {
  readonly [GEMINI_MARK] = true;
  #fallback?: BaseLlm;
  readonly #buildFallback: () => BaseLlm;

  constructor(model: string, buildFallback: () => BaseLlm) {
    super({ model });
    this.#buildFallback = buildFallback;
  }

  // Built on first use, so loading an agent needs no credentials.
  get #current(): BaseLlm {
    return runModel.getStore() ?? (this.#fallback ??= this.#buildFallback());
  }

  get apiBackend() {
    const current = this.#current as { apiBackend?: GoogleLLMVariant };
    return current.apiBackend ?? GoogleLLMVariant.GEMINI_API;
  }

  get useInteractionsApi() {
    return (this.#current as { useInteractionsApi?: boolean }).useInteractionsApi ?? false;
  }

  async *generateContentAsync(
    request: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const current = this.#current;
    // ADK filled in this wrapper's name; the model that answers must be named instead.
    request.model = current.model;
    yield* current.generateContentAsync(request, stream, abortSignal);
  }

  connect(request: LlmRequest): Promise<BaseLlmConnection> {
    const current = this.#current;
    request.model = current.model;
    return current.connect(request);
  }
}

export const createRoutedLlm = (model: string, buildFallback: () => BaseLlm): BaseLlm =>
  new RunModelLlm(model, buildFallback);

// The model an agent runs on: the run's chosen model, else AGENT_MODEL (the default).
export const createModel = (env: Record<string, string | undefined>): BaseLlm => {
  const model = env.AGENT_MODEL || DEFAULT_MODEL;
  const apiKey = env.GOOGLE_GENAI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_API_KEY;

  return createRoutedLlm(model, () =>
    isEnabled(env.GOOGLE_GENAI_USE_VERTEXAI) && apiKey
      ? new VertexExpressGemini({ model, apiKey })
      : LLMRegistry.newLlm(model),
  );
};
