type Version = readonly [major: number, minor: number, patch: number];

export const SUPPORTED_NODE_RANGE = "^22.18.0 || ^24.11.0 || >=26.0.0";

const minimumByMajor: ReadonlyMap<number, Version> = new Map([
  [22, [22, 18, 0]],
  [24, [24, 11, 0]],
]);
const FIRST_MAJOR_WITH_EVERY_RELEASE_SUPPORTED = 26;

export const MINIMUM_NODE_VERSION = minimumByMajor.get(22)!;

function parseVersion(version: string): Version {
  const [major = "0", minor = "0", patch = "0"] = version.replace(/^v/, "").split(".");
  return [Number(major), Number(minor), Number.parseInt(patch, 10)];
}

function isAtLeast(current: Version, minimum: Version): boolean {
  for (const [index, part] of current.entries()) {
    if (part !== minimum[index]) return part > minimum[index]!;
  }
  return true;
}

export function runsOnNode(
  versions: Partial<Record<"node" | "bun" | "deno", string>> = process.versions,
): boolean {
  return versions.bun === undefined && versions.deno === undefined;
}

export function supportsPrisma(nodeVersion = process.versions.node): boolean {
  const current = parseVersion(nodeVersion);
  if (current[0] >= FIRST_MAJOR_WITH_EVERY_RELEASE_SUPPORTED) return true;
  const minimum = minimumByMajor.get(current[0]);
  return minimum !== undefined && isAtLeast(current, minimum);
}

export function getUnsupportedNodeMessage(nodeVersion = process.versions.node): string {
  return [
    `Node.js ${nodeVersion} is unsupported by create-prisma@latest.`,
    "Required: Node.js 22.18 or newer on the 22 line, 24.11 or newer on the 24 line, or 26 and newer.",
    "Update Node.js and run the command again.",
  ].join("\n");
}
