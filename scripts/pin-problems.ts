import { dependencyVersionMap } from "../src/constants/dependencies";

export type Pins = Pick<
  typeof dependencyVersionMap,
  | "prisma"
  | "@prisma/composer"
  | "@prisma/composer-prisma-cloud"
  | "@prisma/orm-postgres"
  | "@prisma/orm-mongo"
  | "alchemy"
  | "effect"
>;

type Dependencies = Record<string, string | undefined>;

export type RegistryMetadata = {
  cliDependencies: Dependencies;
  composerDependencies: Dependencies;
  composerCloudPeerDependencies: Dependencies;
};

export function findPinProblem(pins: Pins, registry: RegistryMetadata): string | undefined {
  const cliVersion = pins.prisma;
  const composerVersion = pins["@prisma/composer"];
  const composerCloudVersion = pins["@prisma/composer-prisma-cloud"];
  const ormVersion = pins["@prisma/orm-postgres"];
  const mongoVersion = pins["@prisma/orm-mongo"];

  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(cliVersion)) {
    return `prisma is pinned to "${cliVersion}", which is not an exact version.`;
  }
  if (composerVersion !== composerCloudVersion) {
    return `@prisma/composer is pinned to ${composerVersion} but @prisma/composer-prisma-cloud to ${composerCloudVersion}.`;
  }
  if (mongoVersion !== ormVersion) {
    return `@prisma/orm-mongo is pinned to ${mongoVersion} but @prisma/orm-postgres to ${ormVersion}.`;
  }

  const composerCliVersion = registry.cliDependencies["@prisma/composer-cli"];
  if (!composerCliVersion) {
    return `prisma@${cliVersion} does not depend on @prisma/composer-cli.`;
  }
  if (composerCliVersion !== composerVersion) {
    return (
      `Version mismatch: prisma@${cliVersion} depends on @prisma/composer-cli@${composerCliVersion}, ` +
      `but scaffolds pin @prisma/composer to ${composerVersion}.\n` +
      `Bump the Composer pins to ${composerCliVersion}, or pin prisma to the release that depends on ${composerVersion}.`
    );
  }

  for (const name of ["alchemy", "effect"] as const) {
    const composerPin = registry.composerDependencies[name];
    if (composerPin !== pins[name]) {
      return (
        `Version mismatch: @prisma/composer@${composerVersion} depends on ${name}@${composerPin}, ` +
        `but scaffolds pin it to ${pins[name]}.`
      );
    }
  }

  const cloudOrmPeer = registry.composerCloudPeerDependencies["@prisma/orm-postgres"];
  if (!cloudOrmPeer) {
    return `@prisma/composer-prisma-cloud@${composerCloudVersion} does not declare a peerDependency on @prisma/orm-postgres.`;
  }
  if (cloudOrmPeer !== ormVersion) {
    return (
      `Version mismatch: @prisma/composer-prisma-cloud@${composerCloudVersion} peers ` +
      `@prisma/orm-postgres@${cloudOrmPeer}, but scaffolds pin it to ${ormVersion}.\n` +
      `Bump the ORM pins to ${cloudOrmPeer}, or pin Composer to the release that peers ${ormVersion}.`
    );
  }

  const toolchainVersion = registry.cliDependencies["@prisma/orm-toolchain"];
  if (!toolchainVersion) {
    return `prisma@${cliVersion} does not depend on @prisma/orm-toolchain.`;
  }
  if (toolchainVersion !== ormVersion) {
    return (
      `Version mismatch: prisma@${cliVersion} bundles @prisma/orm-toolchain@${toolchainVersion}, ` +
      `but scaffolds pin the ORM to ${ormVersion}. \`prisma contract emit\` rejects ORM packages ` +
      `from another release, so wait for a Composer and prisma release on the same ORM version.`
    );
  }

  return undefined;
}
