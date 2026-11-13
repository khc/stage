import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

// Cloud Run job changes made outside the service emit no platform events.
const POLL_MS = 15_000;

export const useTasks = () => useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
export const useJobs = () => useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: POLL_MS });
export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: api.health, retry: false, refetchInterval: POLL_MS });
