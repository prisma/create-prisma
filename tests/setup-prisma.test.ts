import { describe, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCreateCommandEffect } from "../src/commands/create";
import { applicationRuntime } from "../src/runtime";
import {
  CommandExecutionError,
  CommandRunner,
  type CommandSpec,
} from "../src/services/command-runner";
import { initializeAgentSkills, runPrismaInit } from "../src/tasks/prisma-setup/commands";
import { runPrismaJsonCommandEffect } from "../src/tasks/prisma-cli";
import { collectPrismaSetupContext } from "../src/tasks/setup-prisma";

async function withTempProject<T>(run: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(tmpdir(), "create-prisma-setup-"));
  try {
    return await run(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

test("writes pnpm build permissions before the first dependency installation", async () => {
  await withTempProject(async (projectDir) => {
    let installChecked = false;
    const result = await applicationRuntime.runPromise(
      runCreateCommandEffect({
        name: path.relative(process.cwd(), path.join(projectDir, "next-app")),
        template: "next",
        packageManager: "pnpm",
        json: true,
        deploy: false,
      }).pipe(
        Effect.provideService(CommandRunner, {
          run: () => Effect.die("Unexpected unchecked command"),
          runChecked: (spec) =>
            Effect.gen(function* () {
              expect(spec.command).toBe("pnpm");
              expect(spec.args).toEqual(["install"]);
              const fs = yield* FileSystem.FileSystem;
              const config = yield* fs
                .readFileString(path.join(spec.cwd, "pnpm-workspace.yaml"))
                .pipe(Effect.orDie);
              for (const dependency of [
                "esbuild",
                "msgpackr-extract",
                "workerd",
                "sharp",
                "unrs-resolver",
              ]) {
                expect(config).toContain(`  ${dependency}: true`);
              }
              installChecked = true;
              return yield* new CommandExecutionError({
                command: spec.command,
                args: [...spec.args],
                exitCode: 1,
                stdout: "",
                stderr: "Stopped before installing test dependencies",
              });
            }),
        }),
      ),
    );
    expect(installChecked).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { stage: "install_dependencies" } });
  });
});

describe("Prisma setup commands", () => {
  test.each([
    { source: "stdout", stdout: "DATABASE_URL=postgres://user:secret@localhost/db", stderr: "" },
    { source: "stderr", stdout: "", stderr: "DATABASE_URL=postgres://user:secret@localhost/db" },
    {
      source: "envelope fallback",
      stdout: JSON.stringify({ ok: false }),
      stderr: "DATABASE_URL=postgres://user:secret@localhost/db",
    },
    {
      source: "structured error",
      stdout: JSON.stringify({
        ok: false,
        error: {
          summary: "Connection failed",
          why: "DATABASE_URL=postgres://user:secret@localhost/db",
        },
      }),
      stderr: "Authorization: Bearer private-token",
    },
  ])("redacts stored errors from $source", async ({ stdout, stderr }) => {
    const error = await applicationRuntime.runPromise(
      runPrismaJsonCommandEffect({
        packageManager: "npm",
        projectDir: process.cwd(),
        args: ["init", "--yes"],
      }).pipe(
        Effect.provideService(CommandRunner, {
          run: () => Effect.succeed({ exitCode: 1, stdout, stderr }),
          runChecked: () => Effect.die("Expected structured Prisma execution"),
        }),
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({ exitCode: 1, message: expect.stringContaining("<redacted>") });
    expect(JSON.stringify(error)).not.toContain("user:secret");
    expect(JSON.stringify(error)).not.toContain("private-token");
    if (stderr) expect(error).toMatchObject({ stderr: expect.stringContaining("<redacted>") });
  });

  test("keeps package-manager errors when Prisma cannot start", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { json: true, deploy: false, packageManager: "pnpm" },
        { projectDir },
      );
      const message = "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile";
      const error = await applicationRuntime.runPromise(
        initializeAgentSkills(context, projectDir).pipe(
          Effect.provideService(CommandRunner, {
            run: () => Effect.succeed({ exitCode: 1, stdout: message, stderr: "" }),
            runChecked: () => Effect.die("Expected structured Prisma execution"),
          }),
          Effect.flip,
        ),
      );
      expect(error).toMatchObject({ message, exitCode: 1 });
    });
  });

  test("runs no prisma init when no agent skills are wanted", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { json: true, deploy: false, packageManager: "npm", skills: "none" },
        { projectDir },
      );
      await applicationRuntime.runPromise(
        initializeAgentSkills(context, projectDir).pipe(
          Effect.provideService(CommandRunner, {
            run: () => Effect.die("prisma init must not run when no agents are wanted"),
            runChecked: () => Effect.die("prisma init must not run when no agents are wanted"),
          }),
        ),
      );
    });
  });

  test("passes the chosen agents to prisma init", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { json: true, deploy: false, packageManager: "npm", skills: "claude,cursor" },
        { projectDir },
      );
      const commands: CommandSpec[] = [];
      await applicationRuntime.runPromise(
        initializeAgentSkills(context, projectDir).pipe(
          Effect.provideService(CommandRunner, {
            run: (spec: CommandSpec) => {
              commands.push(spec);
              return Effect.succeed({
                exitCode: 0,
                stdout: '{"kind":"result","envelope":{"ok":true,"result":{}}}',
                stderr: "",
              });
            },
            runChecked: () => Effect.die("Expected structured Prisma execution"),
          }),
        ),
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]?.args).toEqual(
        expect.arrayContaining(["init", "--yes", "--skills=claude,cursor"]),
      );
    });
  });

  test("grants overwrite consent only with explicit force", async () => {
    await withTempProject(async (root) => {
      const projectDir = path.join(root, "retry app");
      const context = await collectPrismaSetupContext(
        { json: true, deploy: false, packageManager: "npm" },
        { projectDir },
      );
      const commands: CommandSpec[] = [];
      const runner = {
        run: (spec: CommandSpec) => {
          commands.push(spec);
          return Effect.succeed({
            exitCode: 0,
            stdout: '{"kind":"result","envelope":{"ok":true,"result":{}}}',
            stderr: "",
          });
        },
        runChecked: () => Effect.die("Expected structured Prisma execution"),
      };
      await applicationRuntime.runPromise(
        Effect.gen(function* () {
          yield* runPrismaInit(context, projectDir);
          yield* runPrismaInit(context, projectDir, true);
          yield* initializeAgentSkills(context, projectDir);
        }).pipe(Effect.provideService(CommandRunner, runner)),
      );
      expect(commands[0]?.args).not.toContain("--confirm");
      expect(commands[1]?.args).toContain("--confirm");
      expect(commands[1]?.args[commands[1].args.indexOf("--confirm") + 1]).toBe("retry app");
      expect(commands[0]?.args).toContain("--json");
      expect(commands[0]?.env?.CI).toBe("1");
      expect(commands[2]?.args.slice(-5)).toEqual([
        "init",
        "--yes",
        "--skills=claude,cursor,agents,devin",
        "--json",
        "--no-interactive",
      ]);
      expect(commands[2]?.args.filter((arg) => arg === "--no-interactive")).toHaveLength(1);
    });
  });

  test.each([
    { run: runPrismaInit, command: "orm.init", code: "CLI.CONSENT_REQUIRED" },
    { run: initializeAgentSkills, command: "init", code: "CLI.CONFIG_SECTION_INVALID" },
  ])("preserves structured errors from $command", async ({ run, command, code }) => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { json: true, deploy: false, packageManager: "pnpm" },
        { projectDir },
      );
      const error = await applicationRuntime.runPromise(
        run(context, projectDir).pipe(
          Effect.provideService(CommandRunner, {
            run: () =>
              Effect.succeed({
                exitCode: 2,
                stdout: JSON.stringify({
                  kind: "result",
                  envelope: {
                    ok: false,
                    commandId: command,
                    error: { code, summary: "Setup rejected", why: "Explicit action is required" },
                  },
                }),
                stderr: "",
              }),
            runChecked: () => Effect.die("Expected structured Prisma execution"),
          }),
          Effect.flip,
        ),
      );
      expect(error).toMatchObject({
        message: "Setup rejected: Explicit action is required",
        exitCode: 2,
        prismaCliCommand: command,
        prismaCliErrorCode: code,
      });
    });
  });
});

describe("collectPrismaSetupContext", () => {
  test("--yes uses Prisma Postgres defaults without deploying", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, packageManager: "bun" },
        { projectDir },
      );

      expect(context).toMatchObject({
        databaseProvider: "postgres",
        authoring: "psl",
        packageManager: "bun",
        skillAgents: ["claude", "cursor", "agents", "devin"],
        shouldDeploy: false,
        shouldPromptForWorkspace: false,
      });
    });
  });

  test("--json is non-interactive and deploys with Prisma Postgres defaults", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { json: true, packageManager: "bun" },
        { projectDir },
      );

      expect(context).toMatchObject({
        json: true,
        databaseProvider: "postgres",
        authoring: "psl",
        packageManager: "bun",
        shouldDeploy: true,
        shouldPromptForWorkspace: false,
      });
      expect(context?.output).not.toBe(process.stdout);
    });
  });

  test("--json honors an explicit deployment opt-out", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { json: true, packageManager: "bun", deploy: false },
        { projectDir },
      );

      expect(context?.shouldDeploy).toBe(false);
    });
  });

  test("honors an explicit immediate deployment", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, packageManager: "pnpm", deploy: true },
        { projectDir },
      );
      expect(context?.shouldDeploy).toBe(true);
    });
  });

  test("preserves an explicit workspace for unattended deployment", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        {
          yes: true,
          packageManager: "pnpm",
          deploy: true,
          workspace: "workspace_123",
        },
        { projectDir },
      );
      expect(context).toMatchObject({
        shouldPromptForWorkspace: false,
        workspace: "workspace_123",
      });
    });
  });

  test("allows workspace selection during an interactive deployment", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        {
          provider: "postgres",
          authoring: "psl",
          packageManager: "bun",
          skills: "claude",
          deploy: true,
        },
        { projectDir },
      );
      expect(context.shouldPromptForWorkspace).toBe(true);
    });
  });

  test("--skills none records that no agent skills are wanted", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, packageManager: "npm", skills: "none" },
        { projectDir },
      );
      expect(context.skillAgents).toEqual([]);
    });
  });

  test("--skills keeps the listed agents in order without duplicates", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, packageManager: "npm", skills: "cursor, claude,cursor" },
        { projectDir },
      );
      expect(context.skillAgents).toEqual(["cursor", "claude"]);
    });
  });

  test.each([
    { skills: "zed", fragment: "'zed'" },
    { skills: "none,claude", fragment: "cannot be combined" },
    { skills: ",", fragment: "no agent names" },
  ])("rejects --skills $skills before touching the target", async ({ skills, fragment }) => {
    await withTempProject(async (projectDir) => {
      const result = await applicationRuntime.runPromise(
        runCreateCommandEffect({
          name: path.relative(process.cwd(), path.join(projectDir, "bad-skills-app")),
          template: "minimal",
          packageManager: "npm",
          json: true,
          deploy: false,
          skills,
        }).pipe(
          Effect.provideService(CommandRunner, {
            run: () => Effect.die("No command may run with an invalid --skills value"),
            runChecked: () => Effect.die("No command may run with an invalid --skills value"),
          }),
        ),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { stage: "collect_context", message: expect.stringContaining(fragment) },
      });
    });
  });

  test("keeps MongoDB as an explicit provider option", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, provider: "mongo", packageManager: "npm" },
        { projectDir },
      );
      expect(context?.databaseProvider).toBe("mongo");
    });
  });

  test("supports Deno for local minimal PostgreSQL apps", async () => {
    await withTempProject(async (projectDir) => {
      const context = await collectPrismaSetupContext(
        { yes: true, packageManager: "deno", provider: "postgres" },
        { projectDir, template: "minimal" },
      );

      expect(context).toMatchObject({
        databaseProvider: "postgres",
        packageManager: "deno",
        skillAgents: [],
        shouldDeploy: false,
      });
    });
  });

  test("rejects Deno for unsupported providers, templates, and deployments", async () => {
    await withTempProject(async (projectDir) => {
      await expect(
        collectPrismaSetupContext(
          { yes: true, packageManager: "deno", provider: "mongo" },
          { projectDir, template: "minimal" },
        ),
      ).rejects.toThrow("Deno support currently requires PostgreSQL.");
      await expect(
        collectPrismaSetupContext(
          { yes: true, packageManager: "deno", provider: "postgres" },
          { projectDir, template: "next" },
        ),
      ).rejects.toThrow("Deno support currently requires the minimal template.");
      await expect(
        collectPrismaSetupContext(
          { yes: true, packageManager: "deno", provider: "postgres", deploy: true },
          { projectDir, template: "minimal" },
        ),
      ).rejects.toThrow("Prisma Compute does not support Deno deployments yet. Use --no-deploy.");
    });
  });
});
