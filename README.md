# create-prisma

A modern Prisma 7 CLI with first-party project templates and a smooth create flow.

## Stack

- `trpc-cli` for command routing
- `zod@4` for validated input schemas
- `@clack/prompts@1` for interactive UX
- `execa` for external command execution
- `fs-extra` for filesystem operations
- `handlebars` for conditional template rendering
- `tsdown` for ESM builds

## Usage

Run directly with Bun:

```bash
bunx create-prisma@latest
```

Run directly with Yarn:

```bash
yarn dlx create-prisma@latest
```

Run directly with Deno:

```bash
deno run -A npm:create-prisma@latest
```

Create a new project (default command):

```bash
create-prisma
```

Create a Hono project non-interactively:

```bash
create-prisma --name my-api --template hono --provider postgresql
```

Create a Next.js project non-interactively:

```bash
create-prisma --name my-web --template next --provider postgresql
```

Create a SvelteKit project non-interactively:

```bash
create-prisma --name my-app --template svelte --provider postgresql
```

Create an Astro project non-interactively:

```bash
create-prisma --name my-site --template astro --provider postgresql
```

Create a Nuxt project non-interactively:

```bash
create-prisma --name my-nuxt-app --template nuxt --provider postgresql
```

Create a TanStack Start project non-interactively:

```bash
create-prisma --name my-start-app --template tanstack-start --provider postgresql
```

Create a Turborepo project with a `packages/db` Prisma package:

```bash
create-prisma --name my-monorepo --template turborepo --provider postgresql
```

Set package manager non-interactively:

```bash
create-prisma --name my-app --template hono --package-manager pnpm --install
```

Skip Prisma Client generation:

```bash
create-prisma --name my-app --template hono --no-generate
```

Show verbose command output:

```bash
create-prisma --name my-app --template hono --verbose
```

Run fully non-interactive with defaults:

```bash
create-prisma --yes
```

Use Prisma Postgres auto-provisioning for PostgreSQL:

```bash
create-prisma --name my-app --template hono --provider postgresql --prisma-postgres
```

Enable add-ons with individual flags:

```bash
create-prisma --name my-app --template next --skills --mcp --extension
```

Or run locally:

```bash
bun install
bun run check
bun run build
bun run start
```

The CLI updates `package.json` with Prisma dependencies, optionally runs dependency installation with your selected package manager, and scaffolds Prisma 7 setup files directly inside each app template:

- `prisma/schema.prisma`
- `prisma/seed.ts`
- `src/lib/prisma.ts`, `src/lib/prisma.server.ts`, `src/lib/server/prisma.ts`, `server/utils/prisma.ts`, or `packages/db/src/client.ts`
- `prisma.config.ts`
- `src/generated/prisma` or `server/generated/prisma` (Nuxt) or `packages/db/src/generated/prisma` (Turborepo)
- `.env` (creates or updates `DATABASE_URL`, and writes `CLAIM_URL` when Prisma Postgres is provisioned)
- runs `prisma generate` automatically after scaffolding

`create` is the default command and currently supports:

- templates: `hono`, `next`, `svelte`, `astro`, `nuxt`, `tanstack-start`, `turborepo`
- project name via `--name`
- schema presets via `--schema-preset empty|basic` (default: `basic`)

`create` prompts for database choice, package manager, and whether to install dependencies now.
Supported providers in this flow: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `cockroachdb`.
Supported package managers: `bun`, `deno`, `npm`, `pnpm`, `yarn`.
Package manager prompt auto-detects from `package.json`/lockfiles/user agent and uses that as the initial selection.
`--yes` accepts defaults (`postgresql`, detected package manager, Prisma Postgres enabled for PostgreSQL, install enabled) and skips prompts.
`--no-generate` skips automatic `prisma generate`.
`--verbose` prints full install/generate command output; default mode keeps output concise.
`--force` (create only) allows scaffolding in a non-empty target directory.
Add-ons can be selected interactively or through flags: `--skills`, `--mcp`, `--extension`.
When add-ons are enabled, `create` prompts for the relevant agent and IDE selections, then installs curated Prisma skills (`skills@latest`), configures Prisma MCP (`add-mcp@latest`), and installs the Prisma IDE extension for supported IDE CLIs.
When `postgresql` is selected, `create` can provision Prisma Postgres via `create-db --json` and auto-fill `DATABASE_URL`.
Generated projects also include `db:seed` and configure Prisma's `migrations.seed` hook to run `tsx prisma/seed.ts`.

## Telemetry

The published CLI can send anonymous, high-signal telemetry to PostHog for completed and failed `create` runs. It currently emits `cli:create_command_completed` and `cli:create_command_failed`, following Prisma's `category:object_action` naming convention, and records resolved setup choices such as template, provider, package manager, add-ons, duration, and failure stage.

It does not send project names, file paths, database URLs, or prompt-by-prompt interactions. A random anonymous ID is stored in the local config directory so repeat usage can be counted without fingerprinting, events are marked to avoid creating person profiles for anonymous CLI usage, and custom event properties use kebab-case to match Prisma's PostHog convention.

Telemetry is disabled automatically when:

- the package was built without `CREATE_PRISMA_TELEMETRY_API_KEY`
- `CI`, `GITHUB_ACTIONS`, `DO_NOT_TRACK`, `CREATE_PRISMA_DISABLE_TELEMETRY`, or `CREATE_PRISMA_TELEMETRY_DISABLED` is set

For preview and release builds, set `CREATE_PRISMA_TELEMETRY_API_KEY` and optionally `CREATE_PRISMA_TELEMETRY_HOST`. The default host is `https://us.i.posthog.com`.

## Scripts

- `bun run build` - Build to `dist/`
- `bun run check` - Run formatting and lint checks
- `bun run dev` - Watch mode build
- `bun run start` - Run built CLI
- `bun run lint` - Run `oxlint` with warnings treated as failures
- `bun run lint:fix` - Apply safe `oxlint` fixes
- `bun run format` - Format the repo with `oxfmt`
- `bun run format:check` - Check formatting with `oxfmt`
- `bun run typecheck` - TypeScript checks only
- `bun run bump` - Create a release PR (interactive semver bump)
- `bun run bump -- patch|minor|major|x.y.z` - Non-interactive bump
- `bun run bump -- --dry-run patch` - Preview next version without changing files
- `bun run release-notes` - Generate GitHub release notes via `changelogithub`

## Release Workflow

This repo uses a manual, script-driven release flow:

1. Run `bun run bump` (or pass `patch|minor|major|x.y.z`).
2. The script creates a `release/vX.Y.Z` branch and a PR with commit `chore(release): X.Y.Z`.
3. Merge that PR to `main` with squash (keep commit title `chore(release): X.Y.Z`).
4. GitHub Actions runs `bun run check`, `bun run typecheck`, and `bun run build` before publishing.
5. GitHub Actions creates the `vX.Y.Z` tag and GitHub Release notes via `changelogithub`.
6. GitHub Actions publishes only for `chore(release):` commits, using npm trusted publishing (OIDC, no npm token secret).

Every PR from a branch in this repository also publishes a preview package to npm using the dist-tag `pr<PR_NUMBER>`, so PR 3 is installable as `create-prisma@pr3`.
