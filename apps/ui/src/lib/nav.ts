import { useNavigate } from "@tanstack/react-router";

type Search = Record<string, unknown>;

const keepSearch =
  (patch: Search = {}) =>
  (prev: Search) => ({ ...prev, ...patch });

// The open task is the path (/tasks/:taskId); the job pane and create dialog are search params.
export function useNav() {
  const navigate = useNavigate();
  const setSearch = (patch: Search) => navigate({ to: ".", search: keepSearch(patch) });
  return {
    openTask: (taskId: string) =>
      navigate({
        to: "/tasks/$taskId",
        params: { taskId },
        search: keepSearch({ job: undefined }),
      }),
    openAssistant: (chatId?: string) =>
      chatId
        ? navigate({
            to: "/assistant/$chatId",
            params: { chatId },
            search: keepSearch({ job: undefined }),
          })
        : navigate({ to: "/assistant", search: keepSearch({ job: undefined }) }),
    openJob: (job: string) => navigate({ to: "/jobs", search: keepSearch({ job }) }),
    openCreate: (forJob?: string) => setSearch({ new: true, for: forJob }),
    closeTask: () => navigate({ to: "/tasks", search: keepSearch() }),
    closeJob: () => setSearch({ job: undefined }),
    closeCreate: () => setSearch({ new: undefined, for: undefined }),
  };
}
