import { createCreatePrismaCli } from "./index";
import { createJsonOutputLogger, isJsonOutputRequested } from "./ui/json-output";

createCreatePrismaCli().run({
  ...(isJsonOutputRequested(process.argv) ? { logger: createJsonOutputLogger() } : {}),
  process: {
    exit(code): never {
      const commandExitCode =
        typeof process.exitCode === "number" && process.exitCode !== 0 ? process.exitCode : code;
      process.exit(commandExitCode);
    },
  },
});
