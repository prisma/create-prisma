import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

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
  },
  outputOptions: {
    banner: "#!/usr/bin/env node",
  },
});
