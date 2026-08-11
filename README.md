# create-prisma

Scaffold a new app with Prisma already wired up.

`create-prisma` gives you a project template, Prisma setup, database scripts, and a working starting point without making you assemble everything by hand.

## What It Does

- creates a new app from a supported template
- adds Prisma 7 dependencies for your database
- scaffolds `prisma/schema.prisma`, `prisma/seed.ts`, `prisma.config.ts`, and a Composer application graph for supported templates
- writes a Prisma client singleton in the right place for the selected template
- adds `db:generate`, `db:migrate`, `db:migrate:deploy`, and `db:seed` scripts
- creates an env example for databases managed outside Composer
- installs dependencies when requested, then generates Prisma Client and an initial migration automatically
- can deploy the finished app and its Prisma Postgres database with Prisma Composer

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

Use Prisma Postgres auto-provisioning, which is the PostgreSQL default:

```bash
create-prisma --name my-app --template nest --provider postgresql
```

Deploy a supported app with Prisma Composer:

```bash
create-prisma --name my-api --template hono --provider postgresql --deploy
```

PostgreSQL always includes Prisma Postgres in the Composer application graph. The generated deploy script provisions it with the app, applies the generated migration with `prisma migrate deploy`, seeds it, and removes the temporary direct connection used for setup.

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

Prisma Composer files are included by default, and deployment is supported for:

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

Every package manager receives the same Composer-ready templates and deploy scripts.

## Useful Flags

- `--name` project name or relative path
- `--template` choose the template
- `--provider` choose the database provider
- `--package-manager` choose the package manager/runtime
- `--deploy` deploy supported templates with Prisma Composer
- `--yes` accept defaults and skip prompts
- `--no-install` scaffold only
- `--skills --mcp --extension` enable optional add-ons
- `--force` allow scaffolding into a non-empty directory
- `--verbose` print full command output

## Add-ons

`create-prisma` can also help with a few optional extras:

- Prisma skills for coding agents
- Prisma MCP setup
- Prisma IDE extension install

These can be selected interactively or enabled with flags.

## Deploy with Prisma Composer

Supported templates include Composer by default: `module.ts` declares the application graph, `service.ts` declares the Compute service and its dependencies, and `prisma-composer.config.ts` selects the Prisma Cloud target. The generated project is ready to deploy whether or not you deploy during creation.

Accept the deploy prompt when it appears, or pass the flag:

```bash
create-prisma --name my-api --template hono --provider postgresql --deploy
```

Deployment currently requires `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID`. PostgreSQL always provisions Prisma Postgres and passes its connection through `service.load()`. For other providers, copy `.env.example` to `.env`, set `DATABASE_URL`, and Composer will pass it to the application as a secret input.

A `deploy` script is generated for every supported package manager. It builds and deploys the Composer application. For PostgreSQL it then resolves the Composer-managed database, applies the committed migration with `prisma migrate deploy`, seeds the database, and removes the temporary direct connection. No database URL is written back to the project.

The only Composer-specific prompt asks whether to deploy immediately. It is skipped in `--yes` runs unless you pass `--deploy`; the Composer files are still generated. Prisma Client generation is automatic, and PostgreSQL uses Prisma Postgres by default without additional prompts.

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
