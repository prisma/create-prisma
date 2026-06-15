# create-prisma

Scaffold a new app with Prisma already wired up.

`create-prisma` gives you a project template, Prisma setup, database scripts, and a working starting point without making you assemble everything by hand.

## What It Does

- creates a new app from a supported template
- adds Prisma 7 dependencies for your database
- scaffolds `prisma/schema.prisma`, `prisma/seed.ts`, `prisma.config.ts`, and Compute deploy defaults for Compute-ready templates
- writes a Prisma client singleton in the right place for the selected template
- adds `db:generate`, `db:migrate`, and `db:seed` scripts
- creates or updates the template env file with `DATABASE_URL`
- can install dependencies and run `prisma generate` for you
- can deploy the finished app to Prisma Compute and return a live URL

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

Deploy a supported app to Prisma Compute:

```bash
create-prisma --name my-api --template hono --provider postgresql --deploy
```

With PostgreSQL and no `--database-url`, the Compute flow asks whether to use Prisma Postgres. If accepted, or if `--prisma-postgres` is passed, it creates a Prisma Compute project, creates a `main` Prisma Postgres database on the `main` branch, writes `DATABASE_URL` to the template env file, and deploys the app with the env file configured in `prisma.compute.ts`. Pass `--no-prisma-postgres` to deploy without provisioning a database.

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

Prisma Compute deployment is currently supported for:

- `hono`
- `elysia`
- `next`
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
- `--deploy` deploy supported templates to Prisma Compute
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
When Prisma Compute deploy is selected, the skills add-on recommends the `prisma-compute` skill too.

## Deploy to Prisma Compute

After scaffolding, `create-prisma` can deploy your app to [Prisma Compute](https://www.prisma.io/docs/compute), the serverless hosting for TypeScript apps that runs next to your Prisma Postgres database. It is offered for the templates the Prisma CLI can deploy today: `hono`, `elysia`, `next`, `astro`, `nuxt`, `tanstack-start`, and `turborepo`.

Accept the deploy prompt when it appears, or pass the flag:

```bash
create-prisma --name my-api --template hono --provider postgresql --deploy
```

The deploy step signs you in with the Prisma CLI if you are not signed in yet. With PostgreSQL and no `--database-url`, create-prisma asks whether to use Prisma Postgres. If accepted, or if `--prisma-postgres` is passed, setup creates a Prisma Compute project, creates a `main` Prisma Postgres database on the `main` branch, writes `DATABASE_URL` to the template env file, runs the requested Prisma setup, then deploys the app with the env file configured in `prisma.compute.ts`. Pass `--no-prisma-postgres` to deploy without provisioning a database.

A `prisma.compute.ts` file is generated with the app framework, runtime port, target, and env-file defaults. When deployment is selected, a `compute:deploy` script is added to the generated project so you can redeploy app changes later. That script runs `@prisma/cli@latest app deploy` using `prisma.compute.ts`; it does not create a new project, create a new database, run migrations, or seed data.

The deploy prompt is skipped in `--yes` runs unless you pass `--deploy`. Browser sign-in may still need a person at the keyboard if no Prisma CLI session exists.

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
