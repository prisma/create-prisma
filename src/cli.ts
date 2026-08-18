import { createCreatePrismaCli } from "./index";

createCreatePrismaCli().run({
  process: {
    exit(code): never {
      const commandExitCode =
        typeof process.exitCode === "number" && process.exitCode !== 0 ? process.exitCode : code;
      process.exit(commandExitCode);
    },
  },
});
