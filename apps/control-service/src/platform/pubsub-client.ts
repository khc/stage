import { PubSub } from "@google-cloud/pubsub";

// The project comes from the service's own config, so GOOGLE_CLOUD_PROJECT need not be set.
// The client reads PUBSUB_EMULATOR_HOST itself: Floci locally, real GCP otherwise.
export const createPubSubClient = (projectId: string) => new PubSub({ projectId });
