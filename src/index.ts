import { intro, outro, text, isCancel, select, spinner } from '@clack/prompts';
import type { DatabaseProvider } from './types.js';
import { ensureDir } from './utils/fs.js';
import { installPrismaAndDrivers } from './tasks/install.js';
import { prismaInit } from './tasks/prisma.js';
import { writeDbFile } from './tasks/generateDb.js';

export async function run(): Promise<void> {
  intro(`Create Prisma`);

  // 1) Database provider
  const databaseProvider = await select({
    message: 'Select your database',
    initialValue: 'postgresql',
    options: [
      { value: 'postgresql', label: 'Prisma PostgreSQL', hint: 'Default' },
      { value: 'mysql', label: 'MySQL' },
      { value: 'sqlite', label: 'SQLite' },
      { value: 'sqlserver', label: 'SQL Server' },
      { value: 'cockroachdb', label: 'CockroachDB' },
    ],
  });

  if (isCancel(databaseProvider)) {
    outro('Cancelled.');
    process.exit(0);
    return;
  }

  // Cast to known provider type
  const db = databaseProvider as DatabaseProvider;

  // 2) Source code directory
  const sourceDir = await text({
    message: 'Source code directory',
    placeholder: 'src',
    initialValue: 'src',
    validate(value) {
      if (!value || !value.trim()) return 'Please enter a directory';
    },
  });

  if (isCancel(sourceDir)) {
    outro('Cancelled.');
    process.exit(0);
    return;
  }

  // 3) Ensure directory exists
  const makeDirSpinner = spinner();
  makeDirSpinner.start(`Ensuring "${sourceDir}" exists...`);
  try {
    await ensureDir(String(sourceDir));
    makeDirSpinner.stop(`Directory ready: "${sourceDir}"`);
  } catch (err) {
    makeDirSpinner.stop('Failed to create source directory.');
    throw err;
  }

  // 4) Install Prisma packages
  const installSpinner = spinner();
  installSpinner.start('Installing Prisma dependencies...');
  try {
    const runtimePackages = await installPrismaAndDrivers(db);
    installSpinner.stop(
      `Installed: prisma (dev), ${runtimePackages.join(', ')}`,
    );
  } catch (err) {
    installSpinner.stop('Failed to install Prisma packages.');
    throw err;
  }

  // 5) Initialize Prisma with selected provider
  const initSpinner = spinner();
  initSpinner.start('Initializing Prisma project...');
  try {
    await prismaInit(String(databaseProvider));
    initSpinner.stop('Prisma initialized.');
  } catch (err) {
    initSpinner.stop('Failed to initialize Prisma.');
    throw err;
  }

  // 6) Create db/index.ts template
  const dbSpinner = spinner();
  dbSpinner.start('Creating prisma global...');
  try {
    const dbPath = await writeDbFile(String(sourceDir), db);
    dbSpinner.stop(`Created: ${dbPath}`);
  } catch (err) {
    dbSpinner.stop('Failed to create db.ts');
    throw err;
  }

  outro(
    `Setup complete.
    - Database: ${String(databaseProvider)}
    - Source dir: ${String(sourceDir)}
    - Prisma initialized and Prisma Instance generated in ${String(sourceDir)}

  Next Steps:
   - Generate your Prisma Client with "npx prisma generate"
   - Define your data model in prisma/schema.prisma
   - Visit https://www.prisma.io/docs/getting-started to learn more`,
  );
}

// Allow running directly when transpiled or executed with a TS runner.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
