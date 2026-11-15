import { createConfigLoader, serverConfig, serverDefaults } from "@stage/http/config";

export const loadConfig = createConfigLoader(serverConfig, serverDefaults(8080));
