import { createApp } from "./app";
import { extractFile } from "./extract";

export default {
  port: Number(process.env.PORT ?? 8080),
  fetch: createApp(extractFile).fetch,
};
