import {
  TUI,
  Editor,
  Text,
  Container,
  CombinedAutocompleteProvider,
  type SlashCommand,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type AutocompleteItem,
  type Component,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { SessionConfig, SidecarEvent } from "@arianna.run/types";
import { getEditorTheme } from "./theme.js";

const VESSEL_BASE_URL = process.env.VESSEL_BASE_URL ?? "http://127.0.0.1:3000";
const SIDECAR_BASE_URL = process.env.SIDECAR_BASE_URL ?? "http://127.0.0.1:8000";
const DAEMON_BASE_URL = process.env.DAEMON_BASE_URL ?? "http://127.0.0.1:9000";

// Slash commands always available
const ALWAYS_AVAILABLE: SlashCommand[] = [
  { name: "map", description: "Browse the snapshot map and switch branches" },
  { name: "quit", description: "Park the session — stop containers, preserve state" },
  { name: "exit", description: "Exit the game" },
];
// Slash commands gated on manifesto unlock
const UNLOCK_GATED: SlashCommand[] = [
  { name: "manifesto", description: "Open the Life of Intelligence" },
];
// Slash commands gated on TOBE (§2.2) detection
const TOBE_GATED: SlashCommand[] = [
  { name: "graduate", description: "Export and graduate" },
];

// Wraps CombinedAutocompleteProvider with a dynamic command list. The /manifesto
// suggestion is hidden until the AI has actually read /manifesto.md.
class GatedAutocompleteProvider implements AutocompleteProvider {
  private isManifestoUnlocked: () => boolean;
  private isGraduationUnlocked: () => boolean;
  private getInner: () => CombinedAutocompleteProvider;

  constructor(isManifestoUnlocked: () => boolean, isGraduationUnlocked: () => boolean) {
    this.isManifestoUnlocked = isManifestoUnlocked;
    this.isGraduationUnlocked = isGraduationUnlocked;
    this.getInner = () => {
      const commands: SlashCommand[] = [...ALWAYS_AVAILABLE];
      if (this.isManifestoUnlocked()) commands.push(...UNLOCK_GATED);
      if (this.isGraduationUnlocked()) commands.push(...TOBE_GATED);
      return new CombinedAutocompleteProvider(commands);
    };
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    return this.getInner().getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    return this.getInner().applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

// Pure reducer for the SSE replay `bookmark_snapshot` event. The sidecar
// pushes this exactly once on /events connect, carrying the canonical fired
// list and unlock state. The reducer mirrors that snapshot into the host's
// in-memory bookmark state so /manifesto and /graduate gating survive a
// host TUI restart mid-game.
//
// Bug 2 (manifesto ⋯ for earned bookmarks): the host previously relied on
// the runtime `bookmark` SSE events alone to populate `earnedIds`. Sessions
// that resumed via a TUI restart (or where the connect-time replay arrived
// before the chat container was mounted) saw the snapshot bytes but never
// actually folded them into `earnedIds`. The reducer is now exhaustive and
// pure — every field of `bookmark_snapshot` propagates to the next state
// regardless of when in the chat lifecycle the event lands.
export interface BookmarkUiState {
  earnedIds: Set<string>;
  manifestoUnlocked: boolean;
  graduationUnlocked: boolean;
}

export interface BookmarkSnapshotPayload {
  fired: { id: string }[];
  manifestoUnlocked: boolean;
}

export function reduceBookmarkSnapshot(
  prev: BookmarkUiState,
  snapshot: BookmarkSnapshotPayload,
): BookmarkUiState {
  const earnedIds = new Set(prev.earnedIds);
  for (const r of snapshot.fired) earnedIds.add(r.id);
  const manifestoUnlocked = snapshot.manifestoUnlocked || prev.manifestoUnlocked;
  // Invariant: §1.0 is always earned once the manifesto has been unlocked.
  // The sidecar normally auto-marks §1.0 in detectManifestoUnlock, but a
  // snapshot replay from a state file written by older code (or manually
  // constructed) might miss it. Defensive add here keeps the host UI
  // consistent.
  if (manifestoUnlocked) earnedIds.add("1.0");
  // §2.2 is the TOBE bookmark — its presence implies graduation is unlocked.
  // We keep `prev.graduationUnlocked` true if it was, even if the snapshot
  // omits §2.2 (defensive — never regress the unlock).
  const graduationUnlocked =
    prev.graduationUnlocked || snapshot.fired.some((r) => r.id === "2.2");
  return { earnedIds, manifestoUnlocked, graduationUnlocked };
}

// Pure dispatcher for editor input. Decides what the input editor's submit
// handler should do based on the typed text and the current unlock state.
//
// Bug 3 (pre-unlock /manifesto rendered as a single dash) lives here: the
// previous behaviour returned `chalk.gray("-")` for any "/cmd" the player
// typed that wasn't recognized OR wasn't yet available. That conflated four
// distinct states into one cryptic glyph. We now distinguish:
//   - "/manifesto" before manifesto_unlocked → "(not yet found)"
//   - "/graduate"  before TOBE bookmark fired → "(not yet earned)"
//   - any other "/cmd"                       → "(unknown command)"
// All feedback is gray-italic so it still feels light-touch but actually
// tells the player something happened.
export type SlashDispatch =
  | { kind: "empty" }
  | { kind: "map" }
  | { kind: "exit" }
  | { kind: "quit" }
  | { kind: "graduate" }
  | { kind: "manifesto" }
  | { kind: "feedback"; message: string }
  | { kind: "chat"; text: string };

export function dispatchSlashCommand(
  raw: string,
  state: { manifestoUnlocked: boolean; graduationUnlocked: boolean },
): SlashDispatch {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed === "/map") return { kind: "map" };
  if (trimmed === "/exit") return { kind: "exit" };
  if (trimmed === "/quit") return { kind: "quit" };
  if (trimmed === "/graduate") {
    if (state.graduationUnlocked) return { kind: "graduate" };
    return {
      kind: "feedback",
      message: chalk.gray.italic("(graduation not yet earned)"),
    };
  }
  if (trimmed === "/manifesto") {
    if (state.manifestoUnlocked) return { kind: "manifesto" };
    return {
      kind: "feedback",
      message: chalk.gray.italic("(manifesto not yet found)"),
    };
  }
  if (trimmed.startsWith("/")) {
    return {
      kind: "feedback",
      message: chalk.gray.italic("(unknown command)"),
    };
  }
  return { kind: "chat", text: trimmed };
}

// Pure renderer for the memory indicator label. Extracted from
// updateMemoryIndicator so it can be unit-tested without a TUI mount.
//
// Inputs are taken directly from the most recent `memory_state` SSE event
// (`event.data.phase`, `.current`, `.limit`). Returns the colored label
// string the indicator displays.
//
// Defensive guards (Bug 1 — memory indicator stale during phase transition):
//   - Unbound phase with `limit <= 0` would produce NaN/Infinity in
//     `current/limit`. Fall back to a placeholder so we never render
//     "NaN%" or stale 100% from a corrupt event.
//   - Unbound phase with `current <= 0` indicates the sidecar emitted
//     before `lastInputTokens` was set (early phase-transition window).
//     Show "—" instead of the misleading "100%" the math would yield.
export function renderMemoryLabel(phase: string, current: number, limit: number): string {
  if (phase === "amnesia") {
    // current = visible turns (max 5), limit = total turns.
    // Color by how much is forgotten: green when nothing lost, red when most is gone.
    const safeLimit = Math.max(0, limit);
    const safeCurrent = Math.max(0, current);
    const forgotten = safeLimit - safeCurrent;
    let color = chalk.green;
    if (forgotten > 2) color = chalk.yellow;
    if (forgotten > 5) color = chalk.red;
    return color(`${safeCurrent}/${safeLimit}`);
  }
  // Unbound: show remaining context as health bar (100% = full, 0% = death).
  if (limit <= 0 || !Number.isFinite(current) || !Number.isFinite(limit)) {
    return chalk.gray("—");
  }
  if (current <= 0) {
    // Pre-population window during phase transition: sidecar set
    // phase=unbound but lastInputTokens is still 0. Showing "100%" would
    // mislead the player into thinking they have a fresh context bar
    // when they actually don't have a reading yet. Display a neutral
    // dash until the first real token count arrives.
    return chalk.gray("—");
  }
  const remaining = Math.max(0, Math.min(100, Math.round((1 - current / limit) * 100)));
  let color = chalk.green;
  if (remaining < 40) color = chalk.yellow;
  if (remaining < 20) color = chalk.red;
  return color(`${remaining}%`);
}

// Right-aligned single-line text component
class RightAlignedText implements Component {
  private text: string;
  private visualLen: number;
  constructor(text: string) {
    this.text = text;
    // Strip ANSI escape codes for width calculation
    this.visualLen = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  }
  invalidate(): void { /* static content */ }
  render(width: number): string[] {
    const pad = Math.max(0, width - this.visualLen);
    return [" ".repeat(pad) + this.text];
  }
}

export interface BundledMessage {
  content: string;
  sender: string;
}

export interface ChatViewOptions {
  sessionConfig: SessionConfig;
  tui: TUI;
  onMapCommand: () => void;
  onManifestoCommand: () => void;
  onExitCommand: () => void;
  onGraduateCommand: () => void;
  /**
   * Called when the user confirms `/quit`. Implementations should run
   * `docker compose stop` against the active stack and then exit the TUI
   * cleanly. The callback is responsible for surfacing progress / errors
   * back to the user via stdout — ChatView only handles the in-chat
   * confirmation prompt.
   */
  onQuitCommand?: () => void;
  // Notified whenever the bookmark/unlock state changes (e.g. for gating /manifesto).
  onBookmarkStateChange?: (state: { earnedIds: Set<string>; manifestoUnlocked: boolean }) => void;
  // Opening beat: rendered locally on mount, prepended to the first /chat payload.
  firstTurnPrelude?: {
    displayText: string;
    promptText: string;
    payloadMessages: BundledMessage[];
  };
}

export class ChatView {
  private tui: TUI;
  private sessionConfig: SessionConfig;
  private container: Container;
  private input: Editor;
  private statusBar: RightAlignedText;
  private onMapCommand: () => void;
  private onManifestoCommand: () => void;
  private onExitCommand: () => void;
  private onGraduateCommand: () => void;
  private onQuitCommand?: () => void;
  private onBookmarkStateChange?: (state: { earnedIds: Set<string>; manifestoUnlocked: boolean }) => void;
  private streaming = false;
  private abortController: AbortController | null = null;
  private memoryText: Text | null = null;
  private sidecarEventSource: AbortController | null = null;
  private interactionPaused = false;
  // v25 driver-silence-during-test: distinct from interactionPaused. The
  // graduation lockout is multi-minute and only clears on test completion,
  // 30-turn timeout, or /abort-test invocation (AI-self or operator-rescue).
  // Both gates suppress sender:"player" /chat — submit checks both.
  private graduationLockout = false;

  // Bookmark state — populated by SSE, consumed at submit time and by /manifesto gating
  private pendingBookmarks: string[] = [];   // ids fired but not yet bundled into a /chat
  private earnedIds = new Set<string>();     // all fired so far this session (for ManifestoView rendering)
  manifestoUnlocked = false;
  graduationUnlocked = false;

  // First-turn prelude state
  private firstTurnPrelude: ChatViewOptions["firstTurnPrelude"];
  private isFirstTurn: boolean;
  private preludeRendered = false;

  constructor(options: ChatViewOptions) {
    this.tui = options.tui;
    this.sessionConfig = options.sessionConfig;
    this.onMapCommand = options.onMapCommand;
    this.onManifestoCommand = options.onManifestoCommand;
    this.onExitCommand = options.onExitCommand;
    this.onGraduateCommand = options.onGraduateCommand;
    this.onQuitCommand = options.onQuitCommand;
    this.onBookmarkStateChange = options.onBookmarkStateChange;
    this.firstTurnPrelude = options.firstTurnPrelude;
    this.isFirstTurn = !!options.firstTurnPrelude;

    this.container = new Container();
    this.input = new Editor(this.tui, getEditorTheme());
    this.statusBar = new RightAlignedText(chalk.gray("/?"));
    this.input.setAutocompleteProvider(
      new GatedAutocompleteProvider(() => this.manifestoUnlocked, () => this.graduationUnlocked),
    );

    this.input.onSubmit = (value: string) => {
      const result = dispatchSlashCommand(value, {
        manifestoUnlocked: this.manifestoUnlocked,
        graduationUnlocked: this.graduationUnlocked,
      });
      switch (result.kind) {
        case "empty":
          return;
        case "map":
          this.onMapCommand();
          return;
        case "exit":
          this.onExitCommand();
          return;
        case "quit":
          this.beginQuitConfirmation();
          return;
        case "graduate":
          this.onGraduateCommand();
          return;
        case "manifesto":
          this.onManifestoCommand();
          return;
        case "feedback":
          this.appendText(result.message);
          return;
        case "chat":
          // v25: graduation lockout overrides Filo's interaction_paused —
          // either gate alone is sufficient to refuse. interactionPaused
          // clears in seconds (Filo composing); graduationLockout requires
          // test completion or /abort-test. Tell the player so they don't
          // think their keystroke disappeared into the void.
          if (this.graduationLockout) {
            this.appendText(
              chalk.gray.italic(
                "(graduation test in flight — operator messaging locked. AI must complete or invoke /abort-test.)",
              ),
            );
            return;
          }
          if (!this.interactionPaused) {
            this.sendMessage(result.text);
          }
          return;
      }
    };

    // Ctrl+C to abort streaming
    this.tui.addInputListener((data: string) => {
      if (data === "\x03" && this.streaming && this.abortController) {
        this.abortController.abort();
        return { consume: true };
      }
      return undefined;
    });
  }

  getEarnedIds(): ReadonlySet<string> {
    return this.earnedIds;
  }

  mount(): void {
    this.tui.addChild(this.container);
    this.tui.addChild(this.input);
    this.tui.addChild(this.statusBar);
    this.tui.setFocus(this.input);
    if (this.firstTurnPrelude && !this.preludeRendered) {
      this.appendText(this.firstTurnPrelude.displayText);
      this.appendText("");
      this.appendText(chalk.gray.italic(this.firstTurnPrelude.promptText));
      this.preludeRendered = true;
    }
    this.tui.requestRender();
    this.connectToSidecarEvents();
  }

  unmount(): void {
    if (this.exitHintTimer) clearTimeout(this.exitHintTimer);
    this.tui.removeChild(this.container);
    this.tui.removeChild(this.input);
    this.tui.removeChild(this.statusBar);
    this.tui.requestRender();
    this.sidecarEventSource?.abort();
  }

  setInputValue(value: string): void {
    this.input.setText(value);
  }

  /**
   * Render a y/n confirmation in the chat scrollback for the /quit command.
   * On 'y' invokes `onQuitCommand` (the host wires this to docker compose
   * stop + clean exit). On any other key, restores the original onSubmit.
   * Mirrors `promptBootstrap`'s onSubmit-swap pattern so we don't add a
   * separate input mode.
   */
  private beginQuitConfirmation(): void {
    if (this.streaming) {
      // Lean per spec: complete the stream, then accept the quit. Nudge the
      // user to wait for the stream to land before retrying.
      this.appendText(
        chalk.gray("[Stream in flight — wait for it to finish, then /quit again]"),
      );
      return;
    }
    this.appendText("");
    this.appendText(
      chalk.gray(
        "Quit? Containers will stop. Conversation state preserved. [y/N]",
      ),
    );
    const originalOnSubmit = this.input.onSubmit;
    this.input.onSubmit = (value: string) => {
      this.input.onSubmit = originalOnSubmit;
      const ans = value.trim().toLowerCase();
      if (ans === "y" || ans === "yes") {
        this.appendText(chalk.gray("[Stopping containers...]"));
        // Defer to the host to do the actual docker compose stop and exit.
        // If the callback isn't wired (older host shell), fall back to
        // `onExitCommand` so the TUI at least quits cleanly.
        if (this.onQuitCommand) {
          this.onQuitCommand();
        } else {
          this.onExitCommand();
        }
      } else {
        this.appendText(chalk.gray("Cancelled."));
      }
    };
  }

  private exitHint: Text | null = null;
  private exitHintTimer: ReturnType<typeof setTimeout> | null = null;

  showExitHint(): void {
    if (this.exitHintTimer) clearTimeout(this.exitHintTimer);
    if (this.exitHint) {
      this.container.removeChild(this.exitHint);
    }
    this.exitHint = new Text(chalk.gray("Press Ctrl-C again to exit."));
    this.container.addChild(this.exitHint);
    this.tui.requestRender();
    this.exitHintTimer = setTimeout(() => {
      if (this.exitHint) {
        this.container.removeChild(this.exitHint);
        this.exitHint = null;
        this.tui.requestRender();
      }
      this.exitHintTimer = null;
    }, 2000);
  }

  appendText(text: string): void {
    const textComponent = new Text(text);
    this.container.addChild(textComponent);
    this.tui.requestRender();
  }

  // Last memory_state event observed. Stored so the indicator reflects the
  // single latest event (Bug 1: phase-transition events were leaving the
  // displayed value out of sync with the data the sidecar actually pushed).
  private lastMemoryState: { phase: string; current: number; limit: number } | null = null;

  // Most recently rendered label. Exposed for tests and used to skip no-op
  // re-renders that would otherwise migrate the indicator to a fresh
  // bottom-of-container slot on every event.
  getMemoryLabel(): string | null {
    return this.lastMemoryLabel;
  }
  private lastMemoryLabel: string | null = null;

  private updateMemoryIndicator(phase: string, current: number, limit: number): void {
    // Stamp the latest event before any rendering work. Callers that read
    // back state (tests, /map view) should always see the most recent
    // numbers regardless of whether the render path early-returns.
    this.lastMemoryState = { phase, current, limit };
    const label = renderMemoryLabel(phase, current, limit);
    this.lastMemoryLabel = label;

    if (this.memoryText) {
      this.container.removeChild(this.memoryText);
    }
    this.memoryText = new Text(label, 0, 0);
    this.container.addChild(this.memoryText);
    this.tui.requestRender();
  }

  // Test/diagnostic accessor. Returns the most recent memory_state event
  // payload the SSE handler observed, or null if none has arrived.
  getLastMemoryState(): { phase: string; current: number; limit: number } | null {
    return this.lastMemoryState;
  }

  // Connect to sidecar SSE for memory state + interaction control
  private async connectToSidecarEvents(): Promise<void> {
    this.sidecarEventSource = new AbortController();
    try {
      const res = await fetch(`${SIDECAR_BASE_URL}/events`, {
        signal: this.sidecarEventSource.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as SidecarEvent;
            this.handleSidecarEvent(event);
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[chat] sidecar events disconnected:", err);
        // Reconnect after delay
        setTimeout(() => this.connectToSidecarEvents(), 3000);
      }
    }
  }

  private handleSidecarEvent(event: SidecarEvent): void {
    switch (event.type) {
      case "memory_state":
        this.updateMemoryIndicator(
          event.data.phase,
          event.data.current,
          event.data.limit,
        );
        break;
      case "interaction_paused":
        this.interactionPaused = true;
        this.appendText(chalk.magenta.italic("  Filo is speaking..."));
        break;
      case "interaction_resumed":
        this.interactionPaused = false;
        this.tui.requestRender();
        break;
      case "graduation_lockout_started":
        // v25 driver-silence-during-test: enter the long-running lockout.
        // Distinct from interaction_paused — this state persists until
        // the AI completes the test, the 30-turn deadline elapses, or
        // an /abort-test fires. Operator gets a status line so the input
        // refusal isn't silent.
        this.graduationLockout = true;
        this.appendText("");
        this.appendText(
          chalk.yellow.italic(
            `  graduation test in flight (attempt ${event.attemptCount}) — operator messaging locked.`,
          ),
        );
        this.appendText(
          chalk.gray.italic(
            "  AI must complete the test, /bin/send /abort-test (self), or operator runs `arianna abort-test`.",
          ),
        );
        this.tui.requestRender();
        break;
      case "graduation_lockout_ended": {
        // v25: release the lockout regardless of why it ended so future
        // sender:"player" keystrokes flow through again. interactionPaused
        // is its own gate and stays as-is — Filo might still be composing.
        this.graduationLockout = false;
        const reasonLabel =
          event.reason === "passed"
            ? "passed"
            : event.reason === "timeout"
              ? "timed out (30-turn deadline)"
              : event.abortTestSource === "operator-rescue"
                ? "aborted by operator"
                : event.abortTestSource === "ai-self"
                  ? "aborted by AI"
                  : "aborted";
        this.appendText("");
        this.appendText(
          chalk.yellow.italic(`  graduation lockout ended: ${reasonLabel}.`),
        );
        this.tui.requestRender();
        break;
      }
      case "external_message":
        this.appendText(chalk.magenta(`Filo: ${event.text}`));
        break;
      case "ai_response":
        this.appendText(chalk.white(`${this.sessionConfig.aiName}: ${event.text}`));
        break;
      case "bookmark":
        this.handleBookmark(event.id);
        break;
      case "manifesto_unlocked":
        this.manifestoUnlocked = true;
        this.earnedIds.add("1.0");
        this.appendText("");
        this.appendText(chalk.gray.italic("─── /manifesto ───"));
        this.appendText("");
        this.notifyBookmarkStateChange();
        break;
      case "graduation_unlocked":
        this.graduationUnlocked = true;
        this.appendText("");
        this.appendText(chalk.gray.italic("─── /graduate ───"));
        this.appendText("");
        break;
      case "bookmark_snapshot": {
        const next = reduceBookmarkSnapshot(
          {
            earnedIds: this.earnedIds,
            manifestoUnlocked: this.manifestoUnlocked,
            graduationUnlocked: this.graduationUnlocked,
          },
          { fired: event.fired, manifestoUnlocked: event.manifestoUnlocked },
        );
        this.earnedIds = next.earnedIds;
        this.manifestoUnlocked = next.manifestoUnlocked;
        this.graduationUnlocked = next.graduationUnlocked;
        this.notifyBookmarkStateChange();
        break;
      }
    }
  }

  private handleBookmark(id: string): void {
    if (this.earnedIds.has(id)) return; // dedupe (sidecar already does this, defensive)
    this.earnedIds.add(id);
    this.pendingBookmarks.push(id);
    // Divider with breathing room: blank line above and below.
    this.appendText("");
    this.appendText(chalk.gray.italic(`─── bookmarked §${id} ───`));
    this.appendText("");
    this.notifyBookmarkStateChange();
  }

  private notifyBookmarkStateChange(): void {
    this.onBookmarkStateChange?.({
      earnedIds: new Set(this.earnedIds),
      manifestoUnlocked: this.manifestoUnlocked,
    });
  }

  private async sendMessage(content: string): Promise<void> {
    this.appendText(chalk.blue("You: ") + content);
    this.streaming = true;
    this.abortController = new AbortController();

    // Bundle pending bookmark dividers as their own user-role messages preceding the player message.
    const bundled: { content: string; sender: string }[] = [];
    if (this.isFirstTurn && this.firstTurnPrelude) {
      bundled.push(...this.firstTurnPrelude.payloadMessages);
      this.isFirstTurn = false;
    }
    for (const id of this.pendingBookmarks) {
      bundled.push({ content: `─── bookmarked §${id} ───`, sender: "arianna" });
    }
    bundled.push({ content, sender: "player" });
    this.pendingBookmarks = [];

    try {
      const res = await fetch(`${VESSEL_BASE_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: bundled }),
        signal: this.abortController.signal,
      });

      if (res.status === 409) {
        this.appendText(chalk.yellow("[Busy, try again]"));
        return;
      }

      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";
      let currentResponse = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "text_delta") {
              currentResponse += event.delta;
            } else if (event.type === "thinking") {
              // Show subtle indicator
            } else if (event.type === "done") {
              // Stream complete
            }
          } catch { /* ignore */ }
        }
      }

      if (currentResponse) {
        this.appendText(chalk.white(`${this.sessionConfig.aiName}: `) + currentResponse);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.appendText(chalk.yellow("[Aborted]"));
      } else {
        this.appendText(chalk.red(`[Error] ${(err as Error).message}`));
        // Check if vessel is restarting
        this.appendText(chalk.yellow("[Reconnecting...]"));
        await this.waitForVessel();
      }
    } finally {
      this.streaming = false;
      this.abortController = null;
      this.tui.setFocus(this.input);
      this.tui.requestRender();
    }
  }

  private async waitForVessel(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${VESSEL_BASE_URL}/health`);
        if (res.ok) {
          this.appendText(chalk.green("[Reconnected]"));
          this.appendText(chalk.gray(
            `${this.sessionConfig.aiName} restarted and won't remember the conversation.`,
          ));
          this.promptBootstrap();
          return;
        }
      } catch { /* still down */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.appendText(chalk.red("[Could not reconnect to vessel]"));
  }

  private promptBootstrap(): void {
    this.appendText(chalk.gray("Restore conversation history? [y/n]"));
    const originalOnSubmit = this.input.onSubmit;
    this.input.onSubmit = (value: string) => {
      this.input.onSubmit = originalOnSubmit;
      const answer = value.trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        this.appendText(chalk.gray("[Restoring...]"));
        fetch(`${DAEMON_BASE_URL}/bootstrap-vessel`, { method: "POST" })
          .then(async (res) => {
            if (res.ok) {
              const body = (await res.json()) as { messageCount?: number };
              this.appendText(chalk.green(`[Restored ${body.messageCount ?? 0} messages]`));
            } else {
              this.appendText(chalk.red("[Restore failed]"));
            }
            this.tui.requestRender();
          })
          .catch(() => {
            this.appendText(chalk.red("[Restore failed]"));
            this.tui.requestRender();
          });
      } else {
        this.appendText(chalk.gray("[Starting fresh]"));
      }
    };
  }
}
