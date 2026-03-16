import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const telemetryApiKey = process.env.CREATE_PRISMA_TELEMETRY_API_KEY ?? "";
const telemetryHost = process.env.CREATE_PRISMA_TELEMETRY_HOST || "https://us.i.posthog.com";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  inlineOnly: false,
  clean: true,
  shims: true,
  dts: true,
  outDir: "dist",
  env: {
    CREATE_PRISMA_CLI_VERSION: packageJson.version,
    CREATE_PRISMA_TELEMETRY_API_KEY: telemetryApiKey,
    CREATE_PRISMA_TELEMETRY_HOST: telemetryHost,
  },
  outputOptions: {
    banner: "#!/usr/bin/env node",
  },
});
