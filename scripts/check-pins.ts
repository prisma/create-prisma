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

const [cliDependencies, composerDependencies, composerCloudPeerDependencies] = await Promise.all([
  npmViewJson(`prisma@${dependencyVersionMap.prisma}`, "dependencies"),
  npmViewJson(`@prisma/composer@${dependencyVersionMap["@prisma/composer"]}`, "dependencies"),
  npmViewJson(
    `@prisma/composer-prisma-cloud@${dependencyVersionMap["@prisma/composer-prisma-cloud"]}`,
    "peerDependencies",
  ),
]);

function fail(problem: string): never {
  console.error(problem);
  process.exit(1);
}

const pinProblem = findPinProblem(dependencyVersionMap, {
  cliDependencies,
  composerDependencies,
  composerCloudPeerDependencies,
});
if (pinProblem) fail(pinProblem);

function peerSource(owner: keyof typeof yarnPeerDependencies): string {
  if (owner === "prisma")
    return `@prisma/orm-toolchain@${cliDependencies["@prisma/orm-toolchain"]}`;
  return `${owner}@${dependencyVersionMap[owner]}`;
}

const peerRegistry: Record<string, PeerMetadata> = Object.fromEntries(
  await Promise.all(
    (Object.keys(yarnPeerDependencies) as (keyof typeof yarnPeerDependencies)[]).map(
      async (owner) => {
        const packageSpec = peerSource(owner);
        const [peerDependencies, peerDependenciesMeta] = await Promise.all([
          npmViewJson(packageSpec, "peerDependencies"),
          npmViewJson<PeerMetadata["peerDependenciesMeta"]>(packageSpec, "peerDependenciesMeta"),
        ]);
        return [owner, { packageSpec, peerDependencies, peerDependenciesMeta }] as const;
      },
    ),
  ),
);

const peerProblem = findYarnPeerProblem(yarnPeerDependencies, dependencyVersionMap, peerRegistry);
if (peerProblem) fail(peerProblem);

console.log(
  `prisma@${dependencyVersionMap.prisma} matches Composer ${dependencyVersionMap["@prisma/composer"]} ` +
    `and CLI engine ${dependencyVersionMap["@prisma/cli-engine"]}, and both use ORM ` +
    `${dependencyVersionMap["@prisma/orm-postgres"]}, alchemy ${dependencyVersionMap.alchemy} ` +
    `and effect ${dependencyVersionMap.effect}. Yarn apps declare every required peer of ` +
    `${Object.values(peerRegistry)
      .map((metadata) => metadata.packageSpec)
      .join(", ")}.`,
);
