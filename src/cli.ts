import { createCreatePrismaCli } from "./index";

await createCreatePrismaCli().run({
  formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
