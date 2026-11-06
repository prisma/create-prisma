import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dependencyVersionMap } from "../src/constants/dependencies";
import { findPinProblem } from "./pin-problems";

const execFileAsync = promisify(execFile);

async function npmViewJson(packageSpec: string, field: string): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync("npm", ["view", packageSpec, field, "--json"]);
  return JSON.parse(stdout) as Record<string, string>;
}

const [cliDependencies, composerDependencies, composerCloudPeerDependencies] = await Promise.all([
  npmViewJson(`prisma@${dependencyVersionMap.prisma}`, "dependencies"),
  npmViewJson(`@prisma/composer@${dependencyVersionMap["@prisma/composer"]}`, "dependencies"),
  npmViewJson(
    `@prisma/composer-prisma-cloud@${dependencyVersionMap["@prisma/composer-prisma-cloud"]}`,
    "peerDependencies",
  ),
]);

const problem = findPinProblem(dependencyVersionMap, {
  cliDependencies,
  composerDependencies,
  composerCloudPeerDependencies,
});

if (problem) {
  console.error(problem);
  process.exit(1);
}

console.log(
  `prisma@${dependencyVersionMap.prisma} matches Composer ${dependencyVersionMap["@prisma/composer"]}, ` +
    `and both use ORM ${dependencyVersionMap["@prisma/orm-postgres"]}, alchemy ${dependencyVersionMap.alchemy} ` +
    `and effect ${dependencyVersionMap.effect}.`,
);
