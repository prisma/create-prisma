import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dependencyVersionMap, yarnPeerDependencies } from "../src/constants/dependencies";
import {
  findPinProblem,
  findYarnPeerProblem,
  isNoMatchingVersion,
  newestPublishedVersion,
  noPublishedVersionProblem,
  npmViewProblem,
  readNpmViewFailure,
  type PeerMetadata,
} from "./pin-problems";

const execFileAsync = promisify(execFile);

function fail(problem: string): never {
  console.error(problem);
  process.exit(1);
}

async function npmView(packageSpec: string, field: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", packageSpec, field, "--json"]);
    return stdout;
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    const failure = readNpmViewFailure(stdout, stderr);
    if (field === "version" && isNoMatchingVersion(failure)) return undefined;
    fail(npmViewProblem(packageSpec, field, failure));
  }
}

async function npmViewJson<T = Record<string, string>>(
  packageSpec: string,
  field: string,
): Promise<T> {
  const stdout = (await npmView(packageSpec, field)) ?? "";
  return (stdout.trim() ? JSON.parse(stdout) : {}) as T;
}

async function newestVersion(name: string, pin: string): Promise<string | undefined> {
  const stdout = await npmView(`${name}@${pin}`, "version");
  return stdout === undefined ? undefined : newestPublishedVersion(stdout);
}

const composerCloudSpec = `@prisma/composer-prisma-cloud@${dependencyVersionMap["@prisma/composer-prisma-cloud"]}`;
const [cliDependencies, composerDependencies, composerCloudPeerDependencies] = await Promise.all([
  npmViewJson(`prisma@${dependencyVersionMap.prisma}`, "dependencies"),
  npmViewJson(`@prisma/composer@${dependencyVersionMap["@prisma/composer"]}`, "dependencies"),
  npmViewJson(composerCloudSpec, "peerDependencies"),
]);

const pinProblem = findPinProblem(dependencyVersionMap, {
  cliDependencies,
  composerDependencies,
  composerCloudPeerDependencies,
});
if (pinProblem) fail(pinProblem);

async function peerMetadata(packageSpec: string): Promise<PeerMetadata> {
  const [peerDependencies, peerDependenciesMeta] = await Promise.all([
    npmViewJson(packageSpec, "peerDependencies"),
    npmViewJson<PeerMetadata["peerDependenciesMeta"]>(packageSpec, "peerDependenciesMeta"),
  ]);
  return { packageSpec, peerDependencies, peerDependenciesMeta };
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
  if (!version) fail(noPublishedVersionProblem(owner, dependencyVersionMap[owner]));
  return [`${owner}@${version}`];
}

const peerRegistry: Record<string, PeerMetadata[]> = Object.fromEntries(
  await Promise.all(
    owners.map(
      async (owner) =>
        [owner, await Promise.all((await peerSpecs(owner)).map(peerMetadata))] as const,
    ),
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
  `prisma@${dependencyVersionMap.prisma} depends on Composer ${dependencyVersionMap["@prisma/composer"]}, ` +
    `CLI engine ${dependencyVersionMap["@prisma/cli-engine"]} and management API SDK ` +
    `${dependencyVersionMap["@prisma/management-api-sdk"]}. prisma and Composer both use ORM ` +
    `${dependencyVersionMap["@prisma/orm-postgres"]}, alchemy ${dependencyVersionMap.alchemy} ` +
    `and effect ${dependencyVersionMap.effect}.\nYarn apps declare the required peers of ` +
    `${Object.values(peerRegistry)
      .flat()
      .map((metadata) => metadata.packageSpec)
      .join(", ")}, at pins whose lowest and newest versions satisfy the peer ranges. ` +
    `Peers of the other packages an app lists are not checked.`,
);
