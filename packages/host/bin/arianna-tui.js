#!/usr/bin/env node
// arianna-tui — launches the terminal UI against the resolved profile.
// dist/index.js auto-invokes main() at import time, so we only need to
// catch import-time errors (e.g., dist not built) and surface them cleanly.
import("../dist/index.js").catch((err) => {
  process.stderr.write(`error: arianna-tui failed to load: ${(err && err.message) || err}\n`);
  process.exit(1);
});
