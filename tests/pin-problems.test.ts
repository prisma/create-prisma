import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findPinProblem,
  findYarnPeerProblem,
  type PeerMetadata,
  type Pins,
  type RegistryMetadata,
} from "../scripts/pin-problems";
import { dependencyVersionMap, yarnPeerDependencies } from "../src/constants/dependencies";

const pins: Pins = {
  prisma: "8.0.0-rc.35",
  "@prisma/cli-engine": "0.10.4",
  "@prisma/composer": "0.40.0",
  "@prisma/composer-prisma-cloud": "0.40.0",
  "@prisma/orm-postgres": "8.0.0-rc.25",
  "@prisma/orm-mongo": "8.0.0-rc.25",
  alchemy: "2.0.0-beta.87",
  effect: "4.1.4",
};

function registry(overrides: {
  cli?: RegistryMetadata["cliDependencies"];
  composer?: RegistryMetadata["composerDependencies"];
  cloudPeers?: RegistryMetadata["composerCloudPeerDependencies"];
}): RegistryMetadata {
  return {
    cliDependencies: {
      "@prisma/cli-engine": "0.10.4",
      "@prisma/composer-cli": "0.40.0",
      "@prisma/orm-toolchain": "8.0.0-rc.25",
      ...overrides.cli,
    },
    composerDependencies: { alchemy: "2.0.0-beta.87", effect: "4.1.4", ...overrides.composer },
    composerCloudPeerDependencies: {
      "@prisma/orm-postgres": "8.0.0-rc.25",
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

  test("rejects a prisma CLI on another CLI engine", () => {
    expect(findPinProblem(pins, registry({ cli: { "@prisma/cli-engine": "0.10.3" } }))).toContain(
      "@prisma/cli-engine@0.10.3",
    );
  });

  test("rejects a prisma CLI that does not list the CLI engine", () => {
    expect(findPinProblem(pins, registry({ cli: { "@prisma/cli-engine": undefined } }))).toContain(
      "does not depend on @prisma/cli-engine",
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

describe("findYarnPeerProblem", () => {
  const versions = { pg: "^8.22.0", "@types/pg": "^8.20.0", "temporal-polyfill": "^1.0.8" };
  const yarnPeers = { "@prisma/orm-postgres": ["@types/pg", "pg", "temporal-polyfill"] };
  function peerRegistry(
    peerDependencies: PeerMetadata["peerDependencies"],
    peerDependenciesMeta: PeerMetadata["peerDependenciesMeta"] = {},
  ): Record<string, PeerMetadata> {
    return {
      "@prisma/orm-postgres": {
        packageSpec: "@prisma/orm-postgres@8.0.0-rc.25",
        peerDependencies,
        peerDependenciesMeta,
      },
    };
  }
  const currentPeers = { pg: "^8.22.0", "@types/pg": "^8.20.0", "temporal-polyfill": "^1.0.8" };

  test("accepts listed peers whose pins satisfy the peer ranges", () => {
    expect(findYarnPeerProblem(yarnPeers, versions, peerRegistry(currentPeers))).toBeUndefined();
  });

  test("ignores optional peers", () => {
    expect(
      findYarnPeerProblem(
        yarnPeers,
        versions,
        peerRegistry({ ...currentPeers, typescript: ">=5.9" }, { typescript: { optional: true } }),
      ),
    ).toBeUndefined();
  });

  test("rejects a required peer that Yarn apps do not declare", () => {
    expect(
      findYarnPeerProblem(
        yarnPeers,
        versions,
        peerRegistry({ ...currentPeers, mongodb: "^7.0.0" }),
      ),
    ).toContain("requires the peer dependency mongodb@^7.0.0, which Yarn apps do not declare");
  });

  test("rejects a pin outside the peer range", () => {
    expect(
      findYarnPeerProblem(yarnPeers, versions, peerRegistry({ ...currentPeers, pg: "^9.0.0" })),
    ).toContain("requires pg@^9.0.0, but scaffolds pin pg to ^8.22.0");
  });

  test("rejects a listed peer the package no longer requires", () => {
    const { "temporal-polyfill": _, ...withoutTemporal } = currentPeers;
    expect(findYarnPeerProblem(yarnPeers, versions, peerRegistry(withoutTemporal))).toContain(
      "lists temporal-polyfill under @prisma/orm-postgres",
    );
  });
});

async function runCheckPins(toolchainVersion: string) {
  const binDir = await mkdtemp(path.join(tmpdir(), "create-prisma-pins-"));
  const peerSpecs: Record<string, string> = {
    ...Object.fromEntries(
      Object.keys(yarnPeerDependencies).map((owner) => [
        owner,
        `${owner}@${dependencyVersionMap[owner as keyof typeof dependencyVersionMap]}`,
      ]),
    ),
    prisma: `@prisma/orm-toolchain@${toolchainVersion}`,
  };
  const metadata = {
    [`prisma@${dependencyVersionMap.prisma} dependencies`]: {
      "@prisma/cli-engine": dependencyVersionMap["@prisma/cli-engine"],
      "@prisma/composer-cli": dependencyVersionMap["@prisma/composer"],
      "@prisma/orm-toolchain": toolchainVersion,
    },
    [`@prisma/composer@${dependencyVersionMap["@prisma/composer"]} dependencies`]: {
      alchemy: dependencyVersionMap.alchemy,
      effect: dependencyVersionMap.effect,
    },
    ...Object.fromEntries(
      Object.entries(yarnPeerDependencies).map(([owner, peers]) => [
        `${peerSpecs[owner]} peerDependencies`,
        Object.fromEntries(
          peers.map((peer) => [
            peer,
            dependencyVersionMap[peer as keyof typeof dependencyVersionMap],
          ]),
        ),
      ]),
    ),
  };
  const npmStub = path.join(binDir, "npm");
  await writeFile(
    npmStub,
    `#!/usr/bin/env node\nconst value = ${JSON.stringify(metadata)}[process.argv[3] + " " + process.argv[4]];\nif (value) process.stdout.write(JSON.stringify(value));\n`,
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
