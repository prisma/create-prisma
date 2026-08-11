import packageJson from "../../package.json" with { type: "json" };

export const supportedNodeVersionRange = packageJson.engines.node;

function getMinimumNodeMajor(): number {
  const match = /^>=(\d+)(?:\.\d+){0,2}$/.exec(supportedNodeVersionRange);
  if (!match) {
    throw new Error(`Unsupported Node.js engine range: ${supportedNodeVersionRange}`);
  }

  return Number(match[1]);
}

export function getNodeVersionCompatibilityError(nodeVersion: string): string | undefined {
  const majorMatch = /^v?(\d+)(?:\.|$)/.exec(nodeVersion);
  const currentMajor = majorMatch ? Number(majorMatch[1]) : Number.NaN;
  const minimumMajor = getMinimumNodeMajor();

  if (Number.isFinite(currentMajor) && currentMajor >= minimumMajor) {
    return undefined;
  }

  return [
    `Node.js ${nodeVersion} is unsupported.`,
    "",
    `create-prisma requires Node.js ${minimumMajor} LTS or newer.`,
    "Update Node.js, then run create-prisma again.",
  ].join("\n");
}
