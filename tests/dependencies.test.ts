import { describe, expect, test } from "bun:test";

import { dependencyVersionMap, getDependencyVersion } from "../src/constants/dependencies";

describe("Prisma 8 dependency versions", () => {
  test("uses the selected Prisma 8 and Composer releases", () => {
    expect(getDependencyVersion("@prisma/orm-postgres")).toBe("8.0.0-rc.4");
    expect(getDependencyVersion("@prisma/composer")).toBe("0.12.0");
    expect(getDependencyVersion("@prisma/composer-prisma-cloud")).toBe("0.12.0");
    expect(getDependencyVersion("prisma")).toBe("next");
    expect(getDependencyVersion("alchemy")).toBe("2.0.0-beta.74");
    expect(getDependencyVersion("effect")).toBe("4.0.0-rc.111");
  });

  test("returns undefined for dependencies missing from the version map", () => {
    expect(getDependencyVersion("not-a-package")).toBeUndefined();
    expect(dependencyVersionMap.esbuild).toMatch(/^\^/);
  });
});
