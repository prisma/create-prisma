import { select, text } from "@clack/prompts";
import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type BumpType = "major" | "minor" | "patch";

type PackageJson = Record<string, unknown> & {
  version: string;
};

const PACKAGE_JSON_PATH = join(process.cwd(), "package.json");

function isBumpType(value: string): value is BumpType {
  return value === "major" || value === "minor" || value === "patch";
}

function isSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function bumpVersion(currentVersion: string, bumpType: BumpType): string {
  if (!isSemver(currentVersion)) {
    throw new Error(
      `Current version "${currentVersion}" is not in x.y.z format. Please fix package.json first.`,
    );
  }

  const [major, minor, patch] = currentVersion.split(".").map(Number);

  if (bumpType === "major") {
    return `${major + 1}.0.0`;
  }

  if (bumpType === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

async function pickVersionInput(initialInput?: string): Promise<string> {
  if (initialInput) {
    return initialInput;
  }

  const bumpType = await select({
    message: "What type of release do you want to create?",
    options: [
      { value: "patch", label: "Patch (bug fixes)" },
      { value: "minor", label: "Minor (new features)" },
      { value: "major", label: "Major (breaking changes)" },
      { value: "custom", label: "Custom version" },
    ],
  });

  if (bumpType === "custom") {
    const customVersion = await text({
      message: "Enter the version (x.y.z):",
      placeholder: "0.2.0",
    });

    if (typeof customVersion === "string" && customVersion.trim()) {
      return customVersion.trim();
    }

    throw new Error("No version selected.");
  }

  if (typeof bumpType === "string") {
    return bumpType;
  }

  throw new Error("No version selected.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const rawVersionInput = args.find((arg) => !arg.startsWith("--"));

  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;
  const currentVersion = packageJson.version;
  const versionInput = await pickVersionInput(rawVersionInput);

  const newVersion = isBumpType(versionInput)
    ? bumpVersion(currentVersion, versionInput)
    : versionInput;

  if (!isSemver(newVersion)) {
    throw new Error(`Version must be in x.y.z format. Received "${newVersion}".`);
  }

  console.log(`Current version: ${currentVersion}`);
  console.log(`Next version: ${newVersion}`);

  if (isDryRun) {
    console.log(`Dry run complete. No files were changed.`);
    return;
  }

  const statusOutput = await $`git status --porcelain`.text();
  if (statusOutput.trim()) {
    throw new Error("You have uncommitted changes. Commit or stash them first.");
  }

  const branchName = `release/v${newVersion}`;
  const commitMessage = `chore(release): ${newVersion}`;

  await $`git checkout main`;
  await $`git pull origin main`;
  await $`git checkout -b ${branchName}`;

  packageJson.version = newVersion;
  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);

  await $`bun install`;
  await $`bun run typecheck`;
  await $`bun run build`;

  await $`git add package.json bun.lock`;
  await $`git commit -m ${commitMessage}`;
  await $`git push -u origin ${branchName}`;

  const prTitle = commitMessage;
  const prBody = `## Release v${newVersion}

This PR bumps \`create-prisma\` to \`${newVersion}\`.

When this PR merges, GitHub Actions publishes to npm using trusted publishing.
`;

  await $`gh pr create --title ${prTitle} --body ${prBody} --base main --head ${branchName}`;

  await $`git checkout main`;

  console.log(`Release PR created for v${newVersion}.`);
  console.log(`Next: wait for CI, then merge (or auto-merge) to publish.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release bump failed: ${message}`);
  process.exit(1);
});
