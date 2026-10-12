type Version = readonly [major: number, minor: number, patch: number];

const supportedNodeLines = [
  { major: 22, minimum: [22, 18, 0] },
  { major: 24, minimum: [24, 11, 0] },
] as const satisfies readonly { major: number; minimum: Version }[];
const FIRST_MAJOR_WITH_EVERY_RELEASE_SUPPORTED = 26;

export const SUPPORTED_NODE_RANGE = [
  ...supportedNodeLines.map(({ minimum }) => `^${minimum.join(".")}`),
  `>=${FIRST_MAJOR_WITH_EVERY_RELEASE_SUPPORTED}.0.0`,
].join(" || ");

export const MINIMUM_NODE_VERSION: Version = supportedNodeLines[0].minimum;

const SUPPORTED_NODE_DESCRIPTION = `${supportedNodeLines
  .map(({ major, minimum }) => `${minimum[0]}.${minimum[1]} or newer on the ${major} line`)
  .join(", ")}, or ${FIRST_MAJOR_WITH_EVERY_RELEASE_SUPPORTED} and newer`;

const RELEASE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/;

function parseReleaseVersion(version: string): Version | undefined {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
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
  const current = parseReleaseVersion(nodeVersion);
  if (!current) return false;
  if (current[0] >= FIRST_MAJOR_WITH_EVERY_RELEASE_SUPPORTED) return true;
  const line = supportedNodeLines.find(({ major }) => major === current[0]);
  return line !== undefined && isAtLeast(current, line.minimum);
}

export function getUnsupportedNodeMessage(nodeVersion = process.versions.node): string {
  return [
    `Node.js ${nodeVersion} is unsupported by create-prisma@latest.`,
    `Required: Node.js ${SUPPORTED_NODE_DESCRIPTION}.`,
    "Update Node.js and run the command again.",
  ].join("\n");
}
