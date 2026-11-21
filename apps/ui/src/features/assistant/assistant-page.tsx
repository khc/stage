import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, MessageSquare, PanelLeft, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ConfirmDelete } from "@/components/confirm-delete";
import { ErrorBox } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, taskTitle, type ModelRef, type Task } from "@/lib/api";
import { modelOptions, pickedModel, type ModelPick } from "@/lib/models";
import { useNav } from "@/lib/nav";
import { useProviders, useTasks } from "@/lib/queries";
import { cn } from "@/lib/utils";

import { AssistantComposer } from "./assistant-composer";
import { childTaskCountMap, groupChatTurns, rootChatTasks } from "./assistant-model";
import { AssistantThread } from "./assistant-thread";
import { useAssistantChat } from "./use-assistant-chat";

function ThreadList({
  tasks,
  childCounts,
  activeChatId,
  search,
  onSearchChange,
  onNewChat,
  onSelectChat,
  onDeletedChat,
}: {
  tasks: Task[];
  childCounts: Map<string, number>;
  activeChatId?: string;
  search: string;
  onSearchChange: (next: string) => void;
  onNewChat: () => void;
  onSelectChat: (taskId: string) => void;
  onDeletedChat: (taskId: string) => void;
}) {
  const query = search.trim().toLowerCase();
  const filtered = query
    ? tasks.filter((task) =>
        `${taskTitle(task)} ${task.jobName ?? ""} ${task.agentName ?? ""}`
          .toLowerCase()
          .includes(query),
      )
    : tasks;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
      <Button className="w-full justify-start gap-2 rounded-xl" onClick={onNewChat}>
        <Plus className="size-4" />
        New chat
      </Button>
      {tasks.length > 5 && (
        <div className="relative">
          <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label="Search conversations"
            placeholder="Search chats…"
            className="h-8 rounded-lg pl-8 text-xs"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-0.5">
        {!filtered.length ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {tasks.length ? "No matching conversations." : "Your conversations appear here."}
          </p>
        ) : (
          filtered.map((task) => {
            const active = task.taskId === activeChatId;
            const subtasks = childCounts.get(task.taskId) ?? 0;
            return (
              <div
                key={task.taskId}
                className={cn(
                  "group flex items-center gap-1 rounded-lg px-2 py-0.5 transition-colors",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectChat(task.taskId)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm leading-5"
                >
                  <MessageSquare
                    className={cn(
                      "size-3.5 shrink-0",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{taskTitle(task)}</span>
                  {subtasks > 0 && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                      {subtasks}
                    </Badge>
                  )}
                </button>
                <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <ConfirmDelete
                    size="icon-xs"
                    label="Delete conversation"
                    question={`Delete "${taskTitle(task)}"${subtasks ? ` and its ${subtasks} subtask${subtasks === 1 ? "" : "s"}` : ""}?`}
                    remove={() => api.deleteTask(task.taskId)}
                    onDeleted={() => onDeletedChat(task.taskId)}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function AssistantPage({ chatId }: { chatId?: string }) {
  const queryClient = useQueryClient();
  const { openAssistant } = useNav();
  const tasksQuery = useTasks();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [railOpen, setRailOpen] = useState(true);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  // The model picked in the message box. An open chat starts on its task's default; a new chat on
  // the last pick; the pick is not written back to the task.
  const [modelPick, setModelPick] = useState<ModelPick | null>(null);
  const [lastModel, setLastModel] = useState<ModelRef | undefined>();
  const models = modelOptions(useProviders().data?.providers ?? []);

  useEffect(() => {
    setDraft("");
  }, [chatId]);

  const chat = useAssistantChat(chatId, {
    onSessionStarted: (newTaskId) => {
      void openAssistant(newTaskId);
    },
  });

  const pickKey = chatId ?? "new";
  const model = pickedModel(
    modelPick,
    pickKey,
    models,
    chatId ? chat.taskQuery.data?.defaultModel : lastModel,
  );
  const allTasks = tasksQuery.data?.tasks ?? [];
  const rootTasks = useMemo(() => rootChatTasks(allTasks), [allTasks]);
  const childCounts = useMemo(() => childTaskCountMap(allTasks), [allTasks]);
  const agents = chat.activeTarget
    ? chat.targets.agentsByJob[chat.activeTarget.jobName]
    : undefined;

  const events = chat.sessionQuery.data?.events ?? [];
  const turns = useMemo(() => groupChatTurns(events), [events]);

  const activeSessionSummary = chat.sessions.find((s) => s.id === chat.activeSessionId);
  const runStatus = chat.sessionQuery.data?.run?.status ?? activeSessionSummary?.run?.status;
  const isRunning = runStatus === "running" || chat.sendMutation.isPending;
  const isLoadingSession =
    !!chatId && !!chat.activeSessionId && chat.sessionQuery.isPending && !chat.sessionQuery.data;

  const disabledReason = !chat.activeTarget
    ? chat.targets.isPending
      ? "Loading workspace agents…"
      : "No Cloud Run jobs are configured yet."
    : runStatus === "running"
      ? "The assistant is still responding…"
      : undefined;

  const activeLabel = chat.activeTarget
    ? chat.activeTarget.agentName
      ? `${chat.activeTarget.agentName} · ${chat.activeTarget.jobName}`
      : chat.activeTarget.jobName
    : undefined;

  const handleSubmit = () => {
    if (!chat.activeTarget || !draft.trim()) return;
    const text = draft;
    chat.sendMutation.mutate(
      { text, target: chat.activeTarget, files: chat.stagedFiles, model },
      {
        onSuccess: () => setDraft(""),
      },
    );
  };

  const handleNewChat = () => {
    setDraft("");
    chat.resetDraft();
    setMobileRailOpen(false);
    void openAssistant();
  };

  const handleDeletedChat = (deletedId: string) => {
    queryClient.removeQueries({ queryKey: ["task", deletedId] });
    queryClient.removeQueries({ queryKey: ["sessions", deletedId] });
    queryClient.removeQueries({ queryKey: ["documents", deletedId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    if (chatId === deletedId) void openAssistant();
  };

  const pageError =
    chat.sendMutation.error ??
    chat.uploadMutation.error ??
    chat.removeDocumentMutation.error ??
    (chatId ? (chat.taskQuery.error ?? chat.sessionQuery.error) : null);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {railOpen && (
        <aside
          aria-label="Conversations"
          className="hidden w-68 shrink-0 flex-col border-r bg-muted/20 md:flex"
        >
          <ThreadList
            tasks={rootTasks}
            childCounts={childCounts}
            activeChatId={chatId}
            search={search}
            onSearchChange={setSearch}
            onNewChat={handleNewChat}
            onSelectChat={(id) => void openAssistant(id)}
            onDeletedChat={handleDeletedChat}
          />
        </aside>
      )}
      <Sheet open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
              <img src="/stage.png" alt="" aria-hidden className="size-4 rounded-[4px]" />
              Conversations
            </SheetTitle>
          </SheetHeader>
          <ThreadList
            tasks={rootTasks}
            childCounts={childCounts}
            activeChatId={chatId}
            search={search}
            onSearchChange={setSearch}
            onNewChat={handleNewChat}
            onSelectChat={(id) => {
              setMobileRailOpen(false);
              void openAssistant(id);
            }}
            onDeletedChat={handleDeletedChat}
          />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Open conversations"
            onClick={() => setMobileRailOpen(true)}
          >
            <PanelLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hidden md:inline-flex"
            aria-label={railOpen ? "Hide conversations" : "Show conversations"}
            onClick={() => setRailOpen((open) => !open)}
          >
            <PanelLeft />
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {chatId && chat.taskQuery.data ? taskTitle(chat.taskQuery.data) : "New conversation"}
          </h1>
          {activeLabel && (
            <Badge variant="secondary" className="hidden font-mono text-xs sm:inline-flex">
              <img src="/stage.png" alt="" aria-hidden className="size-3.5 rounded-[3px]" />
              {activeLabel}
            </Badge>
          )}
          {chatId && (
            <Link
              to="/tasks/$taskId"
              params={{ taskId: chatId }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Open task
              <ExternalLink className="size-3" />
            </Link>
          )}
        </div>
        {pageError && (
          <div className="mx-auto w-full max-w-3xl px-4 pt-3 md:px-6">
            <ErrorBox
              error={pageError}
              retry={
                chatId && chat.taskQuery.isError ? () => void chat.taskQuery.refetch() : undefined
              }
            />
          </div>
        )}
        <AssistantThread
          turns={turns}
          agents={agents}
          target={chat.activeTarget}
          isRunning={isRunning}
          isLoadingSession={isLoadingSession}
          childCount={chatId ? (childCounts.get(chatId) ?? 0) : 0}
          taskId={chatId}
          onStarterSelect={(prompt) => setDraft(prompt)}
        />
        <AssistantComposer
          value={draft}
          onChange={setDraft}
          onSubmit={handleSubmit}
          target={chat.activeTarget}
          targetOptions={chat.targets.options}
          targetLocked={!!chatId}
          onTargetChange={chat.setTargetOverride}
          modelOptions={models}
          model={model}
          onModelChange={(next) => {
            setModelPick({ key: pickKey, model: next });
            setLastModel(next);
          }}
          hasHistory={turns.length > 0}
          stagedFiles={chat.stagedFiles}
          documents={chat.documentsQuery.data?.documents ?? []}
          onAttachFiles={(files) => {
            if (chatId) chat.uploadMutation.mutate(files);
            else chat.addStagedFiles(files);
          }}
          onRemoveStagedFile={chat.removeStagedFile}
          onDeleteDocument={
            chatId ? (documentId) => chat.removeDocumentMutation.mutate(documentId) : undefined
          }
          disabled={!chat.activeTarget || runStatus === "running"}
          disabledReason={disabledReason}
          isSending={chat.sendMutation.isPending}
          isUploading={chat.uploadMutation.isPending}
        />
      </div>
    </div>
  );
}
