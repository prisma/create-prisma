// @ts-check
import { prismaVitePlugin } from "@prisma-next/vite-plugin-contract-emit";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [prismaVitePlugin()],
  },
});
