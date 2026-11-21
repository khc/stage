import { Cpu } from "lucide-react";
import { useState } from "react";

import { PillSelectTrigger } from "@/components/pill-select-trigger";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ModelRef } from "@/lib/api";
import { modelKey, needsSwitchConfirmation, type ModelOption } from "@/lib/models";
import { cn } from "@/lib/utils";

const NONE = "__none";

// What the switch warning says; kept apart from the dialog so it can be tested without a portal.
export const switchModelCopy = (from: string, to: string) => ({
  title: "Switch model?",
  body: `The whole conversation so far is sent to the new model with your next message. It does not share the cached context of ${from}, and it counts tokens differently, so that message can use many more input tokens and cost more. The longer the conversation, the bigger the difference.`,
  keep: `Keep ${from}`,
  switch: `Switch to ${to}`,
});

export function SwitchModelDialog({
  open,
  from,
  to,
  onKeep,
  onSwitch,
}: {
  open: boolean;
  from: string;
  to: string;
  onKeep: () => void;
  onSwitch: () => void;
}) {
  const copy = switchModelCopy(from, to);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{copy.keep}</AlertDialogCancel>
          <AlertDialogAction onClick={onSwitch}>{copy.switch}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Chooses the model of a task or a message. "Job default" means no model is chosen. In a session
// that has messages, a change is held until the user confirms the token-usage warning.
export function ModelPicker({
  options,
  value,
  onChange,
  disabled = false,
  hasHistory = false,
  compact = false,
  id,
}: {
  options: ModelOption[];
  value?: ModelRef;
  onChange: (next?: ModelRef) => void;
  disabled?: boolean;
  hasHistory?: boolean;
  // The small pill used beside the message box, instead of a full-width field.
  compact?: boolean;
  id?: string;
}) {
  const [held, setHeld] = useState<{ next?: ModelRef } | null>(null);
  const label = (ref?: ModelRef) =>
    ref
      ? (options.find((o) => modelKey(o.ref) === modelKey(ref))?.label ?? ref.model)
      : "Job default";
  const empty = options.length === 0;
  const Trigger = compact ? PillSelectTrigger : SelectTrigger;

  const choose = (key: string | null) => {
    const next =
      !key || key === NONE ? undefined : options.find((o) => modelKey(o.ref) === key)?.ref;
    if (needsSwitchConfirmation(hasHistory, value, next)) setHeld({ next });
    else onChange(next);
  };

  return (
    <>
      <Select
        value={value ? modelKey(value) : NONE}
        disabled={disabled || empty}
        items={[
          { value: NONE, label: "Job default" },
          ...options.map((o) => ({ value: modelKey(o.ref), label: o.label })),
        ]}
        onValueChange={choose}
      >
        <Trigger
          id={id}
          aria-label="Model"
          title={empty ? "Add a model in Settings → Providers" : "Model for this message"}
          className={cn(!compact && "w-full")}
        >
          <Cpu aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <SelectValue>{empty ? "No models" : label(value)}</SelectValue>
        </Trigger>
        <SelectContent align="start" className="min-w-72">
          <SelectItem value={NONE}>Job default</SelectItem>
          {options.map((o) => (
            <SelectItem key={modelKey(o.ref)} value={modelKey(o.ref)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SwitchModelDialog
        open={held !== null}
        from={label(value)}
        to={held ? label(held.next) : ""}
        onKeep={() => setHeld(null)}
        onSwitch={() => {
          if (held) onChange(held.next);
          setHeld(null);
        }}
      />
    </>
  );
}
