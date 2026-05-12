#!/usr/bin/env node
// Defers to the compiled entrypoint. Calling main() explicitly avoids fragile
// "is this the entrypoint" checks under symlinks / npm bin shims.
import("../dist/index.js").then(({ main }) =>
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`error: ${(err && err.message) || err}\n`);
      process.exit(1);
    },
  ),
);
