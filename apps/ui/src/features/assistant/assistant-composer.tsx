import { ArrowUp, ChevronDown, FileText, Plus, X } from "lucide-react";
import { useRef } from "react";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { ModelPicker } from "@/features/models/model-picker";
import type { DocumentSummary, ModelRef } from "@/lib/api";
import type { ModelOption } from "@/lib/models";

import {
  parseTargetKey,
  targetKey,
  type AssistantTarget,
  type AssistantTargetOption,
} from "./assistant-model";

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
  stagedFiles = [],
  documents = [],
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
            label: target.agentName ? `${target.agentName} · ${target.jobName}` : target.jobName,
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
          <InputGroupAddon align="block-end">
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
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={targetLocked || !selectItems.length}
                render={
                  <InputGroupButton
                    size="sm"
                    variant="outline"
                    aria-label="Assistant agent"
                    title={
                      targetLocked
                        ? "Agent is fixed for this conversation"
                        : "Choose which agent handles this conversation"
                    }
                    className="max-w-60 rounded-full"
                  />
                }
              >
                <img src="/stage.png" alt="" aria-hidden className="size-3.5 rounded-[3px]" />
                <span className="truncate">
                  {selectItems.find((item) => item.value === selectedId)?.label ??
                    "No agents available"}
                </span>
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Agent</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={selectedId ?? ""}
                  onValueChange={(next) => {
                    const parsed = parseTargetKey(next);
                    if (parsed) onTargetChange(parsed);
                  }}
                >
                  {selectItems.map((item) => (
                    <DropdownMenuRadioItem key={item.value} value={item.value}>
                      {item.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
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
