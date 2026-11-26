import { ArrowUp, FileText, Plus, Server, X, Zap } from "lucide-react";
import { useRef } from "react";

import { PillSelectTrigger } from "@/components/pill-select-trigger";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModelPicker } from "@/features/models/model-picker";
import type { DocumentSummary, ModelRef, RunMode } from "@/lib/api";
import type { ModelOption } from "@/lib/models";

import {
  parseTargetKey,
  targetKey,
  targetLabel,
  type AssistantTarget,
  type AssistantTargetOption,
} from "./assistant-model";

// Stable defaults, so an omitted prop does not change on every render.
const NO_FILES: File[] = [];
const NO_DOCUMENTS: DocumentSummary[] = [];

export function AssistantComposer({
  value,
  onChange,
  onSubmit,
  target,
  targetOptions,
  targetLocked = false,
  onTargetChange,
  modelOptions,
  model,
  onModelChange,
  hasHistory = false,
  runMode = "workflow",
  onRunModeChange,
  serviceAvailable = false,
  stagedFiles = NO_FILES,
  documents = NO_DOCUMENTS,
  onAttachFiles,
  onRemoveStagedFile,
  onDeleteDocument,
  disabled = false,
  disabledReason,
  isSending = false,
  isUploading = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  target?: AssistantTarget;
  targetOptions: AssistantTargetOption[];
  targetLocked?: boolean;
  onTargetChange: (next: AssistantTarget) => void;
  // The models a message can be sent with; without any the picker is not shown.
  modelOptions: ModelOption[];
  model?: ModelRef;
  onModelChange: (next?: ModelRef) => void;
  // True once the conversation has messages: changing the model then asks first.
  hasHistory?: boolean;
  runMode?: RunMode;
  onRunModeChange?: (next: RunMode) => void;
  // Whether the selected agent's job has a Cloud Run service mapped in AGENT_SERVICES.
  serviceAvailable?: boolean;
  stagedFiles?: File[];
  documents?: DocumentSummary[];
  onAttachFiles: (files: File[]) => void;
  onRemoveStagedFile?: (index: number) => void;
  onDeleteDocument?: (documentId: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  isSending?: boolean;
  isUploading?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedId = target ? targetKey(target) : null;
  const selectedOption = targetOptions.find((option) => option.id === selectedId);
  const blockedHint = disabledReason ?? selectedOption?.unsupportedHint;
  const canSend =
    !!value.trim() && !!target && !disabled && !blockedHint && !isSending && !isUploading;

  const selectItems = [
    ...targetOptions.map((option) => ({ value: option.id, label: option.label })),
    ...(target && !selectedOption
      ? [
          {
            value: targetKey(target),
            label: targetLabel(target),
          },
        ]
      : []),
  ];

  const hasAttachments = stagedFiles.length > 0 || documents.length > 0;

  return (
    <div className="shrink-0 px-4 pt-2 pb-4 md:px-6">
      <form
        className="mx-auto flex w-full max-w-3xl flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSubmit();
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Attach documents"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (list.length) onAttachFiles(list);
          }}
        />
        <InputGroup className="rounded-3xl bg-card shadow-sm">
          {hasAttachments && (
            <InputGroupAddon align="block-start" className="flex-wrap">
              {stagedFiles.map((file, i) => (
                <FileChip
                  // The same file can be staged twice, so the index keeps the keys unique.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={`staged-${file.name}-${i}`}
                  name={file.name}
                  onRemove={onRemoveStagedFile && (() => onRemoveStagedFile(i))}
                />
              ))}
              {documents.map((doc) => (
                <FileChip
                  key={doc.documentId}
                  name={doc.filename}
                  onRemove={onDeleteDocument && (() => onDeleteDocument(doc.documentId))}
                />
              ))}
            </InputGroupAddon>
          )}
          <InputGroupTextarea
            aria-label="Message assistant"
            className="max-h-44 min-h-[3.25rem] resize-none p-3"
            rows={2}
            maxLength={10_000}
            value={value}
            placeholder="Message Stage Assistant…"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }}
          />
          <InputGroupAddon align="block-end" className="flex-wrap gap-1.5">
            <InputGroupButton
              type="button"
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              aria-label="Attach file"
              disabled={isUploading || isSending}
              onClick={() => fileInput.current?.click()}
            >
              {isUploading ? <Spinner /> : <Plus />}
            </InputGroupButton>
            <Select
              value={selectedId}
              items={selectItems}
              disabled={targetLocked || !selectItems.length}
              onValueChange={(next) => {
                const parsed = next ? parseTargetKey(next) : undefined;
                if (parsed) onTargetChange(parsed);
              }}
            >
              <PillSelectTrigger
                className="max-w-44 sm:max-w-60"
                aria-label="Assistant agent"
                title={
                  targetLocked
                    ? "Agent is fixed for this conversation"
                    : "Choose which agent handles this conversation"
                }
              >
                <img src="/stage.svg" alt="" aria-hidden className="size-3.5" />
                <SelectValue placeholder="No agents available" />
              </PillSelectTrigger>
              <SelectContent align="start" className="min-w-80">
                {selectItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelOptions.length > 0 && (
              <ModelPicker
                compact
                options={modelOptions}
                value={model}
                onChange={onModelChange}
                hasHistory={hasHistory}
                disabled={isSending}
              />
            )}
            <Tabs
              value={serviceAvailable ? runMode : "workflow"}
              onValueChange={(next) => {
                if (next === "workflow" || next === "quick") onRunModeChange?.(next);
              }}
            >
              <TabsList
                aria-label="Execution mode"
                className="h-8 rounded-full border border-border/60 bg-muted/50 p-0.5 max-md:h-auto"
              >
                <TabsTrigger
                  value="workflow"
                  disabled={isSending}
                  title="Run in the background as a Cloud Run job"
                  className="h-7 rounded-full px-2.5 text-xs font-medium max-md:min-h-11"
                >
                  <Server aria-hidden className="size-3.5" />
                  Job
                </TabsTrigger>
                <TabsTrigger
                  value="quick"
                  disabled={isSending || !serviceAvailable}
                  aria-label={
                    serviceAvailable
                      ? "Service"
                      : "Service unavailable: no Cloud Run service configured for this job"
                  }
                  title={
                    serviceAvailable
                      ? "Run directly on the Cloud Run service"
                      : "No Cloud Run service configured for this job"
                  }
                  className="h-7 rounded-full px-2.5 text-xs font-medium max-md:min-h-11"
                >
                  <Zap aria-hidden className="size-3.5" />
                  Service
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="ml-auto rounded-full"
              aria-label="Send message"
              disabled={!canSend}
            >
              {isSending ? <Spinner /> : <ArrowUp />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <p
          className="px-2 text-center text-xs text-muted-foreground"
          role={blockedHint ? "status" : undefined}
        >
          {blockedHint ?? (
            <>
              <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> for a new line
            </>
          )}
        </p>
      </form>
    </div>
  );
}

function FileChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
  return (
    <Attachment size="sm">
      <AttachmentMedia>
        <FileText />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
      </AttachmentContent>
      {onRemove && (
        <AttachmentActions>
          <AttachmentAction aria-label={`Remove ${name}`} onClick={onRemove}>
            <X />
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
}
