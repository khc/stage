import { TypeCompiler } from "@sinclair/typebox/compiler";
import { t } from "elysia";

// The settings every HTTP app has. Local runs listen on loopback only; a container sets
// HOST=0.0.0.0 explicitly.
export const serverConfig = {
  PORT: t.Numeric({ minimum: 1, maximum: 65535, multipleOf: 1 }),
  HOST: t.String({ minLength: 1 }),
};

export const serverDefaults = (port: number) => ({ PORT: String(port), HOST: "127.0.0.1" });

type Env = Record<string, string | undefined>;

// A loader for an app's environment: `fields` is its TypeBox schema (spread `serverConfig` in),
// `defaults` the string values used for what is missing. TypeBox does not apply schema defaults on
// decode, so they are merged in first; a variable that is undefined counts as missing. Throws when
// a value does not match.
export const createConfigLoader = <const Fields extends Parameters<typeof t.Object>[0]>(
  fields: Fields,
  defaults: Record<string, string>,
) => {
  const schema = TypeCompiler.Compile(t.Object(fields));
  return (env: Env) =>
    schema.Decode({
      ...defaults,
      ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    });
};
