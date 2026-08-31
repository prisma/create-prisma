import { isBuiltin } from "node:module";
import { defineConfig } from "tsdown";

const optionalNestDependencies = [
  /^@nestjs\/microservices(?:\/|$)/,
  /^@nestjs\/platform-socket\.io(?:\/|$)/,
  /^@nestjs\/websockets(?:\/|$)/,
  /^class-transformer(?:\/|$)/,
  /^class-validator(?:\/|$)/,
];

export default defineConfig({
  entry: { server: "src/main.ts" },
  platform: "node",
  target: "node22.18",
  format: "esm",
  clean: true,
  hash: false,
  banner:
    "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  deps: {
    alwaysBundle: (id) =>
      !isBuiltin(id) && !optionalNestDependencies.some((pattern) => pattern.test(id)),
    neverBundle: optionalNestDependencies,
  },
});
