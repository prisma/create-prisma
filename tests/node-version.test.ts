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
  test("accepts exactly the versions in the supported range, as semver decides", () => {
    for (const version of [
      "20.19.0",
      "22.17.9",
      "22.18.0",
      "22.22.3",
      "23.0.0",
      "23.11.0",
      "24.0.0",
      "24.10.9",
      "24.11.0",
      "24.15.0",
      "25.9.0",
      "26.0.0",
      "27.1.0",
      "22.18.0-rc.1",
      "24.11.0-rc.1",
      "26.0.0-nightly20261001abcdef",
      "27.0.0-pre",
    ]) {
      expect([version, supportsPrisma(version)]).toEqual([
        version,
        Bun.semver.satisfies(version, SUPPORTED_NODE_RANGE),
      ]);
    }
  });

  test("checks the boundaries of the supported range", () => {
    for (const [version, supported] of [
      ["22.17.9", false],
      ["v22.18.0", true],
      ["23.0.0", false],
      ["24.10.9", false],
      ["24.11.0", true],
      ["24.11.0-rc.1", false],
      ["26.0.0", true],
      ["26.0.0-nightly20261001abcdef", false],
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
