import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { sessionRefetchInterval, useSessionStream } from "@/features/tasks/session-parts";
import {
  api,
  shortJobName,
  type AgentInfo,
  type Api,
  type ModelRef,
  type RunMode,
  type Session,
  type SessionSummary,
} from "@/lib/api";
import { readAssistantSettings } from "@/lib/assistant-settings";
import { useJobs } from "@/lib/queries";

import {
  buildTargetOptions,
  resolveDefaultTarget,
  resolveSavedTarget,
  toChatTitle,
  type AssistantTarget,
} from "./assistant-model";

export type StartingSession = { taskId: string; sessionId: string };
export type PendingTask = { taskId: string; uploadedNames: Set<string> };

export function pickActiveSessionId(
  sessions: SessionSummary[],
  preferredId?: string | null,
  startingId?: string | null,
): string | null {
  if (startingId && (!sessions.length || sessions.some((s) => s.id === startingId))) {
    return startingId;
  }
  if (preferredId && sessions.some((s) => s.id === preferredId)) {
    return preferredId;
  }
  const latest = sessions.toSorted((a, b) => b.lastUpdateTime - a.lastUpdateTime)[0];
  return latest?.id ?? null;
}

export function isAwaitingRunStart(
  starting: StartingSession | null,
  chatId: string | undefined,
  activeSessionId: string | null,
  session: Pick<Session, "run"> | undefined,
): boolean {
  return (
    !!chatId &&
    !!starting &&
    starting.taskId === chatId &&
    activeSessionId === starting.sessionId &&
    !session?.run
  );
}

export function shouldPollSessions(
  sessions: SessionSummary[] | undefined,
  starting: StartingSession | null,
  chatId: string | undefined,
  startingSessionDetail?: Pick<Session, "run">,
): number | false {
  if (sessions?.some((s) => s.run?.status === "running")) return 5000;
  if (startingSessionDetail?.run?.status === "running") return 5000;
  if (!chatId || starting?.taskId !== chatId) return false;
  const startingSummary = sessions?.find((s) => s.id === starting.sessionId);
  const run = startingSessionDetail?.run ?? startingSummary?.run;
  if (run && run.status !== "running") return false;
  return 5000;
}

export async function executeNewChatSend({
  client,
  pending,
  setPending,
  target,
  message,
  files,
  onCreated,
  onUploaded,
  model,
  mode,
}: {
  client: Pick<Api, "create" | "uploadDocument" | "startSession">;
  pending: PendingTask | null;
  setPending: (next: PendingTask | null) => void;
  target: AssistantTarget;
  message: string;
  files: File[];
  onCreated?: (taskId: string) => void;
  onUploaded?: (taskId: string) => void;
  // The model picked for the first message; it also becomes the new task's default.
  model?: ModelRef;
  mode?: RunMode;
}): Promise<{ taskId: string; sessionId?: string }> {
  let state = pending;
  if (!state) {
    const task = await client.create({
      name: toChatTitle(message),
      prompt: message,
      jobName: target.jobName,
      ...(target.agentName && { agentName: target.agentName }),
      ...(model && { defaultModel: model }),
    });
    state = { taskId: task.taskId, uploadedNames: new Set() };
    setPending(state);
    onCreated?.(task.taskId);
  }

  for (const file of files) {
    if (state.uploadedNames.has(file.name)) continue;
    await client.uploadDocument(state.taskId, file);
    state.uploadedNames.add(file.name);
    onUploaded?.(state.taskId);
  }

  const started = mode
    ? await client.startSession(state.taskId, message, model, mode)
    : await client.startSession(state.taskId, message, model);
  setPending(null);
  return { taskId: state.taskId, sessionId: started.sessionId };
}

export function useAssistantTargets() {
  const jobsQuery = useJobs();
  const namedJobs = useMemo(
    () => (jobsQuery.data?.jobs ?? []).filter((job) => !!job.name),
    [jobsQuery.data?.jobs],
  );
  const agentQueries = useQueries({
    queries: namedJobs.map((job) => {
      const name = shortJobName(job);
      return {
        queryKey: ["agents", name],
        queryFn: () => api.agents(name),
        enabled: !!job.name,
        retry: false,
      };
    }),
  });

  const agentsByJob = useMemo(() => {
    const map: Record<string, AgentInfo[]> = {};
    namedJobs.forEach((job, i) => {
      const agents = agentQueries[i]?.data?.agents;
      if (agents) map[shortJobName(job)] = agents;
    });
    return map;
  }, [namedJobs, agentQueries]);

  const [saved] = useState(() => readAssistantSettings().defaultTarget);
  const defaultTarget = useMemo(
    () =>
      resolveSavedTarget(saved, namedJobs, agentsByJob) ??
      resolveDefaultTarget(namedJobs, agentsByJob),
    [saved, namedJobs, agentsByJob],
  );
  const options = useMemo(
    () => buildTargetOptions(namedJobs, agentsByJob),
    [namedJobs, agentsByJob],
  );

  return {
    jobsQuery,
    agentsByJob,
    defaultTarget,
    options,
    isPending: jobsQuery.isPending,
  };
}

export function useAssistantChat(
  chatId?: string,
  options?: { onSessionStarted?: (taskId: string, sessionId?: string) => void },
) {
  const queryClient = useQueryClient();
  const targets = useAssistantTargets();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [startingSession, setStartingSession] = useState<StartingSession | null>(null);
  const [targetOverride, setTargetOverride] = useState<AssistantTarget | undefined>(undefined);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const pendingTaskRef = useRef<PendingTask | null>(null);

  const taskQuery = useQuery({
    queryKey: ["task", chatId],
    queryFn: () => api.task(chatId!),
    enabled: !!chatId,
  });

  const sessionsQuery = useQuery({
    queryKey: ["sessions", chatId],
    queryFn: () => api.sessions(chatId!),
    enabled: !!chatId,
    refetchInterval: (query) => {
      const detail =
        chatId && startingSession?.taskId === chatId
          ? queryClient.getQueryData<Session>(["session", chatId, startingSession.sessionId])
          : undefined;
      return shouldPollSessions(query.state.data?.sessions, startingSession, chatId, detail);
    },
  });

  const documentsQuery = useQuery({
    queryKey: ["documents", chatId],
    queryFn: () => api.documents(chatId!),
    enabled: !!chatId,
  });

  const sortedSessions = useMemo(
    () =>
      (sessionsQuery.data?.sessions ?? []).toSorted((a, b) => b.lastUpdateTime - a.lastUpdateTime),
    [sessionsQuery.data?.sessions],
  );

  const activeSessionId = chatId
    ? pickActiveSessionId(
        sortedSessions,
        selectedSessionId,
        startingSession?.taskId === chatId ? startingSession.sessionId : null,
      )
    : null;

  const sessionQuery = useQuery({
    queryKey: ["session", chatId, activeSessionId],
    queryFn: () => api.session(chatId!, activeSessionId!),
    enabled: !!chatId && !!activeSessionId,
    refetchInterval: (query) =>
      sessionRefetchInterval(
        query.state.data,
        isAwaitingRunStart(startingSession, chatId, activeSessionId, query.state.data),
      ),
  });

  useSessionStream(chatId ?? "", chatId ? activeSessionId : null);

  const activeTarget: AssistantTarget | undefined = chatId
    ? taskQuery.data?.jobName
      ? { jobName: taskQuery.data.jobName, agentName: taskQuery.data.agentName }
      : undefined
    : (targetOverride ?? targets.defaultTarget);

  const sendMutation = useMutation({
    mutationFn: async ({
      text,
      target,
      files,
      model,
      mode,
    }: {
      text: string;
      target: AssistantTarget;
      files: File[];
      model?: ModelRef;
      mode?: RunMode;
    }) => {
      const trimmed = text.trim();
      if (!chatId) {
        return executeNewChatSend({
          client: api,
          pending: pendingTaskRef.current,
          setPending: (next) => {
            pendingTaskRef.current = next;
          },
          target,
          message: trimmed,
          files,
          model,
          mode,
          onCreated: () => {
            void queryClient.invalidateQueries({ queryKey: ["tasks"] });
          },
          onUploaded: (taskId) => {
            void queryClient.invalidateQueries({ queryKey: ["documents", taskId] });
          },
        });
      }

      if (activeSessionId) {
        await api.resume(chatId, activeSessionId, trimmed, model, mode);
        return { taskId: chatId, sessionId: activeSessionId, resumed: true as const };
      }

      const started = await api.startSession(chatId, trimmed, model, mode);
      return { taskId: chatId, sessionId: started.sessionId, resumed: false as const };
    },
    onSuccess: (result) => {
      if (!chatId) {
        setStagedFiles([]);
        if (result.sessionId) {
          setStartingSession({ taskId: result.taskId, sessionId: result.sessionId });
        }
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["sessions", result.taskId] });
        options?.onSessionStarted?.(result.taskId, result.sessionId);
        return;
      }

      if ("resumed" in result && result.resumed && result.sessionId) {
        void queryClient.invalidateQueries({ queryKey: ["session", chatId, result.sessionId] });
      } else if (result.sessionId) {
        setStartingSession({ taskId: chatId, sessionId: result.sessionId });
      }
      void queryClient.invalidateQueries({ queryKey: ["sessions", chatId] });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      if (!chatId) return;
      for (const file of files) {
        await api.uploadDocument(chatId, file);
      }
    },
    onSuccess: () => {
      if (chatId) void queryClient.invalidateQueries({ queryKey: ["documents", chatId] });
    },
  });

  const removeDocumentMutation = useMutation({
    mutationFn: async (documentId: string) => {
      if (!chatId) return;
      await api.deleteDocument(chatId, documentId);
    },
    onSuccess: () => {
      if (chatId) void queryClient.invalidateQueries({ queryKey: ["documents", chatId] });
    },
  });

  const { reset: resetSend } = sendMutation;
  const { reset: resetUpload } = uploadMutation;
  const { reset: resetRemoveDoc } = removeDocumentMutation;

  useEffect(() => {
    setSelectedSessionId(null);
    setTargetOverride(undefined);
    setStagedFiles([]);
    pendingTaskRef.current = null;
    setStartingSession((prev) => (prev && prev.taskId === chatId ? prev : null));
    resetSend();
    resetUpload();
    resetRemoveDoc();
  }, [chatId, resetSend, resetUpload, resetRemoveDoc]);

  const settledStatus = sessionQuery.data?.run?.status;
  useEffect(() => {
    if (
      startingSession &&
      startingSession.taskId === chatId &&
      activeSessionId === startingSession.sessionId &&
      settledStatus &&
      settledStatus !== "running"
    ) {
      setStartingSession(null);
    }
  }, [chatId, activeSessionId, startingSession, settledStatus]);

  const resetDraft = () => {
    pendingTaskRef.current = null;
    setStagedFiles([]);
    setTargetOverride(undefined);
    resetSend();
    resetUpload();
    resetRemoveDoc();
  };

  return {
    targets,
    activeTarget,
    setTargetOverride,
    taskQuery,
    sessions: sortedSessions,
    sessionsQuery,
    activeSessionId,
    setSelectedSessionId,
    sessionQuery,
    documentsQuery,
    stagedFiles,
    addStagedFiles: (files: File[]) => setStagedFiles((prev) => [...prev, ...files]),
    removeStagedFile: (index: number) =>
      setStagedFiles((prev) => prev.filter((_, i) => i !== index)),
    resetDraft,
    sendMutation,
    uploadMutation,
    removeDocumentMutation,
  };
}
