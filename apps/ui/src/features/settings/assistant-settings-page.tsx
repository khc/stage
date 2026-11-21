import { Bot, Server, Zap } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseTargetKey, targetKey } from "@/features/assistant/assistant-model";
import { useAssistantTargets } from "@/features/assistant/use-assistant-chat";
import { ModelPicker } from "@/features/models/model-picker";
import type { RunMode } from "@/lib/api";
import {
  sameAssistantSettings,
  useAssistantSettings,
  type AssistantSettings,
} from "@/lib/assistant-settings";
import { modelOptions, usableModel } from "@/lib/models";
import { useProviders } from "@/lib/queries";

const AUTOMATIC = "automatic";

const runModes: { value: RunMode; label: string; hint: string }[] = [
  { value: "workflow", label: "Job", hint: "Runs in the background as a Cloud Run job." },
  {
    value: "quick",
    label: "Service",
    hint: "Runs directly on the agent's Cloud Run service, where it has one.",
  },
];

export function AssistantSettingsPage() {
  const [saved, save] = useAssistantSettings();
  const [draft, setDraft] = useState<AssistantSettings>(saved);
  const { options } = useAssistantTargets();
  const models = modelOptions(useProviders().data?.providers ?? []);
  const dirty = !sameAssistantSettings(draft, saved);
  const change = (patch: Partial<AssistantSettings>) => setDraft({ ...draft, ...patch });
  const savedKey = draft.defaultTarget ? targetKey(draft.defaultTarget) : AUTOMATIC;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save(draft);
    toast.success("Assistant settings saved");
  };
  const agentItems = [
    { value: AUTOMATIC, label: "Automatic (orchestrator)" },
    ...options.map((option) => ({ value: option.id, label: option.label })),
  ];

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-4" />
            Assistant
          </CardTitle>
        </CardHeader>
        <CardContent className="flex max-w-xl flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-agent">Default agent</Label>
            <Select
              value={savedKey}
              items={agentItems}
              onValueChange={(next) =>
                change({
                  defaultTarget: next && next !== AUTOMATIC ? parseTargetKey(next) : undefined,
                })
              }
            >
              <SelectTrigger id="default-agent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agentItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The agent a new conversation starts with. You can still switch it in the chat.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-run-mode">Default execution mode</Label>
            <Select
              value={draft.runMode}
              items={runModes.map(({ value, label }) => ({ value, label }))}
              onValueChange={(next) => {
                if (next === "workflow" || next === "quick") change({ runMode: next });
              }}
            >
              <SelectTrigger id="default-run-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {runModes.map(({ value, label, hint }) => (
                  <SelectItem key={value} value={value}>
                    {value === "quick" ? <Zap aria-hidden /> : <Server aria-hidden />}
                    {label}
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A new conversation uses this mode. An agent without a service always runs as a job.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="default-model">Default model</Label>
            <ModelPicker
              id="default-model"
              options={models}
              value={usableModel(models, draft.defaultModel)}
              onChange={(next) => change({ defaultModel: next })}
            />
            <p className="text-xs text-muted-foreground">
              The model a new conversation starts with. "Job default" leaves the choice to the job.
            </p>
          </div>
        </CardContent>
        <CardFooter className="justify-between gap-2 text-xs text-muted-foreground">
          <span>Saved in this browser.</span>
          <Button type="submit" disabled={!dirty}>
            Save
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
