import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findPinProblem,
  findYarnPeerProblem,
  isNoMatchingVersion,
  newestPublishedVersion,
  npmViewProblem,
  readNpmViewFailure,
  type PeerMetadata,
  type Pins,
  type RegistryMetadata,
} from "../scripts/pin-problems";
import { dependencyVersionMap } from "../src/constants/dependencies";

const pins: Pins = {
  prisma: "8.0.0-rc.35",
  "@prisma/cli-engine": "0.10.4",
  "@prisma/management-api-sdk": "1.101.0",
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
      "@prisma/management-api-sdk": "1.101.0",
      "@prisma/orm-toolchain": "8.0.0-rc.25",
      ...overrides.cli,
    },
    composerDependencies: {
      alchemy: "2.0.0-beta.87",
      effect: "4.1.4",
      ...overrides.composer,
    },
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

  test("rejects a prisma CLI on another management API SDK", () => {
    expect(
      findPinProblem(pins, registry({ cli: { "@prisma/management-api-sdk": "1.102.0" } })),
    ).toContain(
      "depends on @prisma/management-api-sdk@1.102.0, but Yarn scaffolds pin it to 1.101.0.\nPin @prisma/management-api-sdk to 1.102.0.",
    );
  });

  test("rejects a prisma CLI that does not list the management API SDK", () => {
    expect(
      findPinProblem(pins, registry({ cli: { "@prisma/management-api-sdk": undefined } })),
    ).toContain("does not depend on @prisma/management-api-sdk");
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
  const newest = { pg: "8.23.1", "@types/pg": "8.23.1", "temporal-polyfill": "1.0.8" };
  const yarnPeers = { "@prisma/orm-postgres": ["@types/pg", "pg", "temporal-polyfill"] };
  function peerRegistry(
    peerDependencies: PeerMetadata["peerDependencies"],
    peerDependenciesMeta: PeerMetadata["peerDependenciesMeta"] = {},
  ): Record<string, PeerMetadata[]> {
    return {
      "@prisma/orm-postgres": [
        { packageSpec: "@prisma/orm-postgres@8.0.0-rc.25", peerDependencies, peerDependenciesMeta },
      ],
    };
  }
  const currentPeers = { pg: "^8.22.0", "@types/pg": "^8.20.0", "temporal-polyfill": "^1.0.8" };

  test("accepts listed peers whose pins satisfy the peer ranges", () => {
    expect(
      findYarnPeerProblem(yarnPeers, versions, newest, peerRegistry(currentPeers)),
    ).toBeUndefined();
  });

  test("ignores optional peers", () => {
    expect(
      findYarnPeerProblem(
        yarnPeers,
        versions,
        newest,
        peerRegistry({ ...currentPeers, typescript: ">=5.9" }, { typescript: { optional: true } }),
      ),
    ).toBeUndefined();
  });

  test("rejects a required peer that Yarn apps do not declare", () => {
    expect(
      findYarnPeerProblem(
        yarnPeers,
        versions,
        newest,
        peerRegistry({ ...currentPeers, mongodb: "^7.0.0" }),
      ),
    ).toContain("requires the peer dependency mongodb@^7.0.0, which Yarn apps do not declare");
  });

  test("rejects a pin whose lowest version is outside the peer range", () => {
    expect(
      findYarnPeerProblem(
        yarnPeers,
        versions,
        newest,
        peerRegistry({ ...currentPeers, pg: "^9.0.0" }),
      ),
    ).toContain("requires pg@^9.0.0, but scaffolds pin pg to ^8.22.0");
  });

  test("rejects a pin whose newest version is outside a narrower peer range", () => {
    expect(
      findYarnPeerProblem(
        yarnPeers,
        versions,
        newest,
        peerRegistry({ ...currentPeers, pg: "~8.22.0" }),
      ),
    ).toContain("requires pg@~8.22.0, but the pin ^8.22.0 lets a fresh install resolve pg@8.23.1");
  });

  test("rejects a pin with no published version", () => {
    const { pg: _, ...withoutPg } = newest;
    expect(findYarnPeerProblem(yarnPeers, versions, withoutPg, peerRegistry(currentPeers))).toBe(
      "No published version of pg matches its pin ^8.22.0.\n" +
        "Change the pg pin in src/constants/dependencies.ts to a published version.",
    );
  });

  test("rejects a pin that is not a version or a caret or tilde range", () => {
    expect(
      findYarnPeerProblem(
        yarnPeers,
        { ...versions, pg: "latest" },
        newest,
        peerRegistry(currentPeers),
      ),
    ).toContain('pg is pinned to "latest", so check:pins cannot tell');
  });

  test("rejects a listed package whose peers were not fetched", () => {
    expect(findYarnPeerProblem(yarnPeers, versions, newest, {})).toBe(
      "No npm metadata was fetched for the peers listed under @prisma/orm-postgres.",
    );
  });

  test("rejects a peer one package requires, though another marks it optional", () => {
    const registry = {
      prisma: [
        {
          packageSpec: "prisma@8.0.0-rc.35",
          peerDependencies: { typescript: ">=5.0" },
          peerDependenciesMeta: { typescript: { optional: true } },
        },
        {
          packageSpec: "@prisma/orm-toolchain@8.0.0-rc.25",
          peerDependencies: { typescript: "^6.0.0" },
          peerDependenciesMeta: {},
        },
      ],
    };
    expect(findYarnPeerProblem({ prisma: [] }, versions, newest, registry)).toContain(
      "@prisma/orm-toolchain@8.0.0-rc.25 requires the peer dependency typescript@^6.0.0",
    );
  });

  test("checks each package's range for a peer they both require", () => {
    const registry = {
      prisma: [
        {
          packageSpec: "prisma@8.0.0-rc.35",
          peerDependencies: { pg: "~8.22.0" },
          peerDependenciesMeta: {},
        },
        {
          packageSpec: "@prisma/orm-toolchain@8.0.0-rc.25",
          peerDependencies: { pg: "^8.0.0" },
          peerDependenciesMeta: {},
        },
      ],
    };
    expect(findYarnPeerProblem({ prisma: ["pg"] }, versions, newest, registry)).toContain(
      "prisma@8.0.0-rc.35 requires pg@~8.22.0, but the pin ^8.22.0 lets a fresh install resolve pg@8.23.1",
    );
  });

  test("rejects a listed peer the package no longer requires", () => {
    const { "temporal-polyfill": _, ...withoutTemporal } = currentPeers;
    expect(
      findYarnPeerProblem(yarnPeers, versions, newest, peerRegistry(withoutTemporal)),
    ).toContain("lists temporal-polyfill under @prisma/orm-postgres");
  });
});

describe("newestPublishedVersion", () => {
  test("picks the newest version by semver, not by position or string order", () => {
    expect(newestPublishedVersion(JSON.stringify(["8.23.1", "8.9.0", "8.22.0"]))).toBe("8.23.1");
    expect(
      newestPublishedVersion(JSON.stringify(["8.0.0-rc.9", "8.0.0-rc.25", "8.0.0-rc.3"])),
    ).toBe("8.0.0-rc.25");
    expect(newestPublishedVersion(JSON.stringify(["8.0.0-rc.9", "8.0.0", "8.0.0-rc.25"]))).toBe(
      "8.0.0",
    );
  });

  test("reads the single version npm prints for an exact pin", () => {
    expect(newestPublishedVersion('"8.22.0"\n')).toBe("8.22.0");
  });

  test("returns nothing when npm prints nothing", () => {
    expect(newestPublishedVersion("")).toBeUndefined();
  });
});

describe("npm view failures", () => {
  const noMatch = JSON.stringify({
    error: { code: "E404", summary: "No match found for version ^99.0.0", detail: "…" },
  });

  test("treats E404 as no published version matching the pin", () => {
    expect(isNoMatchingVersion(readNpmViewFailure(noMatch, "npm error code E404"))).toBe(true);
  });

  test("names the spec, npm's summary and what to change for other failures", () => {
    const failure = readNpmViewFailure(
      JSON.stringify({ error: { code: "ENOTFOUND", summary: "request to registry failed" } }),
      "",
    );
    expect(isNoMatchingVersion(failure)).toBe(false);
    expect(npmViewProblem("prisma@8.0.0-rc.35", "dependencies", failure)).toBe(
      "npm view prisma@8.0.0-rc.35 dependencies failed: request to registry failed\n" +
        "Check that this version is published and that npm can reach the registry, " +
        "then fix the pin in src/constants/dependencies.ts if needed.",
    );
  });

  test("falls back to npm's first stderr line when stdout is not JSON", () => {
    expect(readNpmViewFailure("", "\nnpm error code EAI_AGAIN\nnpm error more\n")).toEqual({
      summary: "npm error code EAI_AGAIN",
    });
  });
});

const ormVersion = dependencyVersionMap["@prisma/orm-postgres"];
const npmPeersToday: Record<string, Record<string, string>> = {
  "@prisma/cli-engine": { "@prisma/management-api-sdk": "^1.55.0" },
  "@prisma/composer-prisma-cloud": {
    pg: "^8.22.0",
    "@types/pg": "^8.20.0",
    "@prisma/orm-postgres": ormVersion,
  },
  "@prisma/orm-mongo": { mongodb: "^7.0.0", "temporal-polyfill": "^1.0.8" },
  "@prisma/orm-postgres": { pg: "^8.22.0", "@types/pg": "^8.20.0", "temporal-polyfill": "^1.0.8" },
  "@prisma/orm-toolchain": { "@prisma/cli-engine": "0.10.4" },
  alchemy: { effect: "^4.1.4" },
};

async function runCheckPins(
  options: {
    toolchainVersion?: string;
    extraPeers?: Record<string, Record<string, string>>;
    publishedVersions?: Record<string, string[]>;
  } = {},
) {
  const toolchainVersion = options.toolchainVersion ?? ormVersion;
  const binDir = await mkdtemp(path.join(tmpdir(), "create-prisma-pins-"));
  const pin = (name: string) => dependencyVersionMap[name as keyof typeof dependencyVersionMap];
  const peerResponses = Object.fromEntries(
    Object.entries({ ...npmPeersToday, ...options.extraPeers }).map(([name, peers]) => [
      `${name}@${name === "@prisma/orm-toolchain" ? toolchainVersion : pin(name)} peerDependencies`,
      { ...npmPeersToday[name], ...peers },
    ]),
  );
  const metadata = {
    [`prisma@${dependencyVersionMap.prisma} dependencies`]: {
      "@prisma/cli-engine": dependencyVersionMap["@prisma/cli-engine"],
      "@prisma/composer-cli": dependencyVersionMap["@prisma/composer"],
      "@prisma/management-api-sdk": dependencyVersionMap["@prisma/management-api-sdk"],
      "@prisma/orm-toolchain": toolchainVersion,
    },
    [`@prisma/composer@${dependencyVersionMap["@prisma/composer"]} dependencies`]: {
      alchemy: dependencyVersionMap.alchemy,
      effect: dependencyVersionMap.effect,
    },
    [`@prisma/composer-prisma-cloud@${dependencyVersionMap["@prisma/composer-prisma-cloud"]} peerDependencies`]:
      npmPeersToday["@prisma/composer-prisma-cloud"],
    ...peerResponses,
  };
  const npmStub = path.join(binDir, "npm");
  await writeFile(
    npmStub,
    [
      "#!/usr/bin/env node",
      "const [spec, field] = process.argv.slice(3, 5);",
      "if (field === 'version') {",
      `  const published = ${JSON.stringify(options.publishedVersions ?? {})}[spec];`,
      "  if (published && published.length === 0) {",
      "    process.stdout.write(JSON.stringify({ error: { code: 'E404', summary: 'No match found for version ' + spec } }));",
      "    process.stderr.write('npm error code E404\\n');",
      "    process.exit(1);",
      "  }",
      "  if (published) {",
      "    process.stdout.write(JSON.stringify(published));",
      "    process.exit(0);",
      "  }",
      "  const range = spec.slice(spec.lastIndexOf('@') + 1);",
      "  const version = range.replace(/^[\\^~]/, '');",
      "  process.stdout.write(JSON.stringify(range === version ? version : [version]));",
      "  process.exit(0);",
      "}",
      `const value = ${JSON.stringify(metadata)}[spec + " " + field];`,
      "if (value) process.stdout.write(JSON.stringify(value));",
      "",
    ].join("\n"),
  );
  await chmod(npmStub, 0o755);
  try {
    const result = Bun.spawnSync(["bun", "scripts/check-pins.ts"], {
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

describe("check:pins", () => {
  test("exits 0 when the registry matches the pins", async () => {
    const { exitCode, stdout } = await runCheckPins();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Peers of the other packages an app lists are not checked.");
  });

  test("exits non-zero when prisma bundles another ORM toolchain", async () => {
    const { exitCode, stderr } = await runCheckPins({ toolchainVersion: "8.0.0-rc.0" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("bundles @prisma/orm-toolchain@8.0.0-rc.0");
  });

  test("exits non-zero when a listed package gains a required peer", async () => {
    const { exitCode, stderr } = await runCheckPins({ extraPeers: { alchemy: { ws: "^8.21.0" } } });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `alchemy@${dependencyVersionMap.alchemy} requires the peer dependency ws@^8.21.0, which Yarn apps do not declare.`,
    );
  });

  test("checks the newest version npm lists for a range pin", async () => {
    const pgSpec = `pg@${dependencyVersionMap.pg}`;
    const { exitCode, stderr } = await runCheckPins({
      extraPeers: { "@prisma/orm-postgres": { pg: "~8.23.0" } },
      publishedVersions: { [pgSpec]: ["8.24.0", "8.9.0", "8.24.1", "8.24.1-beta.2", "8.23.1"] },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `requires pg@~8.23.0, but the pin ${dependencyVersionMap.pg} lets a fresh install resolve pg@8.24.1.`,
    );
  });

  test("names the package and pin when no published version matches", async () => {
    const { exitCode, stderr } = await runCheckPins({
      publishedVersions: { [`pg@${dependencyVersionMap.pg}`]: [] },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `No published version of pg matches its pin ${dependencyVersionMap.pg}.\n` +
        "Change the pg pin in src/constants/dependencies.ts to a published version.\n",
    );
  });

  test("exits non-zero when prisma itself gains a required peer", async () => {
    const { exitCode, stderr } = await runCheckPins({ extraPeers: { prisma: { vite: "^8.0.0" } } });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires the peer dependency vite@^8.0.0");
  });
});
