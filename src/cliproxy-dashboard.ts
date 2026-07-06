import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export * from "./server/accounts.js";
export * from "./server/api.js";
export * from "./server/cli.js";
export * from "./server/commands.js";
export * from "./server/config.js";
export * from "./server/constants.js";
export * from "./server/dashboard-state.js";
export * from "./server/files.js";
export * from "./server/logs.js";
export * from "./server/paths.js";
export * from "./server/proxy-models.js";
export * from "./server/quota-log-updates.js";
export * from "./server/quota-store.js";
export * from "./server/server.js";
export * from "./server/static.js";
export * from "./server/types.js";
export * from "./server/util.js";

import { main } from "./server/cli.js";

const isDirectExecution = (() => {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(message + "\n");
    process.exit(1);
  });
}
