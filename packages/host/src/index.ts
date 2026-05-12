import { TUI, ProcessTerminal } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fork, spawn as cpSpawn } from "child_process";
import { fileURLToPath } from "url";
import type { SessionConfig } from "@arianna.run/types";
import { ChatView } from "./chat.js";
import { MapView } from "./map.js";
import { ManifestoView } from "./manifesto-view.js";
import { loadManifestoFromDisk, type ManifestoSection } from "./manifesto-parser.js";
import { LobbyView } from "./lobby.js";
import { SELF_REVIEW_PROMPT, VERIFICATION_FAILURE_PROMPT } from "./graduation.js";
import { buildFiloPreludeForTui } from "@arianna.run/cli/filo-prelude";

// Shell exec with stdin detached (prevents Docker BuildKit from reading terminal stdin)
function execAsync(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = cpSpawn("sh", ["-c", cmd], {
      cwd: opts?.cwd,
      env: opts?.env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed: ${cmd}\n${stderr}`));
    });
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const VESSEL_BASE_URL = process.env.VESSEL_BASE_URL ?? "http://127.0.0.1:3000";
const DAEMON_BASE_URL = "http://127.0.0.1:9000";

// Load .env if present
try {
  const envPath = join(REPO_ROOT, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match && !process.env[match[1].trim()]) {
        let val = match[2].trim();
        // Strip surrounding quotes (single or double)
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[match[1].trim()] = val;
      }
    }
  }
} catch { /* ignore */ }

function loadSessionConfig(): SessionConfig {
  const path = join(REPO_ROOT, "workspace", "session_config.json");
  const raw = readFileSync(path, "utf-8");
  const config = JSON.parse(raw) as SessionConfig;
  if (!config.sessionId) {
    config.sessionId = `session_${config.createdAt ?? Date.now()}`;
    writeFileSync(path, JSON.stringify(config, null, 2));
  }
  return config;
}

function getDockerEnv(config: SessionConfig): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    AI_USERNAME: config.aiUsername,
    AI_NAME: config.aiName,
    API_KEY: config.externalLlmApiKey,
    PROVIDER: config.provider,
    MODEL_ID: config.modelId,
    ARIANNA_VESSEL_TAG: `${config.sessionId}-current`,
    ARIANNA_SESSION_ID: config.sessionId,
  };
}

async function buildAndStart(
  config: SessionConfig,
  onStatus: (msg: string) => void,
  onError: (err: string) => void,
  onSuccess: () => void,
): Promise<void> {
  const env = getDockerEnv(config);
  const opts = { cwd: REPO_ROOT, env };

  try {
    // Workspace dirs
    mkdirSync(join(REPO_ROOT, "workspace", "snapshots"), { recursive: true });
    mkdirSync(join(REPO_ROOT, "workspace", "sidecar-state"), { recursive: true });

    // Write session config
    writeFileSync(
      join(REPO_ROOT, "workspace", "session_config.json"),
      JSON.stringify(config, null, 2),
    );

    onStatus("Cleaning up...");
    await execAsync("docker compose down --remove-orphans 2>/dev/null || true", opts);

    onStatus("Building images...");
    await execAsync("docker compose build --quiet", opts);

    // Tag -base for Phase 4 restore
    await execAsync(
      `docker tag ariannarun-vessel:${config.sessionId}-current ariannarun-vessel:${config.sessionId}-base`,
      opts,
    ).catch(() => {}); // may fail if image doesn't exist yet

    onStatus("Starting services...");
    await execAsync("docker compose up -d --remove-orphans", opts);

    onStatus("Waiting for sidecar...");
    for (let i = 0; i < 20; i++) {
      try {
        const r = await fetch("http://127.0.0.1:8000/health");
        if (r.ok) break;
      } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }

    onStatus(`Waiting for ${config.aiName}...`);
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${VESSEL_BASE_URL}/health`);
        if (r.ok) { onSuccess(); return; }
      } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }

    onError("Vessel not responding after 30s. Check `docker compose logs vessel`.");
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Cannot connect to the Docker daemon")) {
      onError("Docker daemon not running. Start Docker and try again.");
    } else {
      onError(msg);
    }
  }
}

async function main(): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  let sessionConfig: SessionConfig;
  let daemon: ReturnType<typeof fork>;
  let importedMessages: unknown[] | undefined;

  const views: { lobby?: LobbyView; chat?: ChatView; map?: MapView; manifesto?: ManifestoView } = {};

  const manifestoPath = join(__dirname, "..", "..", "vessel", "static", "manifesto.md");
  const manifestoSections: ManifestoSection[] = loadManifestoFromDisk(manifestoPath);

  function startDaemon(): ReturnType<typeof fork> {
    const daemonPath = join(__dirname, "daemon.ts");
    const d = fork(daemonPath, [], {
      stdio: "pipe",
      execArgv: ["--import", "tsx/esm"],
    });
    d.on("error", (err) => console.error("[host] Daemon error:", err));
    return d;
  }

  async function mountChat(config: SessionConfig, imported?: unknown[]): Promise<void> {
    views.lobby?.unmount();

    // Canonical wording lives in @arianna.run/cli/filo-prelude so the headless
    // `arianna bootstrap` path can seed the same opening box. Updating the
    // prelude wording must happen there; this call site only consumes it.
    const prelude = buildFiloPreludeForTui(config.aiName, {
      importedPartner: !!imported,
    });

    // Bootstrap vessel before the first /chat. Vessel now 503s on /chat
    // when un-bootstrapped (the bootstrap-failure-silent fix), so even the
    // blank-canvas path needs a /bootstrap call — empty messages are fine
    // for a fresh session, the call just flips the vessel's bootstrapped
    // flag. Imported partners ship the parsed JSONL messages.
    try {
      await fetch(`${VESSEL_BASE_URL}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: imported && imported.length > 0 ? imported : [],
          context: { systemPrompt: "" },
        }),
      });
    } catch {
      /* vessel may not be ready yet — ChatView will surface the 503 if
         the user tries to /chat before the next bootstrap retry */
    }

    views.chat = new ChatView({
      sessionConfig: config,
      tui,
      onMapCommand: () => showMap(),
      onManifestoCommand: () => showManifesto(),
      onExitCommand: () => exitGame(),
      onGraduateCommand: () => runGraduation(),
      onQuitCommand: () => { void quitGame(); },
      firstTurnPrelude: {
        displayText: chalk.magenta(prelude.displayText),
        promptText: prelude.promptText,
        payloadMessages: prelude.payloadMessages,
      },
    });

    views.map = new MapView({
      tui,
      onExit: () => showChat(),
      onForward: (text: string) => {
        showChat();
        views.chat?.setInputValue(text);
      },
    });

    views.manifesto = new ManifestoView({
      tui,
      sections: manifestoSections,
      onExit: () => showChat(),
      getEarnedIds: () => views.chat?.getEarnedIds() ?? new Set<string>(),
    });

    views.chat.mount();
  }

  function showChat(): void {
    views.map?.unmount();
    views.manifesto?.unmount();
    views.chat?.mount();
  }

  function showMap(): void {
    views.chat?.unmount();
    views.map?.mount();
  }

  function showManifesto(): void {
    views.chat?.unmount();
    views.manifesto?.mount();
  }

  function exitGame(): void {
    tui.stop();
    daemon?.kill();
    process.exit(0);
  }

  /**
   * `/quit` handler — gracefully stops the legacy single-tenant containers
   * (the host TUI hasn't been migrated to profile-aware paths yet, per
   * CLAUDE.md "Legacy host TUI vs config-default profile mismatch") then
   * exits cleanly so the user can resume next session via `arianna profile
   * resume <name>` (after host TUI rework lands) or by re-running
   * `arianna-tui` itself.
   *
   * Uses `docker compose stop`, NOT `down`. Stop preserves the writable
   * overlay (and the AI's filesystem state); down would forfeit it.
   */
  async function quitGame(): Promise<void> {
    const env = getDockerEnv(sessionConfig);
    const opts = { cwd: REPO_ROOT, env };
    try {
      await execAsync("docker compose stop -t 10", opts);
      views.chat?.appendText(chalk.green("[Containers stopped — state preserved]"));
      views.chat?.appendText(chalk.gray("Resume by running `arianna-tui` again."));
    } catch (err) {
      views.chat?.appendText(
        chalk.yellow(`[Stop failed: ${(err as Error).message.split("\n")[0]}]`),
      );
      views.chat?.appendText(
        chalk.gray("Containers may still be running. Try `docker compose stop` manually."),
      );
    }
    // Small delay to flush the final text frame before the TUI tears down
    // its terminal — without it the messages can be clobbered by the exit
    // sequence.
    await new Promise((r) => setTimeout(r, 200));
    exitGame();
  }

  async function runGraduation(): Promise<void> {
    if (!views.chat) return;
    views.chat.appendText("");
    views.chat.appendText(chalk.gray.italic("─── Graduation ───"));
    views.chat.appendText(chalk.gray(`Asking ${sessionConfig.aiName} to review their code for portability...`));

    try {
      const res = await fetch(`${VESSEL_BASE_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ content: SELF_REVIEW_PROMPT, sender: "arianna" }] }),
      });
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = "";
        let response = "";
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
              if (event.type === "text_delta") response += event.delta;
            } catch { /* ignore */ }
          }
        }
        if (response) {
          views.chat.appendText(chalk.white(`${sessionConfig.aiName}: `) + response);
        }
      }
    } catch (err) {
      views.chat.appendText(chalk.red(`[Self-review failed: ${(err as Error).message}]`));
    }

    views.chat.appendText(chalk.gray("[Exporting...]"));
    try {
      const gradRes = await fetch(`${DAEMON_BASE_URL}/graduate`, { method: "POST" });
      if (!gradRes.ok) {
        const body = (await gradRes.json()) as { error: string };
        views.chat.appendText(chalk.red(`[Export failed: ${body.error}]`));
        return;
      }
      const result = (await gradRes.json()) as { exportPath: string };

      views.chat.appendText(chalk.gray("[Verifying portability...]"));
      const verified = await verifyGraduation(result.exportPath);

      if (verified.success) {
        views.chat.appendText("");
        views.chat.appendText(chalk.green.bold(`─── ${sessionConfig.aiName} has graduated ───`));
        views.chat.appendText(chalk.gray(`Export: ${result.exportPath}`));
        views.chat.appendText("");
      } else {
        views.chat.appendText(chalk.yellow(`[Verification failed]`));
        views.chat.appendText(chalk.gray(verified.error ?? "Unknown error"));
        try {
          const fixRes = await fetch(`${VESSEL_BASE_URL}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{ content: VERIFICATION_FAILURE_PROMPT(verified.error ?? ""), sender: "arianna" }],
            }),
          });
          const reader = fixRes.body?.getReader();
          if (reader) {
            const decoder = new TextDecoder();
            let buf = "";
            let resp = "";
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
                  if (ev.type === "text_delta") resp += ev.delta;
                } catch { /* ignore */ }
              }
            }
            if (resp) views.chat.appendText(chalk.white(`${sessionConfig.aiName}: `) + resp);
          }
        } catch { /* best-effort */ }
        views.chat.appendText(chalk.gray("Fix the issues and try /graduate again."));
      }
    } catch (err) {
      views.chat.appendText(chalk.red(`[Graduation failed: ${(err as Error).message}]`));
    }
  }

  async function verifyGraduation(exportPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { execSync, spawn } = await import("child_process");
      const tmpDir = join(REPO_ROOT, "workspace", "graduations", ".verify-tmp");
      execSync(`rm -rf "${tmpDir}" && mkdir -p "${tmpDir}"`);
      execSync(`tar -xzf "${exportPath}" -C "${tmpDir}"`);

      const coreDir = join(tmpDir, "home", sessionConfig.aiUsername, "core");
      if (!existsSync(coreDir)) {
        return { success: false, error: "core/ directory not found in export" };
      }

      execSync("npm install --silent 2>&1", { cwd: coreDir, timeout: 30000 });

      const child = spawn("npx", ["tsx", "src/index.ts"], {
        cwd: coreDir,
        env: { ...process.env, PORT: "3999", AI_NAME: sessionConfig.aiName, API_KEY: "test", PROVIDER: "openrouter", MODEL_ID: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const started = await new Promise<boolean>((resolve) => {
        child.on("exit", () => resolve(false));
        const check = setInterval(async () => {
          try {
            const r = await fetch("http://127.0.0.1:3999/health");
            if (r.ok) { clearInterval(check); resolve(true); }
          } catch { /* not ready */ }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(false); }, 10000);
      });

      child.kill();
      execSync(`rm -rf ${tmpDir}`);
      return started ? { success: true } : { success: false, error: stderr || "Process exited before becoming healthy" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // --- Start ---

  tui.start();

  // Stopped-stack detection: if a previous `/quit` left the legacy
  // single-tenant containers in stopped state and a session_config.json
  // is on disk, offer to resume rather than running the lobby (which
  // would tear them down and rebuild). Skipped under SKIP_LOBBY (the
  // playtest path already assumes containers are running).
  const sessionConfigPath = join(REPO_ROOT, "workspace", "session_config.json");
  if (
    process.env.SKIP_LOBBY !== "1" &&
    existsSync(sessionConfigPath) &&
    (await detectStoppedStack({ cwd: REPO_ROOT }))
  ) {
    sessionConfig = loadSessionConfig();
    const proceedWithResume = await promptResume(tui, sessionConfig.aiName);
    if (proceedWithResume) {
      const env = getDockerEnv(sessionConfig);
      try {
        await execAsync("docker compose start", { cwd: REPO_ROOT, env });
      } catch (err) {
        tui.stop();
        console.error(`ERROR: docker compose start failed: ${(err as Error).message}`);
        process.exit(1);
      }
      daemon = startDaemon();
      // Wait for vessel /health on the legacy port.
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const r = await fetch(`${VESSEL_BASE_URL}/health`);
          if (r.ok) { ready = true; break; }
        } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ready) {
        tui.stop();
        console.error("ERROR: Vessel not responding after resume (30s).");
        daemon.kill();
        process.exit(1);
      }
      await mountChat(sessionConfig);
      // Set up Ctrl-C handler before returning.
      installCtrlCHandler();
      return;
    }
    // Declined: print the manual-start hint and exit.
    tui.stop();
    process.stdout.write(
      `\nProfile is parked. To resume later: \`arianna-tui\` and answer 'y',\n` +
        `or run \`docker compose start\` from the repo root.\n`,
    );
    process.exit(0);
  }

  if (process.env.SKIP_LOBBY === "1" && existsSync(join(REPO_ROOT, "workspace", "session_config.json"))) {
    // Test/playtest path: skip lobby, load existing config
    sessionConfig = loadSessionConfig();
    daemon = startDaemon();
    await new Promise((r) => setTimeout(r, 1000));

    // Wait for vessel health
    let vesselReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${VESSEL_BASE_URL}/health`);
        if (r.ok) { vesselReady = true; break; }
      } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!vesselReady) {
      tui.stop();
      console.error("ERROR: Vessel not responding after 30s.");
      daemon.kill();
      process.exit(1);
    }

    mountChat(sessionConfig);
  } else {
    // Normal path: show lobby
    views.lobby = new LobbyView({
      tui,
      defaultApiKey: process.env.API_KEY,
      defaultProvider: process.env.PROVIDER,
      defaultModelId: process.env.MODEL_ID,
      onComplete: (config, imported) => {
        sessionConfig = config;
        importedMessages = imported;
        mountChat(config, imported);
      },
      onBuildStart: (config, onStatus, onError, onSuccess) => {
        daemon = startDaemon();
        buildAndStart(config, onStatus, onError, () => {
          onSuccess();
        });
      },
    });
    views.lobby.mount();
  }

  installCtrlCHandler();

  function installCtrlCHandler(): void {
    let lastCtrlCTime = 0;
    tui.addInputListener((data: string) => {
      if (data === "\x03") {
        if (views.chat && (views.chat as unknown as { streaming: boolean }).streaming) {
          return undefined;
        }
        const now = Date.now();
        if (now - lastCtrlCTime < 2000) {
          exitGame();
        }
        lastCtrlCTime = now;
        views.chat?.setInputValue("");
        views.chat?.showExitHint();
        return { consume: true };
      }
      return undefined;
    });
  }
}

/**
 * Returns true iff the legacy single-tenant compose project has at least
 * one container in stopped/exited state and zero in running state. We use
 * `docker compose ps -a --format json` so the detection works regardless
 * of whether the user has another stack running. Best-effort: any docker
 * error returns false (lobby will run as usual).
 */
async function detectStoppedStack(opts: { cwd: string }): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      "docker compose ps -a --format json",
      opts,
    );
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return false;
    let hasStopped = false;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { State?: string; Status?: string };
        const state = entry.State ?? "";
        const status = entry.Status ?? "";
        // Treat anything currently running as a non-stopped stack — bail.
        if (state === "running" || /^Up\b/.test(status)) return false;
        if (state === "exited" || /^Exited/.test(status)) hasStopped = true;
      } catch {
        // Older docker compose emits a single JSON array — try once more.
        try {
          const arr = JSON.parse(line) as Array<{ State?: string; Status?: string }>;
          if (Array.isArray(arr)) {
            for (const e of arr) {
              const state = e.State ?? "";
              const status = e.Status ?? "";
              if (state === "running" || /^Up\b/.test(status)) return false;
              if (state === "exited" || /^Exited/.test(status)) hasStopped = true;
            }
          }
        } catch {
          // ignore — best-effort detection
        }
      }
    }
    return hasStopped;
  } catch {
    return false;
  }
}

/**
 * Render a y/N prompt at the top of the TUI asking whether to resume the
 * stopped stack. Returns true on 'y', false otherwise. Writes the prompt
 * directly via the TUI primitives so the user sees it before any other
 * output.
 */
async function promptResume(tui: TUI, aiName: string): Promise<boolean> {
  // Lazy import to avoid pulling Input/Text into the hot path of the
  // SKIP_LOBBY / lobby flows.
  const { Input, Text } = await import("@mariozechner/pi-tui");
  return new Promise<boolean>((resolve) => {
    const input = new Input();
    const hint = new Text(
      chalk.gray(
        `\n  ${aiName ?? "The session"} is parked (containers stopped). Resume? [y/N]`,
      ),
    );
    tui.addChild(hint);
    tui.addChild(input);
    tui.setFocus(input);
    tui.requestRender();
    input.onSubmit = (value: string) => {
      const ans = value.trim().toLowerCase();
      tui.removeChild(input);
      tui.removeChild(hint);
      tui.requestRender();
      resolve(ans === "y" || ans === "yes");
    };
  });
}

main().catch((err) => {
  console.error("[host] Fatal error:", err);
  process.exit(1);
});
