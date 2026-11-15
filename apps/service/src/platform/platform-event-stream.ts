import type { PubSub } from "@google-cloud/pubsub";

import type { StreamListener } from "./session-event-stream";
import { createTopicSubscriber } from "./topic-subscriber";

export type PlatformEventStream = ((listener: StreamListener) => Promise<() => void>) & {
  // Deletes the subscription; undefined in a test fake.
  stop?: () => Promise<void>;
};

// One ephemeral subscription per service process, fanned out in memory to
// every connected /events client. Started on the first listener.
export const createPlatformEventStream = (
  pubsub: Pick<PubSub, "topic">,
  topicName: string,
  subscriptionName = `stage-service-platform-${crypto.randomUUID()}`,
): PlatformEventStream => {
  const listeners = new Set<StreamListener>();
  const start = createTopicSubscriber(pubsub, topicName, subscriptionName, (message) => {
    const { eventId } = message.attributes;
    if (!eventId) return;
    for (const listener of listeners) listener(eventId, message.data.toString());
  });

  const stream = async (listener: StreamListener) => {
    await start();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return Object.assign(stream, { stop: start.stop });
};
