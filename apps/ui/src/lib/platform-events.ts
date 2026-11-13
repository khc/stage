import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

const POLL_MS = 15_000;

type PlatformEvent = { type: string; taskId?: string; jobName?: string };

// The queries a platform event makes stale.
export const invalidationsFor = ({ type, taskId, jobName }: PlatformEvent): QueryKey[] => {
  switch (type) {
    case "task.created":
    case "task.deleted":
      return [["tasks"], ...(taskId ? [["task", taskId]] : [])];
    case "task.run_requested":
      return [["tasks"], ...(taskId ? [["sessions", taskId]] : [])];
    case "document.added":
    case "document.removed":
      return taskId
        ? [
            ["documents", taskId],
            ["task", taskId],
          ]
        : [];
    case "job.registration_requested":
      return jobName ? [["agents", jobName]] : [];
    default:
      return [];
  }
};

let live = false;
const listeners = new Set<() => void>();
const setLive = (value: boolean) => {
  if (live === value) return;
  live = value;
  for (const listener of listeners) listener();
};

export const isLive = () => live;
// Query default: poll only while the event stream is not delivering updates.
export const pollUnlessLive = () => (live ? false : POLL_MS);
export const usePlatformLive = () =>
  useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, isLive);

// Opens the platform event stream. Events published while disconnected are
// lost, so every (re)connect refreshes all queries. The browser reconnects on
// its own after a drop; a 501 (no topic configured) leaves polling in place.
export const startPlatformEvents = (client: QueryClient, url = "/events") => {
  const source = new EventSource(url);
  source.addEventListener("open", () => {
    setLive(true);
    void client.invalidateQueries();
  });
  source.addEventListener("message", (message) => {
    try {
      for (const queryKey of invalidationsFor(JSON.parse(message.data) as PlatformEvent))
        void client.invalidateQueries({ queryKey });
    } catch {
      // A malformed message is ignored; the next reconnect refreshes everything.
    }
  });
  // Observers recompute refetchInterval only when a query updates, so refetch
  // now to let them resume polling.
  source.addEventListener("error", () => {
    setLive(false);
    void client.invalidateQueries();
  });
  return () => {
    source.close();
    setLive(false);
  };
};
