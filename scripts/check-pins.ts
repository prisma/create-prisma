import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { dependencyVersionMap } from "../src/constants/dependencies";

const execFileAsync = promisify(execFile);

const cliVersion = dependencyVersionMap.prisma;
const ormVersion = dependencyVersionMap["@prisma/orm-postgres"];

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(cliVersion)) {
  console.error(`prisma is pinned to "${cliVersion}", which is not an exact version.`);
  process.exit(1);
}

const { stdout } = await execFileAsync("npm", [
  "view",
  `prisma@${cliVersion}`,
  "dependencies",
  "--json",
]);
const dependencies = JSON.parse(stdout) as Record<string, string>;
const toolchainVersion = dependencies["@prisma/orm-toolchain"];

if (!toolchainVersion) {
  console.error(`prisma@${cliVersion} does not depend on @prisma/orm-toolchain.`);
  process.exit(1);
}

if (toolchainVersion !== ormVersion) {
  console.error(
    `Version mismatch: prisma@${cliVersion} bundles @prisma/orm-toolchain@${toolchainVersion}, ` +
      `but scaffolds pin @prisma/orm-postgres to ${ormVersion}.\n` +
      `Bump the ORM pins to ${toolchainVersion}, or pin prisma to the release that bundles ${ormVersion}.`,
  );
  process.exit(1);
}

const mongoVersion = dependencyVersionMap["@prisma/orm-mongo"];
if (mongoVersion !== ormVersion) {
  console.error(
    `@prisma/orm-mongo is pinned to ${mongoVersion} but @prisma/orm-postgres to ${ormVersion}.`,
  );
  process.exit(1);
}

console.log(
  `prisma@${cliVersion} bundles @prisma/orm-toolchain@${toolchainVersion}, which matches the pinned @prisma/orm-postgres and @prisma/orm-mongo.`,
);
