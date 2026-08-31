import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/server.mjs",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  external: [
    "@nestjs/websockets/*",
    "@nestjs/microservices",
    "@nestjs/microservices/*",
    "@nestjs/platform-socket.io",
    "class-transformer",
    "class-validator",
  ],
});
