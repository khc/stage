import { z } from "zod";

// The provider kinds a job can run: ADK has a model for each.
export const RUNNABLE_KINDS = ["google", "google-express", "openai"] as const;

// A model chosen on a saved provider; the choice carries ids only, never a key.
export const modelRefSchema = z.object({
  providerId: z.uuid(),
  model: z.string().trim().min(1).max(200),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

type SelectableProvider = {
  enabled: boolean;
  kind: string;
  models?: string[];
  disabledModels?: string[];
};

// A model can be used when its provider is enabled and runnable, and the model was added to the
// provider and not switched off.
export const isSelectableModel = (provider: SelectableProvider, model: string): boolean =>
  provider.enabled &&
  (RUNNABLE_KINDS as readonly string[]).includes(provider.kind) &&
  (provider.models ?? []).includes(model) &&
  !(provider.disabledModels ?? []).includes(model);
