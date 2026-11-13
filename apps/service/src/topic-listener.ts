import type { Message, PubSub } from "@google-cloud/pubsub";

const SUBSCRIPTION_TTL_SECONDS = 24 * 60 * 60;

// Returns a start function that, on first call, creates the topic and one
// ephemeral subscription and delivers each (already acked) message to
// onMessage. A failed start is retried by the next call.
export const createTopicListener = (
  pubsub: Pick<PubSub, "topic">,
  topicName: string,
  subscriptionName: string,
  onMessage: (message: Message) => void,
) => {
  let started: Promise<void> | undefined;
  return () =>
    (started ??= (async () => {
      const [topic] = await pubsub.topic(topicName).get({ autoCreate: true });
      const [subscription] = await topic.createSubscription(subscriptionName, {
        expirationPolicy: { ttl: { seconds: SUBSCRIPTION_TTL_SECONDS } },
      });
      subscription.on("error", (err) => console.error("Event subscription error", err));
      subscription.on("message", (message) => {
        message.ack();
        onMessage(message);
      });
    })().catch((err) => {
      started = undefined;
      throw err;
    }));
};
