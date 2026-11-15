import { t } from "elysia";
import { TypeCompiler } from "elysia/type-system";

const Env = TypeCompiler.Compile(
  t.Object({ PORT: t.Numeric({ minimum: 1, maximum: 65535, multipleOf: 1 }) }),
);

// TypeBox does not apply schema defaults on decode, so they are merged in first.
const defaults = { PORT: "3001" };

export const loadConfig = (env: Record<string, string | undefined>) =>
  Env.Decode({
    ...defaults,
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
  });
