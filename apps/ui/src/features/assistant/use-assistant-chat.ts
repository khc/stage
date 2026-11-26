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

// A message resumes a session that already ran, so its cached run is the previous one, finished: the
// session is then polled for the new run until it appears (the job needs a few seconds to start it),
// not for as long as the cached run looks done. Gives up after RESUME_WAIT_MS if no run ever starts.
export type ResumedRun = {
  taskId: string;
  sessionId: string;
  previousStartedAt?: number;
  sentAt: number;
};
export const RESUME_WAIT_MS = 120_000;

export function isAwaitingResumedRun(
  resumed: ResumedRun | null,
  chatId: string | undefined,
  activeSessionId: string | null,
  session: Pick<Session, "run"> | undefined,
  now = Date.now(),
): boolean {
  return (
    !!resumed &&
    resumed.taskId === chatId &&
    resumed.sessionId === activeSessionId &&
    now - resumed.sentAt < RESUME_WAIT_MS &&
    session?.run?.startedAt === resumed.previousStartedAt
  );
}

// How often the open session is refetched: while its run is under way, while a just-started session has
// no run yet, and while a resumed one still shows the previous run.
export function chatSessionRefetchInterval(
  session: Pick<Session, "run" | "events"> | undefined,
  starting: StartingSession | null,
  resumed: ResumedRun | null,
  chatId: string | undefined,
  activeSessionId: string | null,
  now = Date.now(),
): number | false {
  const awaitingResume = isAwaitingResumedRun(resumed, chatId, activeSessionId, session, now);
  return awaitingResume
    ? 2000
    : sessionRefetchInterval(
        session,
        isAwaitingRunStart(starting, chatId, activeSessionId, session),
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
    // oxlint-disable-next-line eslint/no-await-in-loop -- documents upload one at a time, in the order the user chose
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
  const [resumedRun, setResumedRun] = useState<ResumedRun | null>(null);
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
      chatSessionRefetchInterval(
        query.state.data,
        startingSession,
        resumedRun,
        chatId,
        activeSessionId,
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
        // Read before the resume: the cached run is the one that finished before this message.
        const previousStartedAt = queryClient.getQueryData<Session>([
          "session",
          chatId,
          activeSessionId,
        ])?.run?.startedAt;
        await api.resume(chatId, activeSessionId, trimmed, model, mode);
        return {
          taskId: chatId,
          sessionId: activeSessionId,
          resumed: true as const,
          previousStartedAt,
        };
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
        setResumedRun({
          taskId: chatId,
          sessionId: result.sessionId,
          previousStartedAt: result.previousStartedAt,
          sentAt: Date.now(),
        });
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
        // oxlint-disable-next-line eslint/no-await-in-loop -- documents upload one at a time, in the order the user chose
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
    // oxlint-disable-next-line react/set-state-in-effect -- a new chat id resets the state and clears a ref, which render-time reset cannot do
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
      // oxlint-disable-next-line react/set-state-in-effect -- the chat's pending send is over once its run settles; this clears the marker after the fact
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
