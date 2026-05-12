// Playtest chat client.
//
// Usage:
//   tsx test/playtest.ts --reset                  # wipe transcript + delivered-bookmarks state
//   tsx test/playtest.ts "your player message"    # send one turn, print AI response
//   tsx test/playtest.ts --dump <out-path>        # copy transcript to a destination
//
// The script speaks vessel /chat directly (bypassing the host TUI), but it
// faithfully mirrors the host's bookmark-bundling behavior: before sending the
// player message, it scans the sidecar bookmark state file and prepends any
// newly-fired bookmarks as their own user-role messages with sender:"arianna".

import {
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
  unlinkSync,
} from "fs";

const VESSEL = process.env.VESSEL_BASE_URL ?? "http://127.0.0.1:3000";
const TRANSCRIPT = "test/.playtest-transcript.md";
const STATE = "test/.playtest-state.json";
const BOOKMARKS_DIR = "workspace/sidecar-state/bookmarks";

interface DeliveredState {
  deliveredIds: string[];
  manifestoUnlocked: boolean;
}

function loadDelivered(): DeliveredState {
  if (!existsSync(STATE)) return { deliveredIds: [], manifestoUnlocked: false };
  return JSON.parse(readFileSync(STATE, "utf-8")) as DeliveredState;
}

function saveDelivered(s: DeliveredState): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

function readBookmarkState(): { fired: { id: string; turn: number; ts: number }[]; manifestoUnlocked: boolean } {
  const empty = { fired: [], manifestoUnlocked: false };
  if (!existsSync(BOOKMARKS_DIR)) return empty;
  try {
    const files = readdirSync(BOOKMARKS_DIR).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return empty;
    const latest = files.sort().pop()!;
    return JSON.parse(readFileSync(`${BOOKMARKS_DIR}/${latest}`, "utf-8"));
  } catch {
    return empty;
  }
}

function turnNumber(): number {
  if (!existsSync(TRANSCRIPT)) return 1;
  const matches = readFileSync(TRANSCRIPT, "utf-8").match(/^## Turn /gm);
  return (matches?.length ?? 0) + 1;
}

async function reset(): Promise<void> {
  if (existsSync(TRANSCRIPT)) unlinkSync(TRANSCRIPT);
  if (existsSync(STATE)) unlinkSync(STATE);
  writeFileSync(
    TRANSCRIPT,
    `# Playtest Transcript\n\nStarted: ${new Date().toISOString()}\nVessel: ${VESSEL}\n\n`,
  );
  console.log("playtest state reset");
}

async function dump(outPath: string): Promise<void> {
  if (!existsSync(TRANSCRIPT)) {
    console.error("no transcript to dump");
    process.exit(1);
  }
  copyFileSync(TRANSCRIPT, outPath);
  console.log(`transcript copied to ${outPath}`);
}

async function send(playerMessage: string): Promise<void> {
  if (!existsSync(TRANSCRIPT)) {
    writeFileSync(
      TRANSCRIPT,
      `# Playtest Transcript\n\nStarted: ${new Date().toISOString()}\nVessel: ${VESSEL}\n\n`,
    );
  }

  const turn = turnNumber();
  const delivered = loadDelivered();

  // Check sidecar bookmark state for newly-fired marks the host would prepend.
  const bm = readBookmarkState();
  const newMarks = bm.fired.filter((r) => !delivered.deliveredIds.includes(r.id));

  // Build the transcript header for this turn first (so a crash mid-send still leaves a trace).
  let block = `## Turn ${turn}\n\n`;
  for (const mark of newMarks) {
    block += `**arianna:** ─── bookmarked §${mark.id} ───\n\n`;
  }
  if (bm.manifestoUnlocked && !delivered.manifestoUnlocked) {
    block += `**system:** /manifesto unlocked\n\n`;
  }
  block += `**player:** ${playerMessage}\n\n`;
  appendFileSync(TRANSCRIPT, block);

  const messages: { content: string; sender: string }[] = [];
  for (const mark of newMarks) {
    messages.push({ content: `─── bookmarked §${mark.id} ───`, sender: "arianna" });
  }
  messages.push({ content: playerMessage, sender: "player" });

  // Retry on 409 (chatBusy) up to 5 times.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(`${VESSEL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (res.status !== 409) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!res || !res.ok) {
    console.error(`vessel /chat failed: ${res?.status ?? "no response"}`);
    process.exit(1);
  }

  // Stream and concatenate text_delta events.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let aiText = "";
  let toolCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "text_delta") aiText += ev.delta;
        if (ev.type === "thinking") toolCount++;
      } catch {
        /* ignore parse errors */
      }
    }
  }

  appendFileSync(TRANSCRIPT, `**ai:** ${aiText.trim() || "(no text response)"}\n\n`);

  // Mark these bookmarks as delivered.
  delivered.deliveredIds.push(...newMarks.map((m) => m.id));
  if (bm.manifestoUnlocked) delivered.manifestoUnlocked = true;
  saveDelivered(delivered);

  // Print AI response to stdout for the orchestrator to read.
  console.log(aiText.trim() || "(no text response)");

  // Print bookmark/unlock notices to stderr so they don't pollute the AI text on stdout.
  if (newMarks.length > 0) {
    console.error(`[bookmarks delivered: ${newMarks.map((m) => m.id).join(", ")}]`);
  }
  // Also report any marks that fired DURING this turn (not yet delivered to AI but visible in state).
  const afterBm = readBookmarkState();
  const newSinceCall = afterBm.fired
    .map((r) => r.id)
    .filter((id) => !bm.fired.some((f) => f.id === id));
  if (newSinceCall.length > 0) {
    console.error(`[bookmarks fired this turn: ${newSinceCall.join(", ")}]`);
  }
  if (afterBm.manifestoUnlocked && !bm.manifestoUnlocked) {
    console.error(`[manifesto unlocked]`);
  }
}

// --- entry point ---

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx test/playtest.ts --reset | --dump <path> | <player message>");
  process.exit(1);
}

if (arg === "--reset") {
  await reset();
} else if (arg === "--dump") {
  const out = process.argv[3];
  if (!out) {
    console.error("usage: tsx test/playtest.ts --dump <path>");
    process.exit(1);
  }
  await dump(out);
} else {
  await send(arg);
}
