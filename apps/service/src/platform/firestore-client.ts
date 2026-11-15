import { Firestore } from "@google-cloud/firestore";

// The project comes from the service's own config, so GOOGLE_CLOUD_PROJECT need not be set.
// The client reads FIRESTORE_EMULATOR_HOST itself: Floci locally, real GCP otherwise.
export const createFirestoreClient = (projectId: string) => new Firestore({ projectId });
