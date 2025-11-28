# create-prisma (minimal CLI)

Minimal ESM-first Node.js CLI scaffold built with [@clack/prompts](https://www.npmjs.com/package/@clack/prompts) and [tsdown](https://www.npmjs.com/package/tsdown).

## Usage

- Local dev:

```bash
npm install
npm run build
node dist/cli.js
```

- Execute via the bin shim:

```bash
node bin/create-prisma.js
```

## Scripts

- `npm run build` – build with tsdown to `dist/`
- `npm run dev` – rebuild on changes
- `npm run start` – run the built CLI (`dist/cli.js`)
- `npm run typecheck` – TypeScript type-check only

## Notes

- This project is ESM-first (`"type": "module"`).
- The executable entry is defined in `package.json` `bin` and implemented in `bin/create-prisma.js`.
- The actual CLI logic lives in `src/cli.ts` and is built to `dist/cli.js`.


