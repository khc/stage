import { expect, test } from "bun:test";

import { createFirestoreClient } from "./firestore-client";
import { createPubSubClient } from "./pubsub-client";

// Both clients keep the project they were built with on `projectId`, which their types omit.
const projectOf = (client: unknown) => (client as { projectId: string }).projectId;

test("the clients use the project they are given, not the ambient GOOGLE_CLOUD_PROJECT", () => {
  const ambient = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = "ambient-project";
  try {
    expect(projectOf(createFirestoreClient("given-project"))).toBe("given-project");
    expect(projectOf(createPubSubClient("given-project"))).toBe("given-project");
  } finally {
    if (ambient === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = ambient;
  }
});
