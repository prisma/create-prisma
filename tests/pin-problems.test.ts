import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findPinProblem, type Pins, type RegistryMetadata } from "../scripts/pin-problems";
import { dependencyVersionMap } from "../src/constants/dependencies";

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

async function runCheckPins(toolchainVersion: string) {
  const binDir = await mkdtemp(path.join(tmpdir(), "create-prisma-pins-"));
  const metadata = {
    [`prisma@${dependencyVersionMap.prisma}`]: {
      "@prisma/composer-cli": dependencyVersionMap["@prisma/composer"],
      "@prisma/orm-toolchain": toolchainVersion,
    },
    [`@prisma/composer@${dependencyVersionMap["@prisma/composer"]}`]: {
      alchemy: dependencyVersionMap.alchemy,
      effect: dependencyVersionMap.effect,
    },
    [`@prisma/composer-prisma-cloud@${dependencyVersionMap["@prisma/composer-prisma-cloud"]}`]: {
      "@prisma/orm-postgres": dependencyVersionMap["@prisma/orm-postgres"],
    },
  };
  const npmStub = path.join(binDir, "npm");
  await writeFile(
    npmStub,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${JSON.stringify(metadata)}[process.argv[3]]));\n`,
  );
  await chmod(npmStub, 0o755);
  try {
    const result = Bun.spawnSync(["bun", "scripts/check-pins.ts"], {
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString() };
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

describe("check:pins", () => {
  test("exits 0 when the registry matches the pins", async () => {
    expect((await runCheckPins(dependencyVersionMap["@prisma/orm-postgres"])).exitCode).toBe(0);
  });

  test("exits non-zero when prisma bundles another ORM toolchain", async () => {
    const { exitCode, stderr } = await runCheckPins("8.0.0-rc.0");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("bundles @prisma/orm-toolchain@8.0.0-rc.0");
  });
});
