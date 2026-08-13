# create-prisma

Create a Prisma Next app with Prisma Composer built in.

## Quick start

Use your package manager:

```bash
npx create-prisma@next my-app
pnpm dlx create-prisma@next my-app
yarn dlx create-prisma@next my-app
bunx create-prisma@next my-app
```

The CLI initializes Prisma Next with `@prisma/cli@next`, installs dependencies, emits the contract, and generates a deployable Composer app. PostgreSQL projects use Composer's native Prisma Postgres provider, including migrations and a typed runtime client.

The only Composer prompt is:

```text
Deploy to Prisma now?
```

Choose no to deploy later with the generated `deploy` script.

## Templates

- `minimal`
- `hono`
- `elysia`
- `nest`
- `next`
- `svelte` (SvelteKit)
- `astro`
- `nuxt`
- `tanstack-start`

PostgreSQL and MongoDB are supported with PSL or TypeScript contract authoring. npm, pnpm, Yarn, and Bun are supported.

## Options

- positional project name or `--name`
- `--template`
- `--provider postgres|postgresql|mongo|mongodb`
- `--authoring psl|typescript`
- `--package-manager npm|pnpm|yarn|bun`
- `--deploy` / `--no-deploy`
- `--yes`
- `--force`
- `--verbose`

This branch intentionally targets Prisma Next only. It does not generate a Prisma 7 compatibility path.

## Development

```bash
bun install
bun run test:unit
bun run typecheck
bun run check
bun run build
```

## Telemetry

Published builds may send anonymous usage telemetry. It never includes project names, file paths, or database URLs. Disable it with `DO_NOT_TRACK`, `CREATE_PRISMA_DISABLE_TELEMETRY`, or `CREATE_PRISMA_TELEMETRY_DISABLED`.
