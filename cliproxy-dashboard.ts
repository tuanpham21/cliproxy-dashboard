import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
