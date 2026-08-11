import { getNodeVersionCompatibilityError } from "./utils/node-version";

const nodeVersionError = getNodeVersionCompatibilityError(process.versions.node);
if (nodeVersionError) {
  process.stderr.write(`${nodeVersionError}\n`);
  process.exit(1);
}

const { createCreatePrismaCli } = await import("./index");

await createCreatePrismaCli().run({
  formatError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}
