import type { PubSub } from "@google-cloud/pubsub";

import type { EventListener } from "./live-events";
import { createTopicListener } from "./topic-listener";

export type PlatformStream = (listener: EventListener) => Promise<() => void>;

// One ephemeral subscription per service process, fanned out in memory to
// every connected /events client. Started on the first listener.
export const createPlatformStream = (
  pubsub: Pick<PubSub, "topic">,
  topicName: string,
  subscriptionName = `stage-service-platform-${crypto.randomUUID()}`,
): PlatformStream => {
  const listeners = new Set<EventListener>();
  const start = createTopicListener(pubsub, topicName, subscriptionName, (message) => {
    const { eventId } = message.attributes;
    if (!eventId) return;
    for (const listener of listeners) listener(eventId, message.data.toString());
  });

  return async (listener) => {
    await start();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
};
