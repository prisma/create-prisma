import { prismaVitePlugin } from "@prisma-next/vite-plugin-contract-emit";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [prismaVitePlugin(), sveltekit()],
});
