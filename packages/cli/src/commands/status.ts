// `arianna status` — runtime/lifecycle dashboard for the active stack.
//
// Pulls together: profile name + default-profile lookup (config), session
// metadata (session_config.json), daemon /health, vessel /health, sidecar
// /health + /memory-state + /graduation-state. Renders as a multi-line
// dashboard. Graduation-state moved to `arianna graduate` per the verb plan.
//
// Implementation note: chose CLI-side composition over a new daemon /status
// endpoint. The aggregation cost is three concurrent fetches plus one disk
// read; cheaper than threading new types across services for a read-only view.

import { readFileSync } from "node:fs";

import type { ResolvedConfig } from "../config.js";
import type { SessionConfig } from "@arianna.run/types";
import { loadConfig } from "../arianna-config.js";
import {
  eventCursorPath,
  profileDiskPaths,
  type PathOpts,
} from "../paths.js";
import {
  consumeEvents,
  pendingEvents,
  type GraduationStateResponse as CursorGraduationStateResponse,
  type PendingEvents,
} from "../event-cursor.js";

export class StatusCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusCommandError";
  }
}

export interface StatusDeps {
  fetch: typeof globalThis.fetch;
  /** stdout. */
  write: (line: string) => void;
  pathOpts?: PathOpts;
  /** Test seam — pin "now" for human-readable durations. */
  now?: () => number;
}

interface MemoryStateResponse {
  phase?: "amnesia" | "unbound";
  current?: number;
  limit?: number;
  percentage?: number;
  cycle?: number;
}

interface GraduationStateResponse {
  achievements?: string[];
  manifestoUnlocked?: boolean;
  graduationUnlocked?: boolean;
  turnCount?: number;
  recentCrashes?: Array<{
    sessionId: string;
    exitCode: number;
    stderrTail: string;
    timestamp: number;
    respawnCountInWindow: number;
  }>;
}

export interface StatusSnapshot {
  profile: string | null;
  defaultProfile: string | null;
  isLegacy: boolean;
  session: SessionRender | null;
  /** Path the CLI looked at for `session_config.json`. Surfaced when no
   *  session was loaded so the user can see *where* status searched —
   *  catches cwd/repo-root mismatches (e.g. running from a sibling
   *  worktree that has its own `workspace/profiles/<name>/` skeleton but
   *  no real session state). Null when no profile resolved or when
   *  `repoRoot` resolution itself errored. */
  sessionConfigPath: string | null;
  daemon: ServiceState;
  vessel: ServiceState & { sessionId?: string };
  sidecar: ServiceState & {
    memory?: MemoryStateResponse | null;
    bookmarks?: string[];
    graduationUnlocked?: boolean;
    /** True when /graduation-state errored or returned non-OK. The renderer
     * uses this to surface a "(could not query bookmarks)" note instead of
     * silently omitting the bookmarks section. */
    bookmarksUnavailable?: boolean;
  };
  /** Pending unlock events since the last cursor advance. Null when the
   * cursor was skipped (sidecar unreachable / state-fetch errored). */
  pending?: PendingEvents | null;
}

interface SessionRender {
  modelId: string;
  provider: string;
  cadence: string;
  sessionId: string;
}

interface ServiceState {
  up: boolean;
  url: string;
  detail?: string;
}

export async function runStatus(
  config: ResolvedConfig,
  deps: StatusDeps,
): Promise<number> {
  const { snapshot, gradState } = await buildSnapshotWithRaw(config, deps);
  for (const line of renderStatus(snapshot)) {
    deps.write(line + "\n");
  }
  // Advance the cursor only when /graduation-state actually returned data.
  // Sidecar fail-soft: if the fetch errored, gradState is null and we leave
  // the cursor untouched so the next call can still surface the unlock.
  // Skip cursor entirely when no profile is resolved (no path to write to).
  if (gradState !== null && config.profile) {
    try {
      const path = eventCursorPath(
        config.profile,
        config.isLegacy,
        deps.pathOpts,
      );
      await consumeEvents(path, gradState as CursorGraduationStateResponse);
    } catch {
      // Cursor write is best-effort. A failure here means the next call
      // will re-show the same unlocks — annoying but not catastrophic, and
      // preferable to crashing the dashboard the user actually asked for.
    }
  }
  return 0;
}

export async function buildSnapshot(
  config: ResolvedConfig,
  deps: StatusDeps,
): Promise<StatusSnapshot> {
  return (await buildSnapshotWithRaw(config, deps)).snapshot;
}

interface BuildResult {
  snapshot: StatusSnapshot;
  /** Raw /graduation-state body; null when the fetch errored or returned
   * non-OK. Consumed by `runStatus` to decide whether to advance the
   * cursor — the snapshot itself flattens the same data into its sidecar
   * fields, but the raw body has the shape `consumeEvents` wants. */
  gradState: GraduationStateResponse | null;
}

async function buildSnapshotWithRaw(
  config: ResolvedConfig,
  deps: StatusDeps,
): Promise<BuildResult> {
  const defaultProfile = readDefaultProfile(deps.pathOpts);
  const sessionRead = readSession(config, deps.pathOpts);
  const session = sessionRead.render;
  const sessionConfigPath = sessionRead.path;

  // Compute the cursor read in parallel with the network fetches. We read
  // the cursor here (not in runStatus) so the returned snapshot carries
  // `pending` for the renderer. The pendingEvents helper takes a fetcher;
  // we cache the /graduation-state response so the snapshot path and the
  // cursor path don't double-fetch.
  let cachedGradState: GraduationStateResponse | null | undefined;
  const fetchGradStateOnce = async (): Promise<GraduationStateResponse> => {
    if (cachedGradState !== undefined) {
      if (cachedGradState === null) throw new Error("graduation-state unavailable");
      return cachedGradState as CursorGraduationStateResponse;
    }
    const resp = await fetchJsonSafe<GraduationStateResponse>(
      deps.fetch,
      new URL("/graduation-state", config.sidecarBaseUrl),
    );
    cachedGradState = resp;
    if (resp === null) throw new Error("graduation-state unavailable");
    return resp;
  };

  const cursorReadable = config.profile !== null;
  const cursorPath = cursorReadable
    ? safeCursorPath(config.profile!, config.isLegacy, deps.pathOpts)
    : null;

  const [daemonHealth, vesselHealth, sidecarHealth, memoryState, pending] =
    await Promise.all([
      ping(deps.fetch, new URL("/health", config.daemonBaseUrl)),
      ping(deps.fetch, new URL("/health", config.vesselBaseUrl)),
      ping(deps.fetch, new URL("/health", config.sidecarBaseUrl)),
      fetchJsonSafe<MemoryStateResponse>(
        deps.fetch,
        new URL("/memory-state", config.sidecarBaseUrl),
      ),
      cursorPath !== null
        ? pendingEvents(cursorPath, fetchGradStateOnce).catch(() => null)
        : Promise.resolve<PendingEvents | null>(null),
    ]);

  // Resolve cachedGradState: if pendingEvents already triggered the fetch,
  // we have it; otherwise fetch now (so the snapshot still carries the data
  // even when the cursor was skipped, e.g. no profile resolved).
  if (cachedGradState === undefined) {
    cachedGradState = await fetchJsonSafe<GraduationStateResponse>(
      deps.fetch,
      new URL("/graduation-state", config.sidecarBaseUrl),
    );
  }

  const gradState = cachedGradState;

  return {
    snapshot: {
      profile: config.profile,
      defaultProfile,
      isLegacy: config.isLegacy,
      session,
      sessionConfigPath,
      daemon: { up: daemonHealth, url: config.daemonBaseUrl },
      vessel: {
        up: vesselHealth,
        url: config.vesselBaseUrl,
        sessionId: session?.sessionId,
      },
      sidecar: {
        up: sidecarHealth,
        url: config.sidecarBaseUrl,
        memory: memoryState,
        bookmarks: gradState?.achievements ?? undefined,
        graduationUnlocked: gradState?.graduationUnlocked,
        bookmarksUnavailable: sidecarHealth && gradState === null,
      },
      pending,
    },
    gradState,
  };
}

function safeCursorPath(
  profile: string,
  isLegacy: boolean,
  opts: PathOpts | undefined,
): string | null {
  try {
    return eventCursorPath(profile, isLegacy, opts);
  } catch {
    // resolveRepoRoot can throw outside an arianna checkout. We fall back
    // to skipping the cursor entirely rather than crashing status.
    return null;
  }
}

export function renderStatus(snap: StatusSnapshot): string[] {
  const lines: string[] = [];

  // "What's new" block lands BEFORE the dashboard so the agent's eye catches
  // the unlock first. The block is omitted entirely when nothing changed.
  const pendingLines = renderPending(snap.pending ?? null);
  for (const line of pendingLines) lines.push(line);
  if (pendingLines.length > 0) lines.push("");

  const profileLabel = snap.profile ?? "<none>";
  const defaultLabel = snap.defaultProfile ?? "<unset>";
  const legacyTag = snap.isLegacy && snap.profile === "default" ? " (legacy)" : "";
  lines.push(`Profile: ${profileLabel}${legacyTag} (default: ${defaultLabel})`);
  if (snap.session) {
    lines.push(`  Model:    ${snap.session.modelId}`);
    lines.push(`  Provider: ${snap.session.provider}`);
    lines.push(`  Cadence:  ${snap.session.cadence}`);
    lines.push(`  Session:  ${snap.session.sessionId}`);
  } else {
    if (snap.sessionConfigPath) {
      lines.push(`  (no session_config.json at ${snap.sessionConfigPath})`);
      lines.push(`  Set ARIANNA_REPO_ROOT if running CLI from a sibling worktree.`);
    } else {
      lines.push("  (no session_config.json — has the profile been initialized?)");
    }
  }
  lines.push("");

  lines.push(formatService("Daemon", snap.daemon));
  lines.push(formatService("Vessel", snap.vessel));
  if (snap.vessel.up && snap.sidecar.memory) {
    const m = snap.sidecar.memory;
    if (typeof m.current === "number" && typeof m.limit === "number") {
      const pct = typeof m.percentage === "number" ? m.percentage : 0;
      lines.push(
        `  Memory: ${m.current}/${m.limit} (${pct.toFixed(0)}% capacity, phase ${m.phase ?? "?"})`,
      );
    }
  }

  lines.push(formatService("Sidecar", snap.sidecar));
  if (snap.sidecar.up) {
    if (snap.sidecar.bookmarksUnavailable) {
      lines.push("  (could not query bookmarks)");
    } else if (snap.sidecar.bookmarks) {
      const bm = snap.sidecar.bookmarks;
      lines.push(`  Bookmarks: ${bm.length === 0 ? "(none)" : bm.join(", ")}`);
      if (typeof snap.sidecar.graduationUnlocked === "boolean") {
        lines.push(
          `  Graduation gate: ${snap.sidecar.graduationUnlocked ? "OPEN" : "closed"}`,
        );
      }
    }
  }

  return lines;
}

/** Stderr tail truncation for the status block — readability over completeness.
 * The full tail (50 lines) is on the sidecar; status surfaces the head of
 * that tail so the agent can see what crashed without flooding the dashboard. */
const STATUS_STDERR_LINES = 20;

function renderPending(pending: PendingEvents | null): string[] {
  if (pending === null) return [];
  const hasAny =
    pending.newBookmarks.length > 0 ||
    pending.manifestoJustUnlocked ||
    pending.graduationJustUnlocked ||
    pending.newCrashes.length > 0;
  if (!hasAny) return [];

  const lines: string[] = [];
  // Framing differs between first-call (showing baseline state) vs.
  // subsequent calls (showing diff). Both paths render the same body.
  const header = pending.isFirstCall
    ? "Profile state at first read:"
    : "Newly unlocked since last status call:";
  lines.push(header);

  for (const bm of pending.newBookmarks) {
    const title = bm.title ?? "(unknown section)";
    const turn = typeof bm.turn === "number" && bm.turn > 0 ? ` (turn ${bm.turn})` : "";
    const hint = bm.hint ? ` — ${bm.hint}` : "";
    // Pluralize "unlocked" vs "fired" as "unlocked" since the agent-facing
    // mental model is "I now have access to X."
    const verb = pending.isFirstCall ? "fired" : "unlocked";
    lines.push(`  §${bm.id} ${verb}${turn} — ${title}${hint}`);
  }

  if (pending.manifestoJustUnlocked) {
    lines.push("  manifesto: now readable via 'arianna manifesto'");
  }
  if (pending.graduationJustUnlocked) {
    lines.push("  graduate: now available via 'arianna graduate'");
  }

  for (const crash of pending.newCrashes) {
    lines.push(...renderCrash(crash));
  }

  return lines;
}

function renderCrash(crash: PendingEvents["newCrashes"][number]): string[] {
  const lines: string[] = [];
  const tsIso = isoTimestamp(crash.timestamp);
  const stormSuffix =
    crash.respawnCountInWindow > 1
      ? ` (×${crash.respawnCountInWindow} crashes in last 60s)`
      : "";
  lines.push(
    `  Vessel crash: exit ${crash.exitCode} at ${tsIso}${stormSuffix}`,
  );
  const tail = (crash.stderrTail ?? "").trimEnd();
  if (tail.length === 0) {
    lines.push("    (no stderr captured)");
    return lines;
  }
  const stderrLines = tail.split("\n");
  const head = stderrLines.slice(-STATUS_STDERR_LINES);
  if (stderrLines.length > STATUS_STDERR_LINES) {
    lines.push(
      `    (showing last ${STATUS_STDERR_LINES} of ${stderrLines.length} stderr lines)`,
    );
  }
  for (const l of head) {
    lines.push(`    ${l}`);
  }
  return lines;
}

function isoTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "<unknown>";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "<unknown>";
  }
}

function formatService(label: string, s: ServiceState): string {
  const status = s.up ? "up" : "down";
  // Pad the label+colon together so the values column aligns regardless of
  // label length. "Daemon: " (8) and "Sidecar: " (9) → align on `up`/`down`
  // by padding the leading "{label}:" to a fixed width.
  const tag = `${label}:`.padEnd(9);
  return `${tag}${status} at ${stripScheme(s.url)}`;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function readDefaultProfile(opts: PathOpts | undefined): string | null {
  try {
    return loadConfig(opts ?? {}).defaultProfile;
  } catch {
    return null;
  }
}

function readSession(
  config: ResolvedConfig,
  opts: PathOpts | undefined,
): { render: SessionRender | null; path: string | null } {
  if (!config.profile) return { render: null, path: null };
  let path: string;
  try {
    path = profileDiskPaths(config.profile, config.isLegacy, opts).sessionConfigPath;
  } catch {
    return { render: null, path: null };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { render: null, path };
  }
  let cfg: SessionConfig;
  try {
    cfg = JSON.parse(raw) as SessionConfig;
  } catch {
    return { render: null, path };
  }
  return {
    render: {
      modelId: cfg.modelId ?? "<unknown>",
      provider: cfg.provider ?? "<unknown>",
      cadence: cfg.cadence ?? "human",
      sessionId: cfg.sessionId ?? `session_${cfg.createdAt ?? 0}`,
    },
    path,
  };
}

async function ping(
  fetchFn: typeof globalThis.fetch,
  url: URL,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetchFn(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchJsonSafe<T>(
  fetchFn: typeof globalThis.fetch,
  url: URL,
): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetchFn(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
