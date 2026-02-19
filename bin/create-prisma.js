#!/usr/bin/env node

// ESM entrypoint that invokes the built CLI.
import('../dist/index.js')
  .then((mod) => {
    if (typeof mod.run === 'function') {
      return mod.run();
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
