# create-prisma

Scaffold a new app with Prisma already wired up.

`create-prisma` gives you a project template, Prisma setup, database scripts, and a working starting point without making you assemble everything by hand.

## What It Does

- creates a new app from a supported template
- adds Prisma 7 dependencies for your database
- scaffolds `prisma/schema.prisma`, `prisma/seed.ts`, and `prisma.config.ts`
- writes a Prisma client singleton in the right place for the selected template
- adds `db:generate`, `db:migrate`, and `db:seed` scripts
- creates or updates `.env` with `DATABASE_URL`
- can install dependencies and run `prisma generate` for you

## Quick Start

Use the package runner you already have:

```bash
npx create-prisma@latest
```

```bash
pnpm dlx create-prisma@latest
```

```bash
yarn dlx create-prisma@latest
```

```bash
bunx create-prisma@latest
```

```bash
deno run -A npm:create-prisma@latest
```

If you already have it available locally:

```bash
create-prisma
```

## Common Examples

Create a project interactively:

```bash
create-prisma
```

Create a Hono app non-interactively:

```bash
create-prisma --name my-api --template hono --provider postgresql
```

Scaffold into the current directory:

```bash
create-prisma --name . --template hono --provider postgresql
```

Create a monorepo with a shared Prisma package:

```bash
create-prisma --name my-monorepo --template turborepo --provider postgresql
```

Use Prisma Postgres auto-provisioning:

```bash
create-prisma --name my-app --template nest --provider postgresql --prisma-postgres
```

## Supported Templates

- `hono`
- `elysia`
- `nest`
- `next`
- `svelte`
- `astro`
- `nuxt`
- `tanstack-start`
- `turborepo`

## Supported Databases

- `postgresql`
- `mysql`
- `sqlite`
- `sqlserver`
- `cockroachdb`

## Supported Package Managers

- `npm`
- `pnpm`
- `yarn`
- `bun`
- `deno`

## Useful Flags

- `--name` project name or relative path
- `--template` choose the template
- `--provider` choose the database provider
- `--package-manager` choose the package manager/runtime
- `--schema-preset empty|basic`
- `--yes` accept defaults and skip prompts
- `--no-install` scaffold only
- `--no-generate` skip `prisma generate`
- `--prisma-postgres` provision Prisma Postgres for PostgreSQL
- `--skills --mcp --extension` enable optional add-ons
- `--force` allow scaffolding into a non-empty directory
- `--verbose` print full command output

## Add-ons

`create-prisma` can also help with a few optional extras:

- Prisma skills for coding agents
- Prisma MCP setup
- Prisma IDE extension install

These can be selected interactively or enabled with flags.

## Local Development

```bash
bun install
bun run check
bun run build
bun run start
```

Useful repo scripts:

- `bun run dev`
- `bun run typecheck`
- `bun run format`
- `bun run lint`
- `bun run bump`

## Telemetry

Published builds may send anonymous usage telemetry to help improve the CLI. It does not include project names, file paths, or database URLs.

Disable it with any of:

- `DO_NOT_TRACK`
- `CREATE_PRISMA_DISABLE_TELEMETRY`
- `CREATE_PRISMA_TELEMETRY_DISABLED`
