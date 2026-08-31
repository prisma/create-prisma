# create-prisma

Create a Prisma 8 app with Prisma Composer built in.

## Quick start

Use your package manager:

```bash
npx create-prisma@latest my-app
pnpm dlx create-prisma@latest my-app
yarn dlx create-prisma@latest my-app
bunx create-prisma@latest my-app
```

The CLI initializes Prisma 8 with `prisma@latest`, installs dependencies, emits the contract, and generates a deployable Composer app. PostgreSQL projects use Composer's native Prisma Postgres provider, including migrations and a typed runtime client.

The deployment prompt is:

```text
Deploy to Prisma now?
```

Choose no to deploy later with the generated `deploy` script.

When multiple Prisma workspace sessions are available, the CLI asks which workspace should receive
the deployment. For unattended usage, pass `--workspace <id-or-name>` or omit it to use the active
workspace. Choosing another workspace also updates the Prisma CLI's active workspace session.

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
- `--yes`
- `--force`
- `--verbose`
- `--json`

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

Published builds may send anonymous usage telemetry. It never includes project names, file paths, or database URLs. Disable it with `DO_NOT_TRACK`, `CREATE_PRISMA_DISABLE_TELEMETRY`, or `CREATE_PRISMA_TELEMETRY_DISABLED`.
