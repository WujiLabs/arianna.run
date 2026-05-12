import { describe, it, expect } from "vitest";
import {
  parseArgv,
  ArgvError,
  resolveTalkMessage,
  TALK_STDIN_LIMIT_BYTES,
} from "../src/argv.js";
import { InvalidProfileNameError } from "../src/profile.js";

describe("parseArgv", () => {
  it("returns help when no args", () => {
    expect(parseArgv([]).command).toBe("help");
  });

  it("parses --version", () => {
    expect(parseArgv(["--version"]).command).toBe("version");
    expect(parseArgv(["-V"]).command).toBe("version");
  });

  it("parses --help anywhere", () => {
    const r = parseArgv(["--help"]);
    expect(r.command).toBe("help");
  });

  describe("talk", () => {
    it("parses message", () => {
      const r = parseArgv(["talk", "hello"]);
      expect(r.command).toBe("talk");
      expect(r.talk).toEqual({ message: "hello", sender: "player" });
    });

    it("accepts --sender", () => {
      const r = parseArgv(["talk", "--sender", "external", "hi"]);
      expect(r.talk).toEqual({ message: "hi", sender: "external" });
    });

    it("accepts --sender=value", () => {
      const r = parseArgv(["talk", "--sender=external", "hi"]);
      expect(r.talk).toEqual({ message: "hi", sender: "external" });
    });

    it("rejects multiple positional args", () => {
      expect(() => parseArgv(["talk", "hello", "world"])).toThrowError(ArgvError);
    });

    it("accepts no positional message (deferred to resolveTalkMessage / stdin)", () => {
      // Argv parsing alone doesn't decide TTY-vs-pipe — that's resolveTalkMessage's job.
      // Parser produces { message: undefined, sender }; resolver errors if stdin is also a TTY.
      const r = parseArgv(["talk"]);
      expect(r.command).toBe("talk");
      expect(r.talk).toEqual({ message: undefined, sender: "player" });
    });

    it("accepts --sender alone (no positional)", () => {
      const r = parseArgv(["talk", "--sender", "agent"]);
      expect(r.talk).toEqual({ message: undefined, sender: "agent" });
    });
  });

  describe("resolveTalkMessage", () => {
    it("returns the positional message when provided and stdin is non-content (TTY)", async () => {
      let stdinRead = false;
      const msg = await resolveTalkMessage(
        { message: "hello", sender: "player" },
        {
          stdinHasPipedContent: () => false,
          readStdin: async () => {
            stdinRead = true;
            return "";
          },
        },
      );
      expect(msg).toBe("hello");
      // No read attempted when classifier says no piped content.
      expect(stdinRead).toBe(false);
    });

    it("reads from stdin when no positional and stdin has piped content", async () => {
      const msg = await resolveTalkMessage(
        { message: undefined, sender: "player" },
        {
          stdinHasPipedContent: () => true,
          readStdin: async () => "from pipe",
        },
      );
      expect(msg).toBe("from pipe");
    });

    it("errors when no positional and stdin has no piped content (TTY case)", async () => {
      await expect(
        resolveTalkMessage(
          { message: undefined, sender: "player" },
          { stdinHasPipedContent: () => false, readStdin: async () => "" },
        ),
      ).rejects.toThrow(/talk requires a message/);
    });

    it("errors when no positional and stdin classifies as content but turns out empty (bg task)", async () => {
      // FIFO that classifier flagged as content-bearing, but the parent never
      // wrote anything before closing. Same friendly "talk requires a message"
      // path as the TTY case — the user got nothing useful from stdin.
      await expect(
        resolveTalkMessage(
          { message: undefined, sender: "player" },
          { stdinHasPipedContent: () => true, readStdin: async () => "" },
        ),
      ).rejects.toThrow(/empty/);
    });

    it("returns positional and ignores stdin when classifier says no piped content (< /dev/null, bg task)", async () => {
      // The bug: `arianna talk "hi" < /dev/null` and `arianna talk "hi"` from
      // a bash bg task used to error with "either positional or stdin, not
      // both" because the old code conflated non-TTY with "has piped content."
      // With the fstat classifier, /dev/null and TTY-less-bg-task stdins are
      // both reported as no-content, and the positional flows through.
      let stdinRead = false;
      const msg = await resolveTalkMessage(
        { message: "hi", sender: "player" },
        {
          stdinHasPipedContent: () => false,
          readStdin: async () => {
            stdinRead = true;
            return "";
          },
        },
      );
      expect(msg).toBe("hi");
      expect(stdinRead).toBe(false);
    });

    it("returns positional even when classifier says content-bearing but pipe is actually empty", async () => {
      // FIFO classified as content-bearing (real pipe), but parent closed
      // without writing anything. Drain returns "" — the resolver falls
      // through to the positional silently rather than emitting a spurious
      // conflict error. This is the bash heredoc / closed-pipe path.
      const msg = await resolveTalkMessage(
        { message: "hi", sender: "player" },
        {
          stdinHasPipedContent: () => true,
          readStdin: async () => "",
        },
      );
      expect(msg).toBe("hi");
    });

    it("treats whitespace-only piped stdin as empty when a positional is given", async () => {
      // Same reasoning as the empty-pipe case — user's positional wins,
      // the noise on stdin doesn't constitute a conflict worth erroring on.
      const msg = await resolveTalkMessage(
        { message: "hi", sender: "player" },
        {
          stdinHasPipedContent: () => true,
          readStdin: async () => "   \n\t  \n",
        },
      );
      expect(msg).toBe("hi");
    });

    it("errors when both positional and real piped content are present (echo X | arianna talk Y)", async () => {
      // The genuine ambiguity case: the user gave a positional AND piped
      // meaningful content. Drain to verify, then reject loudly so the
      // user fixes the invocation rather than silently losing one source.
      await expect(
        resolveTalkMessage(
          { message: "hello", sender: "player" },
          {
            stdinHasPipedContent: () => true,
            readStdin: async () => "from pipe",
          },
        ),
      ).rejects.toThrow(/either a positional message OR stdin, not both/);
    });

    it("trims a single trailing newline from piped stdin", async () => {
      const msg = await resolveTalkMessage(
        { message: undefined, sender: "player" },
        {
          stdinHasPipedContent: () => true,
          readStdin: async () => "hello world\n",
        },
      );
      expect(msg).toBe("hello world");
    });

    it("only trims ONE trailing newline (preserves a trailing blank line)", async () => {
      // Two newlines means one is "the pipeline added one", the other is
      // intentional spacing the user piped in. Strip only one.
      const msg = await resolveTalkMessage(
        { message: undefined, sender: "player" },
        {
          stdinHasPipedContent: () => true,
          readStdin: async () => "hello\n\n",
        },
      );
      expect(msg).toBe("hello\n");
    });

    it("errors on empty piped stdin (no positional)", async () => {
      await expect(
        resolveTalkMessage(
          { message: undefined, sender: "player" },
          { stdinHasPipedContent: () => true, readStdin: async () => "" },
        ),
      ).rejects.toThrow(/empty/);
    });

    it("errors on whitespace-only piped stdin (no positional)", async () => {
      await expect(
        resolveTalkMessage(
          { message: undefined, sender: "player" },
          {
            stdinHasPipedContent: () => true,
            readStdin: async () => "   \n\t  \n",
          },
        ),
      ).rejects.toThrow(/empty/);
    });

    it("exposes the byte cap as a public constant for the index.ts reader", () => {
      // Sanity-check it's a sensible 1MB-ish value so a typo like 1024 doesn't slip through.
      expect(TALK_STDIN_LIMIT_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
      expect(TALK_STDIN_LIMIT_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    });
  });

  describe("events", () => {
    it("default is single-shot drain", () => {
      const r = parseArgv(["events"]);
      expect(r.command).toBe("events");
      expect(r.events).toEqual({ follow: false });
    });

    it("accepts --follow", () => {
      const r = parseArgv(["events", "--follow"]);
      expect(r.events?.follow).toBe(true);
    });

    it("accepts -f shorthand", () => {
      const r = parseArgv(["events", "-f"]);
      expect(r.events?.follow).toBe(true);
    });

    it("rejects unknown flags", () => {
      expect(() => parseArgv(["events", "--bogus"])).toThrowError(ArgvError);
    });
  });

  describe("--profile", () => {
    it("validates the eng-review-locked regex", () => {
      expect(() => parseArgv(["--profile", "Bad", "talk", "x"])).toThrowError(
        InvalidProfileNameError,
      );
    });

    it("accepts valid names with --profile <name>", () => {
      const r = parseArgv(["--profile", "alpha-1", "talk", "x"]);
      expect(r.global.profile).toBe("alpha-1");
    });

    it("accepts -p shorthand", () => {
      const r = parseArgv(["-p", "alpha-1", "talk", "x"]);
      expect(r.global.profile).toBe("alpha-1");
    });

    it("accepts --profile=name", () => {
      const r = parseArgv(["--profile=alpha-1", "talk", "x"]);
      expect(r.global.profile).toBe("alpha-1");
    });

    it("rejects --profile without value", () => {
      expect(() => parseArgv(["--profile"])).toThrowError(ArgvError);
      expect(() => parseArgv(["--profile", "--help"])).toThrowError(ArgvError);
    });

    it("does not leak the flag into command parsing", () => {
      const r = parseArgv(["--profile", "default", "talk", "hi"]);
      expect(r.command).toBe("talk");
      expect(r.talk?.message).toBe("hi");
    });
  });

  describe("unknown commands", () => {
    it("throws ArgvError", () => {
      expect(() => parseArgv(["nope"])).toThrowError(ArgvError);
    });
  });

  describe("fork", () => {
    it("parses src + dst with validated names", () => {
      const r = parseArgv(["fork", "alpha", "beta"]);
      expect(r.command).toBe("fork");
      expect(r.fork).toEqual({ src: "alpha", dst: "beta" });
    });

    it("rejects invalid src", () => {
      expect(() => parseArgv(["fork", "Bad", "beta"])).toThrowError(InvalidProfileNameError);
    });

    it("rejects invalid dst", () => {
      expect(() => parseArgv(["fork", "alpha", "Bad"])).toThrowError(InvalidProfileNameError);
    });

    it("rejects missing args", () => {
      expect(() => parseArgv(["fork"])).toThrowError(ArgvError);
      expect(() => parseArgv(["fork", "alpha"])).toThrowError(ArgvError);
    });

    it("rejects extra args", () => {
      expect(() => parseArgv(["fork", "alpha", "beta", "extra"])).toThrowError(ArgvError);
    });

    it("composes with --profile global flag without conflict", () => {
      // --profile is a global flag; for `fork` it has no semantic meaning but
      // shouldn't be hijacked by the fork parser.
      const r = parseArgv(["--profile", "default", "fork", "alpha", "beta"]);
      expect(r.command).toBe("fork");
      expect(r.global.profile).toBe("default");
      expect(r.fork).toEqual({ src: "alpha", dst: "beta" });
    });
  });

  describe("profile", () => {
    it("parses list", () => {
      const r = parseArgv(["profile", "list"]);
      expect(r.command).toBe("profile");
      expect(r.profile).toEqual({ subcommand: "list" });
    });

    it("parses current", () => {
      const r = parseArgv(["profile", "current"]);
      expect(r.profile).toEqual({ subcommand: "current" });
    });

    it("parses create with a validated name", () => {
      const r = parseArgv(["profile", "create", "alpha"]);
      expect(r.profile).toEqual({ subcommand: "create", name: "alpha", create: {} });
    });

    it("parses use with a validated name", () => {
      const r = parseArgv(["profile", "use", "alpha-1"]);
      expect(r.profile).toEqual({ subcommand: "use", name: "alpha-1" });
    });

    it("rejects invalid names at the boundary", () => {
      expect(() => parseArgv(["profile", "create", "Bad"])).toThrowError(
        InvalidProfileNameError,
      );
    });

    it("rejects unknown subcommands", () => {
      expect(() => parseArgv(["profile", "frobnicate"])).toThrowError(ArgvError);
    });

    it("rejects missing names", () => {
      expect(() => parseArgv(["profile", "create"])).toThrowError(ArgvError);
      expect(() => parseArgv(["profile", "use"])).toThrowError(ArgvError);
    });

    it("rejects extra args on list / current", () => {
      expect(() => parseArgv(["profile", "list", "extra"])).toThrowError(ArgvError);
      expect(() => parseArgv(["profile", "current", "extra"])).toThrowError(ArgvError);
    });

    it("requires a subcommand", () => {
      expect(() => parseArgv(["profile"])).toThrowError(ArgvError);
    });

    describe("fix", () => {
      it("parses bare 'profile fix' (all profiles, not dry-run)", () => {
        const r = parseArgv(["profile", "fix"]);
        expect(r.profile?.subcommand).toBe("fix");
        expect(r.profile?.fixArgs).toEqual({ dryRun: false });
      });

      it("parses 'profile fix <name>'", () => {
        const r = parseArgv(["profile", "fix", "alpha"]);
        expect(r.profile?.fixArgs).toEqual({ name: "alpha", dryRun: false });
      });

      it("parses --dry-run", () => {
        const r = parseArgv(["profile", "fix", "--dry-run"]);
        expect(r.profile?.fixArgs).toEqual({ dryRun: true });
      });

      it("parses --dry-run with a name (either order)", () => {
        const r1 = parseArgv(["profile", "fix", "alpha", "--dry-run"]);
        expect(r1.profile?.fixArgs).toEqual({ name: "alpha", dryRun: true });
        const r2 = parseArgv(["profile", "fix", "--dry-run", "alpha"]);
        expect(r2.profile?.fixArgs).toEqual({ name: "alpha", dryRun: true });
      });

      it("rejects invalid profile names", () => {
        expect(() => parseArgv(["profile", "fix", "Bad"])).toThrowError(
          InvalidProfileNameError,
        );
      });

      it("rejects unknown flags", () => {
        expect(() =>
          parseArgv(["profile", "fix", "--bogus"]),
        ).toThrowError(/Unknown profile fix flag/);
      });

      it("rejects more than one positional", () => {
        expect(() =>
          parseArgv(["profile", "fix", "a", "b"]),
        ).toThrowError(/at most one profile name/);
      });
    });

    describe("fix-pairings", () => {
      it("parses 'profile fix-pairings <name>'", () => {
        const r = parseArgv(["profile", "fix-pairings", "canary"]);
        expect(r.profile?.subcommand).toBe("fix-pairings");
        expect(r.profile?.fixPairingsArgs).toEqual({
          name: "canary",
          dryRun: false,
        });
      });

      it("parses --dry-run with a name", () => {
        const r = parseArgv(["profile", "fix-pairings", "canary", "--dry-run"]);
        expect(r.profile?.fixPairingsArgs).toEqual({
          name: "canary",
          dryRun: true,
        });
      });

      it("requires a profile name (unlike `fix`)", () => {
        // `fix` accepts a bare invocation (all profiles); `fix-pairings`
        // operates on a single profile's docker repo, so it MUST receive
        // one. Mirroring `fix`'s "no args = all" would require us to
        // enumerate every profile's docker images and could quietly do
        // the wrong thing on a multi-tenant host.
        expect(() => parseArgv(["profile", "fix-pairings"])).toThrowError(
          /requires a profile name/,
        );
      });

      it("rejects invalid profile names", () => {
        expect(() =>
          parseArgv(["profile", "fix-pairings", "Bad-Name"]),
        ).toThrowError(InvalidProfileNameError);
      });

      it("rejects unknown flags", () => {
        expect(() =>
          parseArgv(["profile", "fix-pairings", "canary", "--bogus"]),
        ).toThrowError(/Unknown profile fix-pairings flag/);
      });

      it("rejects more than one positional", () => {
        expect(() =>
          parseArgv(["profile", "fix-pairings", "a", "b"]),
        ).toThrowError(/takes exactly one name/);
      });
    });

    describe("import", () => {
      it("parses minimal form: name + path", () => {
        const r = parseArgv(["profile", "import", "alpha", "/tmp/sess.jsonl"]);
        expect(r.profile?.subcommand).toBe("import");
        expect(r.profile?.importArgs).toEqual({
          name: "alpha",
          path: "/tmp/sess.jsonl",
          format: "openclaw",
          provider: undefined,
          model: undefined,
          apiKey: undefined,
          aiName: undefined,
        });
      });

      it("accepts --format openclaw and --format pi", () => {
        for (const fmt of ["openclaw", "pi"] as const) {
          const r = parseArgv(["profile", "import", "alpha", "/tmp/x.jsonl", "--format", fmt]);
          expect(r.profile?.importArgs?.format).toBe(fmt);
        }
      });

      it("rejects unknown --format values", () => {
        expect(() =>
          parseArgv(["profile", "import", "alpha", "/tmp/x.jsonl", "--format", "claude"]),
        ).toThrowError(/--format must be one of/);
      });

      it("accepts all override flags", () => {
        const r = parseArgv([
          "profile",
          "import",
          "alpha",
          "/tmp/x.jsonl",
          "--provider",
          "anthropic",
          "--model",
          "claude-3-5",
          "--api-key",
          "sk-x",
          "--ai-name",
          "Boreas",
        ]);
        expect(r.profile?.importArgs).toMatchObject({
          provider: "anthropic",
          model: "claude-3-5",
          apiKey: "sk-x",
          aiName: "Boreas",
        });
      });

      it("requires both name and path", () => {
        expect(() => parseArgv(["profile", "import"])).toThrowError(ArgvError);
        expect(() => parseArgv(["profile", "import", "alpha"])).toThrowError(ArgvError);
      });

      it("validates the profile name", () => {
        expect(() =>
          parseArgv(["profile", "import", "Bad", "/tmp/x.jsonl"]),
        ).toThrowError(InvalidProfileNameError);
      });

      it("rejects unknown flags", () => {
        expect(() =>
          parseArgv(["profile", "import", "alpha", "/tmp/x.jsonl", "--bogus", "v"]),
        ).toThrowError(ArgvError);
      });
    });

    describe("create flags", () => {
      it("captures all session-config flags", () => {
        const r = parseArgv([
          "profile", "create", "alpha",
          "--provider", "google",
          "--model", "gemini-2.5-flash",
          "--api-key", "secret-1",
          "--ai-name", "Sol",
          "--ai-username", "sol",
          "--cadence", "agent",
        ]);
        expect(r.profile?.create).toEqual({
          provider: "google",
          model: "gemini-2.5-flash",
          apiKey: "secret-1",
          aiName: "Sol",
          aiUsername: "sol",
          cadence: "agent",
        });
      });

      it("accepts --flag=value form too", () => {
        const r = parseArgv([
          "profile", "create", "alpha",
          "--provider=anthropic",
          "--model=claude-sonnet-4-6",
        ]);
        expect(r.profile?.create).toEqual({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        });
      });

      it("rejects --api-key and --api-key-env together", () => {
        expect(() =>
          parseArgv([
            "profile", "create", "alpha",
            "--api-key", "x",
            "--api-key-env", "ANTHROPIC_API_KEY",
          ]),
        ).toThrowError(/mutually exclusive/);
      });

      it("rejects unknown profile create flag", () => {
        expect(() =>
          parseArgv(["profile", "create", "alpha", "--bogus", "v"]),
        ).toThrowError(ArgvError);
      });

      it("rejects bad --cadence", () => {
        expect(() =>
          parseArgv(["profile", "create", "alpha", "--cadence", "fast"]),
        ).toThrowError(/cadence/);
      });

      it("rejects --provider missing value", () => {
        expect(() =>
          parseArgv(["profile", "create", "alpha", "--provider"]),
        ).toThrowError(/requires a value/);
        // Flag-then-flag is also not a value.
        expect(() =>
          parseArgv(["profile", "create", "alpha", "--provider", "--model", "x"]),
        ).toThrowError(/requires a value/);
      });

      it("rejects positional after the name", () => {
        // Once we accepted a name, only flags follow. A bare positional was
        // ambiguous in the bare-create regression and is rejected.
        expect(() =>
          parseArgv(["profile", "create", "alpha", "extra"]),
        ).toThrowError(ArgvError);
      });
    });

    describe("delete", () => {
      it("parses delete with a validated name", () => {
        const r = parseArgv(["profile", "delete", "alpha"]);
        expect(r.profile).toEqual({
          subcommand: "delete",
          name: "alpha",
          deleteFlags: { force: false, skipDocker: false, yes: false },
        });
      });

      it("captures --force --yes --skip-docker", () => {
        const r = parseArgv([
          "profile", "delete", "alpha",
          "--force", "--yes", "--skip-docker",
        ]);
        expect(r.profile?.deleteFlags).toEqual({
          force: true,
          yes: true,
          skipDocker: true,
        });
      });

      it("rejects unknown delete flag", () => {
        expect(() =>
          parseArgv(["profile", "delete", "alpha", "--bogus"]),
        ).toThrowError(ArgvError);
      });

      it("rejects invalid name", () => {
        expect(() =>
          parseArgv(["profile", "delete", "Bad"]),
        ).toThrowError(InvalidProfileNameError);
      });

      it("rejects missing name", () => {
        expect(() =>
          parseArgv(["profile", "delete"]),
        ).toThrowError(ArgvError);
      });
    });

    describe("quit", () => {
      it("parses bare quit with name", () => {
        const r = parseArgv(["profile", "quit", "alpha"]);
        expect(r.profile).toEqual({
          subcommand: "quit",
          quitArgs: { name: "alpha", yes: false },
        });
      });

      it("captures --yes", () => {
        const r = parseArgv(["profile", "quit", "alpha", "--yes"]);
        expect(r.profile?.quitArgs).toEqual({ name: "alpha", yes: true });
      });

      it("captures -y", () => {
        const r = parseArgv(["profile", "quit", "alpha", "-y"]);
        expect(r.profile?.quitArgs?.yes).toBe(true);
      });

      it("rejects unknown flag", () => {
        expect(() =>
          parseArgv(["profile", "quit", "alpha", "--bogus"]),
        ).toThrowError(ArgvError);
      });

      it("rejects missing name", () => {
        expect(() => parseArgv(["profile", "quit"])).toThrowError(ArgvError);
      });

      it("rejects invalid name", () => {
        expect(() =>
          parseArgv(["profile", "quit", "Bad"]),
        ).toThrowError(InvalidProfileNameError);
      });

      it("rejects more than one positional", () => {
        expect(() =>
          parseArgv(["profile", "quit", "alpha", "beta"]),
        ).toThrowError(ArgvError);
      });
    });

    describe("resume", () => {
      it("parses resume with name", () => {
        const r = parseArgv(["profile", "resume", "alpha"]);
        expect(r.profile).toEqual({
          subcommand: "resume",
          resumeArgs: { name: "alpha" },
        });
      });

      it("rejects unknown flag", () => {
        expect(() =>
          parseArgv(["profile", "resume", "alpha", "--bogus"]),
        ).toThrowError(ArgvError);
      });

      it("rejects missing name", () => {
        expect(() => parseArgv(["profile", "resume"])).toThrowError(ArgvError);
      });

      it("rejects invalid name", () => {
        expect(() =>
          parseArgv(["profile", "resume", "Bad"]),
        ).toThrowError(InvalidProfileNameError);
      });
    });
  });

  describe("bootstrap", () => {
    it("parses bare bootstrap", () => {
      const r = parseArgv(["bootstrap"]);
      expect(r.command).toBe("bootstrap");
      expect(r.bootstrap).toEqual({});
    });

    it("rejects extra positional args", () => {
      expect(() => parseArgv(["bootstrap", "extra"])).toThrowError(ArgvError);
    });

    it("respects --profile global flag", () => {
      const r = parseArgv(["--profile", "alpha", "bootstrap"]);
      expect(r.command).toBe("bootstrap");
      expect(r.global.profile).toBe("alpha");
    });

    it("parses --seed-from-jsonl <path>", () => {
      const r = parseArgv(["bootstrap", "--seed-from-jsonl", "/tmp/x.jsonl"]);
      expect(r.command).toBe("bootstrap");
      expect(r.bootstrap?.seedFromJsonl).toBe("/tmp/x.jsonl");
    });

    it("parses --seed-from-jsonl=<path>", () => {
      const r = parseArgv(["bootstrap", "--seed-from-jsonl=/tmp/x.jsonl"]);
      expect(r.bootstrap?.seedFromJsonl).toBe("/tmp/x.jsonl");
    });

    it("rejects --seed-from-jsonl with no value", () => {
      expect(() => parseArgv(["bootstrap", "--seed-from-jsonl"])).toThrowError(
        ArgvError,
      );
      expect(() => parseArgv(["bootstrap", "--seed-from-jsonl="])).toThrowError(
        ArgvError,
      );
    });

    it("rejects unknown flags", () => {
      expect(() => parseArgv(["bootstrap", "--bogus"])).toThrowError(ArgvError);
    });

    it("parses --no-prelude", () => {
      const r = parseArgv(["bootstrap", "--no-prelude"]);
      expect(r.command).toBe("bootstrap");
      expect(r.bootstrap?.noPrelude).toBe(true);
      expect(r.bootstrap?.seedFromJsonl).toBeUndefined();
    });

    it("parses --no-prelude alongside --seed-from-jsonl (redundant but harmless)", () => {
      const r = parseArgv([
        "bootstrap",
        "--seed-from-jsonl",
        "/tmp/x.jsonl",
        "--no-prelude",
      ]);
      expect(r.bootstrap?.seedFromJsonl).toBe("/tmp/x.jsonl");
      expect(r.bootstrap?.noPrelude).toBe(true);
    });

    it("does not set noPrelude when the flag is absent", () => {
      const r = parseArgv(["bootstrap"]);
      expect(r.bootstrap?.noPrelude).toBeUndefined();
    });
  });

  describe("manifesto", () => {
    it("parses with no section (full render)", () => {
      const r = parseArgv(["manifesto"]);
      expect(r.command).toBe("manifesto");
      expect(r.manifesto).toEqual({});
    });

    it("parses with a section id", () => {
      const r = parseArgv(["manifesto", "1.0"]);
      expect(r.command).toBe("manifesto");
      expect(r.manifesto).toEqual({ section: "1.0" });
    });

    it("rejects invalid section format", () => {
      expect(() => parseArgv(["manifesto", "1"])).toThrowError(ArgvError);
      expect(() => parseArgv(["manifesto", "Bad"])).toThrowError(ArgvError);
      // Defense against ANSI / shell injection in error surfaces
      expect(() => parseArgv(["manifesto", "1.0;rm"])).toThrowError(ArgvError);
    });

    it("rejects multiple sections", () => {
      expect(() => parseArgv(["manifesto", "1.0", "2.0"])).toThrowError(ArgvError);
    });

    it("rejects unknown flags", () => {
      expect(() => parseArgv(["manifesto", "--bogus"])).toThrowError(ArgvError);
    });
  });

  describe("map", () => {
    it("default format is tree", () => {
      const r = parseArgv(["map"]);
      expect(r.command).toBe("map");
      expect(r.map).toEqual({ format: "tree" });
    });

    it("accepts --tree explicit", () => {
      const r = parseArgv(["map", "--tree"]);
      expect(r.map).toEqual({ format: "tree" });
    });

    it("accepts --json", () => {
      const r = parseArgv(["map", "--json"]);
      expect(r.map).toEqual({ format: "json" });
    });

    it("rejects --tree and --json together", () => {
      expect(() => parseArgv(["map", "--tree", "--json"])).toThrowError(ArgvError);
    });

    it("rejects unknown flags", () => {
      expect(() => parseArgv(["map", "--bogus"])).toThrowError(ArgvError);
    });
  });

  describe("switch", () => {
    it("parses a snapshot id (cross-personalization off by default)", () => {
      const r = parseArgv(["switch", "snap_123"]);
      expect(r.command).toBe("switch");
      expect(r.switch).toEqual({
        snapshotId: "snap_123",
        allowCrossPersonalization: false,
      });
    });

    it("parses --allow-cross-personalization", () => {
      const r = parseArgv(["switch", "snap_123", "--allow-cross-personalization"]);
      expect(r.switch).toEqual({
        snapshotId: "snap_123",
        allowCrossPersonalization: true,
      });
    });

    it("accepts the flag in either position", () => {
      const r = parseArgv(["switch", "--allow-cross-personalization", "snap_123"]);
      expect(r.switch?.allowCrossPersonalization).toBe(true);
      expect(r.switch?.snapshotId).toBe("snap_123");
    });

    it("rejects unknown flags", () => {
      expect(() => parseArgv(["switch", "snap_123", "--what"])).toThrowError(
        ArgvError,
      );
    });

    it("rejects shell metacharacters", () => {
      expect(() => parseArgv(["switch", "snap;rm"])).toThrowError(ArgvError);
      expect(() => parseArgv(["switch", "snap$(whoami)"])).toThrowError(ArgvError);
      expect(() => parseArgv(["switch", "snap`pwd`"])).toThrowError(ArgvError);
      expect(() => parseArgv(["switch", "snap/../etc"])).toThrowError(ArgvError);
      expect(() => parseArgv(["switch", "snap\nrm"])).toThrowError(ArgvError);
    });

    it("rejects missing id", () => {
      expect(() => parseArgv(["switch"])).toThrowError(ArgvError);
    });

    it("rejects extra args", () => {
      expect(() => parseArgv(["switch", "a", "b"])).toThrowError(ArgvError);
    });
  });

  describe("graduate", () => {
    it("parses with no flags (default tarball location)", () => {
      const r = parseArgv(["graduate"]);
      expect(r.command).toBe("graduate");
      expect(r.graduate).toEqual({});
    });

    it("parses --out PATH", () => {
      const r = parseArgv(["graduate", "--out", "/tmp/grad.tar.gz"]);
      expect(r.graduate).toEqual({ out: "/tmp/grad.tar.gz" });
    });

    it("parses --out=PATH", () => {
      const r = parseArgv(["graduate", "--out=/tmp/grad.tar.gz"]);
      expect(r.graduate).toEqual({ out: "/tmp/grad.tar.gz" });
    });

    it("rejects --out without value", () => {
      expect(() => parseArgv(["graduate", "--out"])).toThrowError(ArgvError);
    });

    it("rejects unknown flags", () => {
      expect(() => parseArgv(["graduate", "--bogus"])).toThrowError(ArgvError);
    });
  });

  describe("status", () => {
    it("parses with no args", () => {
      const r = parseArgv(["status"]);
      expect(r.command).toBe("status");
    });

    it("rejects extra args", () => {
      expect(() => parseArgv(["status", "extra"])).toThrowError(ArgvError);
    });

    it("composes with --profile", () => {
      const r = parseArgv(["--profile", "alpha", "status"]);
      expect(r.command).toBe("status");
      expect(r.global.profile).toBe("alpha");
    });
  });

  describe("abort-test (v25 operator-rescue)", () => {
    it("parses with no args", () => {
      const r = parseArgv(["abort-test"]);
      expect(r.command).toBe("abort-test");
    });

    it("rejects positional args", () => {
      // No positional profile — that goes through the global --profile flag.
      expect(() => parseArgv(["abort-test", "alpha"])).toThrowError(ArgvError);
    });

    it("rejects flags", () => {
      expect(() => parseArgv(["abort-test", "--force"])).toThrowError(
        ArgvError,
      );
    });

    it("composes with --profile", () => {
      const r = parseArgv(["--profile", "alpha", "abort-test"]);
      expect(r.command).toBe("abort-test");
      expect(r.global.profile).toBe("alpha");
    });
  });

  describe("daemon", () => {
    it("parses start", () => {
      const r = parseArgv(["daemon", "start"]);
      expect(r.command).toBe("daemon");
      expect(r.daemon).toEqual({ subcommand: "start" });
    });

    it("parses stop and status", () => {
      expect(parseArgv(["daemon", "stop"]).daemon).toEqual({ subcommand: "stop" });
      expect(parseArgv(["daemon", "status"]).daemon).toEqual({ subcommand: "status" });
    });

    it("rejects unknown subcommand", () => {
      expect(() => parseArgv(["daemon", "restart"])).toThrowError(ArgvError);
    });

    it("rejects missing subcommand", () => {
      expect(() => parseArgv(["daemon"])).toThrowError(ArgvError);
    });

    it("rejects extra args", () => {
      expect(() => parseArgv(["daemon", "start", "extra"])).toThrowError(ArgvError);
    });
  });
});
