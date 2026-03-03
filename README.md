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

Or run locally:

```bash
bun install
bun run build
bun run start
```

The CLI updates `package.json` with Prisma dependencies, optionally runs dependency installation with your selected package manager, and scaffolds Prisma 7 setup files directly inside each app template:
- `prisma/schema.prisma`
- `prisma/seed.ts`
- `src/lib/prisma.ts` or `src/lib/server/prisma.ts`
- `prisma.config.ts`
- `generated/prisma`
- `.env` (creates or updates `DATABASE_URL`, and writes `CLAIM_URL` when Prisma Postgres is provisioned)
- runs `prisma generate` automatically after scaffolding

`create` is the default command and currently supports:
- templates: `hono`, `next`, `svelte`, `astro`
- project name via `--name`
- schema presets via `--schema-preset empty|basic` (default: `basic`)

`create` prompts for database choice, package manager, and whether to install dependencies now.
Supported providers in this flow: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `cockroachdb`.
Supported package managers: `bun`, `pnpm`, `npm`.
Package manager prompt auto-detects from `package.json`/lockfiles/user agent and uses that as the initial selection.
`--yes` accepts defaults (`postgresql`, detected package manager, Prisma Postgres enabled for PostgreSQL, install enabled) and skips prompts.
`--no-generate` skips automatic `prisma generate`.
`--verbose` prints full install/generate command output; default mode keeps output concise.
`--force` (create only) allows scaffolding in a non-empty target directory.
When `postgresql` is selected, `create` can provision Prisma Postgres via `create-db --json` and auto-fill `DATABASE_URL`.
Generated projects also include `db:seed` and configure Prisma's `migrations.seed` hook to run `tsx prisma/seed.ts`.

## Scripts

- `bun run build` - Build to `dist/`
- `bun run dev` - Watch mode build
- `bun run start` - Run built CLI
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
4. GitHub Actions creates the `vX.Y.Z` tag and GitHub Release notes via `changelogithub`.
5. GitHub Actions publishes only for `chore(release):` commits, using npm trusted publishing (OIDC, no npm token secret).
