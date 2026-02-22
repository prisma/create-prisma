# create-prisma

A modern CLI for Prisma 7 initialization with adapter-aware templates.

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

Initialize explicitly in the current project:

```bash
create-prisma init
```

Or set package manager non-interactively:

```bash
create-prisma init --package-manager pnpm --install
```

Run fully non-interactive with defaults:

```bash
create-prisma init --yes
```

Use Prisma Postgres auto-provisioning for PostgreSQL:

```bash
create-prisma init --provider postgresql --prisma-postgres
```

Or run locally:

```bash
bun install
bun run build
bun run start
```

The CLI updates `package.json` with Prisma dependencies, optionally runs dependency installation with your selected package manager, and scaffolds Prisma 7 setup files from Handlebars templates:
- `prisma/schema.prisma`
- `prisma/index.ts`
- `prisma.config.ts`
- `.env` (creates or updates `DATABASE_URL`, and writes `CLAIM_URL` when Prisma Postgres is provisioned)

`init` prompts for database choice, package manager, and whether to install dependencies now.
Supported providers in this flow: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `cockroachdb`.
Supported package managers: `bun`, `pnpm`, `npm`.
Package manager prompt auto-detects from `package.json`/lockfiles/user agent and uses that as the initial selection.
`--yes` accepts defaults (`postgresql`, detected package manager, Prisma Postgres enabled for PostgreSQL, install enabled) and skips prompts.
When `postgresql` is selected, `init` can provision Prisma Postgres via `create-db --json` and auto-fill `DATABASE_URL`.

## Scripts

- `bun run build` - Build to `dist/`
- `bun run dev` - Watch mode build
- `bun run start` - Run built CLI
- `bun run typecheck` - TypeScript checks only
- `bun run changeset` - Create a changeset entry
- `bun run version-packages` - Apply version/changelog updates from changesets
- `bun run release` - Build and publish with `bun publish`

## Changelog Workflow

This repo uses Changesets and GitHub Actions:

1. Create a changeset in your PR via `bun run changeset`.
2. Merge to `main`.
3. The `Changesets` workflow opens/updates a release PR with version and `CHANGELOG.md` updates.
4. Merge the release PR to trigger automated publish via `bun publish`.
