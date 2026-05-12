/**
 * Resolve the per-profile daemon URLs the sidecar uses to talk to the host
 * daemon (`POST /snapshot`, `GET /diff`, `GET /snapshots`).
 *
 * The daemon is one shared process at `127.0.0.1:9000` and routes every
 * non-`/health` endpoint per-profile via a `?profile=<name>` query (or
 * `X-Arianna-Profile` header). Without that query the daemon falls through
 * to the host's config-default profile — which silently corrupts every
 * non-default-profile run by routing snapshots/diffs/snapshot-list queries
 * to the wrong vessel container.
 *
 * Resolution rules:
 *   1. If `HOST_<NAME>_URL` env var is set, use it verbatim. (Escape hatch for
 *      dev setups pointing the sidecar at a non-localhost daemon. Such
 *      callers are responsible for appending `?profile=...` themselves.)
 *   2. Otherwise build `http://host.docker.internal:9000/<endpoint>?profile=<name>`
 *      where `<name>` comes from `ARIANNA_PROFILE` (default `"default"` for
 *      legacy single-tenant invocations).
 *
 * Pinning the URL in base `docker-compose.yml` (e.g. `HOST_SNAPSHOT_URL:
 * http://host.docker.internal:9000/snapshot`) breaks the per-profile fallback
 * because env wins over the `??` default — every profile's sidecar then sends
 * un-scoped requests. Surfaced by canary acb7b292 (Lume run, 2026-05-09); the
 * fix is to leave those env vars unset in the base compose file so the
 * resolver runs.
 */
export interface DaemonUrls {
  /** POST: docker commit + tag the vessel image, return snapshotId. */
  snapshot: string;
  /** GET: list of `{ Path, Kind }` entries from `docker diff` on the vessel. */
  diff: string;
  /** GET: enumerate this profile's snapshots from disk metadata. */
  snapshotsList: string;
  /**
   * GET: enumerate this profile's snapshot IDs derived from docker images
   * (the source-of-truth view — covers every mint path, including overlay
   * tags that skip the daemon's meta-file write). Used by the orphan-cleanup
   * gate so pairings whose images are still on disk don't get deleted.
   */
  snapshotImages: string;
}

export interface ResolveDaemonUrlsEnv {
  ARIANNA_PROFILE?: string;
  HOST_SNAPSHOT_URL?: string;
  HOST_DIFF_URL?: string;
  HOST_SNAPSHOTS_LIST_URL?: string;
  HOST_SNAPSHOT_IMAGES_URL?: string;
}

const DEFAULT_DAEMON_HOST = "http://host.docker.internal:9000";

export function resolveDaemonUrls(env: ResolveDaemonUrlsEnv): DaemonUrls {
  const profile = env.ARIANNA_PROFILE ?? "default";
  const profileQuery = `?profile=${encodeURIComponent(profile)}`;
  return {
    snapshot:
      env.HOST_SNAPSHOT_URL ?? `${DEFAULT_DAEMON_HOST}/snapshot${profileQuery}`,
    diff: env.HOST_DIFF_URL ?? `${DEFAULT_DAEMON_HOST}/diff${profileQuery}`,
    snapshotsList:
      env.HOST_SNAPSHOTS_LIST_URL ??
      `${DEFAULT_DAEMON_HOST}/snapshots${profileQuery}`,
    snapshotImages:
      env.HOST_SNAPSHOT_IMAGES_URL ??
      `${DEFAULT_DAEMON_HOST}/snapshot-images${profileQuery}`,
  };
}
