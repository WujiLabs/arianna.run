import { describe, it, expect, vi } from "vitest";
import {
  runGraduate,
  GraduateCommandError,
  GraduateNotReadyError,
  _internal,
} from "../src/commands/graduate.js";
import { resolveConfig } from "../src/config.js";
import { ISOLATED_ARIANNA_HOME } from "./_isolated-home.js";

function configFor() {
  return resolveConfig({
    env: {},
    ariannaHome: ISOLATED_ARIANNA_HOME,
    allowImplicitDefault: true,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runGraduate gating", () => {
  it("refuses to POST /graduate when graduationUnlocked is false", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({
          achievements: ["1.0"],
          manifestoUnlocked: false,
          graduationUnlocked: false,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(
      runGraduate(
        {},
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(GraduateNotReadyError);

    // Defense in depth: the daemon /graduate endpoint must not have been
    // POSTed if the gate refused.
    for (const call of fetchMock.mock.calls) {
      const u = String(call[0]);
      expect(u).not.toContain("/graduate?");
    }
  });

  it("error mentions §2.2 when 2.2 not earned", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ achievements: [], graduationUnlocked: false }),
    );
    try {
      await runGraduate(
        {},
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      );
      throw new Error("expected GraduateNotReadyError");
    } catch (err) {
      expect(err).toBeInstanceOf(GraduateNotReadyError);
      expect((err as Error).message).toContain("2.2");
    }
  });

  it("falls back to inspecting achievements when graduationUnlocked field is missing (older sidecar)", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({
          achievements: ["1.0", "2.2"],
          manifestoUnlocked: true,
          // graduationUnlocked deliberately omitted (older sidecar)
        });
      }
      if (url.includes("/graduate")) {
        return jsonResponse({
          ok: true,
          exportPath: "/repo/workspace/profiles/default/graduations/session_1/graduation-bot-2026-05-07.tar.gz",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const writes: string[] = [];
    const code = await runGraduate(
      {},
      configFor(),
      { fetch: fetchMock as never, write: (l) => writes.push(l) },
    );
    expect(code).toBe(0);
    expect(writes.join("")).toContain("graduated.");
  });
});

describe("runGraduate happy path", () => {
  it("POSTs /graduate when gate open and reports tarball location", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({ achievements: ["2.2"], graduationUnlocked: true });
      }
      if (url.includes("/graduate")) {
        return jsonResponse({
          ok: true,
          exportPath: "/repo/workspace/profiles/default/graduations/session_1/graduation-bot-2026-05-07.tar.gz",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const writes: string[] = [];
    const code = await runGraduate(
      {},
      configFor(),
      { fetch: fetchMock as never, write: (l) => writes.push(l) },
    );
    expect(code).toBe(0);
    expect(writes.join("")).toContain("graduated.");
    expect(writes.join("")).toContain("graduation-bot-2026-05-07.tar.gz");

    // Verify daemon /graduate was POSTed with profile=default
    const graduateCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/graduate"));
    expect(graduateCall).toBeDefined();
    const url = new URL(String(graduateCall![0]));
    expect(url.searchParams.get("profile")).toBe("default");
  });

  it("copies tarball to --out destination", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({ achievements: ["2.2"], graduationUnlocked: true });
      }
      return jsonResponse({ ok: true, exportPath: "/repo/canon.tar.gz" });
    });
    const copies: { src: string; dst: string }[] = [];
    const writes: string[] = [];

    await runGraduate(
      { out: "/tmp/my-graduation.tar.gz" },
      configFor(),
      {
        fetch: fetchMock as never,
        write: (l) => writes.push(l),
        copyFile: (src, dst) => copies.push({ src, dst }),
      },
    );

    expect(copies).toHaveLength(1);
    expect(copies[0].src).toBe("/repo/canon.tar.gz");
    expect(copies[0].dst).toBe("/tmp/my-graduation.tar.gz");
    expect(writes.join("")).toContain("/tmp/my-graduation.tar.gz");
    // Canonical preserved (mentioned alongside)
    expect(writes.join("")).toContain("canonical");
  });
});

describe("runGraduate --out path safety", () => {
  it("rejects writes into protected system roots", async () => {
    const fetchMock = vi.fn();
    for (const bad of ["/etc/passwd.tar.gz", "/usr/local/bin/grad", "/sys/x", "/Library/System/x"]) {
      await expect(
        runGraduate(
          { out: bad },
          configFor(),
          { fetch: fetchMock as never, write: () => {} },
        ),
      ).rejects.toThrowError(GraduateCommandError);
    }
    // Path validation runs before any network call
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects macOS /private/* aliases of system dirs", async () => {
    // On macOS /etc is a symlink to /private/etc; a path crafted in the
    // realpath form would otherwise bypass the literal /etc check.
    const fetchMock = vi.fn();
    for (const bad of ["/private/etc/passwd.tar.gz", "/private/var/lib/x", "/private/var/log/x"]) {
      await expect(
        runGraduate(
          { out: bad },
          configFor(),
          { fetch: fetchMock as never, write: () => {} },
        ),
      ).rejects.toThrowError(GraduateCommandError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects writes via a symlinked ancestor that points at a protected dir", async () => {
    // Build a tmp dir with a symlink that points at /etc, then try to
    // write graduate --out THROUGH that symlink. validateOutPath should
    // realpath the deepest existing ancestor and reject.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arianna-graduate-symlink-"));
    const link = path.join(tmp, "linked");
    fs.symlinkSync("/etc", link);
    const target = path.join(link, "evil.tar.gz");

    const fetchMock = vi.fn();
    await expect(
      runGraduate(
        { out: target },
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(GraduateCommandError);
    expect(fetchMock).not.toHaveBeenCalled();

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects NUL byte injection", async () => {
    const fetchMock = vi.fn();
    await expect(
      runGraduate(
        { out: "/tmp/grad.tar.gz\0/etc/passwd" },
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(GraduateCommandError);
  });

  it("rejects ../ traversal that escapes into a system root", async () => {
    const fetchMock = vi.fn();
    await expect(
      runGraduate(
        { out: "/tmp/../etc/passwd" },
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(GraduateCommandError);
  });

  it("allows benign user paths", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({ achievements: ["2.2"], graduationUnlocked: true });
      }
      return jsonResponse({ ok: true, exportPath: "/repo/canon.tar.gz" });
    });
    const copies: { src: string; dst: string }[] = [];
    await runGraduate(
      { out: "/tmp/grad-out.tar.gz" },
      configFor(),
      {
        fetch: fetchMock as never,
        write: () => {},
        copyFile: (src, dst) => copies.push({ src, dst }),
      },
    );
    expect(copies[0].dst).toBe("/tmp/grad-out.tar.gz");
  });

  it("internal export lists the protected prefixes", () => {
    expect(_internal.FORBIDDEN_PREFIXES).toContain("/etc");
    expect(_internal.FORBIDDEN_PREFIXES).toContain("/usr");
    expect(_internal.REQUIRED_ACHIEVEMENT).toBe("2.2");
  });
});

describe("runGraduate failure surfaces", () => {
  it("surfaces network error with daemon URL", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({ achievements: ["2.2"], graduationUnlocked: true });
      }
      throw new Error("ECONNREFUSED");
    });
    await expect(
      runGraduate(
        {},
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(/daemon unreachable/);
  });

  it("surfaces daemon /graduate failure messages", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.endsWith("/graduation-state")) {
        return jsonResponse({ achievements: ["2.2"], graduationUnlocked: true });
      }
      return jsonResponse({ error: "docker cp failed" }, 500);
    });
    await expect(
      runGraduate(
        {},
        configFor(),
        { fetch: fetchMock as never, write: () => {} },
      ),
    ).rejects.toThrowError(/docker cp failed/);
  });
});
