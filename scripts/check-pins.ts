import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dependencyVersionMap, yarnPeerDependencies } from "../src/constants/dependencies";
import { findPinProblem, findYarnPeerProblem, type PeerMetadata } from "./pin-problems";

const execFileAsync = promisify(execFile);

async function npmViewJson<T = Record<string, string>>(
  packageSpec: string,
  field: string,
): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["view", packageSpec, field, "--json"]);
  return (stdout.trim() ? JSON.parse(stdout) : {}) as T;
}

const composerCloudSpec = `@prisma/composer-prisma-cloud@${dependencyVersionMap["@prisma/composer-prisma-cloud"]}`;
const [
  cliDependencies,
  composerDependencies,
  composerCloudDependencies,
  composerCloudPeerDependencies,
] = await Promise.all([
  npmViewJson(`prisma@${dependencyVersionMap.prisma}`, "dependencies"),
  npmViewJson(`@prisma/composer@${dependencyVersionMap["@prisma/composer"]}`, "dependencies"),
  npmViewJson(composerCloudSpec, "dependencies"),
  npmViewJson(composerCloudSpec, "peerDependencies"),
]);

function fail(problem: string): never {
  console.error(problem);
  process.exit(1);
}

const pinProblem = findPinProblem(dependencyVersionMap, {
  cliDependencies,
  composerDependencies,
  composerCloudDependencies,
  composerCloudPeerDependencies,
});
if (pinProblem) fail(pinProblem);

async function newestVersion(name: string, pin: string): Promise<string | undefined> {
  const published = await npmViewJson<string | string[] | Record<string, never>>(
    `${name}@${pin}`,
    "version",
  );
  const versions =
    typeof published === "string" ? [published] : Array.isArray(published) ? published : [];
  return versions.sort(Bun.semver.order).at(-1);
}

async function peerMetadata(packageSpecs: string[]): Promise<PeerMetadata> {
  const fetched = await Promise.all(
    packageSpecs.map((packageSpec) =>
      Promise.all([
        npmViewJson(packageSpec, "peerDependencies"),
        npmViewJson<PeerMetadata["peerDependenciesMeta"]>(packageSpec, "peerDependenciesMeta"),
      ]),
    ),
  );
  return {
    packageSpec: packageSpecs.join(" and "),
    peerDependencies: Object.assign({}, ...fetched.map(([peers]) => peers)),
    peerDependenciesMeta: Object.assign({}, ...fetched.map(([, meta]) => meta)),
  };
}

type PeerOwner = keyof typeof yarnPeerDependencies;
const owners = Object.keys(yarnPeerDependencies) as PeerOwner[];

async function peerSpecs(owner: PeerOwner): Promise<string[]> {
  if (owner === "prisma") {
    return [
      `prisma@${dependencyVersionMap.prisma}`,
      `@prisma/orm-toolchain@${cliDependencies["@prisma/orm-toolchain"]}`,
    ];
  }
  const version = await newestVersion(owner, dependencyVersionMap[owner]);
  if (!version)
    fail(`No published version of ${owner} matches its pin ${dependencyVersionMap[owner]}.`);
  return [`${owner}@${version}`];
}

const peerRegistry: Record<string, PeerMetadata> = Object.fromEntries(
  await Promise.all(
    owners.map(async (owner) => [owner, await peerMetadata(await peerSpecs(owner))] as const),
  ),
);

const peerNames = [...new Set(owners.flatMap((owner) => yarnPeerDependencies[owner]))];
const newestPeerVersions = Object.fromEntries(
  await Promise.all(
    peerNames.map(
      async (name) => [name, await newestVersion(name, dependencyVersionMap[name])] as const,
    ),
  ),
);

const peerProblem = findYarnPeerProblem(
  yarnPeerDependencies,
  dependencyVersionMap,
  newestPeerVersions,
  peerRegistry,
);
if (peerProblem) fail(peerProblem);

console.log(
  `prisma@${dependencyVersionMap.prisma} matches Composer ${dependencyVersionMap["@prisma/composer"]}, ` +
    `CLI engine ${dependencyVersionMap["@prisma/cli-engine"]} and management API SDK ` +
    `${dependencyVersionMap["@prisma/management-api-sdk"]}, and both use ORM ` +
    `${dependencyVersionMap["@prisma/orm-postgres"]}, alchemy ${dependencyVersionMap.alchemy} ` +
    `and effect ${dependencyVersionMap.effect}.\nYarn apps declare the required peers of ` +
    `${Object.values(peerRegistry)
      .map((metadata) => metadata.packageSpec)
      .join(", ")}, at pins whose lowest and newest versions satisfy the peer ranges. ` +
    `Peers of the other packages an app lists are not checked.`,
);
