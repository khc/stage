import { expect, test } from "bun:test";

import { Dialog } from "@/components/ui/dialog";
import type { Provider } from "@/lib/api";
import { renderWithApp } from "@/test-utils";

import { NewTaskForm, taskInput } from "./new-task-dialog";

const provider = {
  providerId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
  name: "Express",
  kind: "google-express",
  enabled: true,
  hasApiKey: true,
  models: ["gemini-2.5-flash"],
  createdAt: 1,
  updatedAt: 1,
} as Provider;

test("the dialog offers an optional default model that starts on Job default", async () => {
  const html = await renderWithApp(
    <Dialog open>
      <NewTaskForm jobs={[]} initialJob="" onClose={() => {}} />
    </Dialog>,
    [[["providers"], { providers: [provider] }]],
  );
  expect(html).toContain("Default model");
  expect(html).toContain('aria-label="Model"');
  expect(html).toContain("Job default");
});

test("the create request carries the default model only when one is chosen", () => {
  const model = { providerId: provider.providerId, model: "gemini-2.5-flash" };
  const base = { name: "  Task  ", prompt: "  p  ", jobName: "job", agentName: " " };
  expect(taskInput(base)).toEqual({ name: "Task", prompt: "p", jobName: "job" });
  expect(taskInput({ ...base, agentName: "haiku", model })).toEqual({
    name: "Task",
    prompt: "p",
    jobName: "job",
    agentName: "haiku",
    defaultModel: model,
  });
});
