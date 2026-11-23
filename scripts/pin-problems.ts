import { dependencyVersionMap } from "../src/constants/dependencies";

export type Pins = Pick<
  typeof dependencyVersionMap,
  | "prisma"
  | "@prisma/cli-engine"
  | "@prisma/management-api-sdk"
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

  const cliEngineVersion = registry.cliDependencies["@prisma/cli-engine"];
  if (!cliEngineVersion) {
    return (
      `prisma@${cliVersion} does not depend on @prisma/cli-engine, so Yarn scaffolds cannot pin it ` +
      `to the CLI's version.\nCheck which package now provides the CLI engine and update ` +
      `yarnPeerDependencies in src/constants/dependencies.ts.`
    );
  }
  if (cliEngineVersion !== pins["@prisma/cli-engine"]) {
    return (
      `Version mismatch: prisma@${cliVersion} depends on @prisma/cli-engine@${cliEngineVersion}, ` +
      `but Yarn scaffolds pin it to ${pins["@prisma/cli-engine"]}.\n` +
      `Pin @prisma/cli-engine to ${cliEngineVersion}.`
    );
  }

  const managementSdkVersion = registry.cliDependencies["@prisma/management-api-sdk"];
  if (!managementSdkVersion) {
    return (
      `prisma@${cliVersion} does not depend on @prisma/management-api-sdk, so Yarn scaffolds cannot ` +
      `pin it to the CLI's version.\nCheck whether @prisma/cli-engine still peers on it and update ` +
      `its pin in src/constants/dependencies.ts.`
    );
  }
  if (managementSdkVersion !== pins["@prisma/management-api-sdk"]) {
    return (
      `Version mismatch: prisma@${cliVersion} depends on @prisma/management-api-sdk@${managementSdkVersion}, ` +
      `but Yarn scaffolds pin it to ${pins["@prisma/management-api-sdk"]}.\n` +
      `Pin @prisma/management-api-sdk to ${managementSdkVersion}.`
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

export type PeerMetadata = {
  packageSpec: string;
  peerDependencies: Dependencies;
  peerDependenciesMeta: Record<string, { optional?: boolean } | undefined>;
};

export function findYarnPeerProblem(
  yarnPeers: Record<string, readonly string[]>,
  versions: Dependencies,
  newestVersions: Dependencies,
  registry: Record<string, PeerMetadata>,
): string | undefined {
  const fixLocation = "yarnPeerDependencies in src/constants/dependencies.ts";
  for (const [owner, listedPeers] of Object.entries(yarnPeers)) {
    const metadata = registry[owner];
    if (!metadata) return `No npm metadata was fetched for the peers listed under ${owner}.`;
    const { packageSpec, peerDependencies, peerDependenciesMeta } = metadata;
    const requiredPeers = Object.entries(peerDependencies).filter(
      ([name]) => !peerDependenciesMeta[name]?.optional,
    );

    for (const [name, range] of requiredPeers) {
      if (!listedPeers.includes(name)) {
        return (
          `${packageSpec} requires the peer dependency ${name}@${range}, which Yarn apps do not declare.\n` +
          `Add ${name} to the ${owner} entry of ${fixLocation}.`
        );
      }
      const pin = versions[name];
      const minimum = pin?.replace(/^[\^~]/, "");
      if (!pin || !minimum || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(minimum)) {
        return `${name} is pinned to "${pin}", so check:pins cannot tell whether it satisfies ${packageSpec}'s peer range ${range}.`;
      }
      if (!Bun.semver.satisfies(minimum, range ?? "")) {
        return (
          `${packageSpec} requires ${name}@${range}, but scaffolds pin ${name} to ${pin}.\n` +
          `Pin ${name} to a version in ${range}.`
        );
      }
      const newest = newestVersions[name];
      if (!newest) {
        return `No published version of ${name} was found for the pin ${pin}.`;
      }
      if (!Bun.semver.satisfies(newest, range ?? "")) {
        return (
          `${packageSpec} requires ${name}@${range}, but the pin ${pin} lets a fresh install ` +
          `resolve ${name}@${newest}.\nPin ${name} to a range inside ${range}.`
        );
      }
    }

    for (const name of listedPeers) {
      if (!requiredPeers.some(([peer]) => peer === name)) {
        return (
          `${fixLocation} lists ${name} under ${owner}, but ${packageSpec} does not require it as a peer.\n` +
          `Remove it from that entry.`
        );
      }
    }
  }
  return undefined;
}
