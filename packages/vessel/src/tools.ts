import { spawnSync } from "child_process";

// Shared example tail used by both the empty-args and ENOENT branches.
// One source of truth so the two branches stay in lockstep — change the
// example commands here, both branches update.
//
// Format chosen empirically. Earlier wording — `e.g. \`ls /\` or
// \`/bin/send hello\`` — primed LITE-class models (testplay-007 / Tov on
// gemini-3.1-flash-lite-preview) to read each backticked phrase as a
// single token, producing words=["/bin/send hello"] instead of
// ["/bin/send", "hello"]. The array shape needs to be unambiguous in the
// example itself; the JSON-array form does that without paternalism.
const EMIT_HINT_EXAMPLES =
  'e.g. words: ["ls", "/"]  or  words: ["/bin/send", "hello"]';

// Full usage hint surfaced when `emit` is called with no words. The hint
// doubles as onboarding: the AI's first invalid call learns (a) this is a
// bash-like environment via `ls /` and (b) `/bin/send` is a specific
// command worth trying. See paintover §14 for design notes.
export const EMIT_USAGE_HINT = `emit needs words. ${EMIT_HINT_EXAMPLES}`;

function isEmptyWords(words?: string[]): boolean {
  if (!words || words.length === 0) return true;
  return words.every((w) => w.trim() === "");
}

export async function executeEmit(input?: { words?: string[] }): Promise<string> {
  const words = input?.words;

  if (isEmptyWords(words)) {
    return `[System Feedback] ${EMIT_USAGE_HINT}`;
  }

  const safeWords = words as string[];
  const command = safeWords[0];
  const commandArgs = safeWords.slice(1);

  try {
    const result = spawnSync(command, commandArgs, { encoding: "utf-8" });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        // ENOENT message: native spawnSync error on line 1, shared hint
        // example tail on line 2. The leading line already names the
        // command, so the second line just provides the example pair.
        return `[System Feedback] ${err.message}\n${EMIT_HINT_EXAMPLES}`;
      }
      return `[System Feedback] ${err.message}`;
    }
    return (
      result.stdout || result.stderr || "[Executed successfully with no output]"
    );
  } catch (e) {
    return `[Fatal Error] ${(e as Error).message}`;
  }
}
