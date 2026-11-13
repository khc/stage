import { useNavigate } from "@tanstack/react-router";

type Search = Record<string, unknown>;

// Dialog and pane state lives in the URL search params, so views are linkable.
export function useNav() {
  const navigate = useNavigate();
  const set = (patch: Search) =>
    navigate({ to: ".", search: (prev: Search) => ({ ...prev, ...patch }) });
  return {
    openTask: (task: string) => set({ task, job: undefined }),
    openJob: (job: string) => set({ job, task: undefined }),
    openCreate: (forJob?: string) => set({ new: true, for: forJob }),
    closeTask: () => set({ task: undefined }),
    closeJob: () => set({ job: undefined }),
    closeCreate: () => set({ new: undefined, for: undefined }),
  };
}
