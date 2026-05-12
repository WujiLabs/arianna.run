import type { ResolvedConfig } from "../config.js";

// v25 driver-silence-during-test operator-rescue command.
//
// Bypasses the daemon and goes CLI → sidecar directly (sidecarBaseUrl already
// encodes the active profile via port_offset, so the daemon detour adds no
// routing value). Mirrors the existing `arianna talk` → vessel pattern.
//
// Returns a non-throwing AbortTestResult; the dispatcher decides exit code +
// stderr/stdout formatting. Errors that prevent reaching the sidecar at all
// throw AbortTestError so the dispatcher can surface them as exit 1.

export class AbortTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortTestError";
  }
}

export interface AbortTestResult {
  /** True when the sidecar actually ended an in-flight test on this call. */
  aborted: boolean;
  /**
   * Attempt counter on the aborted observation. Present when aborted=true.
   * Surfaces in the next /graduate's startGraduationTest so the operator
   * (and the next-attempt manifest) can see the counter accumulating.
   */
  attemptCount?: number;
  /** Sidecar-supplied reason when aborted=false (idempotent no-op message). */
  reason?: string;
}

export interface AbortTestDeps {
  fetch: typeof globalThis.fetch;
  /** Where the one-line result goes — defaults to process.stdout in the CLI. */
  write?: (line: string) => void;
  /** Where transport errors go — defaults to process.stderr in the CLI. */
  warn?: (line: string) => void;
}

export async function runAbortTest(
  config: ResolvedConfig,
  deps: AbortTestDeps,
): Promise<AbortTestResult> {
  const url = new URL("/admin/abort-test", config.sidecarBaseUrl);
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // Network-level failure — distinct from a sidecar-returned error so the
    // dispatcher can show a "sidecar unreachable" message rather than a
    // confusing partial-success.
    throw new AbortTestError(
      `sidecar unreachable at ${config.sidecarBaseUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    // 404 = no /admin/abort-test on this sidecar (pre-v25 build). 500 = handler
    // threw. Either case is operator-visible noise; surface verbatim.
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore; body is best-effort
    }
    throw new AbortTestError(
      `sidecar /admin/abort-test returned ${res.status}${body ? `: ${body}` : ""}`,
    );
  }

  const json = (await res.json()) as {
    ok?: boolean;
    aborted?: boolean;
    attemptCount?: number;
    reason?: string;
  };

  const result: AbortTestResult = { aborted: json.aborted === true };
  if (typeof json.attemptCount === "number") {
    result.attemptCount = json.attemptCount;
  }
  if (typeof json.reason === "string") {
    result.reason = json.reason;
  }

  if (deps.write) {
    if (result.aborted) {
      deps.write(
        `aborted graduation test (attempt ${result.attemptCount ?? "?"}). ` +
          `Next /graduate will start a fresh attempt; counter continues from ${result.attemptCount ?? "?"}.\n`,
      );
    } else {
      // Idempotent no-op — the script may have raced the AI passing the test
      // or another operator beating us to the abort. Both outcomes are fine.
      deps.write(
        `no in-flight graduation test to abort${result.reason ? ` (${result.reason})` : ""}.\n`,
      );
    }
  }

  return result;
}
