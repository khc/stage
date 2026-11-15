import { Firestore } from "@google-cloud/firestore";

// The client reads GOOGLE_CLOUD_PROJECT and FIRESTORE_EMULATOR_HOST itself: Floci locally, real GCP otherwise.
export const createFirestoreClient = () => new Firestore();
