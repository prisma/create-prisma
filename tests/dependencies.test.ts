import { describe, expect, test } from "bun:test";

import { dependencyVersionMap, getDependencyVersion } from "../src/constants/dependencies";

describe("Prisma 8 dependency versions", () => {
  test("uses the selected Prisma 8 and Composer releases", () => {
    expect(getDependencyVersion("@prisma/orm-postgres")).toBe("8.0.0-rc.11");
    expect(getDependencyVersion("@prisma/orm-mongo")).toBe("8.0.0-rc.11");
    expect(getDependencyVersion("@prisma/composer")).toBe("0.20.0");
    expect(getDependencyVersion("@prisma/composer-prisma-cloud")).toBe("0.20.0");
    expect(getDependencyVersion("prisma")).toBe("8.0.0-rc.15");
    expect(getDependencyVersion("alchemy")).toBe("2.0.0-beta.74");
    expect(getDependencyVersion("effect")).toBe("4.0.0-rc.112");
    expect(getDependencyVersion("turbo")).toBe("2.10.12");
  });

  test("pins the Prisma CLI to an exact version, not a tag or a range", () => {
    expect(dependencyVersionMap.prisma).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  test("returns undefined for dependencies missing from the version map", () => {
    expect(getDependencyVersion("not-a-package")).toBeUndefined();
    expect(dependencyVersionMap.tsdown).toMatch(/^\^/);
  });
});
