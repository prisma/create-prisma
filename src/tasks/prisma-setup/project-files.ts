import { Effect, FileSystem } from "effect";
import path from "node:path";

export const ensureGitignoreEntry = Effect.fn("PrismaSetup.ensureGitignoreEntry")(function* (
  projectDir: string,
  entry: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const gitignorePath = path.join(projectDir, ".gitignore");
  const existing = (yield* fs.exists(gitignorePath)) ? yield* fs.readFileString(gitignorePath) : "";
  const entries = existing.split(/\r?\n/).map((line) => line.trim());
  if (entries.includes(entry) || entries.includes(`/${entry}`)) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  yield* fs.writeFileString(gitignorePath, `${existing}${separator}${entry}\n`);
});

export const ensureMongoEnvironment = Effect.fn("PrismaSetup.ensureMongoEnvironment")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const envPath = path.join(projectDir, ".env");
  if (!(yield* fs.exists(envPath))) {
    yield* fs.writeFileString(
      envPath,
      'DATABASE_URL="mongodb://localhost:27017/mydb?replicaSet=rs0&directConnection=true"\n',
    );
  }
  yield* ensureGitignoreEntry(projectDir, ".env");
});

export const ensureComposerTypeScriptOptions = Effect.fn(
  "PrismaSetup.ensureComposerTypeScriptOptions",
)(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const tsconfigPath = path.join(projectDir, "tsconfig.json");
  const tsconfig = yield* fs.readFileString(tsconfigPath);
  const additions: string[] = [];
  if (!/"allowImportingTsExtensions"\s*:/.test(tsconfig)) {
    additions.push('    "allowImportingTsExtensions": true,');
  }
  if (!/"noEmit"\s*:/.test(tsconfig)) additions.push('    "noEmit": true,');
  if (additions.length === 0) return;

  const updated = tsconfig.replace(
    /"compilerOptions"\s*:\s*\{/,
    (match) => `${match}\n${additions.join("\n")}`,
  );
  if (updated === tsconfig) {
    return yield* Effect.fail(new Error("tsconfig.json is missing compilerOptions."));
  }
  yield* fs.writeFileString(tsconfigPath, updated);
});
