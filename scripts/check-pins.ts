import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dependencyVersionMap } from "../src/constants/dependencies";

const execFileAsync = promisify(execFile);

async function npmViewJson(packageSpec: string, field: string): Promise<unknown> {
  const { stdout } = await execFileAsync("npm", ["view", packageSpec, field, "--json"]);
  return JSON.parse(stdout) as unknown;
}

const cliVersion = dependencyVersionMap.prisma;
const composerVersion = dependencyVersionMap["@prisma/composer"];
const composerCloudVersion = dependencyVersionMap["@prisma/composer-prisma-cloud"];
const ormVersion = dependencyVersionMap["@prisma/orm-postgres"];
const mongoVersion = dependencyVersionMap["@prisma/orm-mongo"];

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(cliVersion)) {
  console.error(`prisma is pinned to "${cliVersion}", which is not an exact version.`);
  process.exit(1);
}

if (composerVersion !== composerCloudVersion) {
  console.error(
    `@prisma/composer is pinned to ${composerVersion} but @prisma/composer-prisma-cloud to ${composerCloudVersion}.`,
  );
  process.exit(1);
}

if (mongoVersion !== ormVersion) {
  console.error(
    `@prisma/orm-mongo is pinned to ${mongoVersion} but @prisma/orm-postgres to ${ormVersion}.`,
  );
  process.exit(1);
}

const cliDependencies = (await npmViewJson(`prisma@${cliVersion}`, "dependencies")) as Record<
  string,
  string
>;
const composerCliVersion = cliDependencies["@prisma/composer-cli"];
const toolchainVersion = cliDependencies["@prisma/orm-toolchain"];

if (!composerCliVersion) {
  console.error(`prisma@${cliVersion} does not depend on @prisma/composer-cli.`);
  process.exit(1);
}

if (composerCliVersion !== composerVersion) {
  console.error(
    `Version mismatch: prisma@${cliVersion} depends on @prisma/composer-cli@${composerCliVersion}, ` +
      `but scaffolds pin @prisma/composer to ${composerVersion}.\n` +
      `Bump the Composer pins to ${composerCliVersion}, or pin prisma to the release that depends on ${composerVersion}.`,
  );
  process.exit(1);
}

const cloudPeerDependencies = (await npmViewJson(
  `@prisma/composer-prisma-cloud@${composerCloudVersion}`,
  "peerDependencies",
)) as Record<string, string>;
const cloudOrmPeer = cloudPeerDependencies["@prisma/orm-postgres"];

if (!cloudOrmPeer) {
  console.error(
    `@prisma/composer-prisma-cloud@${composerCloudVersion} does not declare a peerDependency on @prisma/orm-postgres.`,
  );
  process.exit(1);
}

if (cloudOrmPeer !== ormVersion) {
  console.error(
    `Version mismatch: @prisma/composer-prisma-cloud@${composerCloudVersion} peers ` +
      `@prisma/orm-postgres@${cloudOrmPeer}, but scaffolds pin it to ${ormVersion}.\n` +
      `Bump the ORM pins to ${cloudOrmPeer}, or pin Composer to the release that peers ${ormVersion}.`,
  );
  process.exit(1);
}

if (toolchainVersion && toolchainVersion !== ormVersion) {
  console.warn(
    `Note: prisma@${cliVersion} bundles @prisma/orm-toolchain@${toolchainVersion}, ` +
      `which differs from the pinned ORM ${ormVersion}. ` +
      `The ORM pin follows @prisma/composer-prisma-cloud's peerDependency so npm install stays resolvable.`,
  );
}

console.log(
  `prisma@${cliVersion} depends on @prisma/composer-cli@${composerCliVersion}, ` +
    `matching the pinned Composer ${composerVersion}; ` +
    `@prisma/composer-prisma-cloud peers @prisma/orm-postgres@${cloudOrmPeer}, matching the ORM pins.`,
);
