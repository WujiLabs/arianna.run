// Shim that lets test/cli-additions.sh invoke the CLI source via tsx without
// requiring a build. The real bin/arianna.js imports the compiled
// dist/index.js — we point at the .ts source under tsx instead.
//
// Why a separate file: index.ts deliberately doesn't auto-invoke main() so
// that tests can import it without side effects. The real bin file invokes
// main() explicitly. This shim is the test-mode equivalent.
import("../packages/cli/src/index.ts").then(({ main }) =>
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`error: ${(err && err.message) || err}\n`);
      process.exit(1);
    },
  ),
);
