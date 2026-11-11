import type { PubSub } from "@google-cloud/pubsub";

export type EventListener = (eventId: string, json: string) => void;
export type LiveEvents = (
  taskId: string,
  sessionId: string,
  listener: EventListener,
) => Promise<() => void>;

const SUBSCRIPTION_TTL_SECONDS = 24 * 60 * 60;

// One ephemeral subscription per service process, fanned out in memory.
// Started on the first listener, so a service nobody streams from never
// touches Pub/Sub. Events published before that are served from Firestore.
export const createLiveEvents = (
  pubsub: Pick<PubSub, "topic">,
  topicName: string,
  subscriptionName = `agent-jobs-service-${crypto.randomUUID()}`,
): LiveEvents => {
  const listeners = new Map<string, Set<EventListener>>();
  let started: Promise<void> | undefined;
  const key = (taskId: string, sessionId: string) =>
    JSON.stringify([taskId, sessionId]);

  const start = () =>
    (started ??= (async () => {
      const [topic] = await pubsub.topic(topicName).get({ autoCreate: true });
      const [subscription] = await topic.createSubscription(
        subscriptionName,
        { expirationPolicy: { ttl: { seconds: SUBSCRIPTION_TTL_SECONDS } } },
      );
      subscription.on("error", (err) =>
        console.error("Event subscription error", err),
      );
      subscription.on("message", (message) => {
        message.ack();
        const { taskId, sessionId, eventId } = message.attributes;
        if (!taskId || !sessionId || !eventId) return;
        for (const listener of listeners.get(key(taskId, sessionId)) ?? [])
          listener(eventId, message.data.toString());
      });
    })().catch((err) => {
      started = undefined;
      throw err;
    }));

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
