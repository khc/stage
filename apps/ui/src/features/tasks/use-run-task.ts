import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useNav } from "@/lib/nav";

export function useRunTask() {
  const client = useQueryClient();
  const { openTask } = useNav();
  return useMutation({
    mutationFn: api.run,
    onSuccess: (result, taskId) => {
      toast.success("Execution submitted", {
        description: `Cloud Run accepted the request. New sessions appear when the agent starts. Operation: ${result.operation || "accepted"}`,
        action: { label: "Open task", onClick: () => void openTask(taskId) },
      });
      void client.invalidateQueries({ queryKey: ["sessions", taskId] });
    },
    onError: (error) => toast.error("Could not start task", { description: error.message }),
  });
}
