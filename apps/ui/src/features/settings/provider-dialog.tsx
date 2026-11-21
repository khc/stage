import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Save } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ErrorBox } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, type Provider, type ProviderKind } from "@/lib/api";

export type ProviderFormState = {
  name: string;
  kind: ProviderKind;
  apiKey: string;
  clearApiKey: boolean;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  enabled: boolean;
};

const NO_DEFAULT_MODEL = "__none";

export const validateBaseUrl = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return "Base URL must start with http:// or https://.";
    if (parsed.username || parsed.password)
      return "Base URL must not include embedded credentials.";
    return undefined;
  } catch {
    return "Base URL must be a valid URL.";
  }
};

export const hasEndpointChanged = (form: ProviderFormState, provider?: Provider) =>
  !!provider && (form.kind !== provider.kind || form.baseUrl.trim() !== (provider.baseUrl ?? ""));

export const canFetchModels = (form: ProviderFormState, provider?: Provider) => {
  if (validateBaseUrl(form.baseUrl)) return false;
  const savedKeyUsable =
    !!provider?.hasApiKey && !form.clearApiKey && !hasEndpointChanged(form, provider);
  return !!form.apiKey.trim() || !!form.baseUrl.trim() || savedKeyUsable;
};

export const buildCreatePayload = (form: ProviderFormState) => {
  const apiKey = form.apiKey.trim();
  const baseUrl = form.baseUrl.trim();
  const defaultModel = form.defaultModel.trim();
  return {
    name: form.name.trim(),
    kind: form.kind,
    ...(apiKey && { apiKey }),
    ...(baseUrl && { baseUrl }),
    ...(defaultModel && { defaultModel }),
    ...(form.models.length > 0 && { models: form.models }),
    enabled: form.enabled,
  };
};

export const buildUpdatePayload = (provider: Provider, form: ProviderFormState) => {
  const apiKey = form.apiKey.trim();
  const baseUrl = form.baseUrl.trim();
  const defaultModel = form.defaultModel.trim();
  return {
    name: form.name.trim(),
    kind: form.kind,
    ...(form.clearApiKey ? { apiKey: null } : apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : provider.baseUrl !== undefined ? { baseUrl: null } : {}),
    ...(defaultModel
      ? { defaultModel }
      : provider.defaultModel !== undefined
        ? { defaultModel: null }
        : {}),
    ...(form.models.length > 0
      ? { models: form.models }
      : provider.models !== undefined
        ? { models: null }
        : {}),
    enabled: form.enabled,
  };
};

const initialForm = (provider?: Provider): ProviderFormState => ({
  name: provider?.name ?? "",
  kind: provider?.kind ?? "google",
  apiKey: "",
  clearApiKey: false,
  baseUrl: provider?.baseUrl ?? "",
  defaultModel: provider?.defaultModel ?? "",
  models: provider?.models ?? [],
  enabled: provider?.enabled ?? true,
});

const KIND_OPTIONS: { value: ProviderKind; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "google-express", label: "Google Express" },
  { value: "openai", label: "OpenAI" },
];

const EXPRESS = "google-express";
const BASE_URL_PLACEHOLDER: Record<ProviderKind, string> = {
  google: "https://generativelanguage.googleapis.com/v1beta",
  "google-express": "https://aiplatform.googleapis.com/v1",
  openai: "https://api.openai.com/v1",
};

export function ProviderDialog({
  open,
  provider,
  onOpenChange,
}: {
  open: boolean;
  provider?: Provider;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        {open && (
          <ProviderForm
            key={provider?.providerId ?? "new"}
            provider={provider}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ProviderForm({ provider, onClose }: { provider?: Provider; onClose: () => void }) {
  const editing = !!provider;
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProviderFormState>(() => initialForm(provider));
  const [fetchedOnce, setFetchedOnce] = useState(false);
  const fetchGenRef = useRef(0);
  const baseUrlError = validateBaseUrl(form.baseUrl);
  const endpointChanged = hasEndpointChanged(form, provider);
  const fetchAllowed = canFetchModels(form, provider);
  const express = form.kind === EXPRESS;
  // Express keys cannot list models: the service returns the documented ones, with nothing to fetch.
  const expressModels = useQuery({
    queryKey: ["provider-models", EXPRESS],
    queryFn: () => api.fetchProviderModels({ kind: EXPRESS }),
    enabled: express,
    staleTime: Infinity,
  });
  const modelOptions = [
    ...new Set([...form.models, ...(form.defaultModel ? [form.defaultModel] : [])]),
  ];

  const fetchMutation = useMutation({
    mutationFn: async (gen: number) => {
      const apiKey = form.apiKey.trim();
      const baseUrl = form.baseUrl.trim();
      const useSavedCredentials = !!provider && !form.clearApiKey && !endpointChanged;
      const result = await api.fetchProviderModels({
        kind: form.kind,
        ...(useSavedCredentials && { providerId: provider.providerId }),
        ...(apiKey && { apiKey }),
        ...(baseUrl
          ? { baseUrl }
          : provider?.baseUrl !== undefined && useSavedCredentials
            ? { baseUrl: null }
            : {}),
      });
      return { ...result, gen };
    },
    onSuccess: ({ models, gen }) => {
      if (gen !== fetchGenRef.current) return;
      setFetchedOnce(true);
      setForm((f) => ({
        ...f,
        models,
        defaultModel: f.defaultModel && models.includes(f.defaultModel) ? f.defaultModel : "",
      }));
    },
  });

  const submitReason = !form.name.trim()
    ? "Enter a provider name to continue."
    : baseUrlError
      ? baseUrlError
      : undefined;

  const mutation = useMutation({
    mutationFn: () =>
      provider
        ? api.updateProvider(provider.providerId, buildUpdatePayload(provider, form))
        : api.createProvider(buildCreatePayload(form)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      onClose();
      toast.success(editing ? "Provider updated" : "Provider added");
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (submitReason || mutation.isPending) return;
    mutation.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <span className="mb-1 grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
          <KeyRound className="size-5" />
        </span>
        <DialogTitle>{editing ? `Edit ${provider.name}` : "Add a provider"}</DialogTitle>
        <DialogDescription>
          Configure a model provider and its credentials for this workspace.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-name" className="justify-between">
          Name<span className="text-xs font-normal text-muted-foreground">Required</span>
        </Label>
        <Input
          id="provider-name"
          placeholder="e.g. Google Gemini or OpenAI"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          maxLength={200}
          required
        />
        <p className="text-xs text-muted-foreground">
          Display name shown in Settings and provider listings.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-kind" className="justify-between">
          Provider type<span className="text-xs font-normal text-muted-foreground">Required</span>
        </Label>
        <Select
          value={form.kind}
          items={KIND_OPTIONS}
          onValueChange={(next) => {
            if (KIND_OPTIONS.some((option) => option.value === next)) {
              fetchGenRef.current += 1;
              fetchMutation.reset();
              setFetchedOnce(false);
              setForm((f) => ({ ...f, kind: next as ProviderKind, models: [], defaultModel: "" }));
            }
          }}
        >
          <SelectTrigger id="provider-kind" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">API protocol used by this provider.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-api-key" className="justify-between">
          API key<span className="text-xs font-normal text-muted-foreground">Optional</span>
        </Label>
        <Input
          id="provider-api-key"
          type="password"
          autoComplete="off"
          disabled={form.clearApiKey}
          placeholder={
            editing && provider.hasApiKey
              ? `Saved (${provider.apiKeyHint ?? "••••"}) — leave blank to keep`
              : "Paste an API key"
          }
          value={form.apiKey}
          onChange={(e) => {
            fetchGenRef.current += 1;
            setForm((f) => ({ ...f, apiKey: e.target.value }));
          }}
          maxLength={1000}
        />
        <p className="text-xs text-muted-foreground">
          {editing &&
          provider.hasApiKey &&
          endpointChanged &&
          !form.clearApiKey &&
          !form.apiKey.trim()
            ? "Provider type or Base URL changed — enter a new API key to keep authentication, or saving will clear the stored key."
            : express
              ? "Use the Vertex AI express-mode API key. Stored write-only; responses only expose whether a key is saved and its last characters."
              : "Stored write-only; responses only expose whether a key is saved and its last characters."}
        </p>
        {editing && provider.hasApiKey && (
          <div className="mt-1 flex items-center gap-2">
            <Checkbox
              id="provider-clear-api-key"
              checked={form.clearApiKey}
              onCheckedChange={(checked) => {
                fetchGenRef.current += 1;
                setForm((f) => ({
                  ...f,
                  clearApiKey: checked === true,
                  ...(checked === true && { apiKey: "" }),
                }));
              }}
            />
            <Label
              htmlFor="provider-clear-api-key"
              className="text-xs font-normal text-muted-foreground"
            >
              Clear saved API key
            </Label>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-base-url" className="justify-between">
          Base URL<span className="text-xs font-normal text-muted-foreground">Optional</span>
        </Label>
        <Input
          id="provider-base-url"
          placeholder={BASE_URL_PLACEHOLDER[form.kind]}
          value={form.baseUrl}
          onChange={(e) => {
            fetchGenRef.current += 1;
            setForm((f) => ({ ...f, baseUrl: e.target.value }));
          }}
          maxLength={500}
          aria-invalid={baseUrlError ? true : undefined}
        />
        <p className="text-xs text-muted-foreground">
          Custom endpoint or proxy URL (http:// or https://). Leave blank for the default.
        </p>
        {baseUrlError && (
          <p className="text-xs text-destructive" role="alert">
            {baseUrlError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-default-model" className="justify-between">
          Default model<span className="text-xs font-normal text-muted-foreground">Optional</span>
        </Label>
        {express ? (
          <>
            <Input
              id="provider-default-model"
              list="provider-express-models"
              placeholder="e.g. gemini-2.5-flash"
              value={form.defaultModel}
              onChange={(e) => setForm((f) => ({ ...f, defaultModel: e.target.value }))}
              maxLength={200}
            />
            <datalist id="provider-express-models">
              {(expressModels.data?.models ?? []).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              Express keys cannot list models. Pick one Google supports for express mode, or type a
              model name.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Select
                value={form.defaultModel || NO_DEFAULT_MODEL}
                disabled={modelOptions.length === 0 || fetchMutation.isPending}
                items={[
                  {
                    value: NO_DEFAULT_MODEL,
                    label: modelOptions.length ? "No default model" : "Fetch models first",
                  },
                  ...modelOptions.map((model) => ({ value: model, label: model })),
                ]}
                onValueChange={(next) =>
                  setForm((f) => ({
                    ...f,
                    defaultModel: !next || next === NO_DEFAULT_MODEL ? "" : next,
                  }))
                }
              >
                <SelectTrigger id="provider-default-model" className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEFAULT_MODEL}>
                    {modelOptions.length ? "No default model" : "Fetch models first"}
                  </SelectItem>
                  {modelOptions.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span title={!fetchAllowed ? "Enter an API key or Base URL first" : undefined}>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!fetchAllowed || fetchMutation.isPending}
                  onClick={() => fetchMutation.mutate(++fetchGenRef.current)}
                >
                  {fetchMutation.isPending ? <Spinner /> : <RefreshCw />}
                  Fetch models
                </Button>
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {!fetchAllowed
                ? "Enter an API key or Base URL to fetch models from the provider API."
                : fetchedOnce
                  ? form.models.length
                    ? `Loaded ${form.models.length} model${form.models.length === 1 ? "" : "s"} from the provider API.`
                    : "The provider API returned no models."
                  : form.models.length
                    ? `${form.models.length} saved model${form.models.length === 1 ? "" : "s"} available. Click Fetch models to refresh.`
                    : "Click Fetch models to load available models from the provider API."}
            </p>
            {fetchMutation.isError && <ErrorBox error={fetchMutation.error} />}
          </>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Checkbox
            id="provider-enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => setForm((f) => ({ ...f, enabled: checked === true }))}
          />
          <Label htmlFor="provider-enabled">Enabled</Label>
        </div>
        <p className="text-xs text-muted-foreground">Disabled providers stay saved but inactive.</p>
      </div>

      {mutation.isError && <ErrorBox error={mutation.error} />}

      {submitReason && (
        <p id="provider-submit-hint" className="text-right text-xs text-muted-foreground">
          {submitReason}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          aria-describedby={submitReason ? "provider-submit-hint" : undefined}
          disabled={!!submitReason || mutation.isPending}
        >
          {mutation.isPending ? <Spinner /> : editing ? <Save /> : <Plus />}
          {editing ? "Save changes" : "Add provider"}
        </Button>
      </DialogFooter>
    </form>
  );
}
