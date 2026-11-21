import { freeTextInputHint } from "@/features/tasks/session-parts";
import {
  parseJsonObject,
  shortJobName,
  type AgentInfo,
  type Job,
  type RunMode,
  type SessionEvent,
  type Task,
} from "@/lib/api";

export const isQuickServiceAvailable = (jobs: Job[], jobName?: string): boolean =>
  !!jobName && !!jobs.find((job) => shortJobName(job) === jobName)?.quickService;

export const resolveEffectiveRunMode = (mode: RunMode, serviceAvailable: boolean): RunMode =>
  serviceAvailable ? mode : "workflow";

export type AssistantTarget = {
  jobName: string;
  agentName?: string;
};

export type AssistantTargetOption = AssistantTarget & {
  id: string;
  label: string;
  description?: string;
  isOrchestrator: boolean;
  unsupportedHint?: string;
};

export type ToolActivity = {
  id: string;
  name: string;
  args?: unknown;
  response?: unknown;
  pending: boolean;
};

export type ChatTurn =
  | {
      id: string;
      kind: "user";
      text: string;
      timestamp?: number;
    }
  | {
      id: string;
      kind: "assistant";
      author?: string;
      textSegments: string[];
      tools: ToolActivity[];
      thoughts: string[];
      errorMessage?: string;
      timestamp?: number;
    };

export const targetKey = (target: AssistantTarget): string =>
  JSON.stringify([target.jobName, target.agentName ?? null]);

export const parseTargetKey = (key: string): AssistantTarget | undefined => {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || !parsed[0]) return undefined;
    const agentName = typeof parsed[1] === "string" && parsed[1] ? parsed[1] : undefined;
    return { jobName: parsed[0], ...(agentName && { agentName }) };
  } catch {
    return undefined;
  }
};

const isExactOrchestrator = (name: string) => /^orchestrator$/i.test(name);
const isOrchestratorLike = (name: string) => /orchestrator/i.test(name);

// Resolves the default assistant target in priority order:
// 1. Exact job "orchestrator" (using its exact "orchestrator" agent if registered)
// 2. Any job with a registered agent matching /^orchestrator$/i, else /orchestrator/i
// 3. Any job whose name matches /orchestrator/i
// 4. Fallback to the first named job
export function resolveDefaultTarget(
  jobs: Job[],
  agentsByJob: Record<string, AgentInfo[]> = {},
): AssistantTarget | undefined {
  const namedJobs = jobs
    .filter((job) => !!job.name)
    .map((job) => ({ job, jobName: shortJobName(job) }));
  if (!namedJobs.length) return undefined;

  const exactJob = namedJobs.find(({ jobName }) => isExactOrchestrator(jobName));
  if (exactJob) {
    const exactAgent = (agentsByJob[exactJob.jobName] ?? []).find((a) =>
      isExactOrchestrator(a.name),
    );
    return {
      jobName: exactJob.jobName,
      ...(exactAgent && { agentName: exactAgent.name }),
    };
  }

  for (const { jobName } of namedJobs) {
    const exactAgent = (agentsByJob[jobName] ?? []).find((a) => isExactOrchestrator(a.name));
    if (exactAgent) return { jobName, agentName: exactAgent.name };
  }

  for (const { jobName } of namedJobs) {
    const similarAgent = (agentsByJob[jobName] ?? []).find((a) => isOrchestratorLike(a.name));
    if (similarAgent) return { jobName, agentName: similarAgent.name };
  }

  const similarJob = namedJobs.find(({ jobName }) => isOrchestratorLike(jobName));
  if (similarJob) return { jobName: similarJob.jobName };

  return { jobName: namedJobs[0]!.jobName };
}

export function buildTargetOptions(
  jobs: Job[],
  agentsByJob: Record<string, AgentInfo[]> = {},
): AssistantTargetOption[] {
  const options: AssistantTargetOption[] = [];
  const defaultTarget = resolveDefaultTarget(jobs, agentsByJob);
  const defaultId = defaultTarget ? targetKey(defaultTarget) : undefined;

  for (const job of jobs) {
    if (!job.name) continue;
    const jobName = shortJobName(job);
    const jobTarget: AssistantTarget = { jobName };
    const jobId = targetKey(jobTarget);
    options.push({
      ...jobTarget,
      id: jobId,
      label: `${jobName} (Default)`,
      isOrchestrator: isOrchestratorLike(jobName) || jobId === defaultId,
    });

    for (const agent of agentsByJob[jobName] ?? []) {
      const target: AssistantTarget = { jobName, agentName: agent.name };
      const id = targetKey(target);
      options.push({
        ...target,
        id,
        label: `${agent.name} · ${jobName}`,
        description: agent.description,
        isOrchestrator: isOrchestratorLike(agent.name) || id === defaultId,
        unsupportedHint: freeTextInputHint(agent.inputSchema),
      });
    }
  }

  return options.toSorted((a, b) => {
    if (a.id === defaultId) return -1;
    if (b.id === defaultId) return 1;
    if (a.isOrchestrator !== b.isOrchestrator) return a.isOrchestrator ? -1 : 1;
    return 0;
  });
}

// The orchestrator calls a registered agent as a tool named "<job>__<agent>"; that call is a subagent run.
export const parseDelegation = (toolName: string): { job: string; agent: string } | undefined => {
  const at = toolName.indexOf("__");
  return at > 0 && at < toolName.length - 2
    ? { job: toolName.slice(0, at), agent: toolName.slice(at + 2) }
    : undefined;
};

export const rootChatTasks = (tasks: Task[]): Task[] => tasks.filter((task) => !task.parentTaskId);

export function childTaskCountMap(tasks: Task[]): Map<string, number> {
  const childrenByParent = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentTaskId || task.parentTaskId === task.taskId) continue;
    const list = childrenByParent.get(task.parentTaskId) ?? [];
    list.push(task.taskId);
    childrenByParent.set(task.parentTaskId, list);
  }

  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.parentTaskId) continue;
    const seen = new Set([task.taskId]);
    const queue = [task.taskId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const childId of childrenByParent.get(id) ?? []) {
        if (!seen.has(childId)) {
          seen.add(childId);
          queue.push(childId);
        }
      }
    }
    if (seen.size > 1) counts.set(task.taskId, seen.size - 1);
  }
  return counts;
}

export function toChatTitle(message: string): string {
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 59).trimEnd()}…` : firstLine;
}

export function groupChatTurns(events: SessionEvent[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let currentAssistant: Extract<ChatTurn, { kind: "assistant" }> | null = null;

  const flushAssistant = () => {
    if (currentAssistant) {
      turns.push(currentAssistant);
      currentAssistant = null;
    }
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const parts = event.content?.parts ?? [];
    const isUser = event.author === "user" || event.content?.role === "user";

    if (isUser) {
      const text = parts
        .filter((part) => !part.functionResponse && part.text != null)
        .map((part) => part.text!)
        .join("\n")
        .trim();
      if (text) {
        flushAssistant();
        turns.push({
          id: event.id ?? `user-${i}`,
          kind: "user",
          text,
          timestamp: event.timestamp,
        });
        continue;
      }
      // A user-role event carrying only functionResponse belongs to the active assistant turn.
      if (!parts.some((part) => part.functionResponse)) continue;
    }

    if (!currentAssistant) {
      currentAssistant = {
        id: event.id ?? `assistant-${i}`,
        kind: "assistant",
        author: event.author,
        textSegments: [],
        tools: [],
        thoughts: [],
        timestamp: event.timestamp,
      };
    }

    if (event.author && !isUser) currentAssistant.author = event.author;
    if (event.timestamp != null) currentAssistant.timestamp = event.timestamp;
    if (event.errorMessage) {
      currentAssistant.errorMessage = currentAssistant.errorMessage
        ? `${currentAssistant.errorMessage}\n${event.errorMessage}`
        : event.errorMessage;
    }

    for (const part of parts) {
      if (part.thought && part.text) {
        const thought = part.text.trim();
        if (thought) currentAssistant.thoughts.push(thought);
      } else if (part.text != null && !part.thought) {
        if (part.text.trim()) currentAssistant.textSegments.push(part.text);
      }

      if (part.functionCall) {
        currentAssistant.tools.push({
          id: `${event.id ?? i}-tool-${currentAssistant.tools.length}`,
          name: part.functionCall.name ?? "Tool",
          args: part.functionCall.args,
          pending: true,
        });
      }

      if (part.functionResponse) {
        const name = part.functionResponse.name ?? "Tool";
        const pendingIndex = currentAssistant.tools.findLastIndex(
          (tool) => tool.pending && tool.name === name,
        );
        if (pendingIndex >= 0) {
          currentAssistant.tools[pendingIndex] = {
            ...currentAssistant.tools[pendingIndex]!,
            response: part.functionResponse.response,
            pending: false,
          };
        } else {
          currentAssistant.tools.push({
            id: `${event.id ?? i}-tool-${currentAssistant.tools.length}`,
            name,
            response: part.functionResponse.response,
            pending: false,
          });
        }
      }
    }
  }

  flushAssistant();
  return turns;
}

export function turnCopyText(turn: Extract<ChatTurn, { kind: "assistant" }>): string {
  return turn.textSegments
    .map((segment) => {
      const obj = parseJsonObject(segment);
      if (obj) {
        for (const key of ["answer", "response", "text"] as const) {
          if (typeof obj[key] === "string" && obj[key].trim()) return obj[key];
        }
      }
      return segment;
    })
    .filter((segment) => segment.trim().length > 0)
    .join("\n\n");
}
