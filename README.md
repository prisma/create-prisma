# create-prisma

A modern Prisma 7 CLI with first-party project templates and great init DX.

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

Initialize Prisma explicitly in the current project:

```bash
create-prisma init
```

Set package manager non-interactively:

```bash
create-prisma init --package-manager pnpm --install
```

Skip Prisma Client generation:

```bash
create-prisma init --no-generate
```

Show verbose command output:

```bash
create-prisma init --verbose
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
- runs `prisma generate` automatically after scaffolding

`create` is the default command and currently supports:
- templates: `hono`, `next`
- project name via `--name`
- schema presets via `--schema-preset empty|basic` (default: `basic`)

`init` configures Prisma in the current project and supports schema presets too (default: `empty`).
Both commands prompt for database choice, package manager, and whether to install dependencies now.
Supported providers in this flow: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `cockroachdb`.
Supported package managers: `bun`, `pnpm`, `npm`.
Package manager prompt auto-detects from `package.json`/lockfiles/user agent and uses that as the initial selection.
`--yes` accepts defaults (`postgresql`, detected package manager, Prisma Postgres enabled for PostgreSQL, install enabled) and skips prompts.
`--no-generate` skips automatic `prisma generate`.
`--verbose` prints full install/generate command output; default mode keeps output concise.
`--force` (create only) allows scaffolding in a non-empty target directory.
If Prisma files already exist, `init` asks whether to keep existing files or overwrite them.
When `postgresql` is selected, `init` can provision Prisma Postgres via `create-db --json` and auto-fill `DATABASE_URL`.

## Scripts

- `bun run build` - Build to `dist/`
- `bun run dev` - Watch mode build
- `bun run start` - Run built CLI
- `bun run typecheck` - TypeScript checks only
- `bun run changeset` - Create a changeset entry
- `bun run version-packages` - Apply version/changelog updates from changesets
- `bun run release` - Build and publish with `npm publish`

## Changelog Workflow

This repo uses Changesets and GitHub Actions:

1. Create a changeset in your PR via `bun run changeset`.
2. Merge to `main`.
3. The `Publish` workflow opens/updates a release PR with version and `CHANGELOG.md` updates.
4. Merge the release PR to trigger automated publish via npm trusted publishing (OIDC, no npm token secret).
