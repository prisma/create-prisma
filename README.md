# create-prisma

Scaffold a new app with Prisma Next already wired up.

`create-prisma@next` gives you a project template, Prisma Next setup, database scripts, and a working starting point without making you assemble everything by hand.

## What It Does

- creates a new app from a supported template
- adds Prisma Next dependencies for PostgreSQL or MongoDB
- scaffolds `prisma/contract.prisma` or `prisma/contract.ts`
- scaffolds `prisma-next.config.ts`
- writes a template-specific Prisma Next runtime helper
- adds `contract:emit`, `db:init`, `db:update`, `migration:plan`, and `migration:apply` scripts
- creates or updates `.env` with `DATABASE_URL`
- can install dependencies and run `prisma-next contract emit`

`db:init`, migrations, and seeding are never run automatically. PostgreSQL projects show
`db:init` as a manual follow-up command; MongoDB projects show the migration plan/apply path
for initial schema setup.

## Quick Start

Use the package runner you already have:

```bash
npx create-prisma@next
```

```bash
pnpm dlx create-prisma@next
```

```bash
yarn dlx create-prisma@next
```

```bash
bunx create-prisma@next
```

```bash
deno run -A npm:create-prisma@next
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
create-prisma --name my-api --template hono --provider postgres
```

Create a MongoDB app:

```bash
create-prisma --name my-api --template hono --provider mongodb
```

Scaffold into the current directory:

```bash
create-prisma --name . --template hono --provider postgres
```

Create a monorepo with a shared Prisma Next package:

```bash
create-prisma --name my-monorepo --template turborepo --provider postgres
```

Use TypeScript contract authoring:

```bash
create-prisma --name my-app --template next --authoring typescript
```

Use Prisma Postgres auto-provisioning:

```bash
create-prisma --name my-app --template nest --provider postgres --prisma-postgres
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

- `postgres` / `postgresql`
- `mongo` / `mongodb`

## Supported Package Managers

- `npm`
- `pnpm`
- `yarn`
- `bun`
- `deno`

## Useful Flags

- `--name` project name or relative path
- `--template` choose the template
- `--provider postgres|postgresql|mongo|mongodb`
- `--authoring psl|typescript`
- `--package-manager` choose the package manager/runtime
- `--schema-preset empty|basic`
- `--database-url` set `DATABASE_URL`
- `--yes` accept defaults and skip prompts
- `--no-install` scaffold only
- `--no-emit` skip `prisma-next contract emit`
- `--prisma-postgres` provision Prisma Postgres for PostgreSQL
- `--skills --mcp --extension` enable optional add-ons
- `--force` allow scaffolding into a non-empty directory
- `--verbose` print full command output

Generated Node-based Prisma Next projects document Node.js 24 LTS or newer.

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
