import { expect, test } from "bun:test";

import { migrateLegacyTaskNames } from "./migrate-legacy-task-names";

type FakeDoc = {
  id: string;
  data: Record<string, unknown>;
  updateTime: string;
  updated?: Record<string, string>;
};

const fakeDb = (docs: FakeDoc[]) =>
  ({
    collection: () => ({
      orderBy: () => ({
        limit: () => ({
          get: async () => ({
            size: docs.length,
            docs: docs.map((d) => ({
              id: d.id,
              updateTime: d.updateTime,
              get: (field: string) => d.data[field],
              ref: {
                update: async (patch: Record<string, string>) => {
                  d.updated = patch;
                },
              },
            })),
          }),
        }),
      }),
    }),
  }) as never;

test("dry-run counts legacy task jobName and agentName without writing", async () => {
  const docs: FakeDoc[] = [
    {
      id: "t1",
      updateTime: "t1",
      data: { jobName: "generic-agents", agentName: "document_analyser" },
    },
    {
      id: "t2",
      updateTime: "t2",
      data: { jobName: "stage--poet-agents--job-lcl", agentName: "haiku-poet" },
    },
  ];
  expect(await migrateLegacyTaskNames(fakeDb(docs))).toEqual({ tasks: 1, unchangedTasks: 1 });
  expect(docs[0]!.updated).toBeUndefined();
});

test("apply rewrites legacy jobName and document_analyser to the new naming convention", async () => {
  const docs: FakeDoc[] = [
    {
      id: "t1",
      updateTime: "t1",
      data: { jobName: "generic-agents", agentName: "document_analyser" },
    },
    { id: "t2", updateTime: "t2", data: { jobName: "poet-agents" } },
    {
      id: "t3",
      updateTime: "t3",
      data: { jobName: "stage--generic-agents--job-dev", agentName: "assistant" },
    },
  ];
  expect(await migrateLegacyTaskNames(fakeDb(docs), { apply: true, env: "dev" })).toEqual({
    tasks: 2,
    unchangedTasks: 1,
  });
  expect(docs[0]!.updated).toEqual({
    jobName: "stage--generic-agents--job-dev",
    agentName: "document-analyser",
  });
  expect(docs[1]!.updated).toEqual({ jobName: "stage--poet-agents--job-dev" });
  expect(docs[2]!.updated).toBeUndefined();
});
