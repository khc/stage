import { t } from "elysia";
import { TypeCompiler } from "elysia/type-system";

const Env = TypeCompiler.Compile(
  t.Object({
    PORT: t.Numeric({ minimum: 1, maximum: 65535, multipleOf: 1 }),
    // Local runs listen on loopback only; the container sets HOST=0.0.0.0 explicitly.
    HOST: t.String({ minLength: 1 }),
    // The Cloud Run project and region that hold the agent jobs.
    GCP_PROJECT: t.String({ minLength: 1 }),
    GCP_REGION: t.String({ minLength: 1 }),
    // Base URL of apps/extract. Without it the document routes answer 501.
    EXTRACT_URL: t.Optional(t.String({ minLength: 1 })),
  }),
);

// TypeBox does not apply schema defaults on decode, so they are merged in first.
const defaults = { PORT: "3001", HOST: "127.0.0.1" };

export const loadConfig = (env: Record<string, string | undefined>) =>
  Env.Decode({
    ...defaults,
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
  });
