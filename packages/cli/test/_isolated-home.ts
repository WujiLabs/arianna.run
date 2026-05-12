// Shared "this path will never resolve to a real ~/.arianna/" sentinel for
// tests that don't care about profile state and just want resolveConfig to
// behave deterministically (legacy 3000/8000/9000 ports, no profile loaded).
//
// Picked so existsSync returns false on macOS and Linux without touching
// the user's actual home dir.
export const ISOLATED_ARIANNA_HOME = "/nonexistent-arianna-home-for-tests";
