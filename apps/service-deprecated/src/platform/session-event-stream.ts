import type { PubSub } from "@google-cloud/pubsub";

import { createTopicSubscriber } from "./topic-subscriber";

export type StreamListener = (eventId: string, json: string) => void;
export type SessionEventStream = (
  taskId: string,
  sessionId: string,
  listener: StreamListener,
) => Promise<() => void>;

const key = (taskId: string, sessionId: string) => JSON.stringify([taskId, sessionId]);

// One ephemeral subscription per service process, fanned out in memory.
// Started on the first listener, so a service nobody streams from never
// touches Pub/Sub. Events published before that are served from Firestore.
export const createSessionEventStream = (
  pubsub: Pick<PubSub, "topic">,
  topicName: string,
  subscriptionName = `stage-service-${crypto.randomUUID()}`,
): SessionEventStream => {
  const listeners = new Map<string, Set<StreamListener>>();
  const start = createTopicSubscriber(pubsub, topicName, subscriptionName, (message) => {
    const { taskId, sessionId, eventId } = message.attributes;
    if (!taskId || !sessionId || !eventId) return;
    for (const listener of listeners.get(key(taskId, sessionId)) ?? [])
      listener(eventId, message.data.toString());
  });

  return async (taskId, sessionId, listener) => {
    await start();
    const k = key(taskId, sessionId);
    const set = listeners.get(k) ?? new Set();
    set.add(listener);
    listeners.set(k, set);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(k);
    };
  };
};
