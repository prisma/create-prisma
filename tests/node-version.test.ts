import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  getUnsupportedNodeMessage,
  MINIMUM_NODE_VERSION,
  runsOnNode,
  SUPPORTED_NODE_RANGE,
  supportsPrisma,
} from "../src/utils/node-version";
import { npmForMinimumNode } from "../src/utils/package-manager";

const repositoryRoot = path.join(import.meta.dir, "..");

describe("Prisma 8 Node compatibility", () => {
  test("accepts exactly the Node.js versions Prisma ORM supports", () => {
    for (const [version, supported] of [
      ["20.19.0", false],
      ["22.17.9", false],
      ["v22.17.9", false],
      ["22.18.0", true],
      ["v22.18.0", true],
      ["22.22.3", true],
      ["23.0.0", false],
      ["23.11.0", false],
      ["24.0.0", false],
      ["24.10.9", false],
      ["24.11.0", true],
      ["24.15.0", true],
      ["25.9.0", false],
      ["26.0.0", true],
      ["27.1.0", true],
    ] as const) {
      expect([version, supportsPrisma(version)]).toEqual([version, supported]);
    }
  });

  test("applies the Node.js range only when running on Node.js, not Bun or Deno", () => {
    expect(runsOnNode({ node: "22.18.0" })).toBe(true);
    expect(runsOnNode({ node: "24.3.0", bun: "1.3.13" })).toBe(false);
    expect(runsOnNode({ node: "24.2.0", deno: "2.9.4" })).toBe(false);
  });

  test("names the supported range in the refusal message", () => {
    expect(getUnsupportedNodeMessage("24.10.0")).toContain(
      "Required: Node.js 22.18 or newer on the 22 line, 24.11 or newer on the 24 line, or 26 and newer.",
    );
  });

  test("declares the supported range in package.json engines", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    expect(SUPPORTED_NODE_RANGE).toBe("^22.18.0 || ^24.11.0 || >=26.0.0");
    expect(packageJson.engines.node).toBe(SUPPORTED_NODE_RANGE);
  });

  test("pairs the npm fallback for generated projects with the minimum Node.js version", () => {
    expect(npmForMinimumNode.node).toEqual(MINIMUM_NODE_VERSION);
  });
});
