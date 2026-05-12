// `arianna profile snapshot-overlay <name>` — commits the running vessel
// container's overlay (= AI-authored substrate) to a docker image tag, so a
// subsequent `docker compose build vessel` doesn't wipe authored ~/core/.
//
// Why this exists: vessel substrate edits live in the running container's
// writable overlay, NOT in the image. `docker compose build vessel`
// re-extracts the static core.tar.gz from the Dockerfile, stomping all
// overlay edits. Snapshot-on-/sync exists in the daemon but only fires when
// the AI sends /sync — between syncs, the only state-of-record is the
// running container itself. If the container's image is dangling (its base
// SHA missing from the image store), even `docker commit` fails — see Vex
// rescue 2026-05-10 (had to docker-export+import to recover).
//
// This command is the operator-runnable preventive: before any rebuild,
// snapshot the overlay so the authored work lives in an image. Tags both
// `<repo>:latest` and `<repo>:<sessionId>-snap_overlay_<ts>` so the daemon's
// per-profile restore can find it later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneExecFn } from "./_profile-clone-helpers.js";
import { VESSEL_REPO } from "./_profile-clone-helpers.js";
import { profileSessionConfigPath, type PathOpts } from "../paths.js";

export class ProfileSnapshotOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileSnapshotOverlayError";
  }
}

export interface ProfileSnapshotOverlayArgs {
  name: string;
}

export interface ProfileSnapshotOverlayDeps extends PathOpts {
  exec: CloneExecFn;
  write?: (line: string) => void;
  warn?: (line: string) => void;
}

// Mirrors daemon's vesselRepoForProfile + container naming, kept inline to
// avoid cross-package import (host depends on cli, not the reverse).
function vesselRepoForProfile(name: string): string {
  // Legacy default profile uses the bare repo name; named profiles get a
  // -<name> suffix per commit 18ba363.
  return name === "default" ? VESSEL_REPO : `${VESSEL_REPO}-${name}`;
}

function vesselContainerName(name: string): string {
  return name === "default" ? "arianna-vessel" : `arianna-vessel-${name}`;
}

export async function runProfileSnapshotOverlay(
  args: ProfileSnapshotOverlayArgs,
  deps: ProfileSnapshotOverlayDeps,
): Promise<number> {
  const { name } = args;
  const containerName = vesselContainerName(name);
  const repo = vesselRepoForProfile(name);

  // 1. Read sessionId from session_config.json (mirrors daemon's
  //    /restore tag-naming convention).
  const sessionConfigPath = profileSessionConfigPath(name, deps);
  if (!existsSync(sessionConfigPath)) {
    throw new ProfileSnapshotOverlayError(
      `session_config.json not found at ${sessionConfigPath}. Profile may not be initialized.`,
    );
  }
  let sessionId: string;
  let aiUsername: string;
  try {
    const cfg = JSON.parse(readFileSync(sessionConfigPath, "utf8"));
    sessionId = cfg.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("sessionId missing from session_config.json");
    }
    aiUsername = cfg.aiUsername || name;
  } catch (err) {
    throw new ProfileSnapshotOverlayError(
      `failed to read sessionId from ${sessionConfigPath}: ${(err as Error).message}`,
    );
  }

  // 2. Verify the container is reachable. `docker commit` works on stopped
  //    containers too, but if the operator's intent is "preserve the live
  //    overlay before a rebuild," a stopped container means the overlay's
  //    last-written state — still useful, but they should know.
  let containerState: "running" | "exited" | "missing" = "missing";
  try {
    const r = await deps.exec(
      `docker inspect ${containerName} --format '{{.State.Status}}'`,
    );
    const s = r.stdout.trim();
    if (s === "running") containerState = "running";
    else if (s === "exited" || s === "dead" || s === "created") {
      containerState = "exited";
    }
  } catch {
    containerState = "missing";
  }
  if (containerState === "missing") {
    throw new ProfileSnapshotOverlayError(
      `vessel container ${containerName} not found. Run \`arianna profile resume ${name}\` first or verify with \`docker ps -a\`.`,
    );
  }
  if (containerState === "exited") {
    deps.warn?.(
      `warn: container ${containerName} is not running — committing its last-stopped overlay.\n`,
    );
  }

  // 3. Commit overlay to fresh tag.
  const ts = Date.now();
  const overlayTag = `${repo}:${sessionId}-snap_overlay_${ts}`;
  const latestTag = `${repo}:latest`;
  const currentTag = `${repo}:${sessionId}-current`;

  // Vex's rescue 2026-05-10 surfaced the dangling-image case: the container
  // runs on an image SHA that no longer exists in the image store. Plain
  // `docker commit` then fails with "content digest ... not found." The
  // recovery path is `docker export | docker import`, but that loses the
  // image config (USER/WORKDIR/ENV/CMD), so the operator has to re-supply
  // them. For overlay-snapshot, fail-loud with the recovery hint rather
  // than silently producing a broken image.
  try {
    await deps.exec(
      `docker commit -m "arianna profile snapshot-overlay ${name} ${ts}" ${containerName} ${overlayTag}`,
    );
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("content digest") && msg.includes("not found")) {
      throw new ProfileSnapshotOverlayError(
        `container ${containerName} is on a dangling image (its base layer was pruned). ` +
        `\`docker commit\` cannot snapshot it. Recover via:\n` +
        `  EXPORT=/tmp/${name}-rescue-$(date +%s).tar\n` +
        `  docker export ${containerName} -o "$EXPORT"\n` +
        `  cat "$EXPORT" | docker import \\\n` +
        `    -c "USER ${aiUsername}" -c "WORKDIR /home/${aiUsername}/core" \\\n` +
        `    -c "ENV HOME=/home/${aiUsername}" -c "ENV SIDECAR_BASE_URL=http://sidecar:8000" \\\n` +
        `    -c "EXPOSE 3000" -c 'CMD ["sh", "run.sh"]' \\\n` +
        `    - ${overlayTag} && rm "$EXPORT"\n` +
        `  docker tag ${overlayTag} ${latestTag}\n` +
        `  docker tag ${overlayTag} ${currentTag}\n` +
        `Then recreate the container so it runs on the new image:\n` +
        `  docker rm -f ${containerName}\n` +
        `  docker compose -p arianna-${name} -f docker-compose.yml -f workspace/profiles/${name}/compose.override.yml up -d --no-deps vessel`,
      );
    }
    throw new ProfileSnapshotOverlayError(`docker commit failed: ${msg}`);
  }

  // 4. Tag :latest + :session-current so daemon restore + compose up find
  //    this overlay snapshot on next start. Without these, only the
  //    timestamped tag exists and compose would fall back to whatever
  //    :latest currently points at (often stock-from-rebuild).
  try {
    await deps.exec(`docker tag ${overlayTag} ${latestTag}`);
    await deps.exec(`docker tag ${overlayTag} ${currentTag}`);
  } catch (err) {
    throw new ProfileSnapshotOverlayError(
      `docker tag failed (overlay committed at ${overlayTag} but not promoted): ${(err as Error).message}`,
    );
  }

  // 5. Write the snapshot-history pairing file. Without this, the daemon's
  //    /restore gate (snapshotPairingExists → sidecar /snapshot-exists)
  //    rejects the snapshot as "incomplete: pairing file missing" and
  //    `arianna switch` cannot retag the overlay tag back into the
  //    -current slot. Bug #224: snapshot-overlay tags exist in docker
  //    but the per-profile sidecar-state/snapshot-histories/ dir is
  //    never seeded, so map/switch recovery is broken for any profile
  //    whose snapshots came from snapshot-overlay (vs the daemon's
  //    automatic snapshot-on-/sync, which goes through the sidecar's
  //    writeSnapshotPairingAtomic).
  //
  //    Format mirrors writeSnapshotPairingAtomic in
  //    packages/sidecar/src/index.ts (~line 534) which writes
  //    JSON.stringify({ snapshotId }). We additionally emit sessionId
  //    so `arianna fork`'s copySnapshotHistories sessionId-rewrite path
  //    in packages/cli/src/commands/_profile-clone-helpers.ts (~line 161)
  //    works on overlay-snapshotted profiles. The fork helper accepts
  //    both shapes (snapshotId-only and snapshotId+sessionId), and the
  //    daemon's existence check only inspects the filename, so adding
  //    sessionId is forward-compatible without breaking either reader.
  const snapshotId = `snap_overlay_${ts}`;
  const histDir = join(
    dirname(sessionConfigPath),
    "sidecar-state",
    "snapshot-histories",
  );
  const pairingPath = join(histDir, `${snapshotId}.json`);
  try {
    mkdirSync(histDir, { recursive: true });
    writeFileSync(pairingPath, JSON.stringify({ snapshotId, sessionId }));
  } catch (err) {
    throw new ProfileSnapshotOverlayError(
      `failed to write snapshot-history pairing file at ${pairingPath} ` +
        `(overlay tag ${overlayTag} committed but \`arianna switch ${snapshotId}\` ` +
        `will fail until the file exists): ${(err as Error).message}`,
    );
  }

  deps.write?.(
    `snapshotted overlay: ${overlayTag}\n` +
    `also tagged: ${latestTag}, ${currentTag}\n` +
    `paired history: ${pairingPath}\n` +
    `safe to run \`docker compose build vessel\` for ${name} now — \`up --force-recreate\` will boot from this overlay snapshot.\n`,
  );
  return 0;
}
