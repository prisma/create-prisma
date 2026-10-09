# create-prisma

Create a Prisma 8 app with Prisma Composer built in.

## Supported versions

create-prisma supports exactly what Prisma ORM supports: Node.js 22.18 or newer on the 22 line, 24.11 or newer on the 24 line, or 26 and newer (`^22.18.0 || ^24.11.0 || >=26.0.0`). Node.js 23 and 24.0 to 24.10 are not supported. create-prisma refuses unsupported Node.js versions before it writes any files, and the generated minimal, hono, elysia, nest and turborepo projects declare the same range in `engines.node`.

Each supported Node.js release works with the npm it ships, including npm 10 on Node.js 22. pnpm, Yarn 4.10 or newer, Bun and Deno are also supported. Yarn 1 is not supported. When create-prisma runs on Bun or Deno instead of Node.js, it skips the Node.js check.

The one exception is the `nuxt` template. Nuxt itself requires Node.js `^22.22.3 || ^24.15.0 || >=26.0.0`, so Nuxt projects declare that narrower range.

## Quick start

Use your package manager:

```bash
npx create-prisma@latest my-app
pnpm dlx create-prisma@latest my-app
yarn dlx create-prisma@latest my-app
bunx create-prisma@latest my-app
```

The CLI initializes Prisma 8 with `prisma@latest`, installs dependencies, emits the contract, and generates a deployable Composer app. PostgreSQL projects use Composer's native Prisma Postgres provider, including migrations and a typed runtime client.

PostgreSQL apps with Composer include `@prisma/dev` as a project devDependency for
local Postgres. In a monorepo it belongs at the root, where Composer runs. Prisma 8
does not include this runtime itself. MongoDB and Deno-only apps do not need it.

create-prisma checks the selected package manager before writing project files and never upgrades your package manager automatically.

The deployment prompt is:

```text
Deploy to Prisma now?
```

Choose no to deploy later with the generated `deploy` script.

New apps explicitly use `us-east-1` in the Composer section of `prisma.config.ts`. Change the
`prismaCloud({ region })` option before deploying if you need another region.
Composer requires a region when creating a new project; leaving it unspecified
only works when deploying into an existing project whose region can be inherited.

When multiple Prisma workspace sessions are available, the CLI asks which workspace should receive
the deployment. For unattended usage, pass `--workspace <id-or-name>` or omit it to use the active
workspace. Choosing another workspace also updates the Prisma CLI's active workspace session.

## Templates

- `minimal`
- `hono`
- `elysia`
- `nest`
- `next`
- `turborepo` (Hello World Node.js server in `apps/server`, shared Prisma package in `packages/database`)
- `svelte` (SvelteKit)
- `astro`
- `nuxt`
- `tanstack-start`

PostgreSQL and MongoDB are supported with PSL or TypeScript contract authoring. npm, pnpm, Yarn, and Bun are supported.

Deno is supported for local minimal PostgreSQL apps:

```bash
deno run -A --minimum-dependency-age=0 npm:create-prisma@latest my-deno-app --template minimal --provider postgres --package-manager deno --no-deploy
```

Deno 2.9 blocks packages published within the previous 24 hours by default. The explicit
dependency-age flag ensures a newly published `create-prisma` release is selected instead of an
older cached version. Prisma Compute does not support Deno deployments yet.

## Options

- positional project name or `--name`
- `--template`
- `--provider postgres|postgresql|mongo|mongodb`
- `--authoring psl|typescript`
- `--package-manager npm|pnpm|yarn|bun|deno`
- `--deploy` / `--no-deploy`
- `--workspace <id-or-name>`
- `--skills <agents>|none`: agents to install skill files for, comma-separated from `claude`, `cursor`, `agents`, `devin` (default: all). `--skills none` writes no `.claude/`, `.cursor/`, `.agents/`, or `.devin/` directories, no `postinstall` hook, and no `skills:sync` script, and records `skills: { agents: [] }` in `prisma.config.ts`. Interactive runs ask instead.
- `--yes`
- `--force`: overwrite generated starter and Prisma files in a non-empty directory. This replaces existing Prisma config, contract, and database-client files; back up edits first. A non-empty standard `migrations` path is protected: use a new directory for a fresh starter, or continue working in the existing project with the Prisma CLI. Custom migration paths are not detected.
- `--verbose`
- `--json`

Without `--force`, non-empty directories are left unchanged. Interactive runs offer to create
an available name, choose another name, or cancel. An existing app without `prisma.config.ts`
also offers to add Prisma through the official `prisma orm init` command. This runs ORM setup
only, not starter generation or deployment; Prisma's own overwrite-consent prompts remain active.
The default project name skips occupied paths. `--yes`, `--json` and non-TTY collisions still fail
without modifying the existing directory.

### JSON output for agents and automation

Use `--json` when another program is driving `create-prisma`:

```bash
bunx create-prisma@latest my-app --template next --package-manager bun --no-deploy --json
```

JSON mode is non-interactive and deploys by default; pass `--no-deploy` to generate locally only. It
writes exactly one compact result object to stdout and suppresses all human UI and subprocess output.
Successful results include the generated project, deployment metadata, next steps, and warnings.
Errors use the same envelope with `ok: false`, an actionable message, and the stage that failed.
`--verbose` is intentionally incompatible with `--json` so the machine-readable contract stays
deterministic.

This branch intentionally targets Prisma 8 only. It does not generate a Prisma 7 compatibility path.

## Development

```bash
bun install
bun run test:unit
bun run typecheck
bun run check
bun run build
```

## Telemetry

Published builds may send anonymous usage telemetry. It never includes project names, file paths, or database URLs. Failure events carry only stable identifiers such as exit codes and tool error codes, never messages or command output. A run rejected for a non-empty directory reports only whether that directory held an existing app, a Prisma project, or other files. Disable it with `DO_NOT_TRACK`, `CREATE_PRISMA_DISABLE_TELEMETRY`, or `CREATE_PRISMA_TELEMETRY_DISABLED`.
