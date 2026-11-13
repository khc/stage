import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const useTasks = () => useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
export const useJobs = () => useQuery({ queryKey: ["jobs"], queryFn: api.jobs });
export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: api.health, retry: false });
