import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/cli.ts"],
	outDir: "dist",
	format: ["esm"],
	platform: "node",
	clean: true,
	dts: false
});


