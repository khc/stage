import { ArrowUp, FileText, Loader2, Paperclip, Sparkles, X } from "lucide-react";
import { useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DocumentSummary } from "@/lib/api";

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
        <InputGroup className="rounded-3xl border bg-card shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-primary/20">
          {hasAttachments && (
            <div className="flex w-full flex-wrap gap-1.5 px-4 pt-3">
              {stagedFiles.map((file, i) => (
                <Badge key={`staged-${file.name}-${i}`} variant="secondary" className="gap-1 pr-1">
                  <FileText className="size-3" />
                  <span className="max-w-44 truncate">{file.name}</span>
                  {onRemoveStagedFile && (
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      className="rounded-full p-0.5 hover:bg-muted"
                      onClick={() => onRemoveStagedFile(i)}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </Badge>
              ))}
              {documents.map((doc) => (
                <Badge key={doc.documentId} variant="outline" className="gap-1 pr-1">
                  <FileText className="size-3 text-primary" />
                  <span className="max-w-44 truncate">{doc.filename}</span>
                  {onDeleteDocument && (
                    <button
                      type="button"
                      aria-label={`Remove ${doc.filename}`}
                      className="rounded-full p-0.5 hover:bg-muted"
                      onClick={() => onDeleteDocument(doc.documentId)}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
          )}
          <InputGroupTextarea
            aria-label="Message assistant"
            className="max-h-44 min-h-[3.25rem] resize-none px-4 pt-3.5 pb-2 text-[15px]"
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
          <InputGroupAddon align="block-end" className="gap-2 px-3 pb-2.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground hover:text-foreground"
              aria-label="Attach file"
              title="Attach file"
              disabled={isUploading || isSending}
              onClick={() => fileInput.current?.click()}
            >
              {isUploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
            </Button>
            <Select
              value={selectedId}
              disabled={targetLocked || !selectItems.length}
              items={selectItems}
              onValueChange={(next) => {
                if (!next) return;
                const parsed = parseTargetKey(next);
                if (parsed) onTargetChange(parsed);
              }}
            >
              <SelectTrigger
                aria-label="Assistant agent"
                title={
                  targetLocked
                    ? "Agent is fixed for this conversation"
                    : "Choose which agent handles this conversation"
                }
                className="h-8 w-auto max-w-60 gap-1.5 rounded-full border-border/60 bg-muted/50 px-3 text-xs font-medium shadow-none"
              >
                <Sparkles className="size-3 text-primary" />
                <SelectValue placeholder="No agents available" />
              </SelectTrigger>
              <SelectContent align="start">
                {selectItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="ml-auto rounded-full"
              aria-label="Send message"
              disabled={!canSend}
            >
              {isSending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <p
          className="px-2 text-center text-xs text-muted-foreground"
          role={blockedHint ? "status" : undefined}
        >
          {blockedHint ?? "Enter to send · Shift+Enter for a new line"}
        </p>
      </form>
    </div>
  );
}
