const MINIMUM_NODE_VERSION = [22, 18, 0] as const;

function parseVersion(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.replace(/^v/, "").split(".");
  return [Number(major), Number(minor), Number.parseInt(patch, 10)];
}

export function supportsPrismaNext(nodeVersion = process.versions.node): boolean {
  const current = parseVersion(nodeVersion);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    if (current[index]! > MINIMUM_NODE_VERSION[index]!) return true;
    if (current[index]! < MINIMUM_NODE_VERSION[index]!) return false;
  }
  return true;
}

export function getUnsupportedNodeMessage(nodeVersion = process.versions.node): string {
  return [
    `Node.js ${nodeVersion} is unsupported by create-prisma@next.`,
    "Required: Node.js 22.18 or newer.",
    "Update Node.js and run the command again.",
  ].join("\n");
}
