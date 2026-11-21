import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { api, type Provider, type ProviderKind } from "@/lib/api";

export type ProviderFormState = {
  name: string;
  kind: ProviderKind;
  apiKey: string;
  clearApiKey: boolean;
  baseUrl: string;
  defaultModel: string;
  modelsText: string;
  enabled: boolean;
};

export const parseModelsInput = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];

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

export const buildCreatePayload = (form: ProviderFormState) => {
  const apiKey = form.apiKey.trim();
  const baseUrl = form.baseUrl.trim();
  const defaultModel = form.defaultModel.trim();
  const models = parseModelsInput(form.modelsText);
  return {
    name: form.name.trim(),
    kind: form.kind,
    ...(apiKey && { apiKey }),
    ...(baseUrl && { baseUrl }),
    ...(defaultModel && { defaultModel }),
    ...(models.length > 0 && { models }),
    enabled: form.enabled,
  };
};

export const buildUpdatePayload = (provider: Provider, form: ProviderFormState) => {
  const apiKey = form.apiKey.trim();
  const baseUrl = form.baseUrl.trim();
  const defaultModel = form.defaultModel.trim();
  const models = parseModelsInput(form.modelsText);
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
    ...(models.length > 0
      ? { models }
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
  modelsText: provider?.models?.join(", ") ?? "",
  enabled: provider?.enabled ?? true,
});

const KIND_OPTIONS: { value: ProviderKind; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
];

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

function ProviderForm({ provider, onClose }: { provider?: Provider; onClose: () => void }) {
  const editing = !!provider;
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProviderFormState>(() => initialForm(provider));
  const baseUrlError = validateBaseUrl(form.baseUrl);
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
            if (next === "google" || next === "openai") setForm((f) => ({ ...f, kind: next }));
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
          onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
          maxLength={1000}
        />
        <p className="text-xs text-muted-foreground">
          Stored write-only; responses only expose whether a key is saved and its last characters.
        </p>
        {editing && provider.hasApiKey && (
          <div className="mt-1 flex items-center gap-2">
            <Checkbox
              id="provider-clear-api-key"
              checked={form.clearApiKey}
              onCheckedChange={(checked) =>
                setForm((f) => ({
                  ...f,
                  clearApiKey: checked === true,
                  ...(checked === true && { apiKey: "" }),
                }))
              }
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
          placeholder="https://api.openai.com/v1"
          value={form.baseUrl}
          onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
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
        <Input
          id="provider-default-model"
          placeholder={form.kind === "google" ? "gemini-2.5-flash" : "gpt-4o"}
          value={form.defaultModel}
          onChange={(e) => setForm((f) => ({ ...f, defaultModel: e.target.value }))}
          maxLength={200}
        />
        <p className="text-xs text-muted-foreground">
          Default model ID selected for this provider.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-models" className="justify-between">
          Models<span className="text-xs font-normal text-muted-foreground">Optional</span>
        </Label>
        <Textarea
          id="provider-models"
          rows={2}
          placeholder="gemini-2.5-flash, gemini-2.5-pro"
          value={form.modelsText}
          onChange={(e) => setForm((f) => ({ ...f, modelsText: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          Comma- or newline-separated model identifiers offered by this provider.
        </p>
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
        <p className="text-xs text-muted-foreground">
          Disabled providers stay saved but inactive.
        </p>
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
