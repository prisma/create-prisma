import { describe, expect, test } from "bun:test";

import { findPinProblem, type Pins, type RegistryMetadata } from "../scripts/pin-problems";

const pins: Pins = {
  prisma: "8.0.0-rc.33",
  "@prisma/composer": "0.38.0",
  "@prisma/composer-prisma-cloud": "0.38.0",
  "@prisma/orm-postgres": "8.0.0-rc.23",
  "@prisma/orm-mongo": "8.0.0-rc.23",
  alchemy: "2.0.0-beta.84",
  effect: "4.0.5",
};

function registry(overrides: {
  cli?: RegistryMetadata["cliDependencies"];
  composer?: RegistryMetadata["composerDependencies"];
  cloudPeers?: RegistryMetadata["composerCloudPeerDependencies"];
}): RegistryMetadata {
  return {
    cliDependencies: {
      "@prisma/composer-cli": "0.38.0",
      "@prisma/orm-toolchain": "8.0.0-rc.23",
      ...overrides.cli,
    },
    composerDependencies: { alchemy: "2.0.0-beta.84", effect: "4.0.5", ...overrides.composer },
    composerCloudPeerDependencies: {
      "@prisma/orm-postgres": "8.0.0-rc.23",
      ...overrides.cloudPeers,
    },
  };
}

describe("findPinProblem", () => {
  test("accepts pins that match the registry", () => {
    expect(findPinProblem(pins, registry({}))).toBeUndefined();
  });

  test("rejects a prisma CLI that bundles another ORM toolchain", () => {
    expect(
      findPinProblem(pins, registry({ cli: { "@prisma/orm-toolchain": "8.0.0-rc.22" } })),
    ).toContain("bundles @prisma/orm-toolchain@8.0.0-rc.22");
  });

  test("rejects a prisma CLI that does not list the ORM toolchain", () => {
    expect(
      findPinProblem(pins, registry({ cli: { "@prisma/orm-toolchain": undefined } })),
    ).toContain("does not depend on @prisma/orm-toolchain");
  });

  test("rejects a prisma CLI on another Composer release", () => {
    expect(findPinProblem(pins, registry({ cli: { "@prisma/composer-cli": "0.37.0" } }))).toContain(
      "@prisma/composer-cli@0.37.0",
    );
  });

  test("rejects Composer peering another ORM release", () => {
    expect(
      findPinProblem(pins, registry({ cloudPeers: { "@prisma/orm-postgres": "8.0.0-rc.20" } })),
    ).toContain("peers @prisma/orm-postgres@8.0.0-rc.20");
  });

  test("rejects alchemy or effect pins that differ from Composer's", () => {
    expect(findPinProblem(pins, registry({ composer: { effect: "4.0.3" } }))).toContain(
      "effect@4.0.3",
    );
    expect(findPinProblem(pins, registry({ composer: { alchemy: "2.0.0-beta.83" } }))).toContain(
      "alchemy@2.0.0-beta.83",
    );
  });
});
