import type { ModelRef, Provider } from "@/lib/api";

// The provider kinds a job can run; the same list as RUNNABLE_KINDS in packages/agents/src/model-ref.ts
// (the UI has no dependency on that package), checked by the same case table in models.test.ts.
const RUNNABLE_KINDS = ["google", "google-express"];

export type ModelOption = { ref: ModelRef; label: string };

const isSelectable = (provider: Provider, model: string) =>
  provider.enabled &&
  RUNNABLE_KINDS.includes(provider.kind) &&
  (provider.models ?? []).includes(model) &&
  !(provider.disabledModels ?? []).includes(model);

// The models a message or a task can be given: those the Providers settings leave switched on.
export const modelOptions = (providers: Provider[]): ModelOption[] =>
  providers.flatMap((provider) =>
    (provider.models ?? [])
      .filter((model) => isSelectable(provider, model))
      .map((model) => ({
        ref: { providerId: provider.providerId, model },
        label: `${provider.name} · ${model}`,
      })),
  );

// No model on both sides is the same choice: the job default.
export const sameModel = (a?: ModelRef, b?: ModelRef) =>
  a?.providerId === b?.providerId && a?.model === b?.model;

export const modelKey = (ref: ModelRef) => JSON.stringify([ref.providerId, ref.model]);

// A saved model, if it can still be chosen; a default whose provider was disabled or deleted is dropped.
export const usableModel = (options: ModelOption[], ref?: ModelRef): ModelRef | undefined =>
  options.find((option) => sameModel(option.ref, ref))?.ref;

// Changing the model of a session that already has messages re-sends the whole conversation to
// another model, so the user is asked first.
export const needsSwitchConfirmation = (hasHistory: boolean, current?: ModelRef, next?: ModelRef) =>
  hasHistory && !sameModel(current, next);

// What a user picked in a message box, for the chat or task it was picked in (`key`).
export type ModelPick = { key: string; model?: ModelRef };

// The model shown in a message box: the user's pick for this chat or task, else the task's default
// while it is still usable. Derived on render, so it follows the task and the providers as they load.
export const pickedModel = (
  pick: ModelPick | null,
  key: string,
  options: ModelOption[],
  defaultModel?: ModelRef,
): ModelRef | undefined => (pick?.key === key ? pick.model : usableModel(options, defaultModel));
