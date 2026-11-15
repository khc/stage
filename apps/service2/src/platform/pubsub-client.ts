import { PubSub } from "@google-cloud/pubsub";

// The client reads PUBSUB_EMULATOR_HOST and GOOGLE_CLOUD_PROJECT itself: Floci locally, real GCP otherwise.
export const createPubSubClient = () => new PubSub();
