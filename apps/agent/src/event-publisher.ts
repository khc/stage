import { PubSub, type Topic } from "@google-cloud/pubsub";
import type { Event } from "@google/adk";

export type PublishEvent = (
  event: Event,
  context: { sessionId: string; taskId?: string },
) => Promise<void>;

export const createEventPublisher = (
  getTopic: () => Promise<Pick<Topic, "publishMessage">>,
): PublishEvent => {
  let topic: ReturnType<typeof getTopic> | undefined;
  return async (event, { sessionId, taskId }) => {
    topic ??= getTopic().catch((err) => {
      topic = undefined;
      throw err;
    });
    await (
      await topic
    ).publishMessage({
      data: Buffer.from(JSON.stringify(event)),
      attributes: {
        eventId: event.id,
        sessionId,
        ...(taskId !== undefined && { taskId }),
      },
    });
  };
};

export const publisherFromEnv = (
  env: Record<string, string | undefined>,
  pubsub: Pick<PubSub, "topic"> = new PubSub(),
): PublishEvent | undefined => {
  const name = env.PUBSUB_TOPIC;
  if (!name) return undefined;
  return createEventPublisher(
    async () => (await pubsub.topic(name).get({ autoCreate: true }))[0],
  );
};
