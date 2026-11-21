import type { Message, PubSub, Subscription } from "@google-cloud/pubsub";

const SUBSCRIPTION_TTL_SECONDS = 24 * 60 * 60;

const drop = async (subscription: Subscription) => {
  try {
    await subscription.delete();
  } catch (err) {
    console.error("Subscription delete failed", err);
  }
};

// Returns a start function that, on first call, creates the topic and one
// ephemeral subscription and delivers each (already acked) message to
// onMessage. A failed start is retried by the next call. A subscription that reports an error
// (it expired, or was deleted) is dropped, and the next call creates a new one. `stop` deletes
// the current subscription, for a graceful shutdown.
export const createTopicSubscriber = (
  pubsub: Pick<PubSub, "topic">,
  topicName: string,
  subscriptionName: string,
  onMessage: (message: Message) => void,
) => {
  let started: Promise<void> | undefined;
  let active: Subscription | undefined;
  let attempt = 0;

  const open = async (isCurrent: () => boolean) => {
    const [topic] = await pubsub.topic(topicName).get({ autoCreate: true });
    const name = attempt ? `${subscriptionName}-${attempt}` : subscriptionName;
    attempt++;
    const [subscription] = await topic.createSubscription(name, {
      expirationPolicy: { ttl: { seconds: SUBSCRIPTION_TTL_SECONDS } },
    });
    active = subscription;
    subscription.on("error", (err) => {
      console.error("Event subscription error", err);
      // Only the subscription in use is dropped; a late error from an older one is ignored.
      if (!isCurrent()) return;
      started = undefined;
      active = undefined;
      void drop(subscription);
    });
    subscription.on("message", (message) => {
      message.ack();
      onMessage(message);
    });
  };

  const start = () => {
    if (!started) {
      const current: Promise<void> = open(() => started === current).catch((err) => {
        started = undefined;
        throw err;
      });
      started = current;
    }
    return started;
  };

  const stop = async () => {
    const subscription = active;
    active = undefined;
    started = undefined;
    await subscription?.delete();
  };

  return Object.assign(start, { stop });
};
