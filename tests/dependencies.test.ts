import { describe, expect, test } from "bun:test";

import {
  dependencyVersionMap,
  getDependencyVersion,
  getMissingYarnPeerDependencies,
} from "../src/constants/dependencies";

describe("Prisma 8 dependency versions", () => {
  test("uses the selected Prisma 8 and Composer releases", () => {
    expect(getDependencyVersion("@prisma/orm-postgres")).toBe("8.0.0-rc.25");
    expect(getDependencyVersion("@prisma/orm-mongo")).toBe("8.0.0-rc.25");
    expect(getDependencyVersion("@prisma/composer")).toBe("0.40.0");
    expect(getDependencyVersion("@prisma/composer-prisma-cloud")).toBe("0.40.0");
    expect(getDependencyVersion("prisma")).toBe("8.0.0-rc.35");
    expect(getDependencyVersion("alchemy")).toBe("2.0.0-beta.87");
    expect(getDependencyVersion("effect")).toBe("4.1.4");
    expect(getDependencyVersion("turbo")).toBe("2.11.10");
    expect(getDependencyVersion("typescript")).toBe("^6.0.3");
  });

  test("pins the Prisma CLI to an exact version, not a tag or a range", () => {
    expect(dependencyVersionMap.prisma).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  test("returns undefined for dependencies missing from the version map", () => {
    expect(getDependencyVersion("not-a-package")).toBeUndefined();
    expect(dependencyVersionMap.tsdown).toMatch(/^\^/);
  });
});

describe("getMissingYarnPeerDependencies", () => {
  test("adds peers in the section of the package that needs them, and @types/* as dev dependencies", () => {
    expect(
      getMissingYarnPeerDependencies({ dependencies: { "@prisma/orm-postgres": "x" } }),
    ).toEqual({ dependencies: ["pg", "temporal-polyfill"], devDependencies: ["@types/pg"] });
  });

  test("adds the peers of peers", () => {
    expect(getMissingYarnPeerDependencies({ devDependencies: { prisma: "x" } })).toEqual({
      dependencies: [],
      devDependencies: ["@prisma/cli-engine", "@prisma/management-api-sdk"],
    });
    expect(
      getMissingYarnPeerDependencies({ dependencies: { "@prisma/composer-prisma-cloud": "x" } }),
    ).toEqual({
      dependencies: ["@prisma/orm-postgres", "pg", "temporal-polyfill"],
      devDependencies: ["@types/pg"],
    });
  });

  test("keeps a peer already declared in the other section where it is", () => {
    expect(
      getMissingYarnPeerDependencies({
        dependencies: { "@prisma/orm-postgres": "x" },
        devDependencies: { pg: "x", "temporal-polyfill": "x" },
      }),
    ).toEqual({ dependencies: [], devDependencies: ["@types/pg"] });
  });

  test("adds nothing when every peer is declared or no listed package has peers", () => {
    expect(
      getMissingYarnPeerDependencies({
        dependencies: { alchemy: "x", effect: "x", react: "x" },
        devDependencies: { typescript: "x" },
      }),
    ).toEqual({ dependencies: [], devDependencies: [] });
    expect(getMissingYarnPeerDependencies({})).toEqual({ dependencies: [], devDependencies: [] });
  });
});
