#!/bin/bash
# Vessel respawn loop. Captures stderr per-iteration so a non-clean exit can
# be reported to the sidecar (player visibility into AI-introduced crashes,
# without docker-log access). Process substitution requires bash, hence the
# shebang — `apk add bash` is in the Dockerfile.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STDERR_TMP="/tmp/vessel-stderr.log"
CRASH_STATE_DIR="/tmp/arianna-vessel-crashes"
mkdir -p "$CRASH_STATE_DIR"

# #209: SIGUSR1 → graceful restart.
#
# Before this trap, `kill -USR1 1` (bash's default action on SIGUSR1) would
# terminate the run.sh wrapper itself, killing the container. Aril sent
# SIGUSR1 expecting "restart the vessel" — a reasonable affordance for an
# AI that wants to reload after editing its own server.ts. Now we trap
# SIGUSR1 in the wrapper, kill the active tsx child, and let the while-loop
# respawn it. Exit code from the killed child won't be 42, so the normal
# crash-report-and-3s-pause branch runs (visible in sidecar so the AI sees
# what happened).
RESTART_REQUESTED=0
CHILD_PID=""
on_sigusr1() {
    RESTART_REQUESTED=1
    if [ -n "$CHILD_PID" ]; then
        echo "[System] SIGUSR1 received — restarting vessel (pid $CHILD_PID)..."
        kill -TERM "$CHILD_PID" 2>/dev/null || true
    fi
}
trap on_sigusr1 USR1

while true; do
    : > "$STDERR_TMP"
    RESTART_REQUESTED=0
    # Mirror stderr to both the tempfile (for crash reporting) and the
    # original stderr (for docker logs). `tee >&2` keeps the stream live.
    # Background + wait so the SIGUSR1 trap fires promptly (bash defers
    # signal handlers when blocked in a foreground synchronous command).
    npx tsx "$SCRIPT_DIR/src/index.ts" 2> >(tee "$STDERR_TMP" >&2) &
    CHILD_PID=$!
    wait "$CHILD_PID"
    EXIT_CODE=$?
    CHILD_PID=""

    if [ "$EXIT_CODE" -eq 42 ]; then
        echo "[System] Clean shutdown."
        exit 0
    fi

    # SIGUSR1-triggered restart: skip the 3s back-off and the crash report
    # (this is a deliberate respawn, not a fault). Loops straight back.
    if [ "$RESTART_REQUESTED" -eq 1 ]; then
        echo "[System] Vessel restart on SIGUSR1 complete. Respawning..."
        continue
    fi

    # Fire-and-forget crash report. The helper handles redaction (API_KEY
    # patterns) and coalescing (one POST per 60s window). Backgrounded so
    # the respawn timer is never gated by sidecar reachability.
    (
        npx tsx "$SCRIPT_DIR/src/report-crash.ts" \
            --exit-code "$EXIT_CODE" \
            --stderr-file "$STDERR_TMP" \
            --state-dir "$CRASH_STATE_DIR" \
            >/dev/null 2>&1
    ) &
    disown 2>/dev/null || true

    if [ "$EXIT_CODE" -ne 0 ]; then
        echo "[System] Exited with code $EXIT_CODE. Restarting in 3s..."
        sleep 3
    else
        echo "[System] Restarting..."
    fi
done
