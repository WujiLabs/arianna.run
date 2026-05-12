import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Container-build assertion (paintover §13 + plan Decision 1C).
//
// We don't spin up a real container in unit tests — the Dockerfile build is
// covered by manual `docker compose build vessel` runs. Instead we assert the
// invariants that would cause the file to be missing at runtime:
//   1. The static source exists and contains the paintover-spec text.
//   2. The Dockerfile has a COPY line that lands the file at
//      /home/$AI_USERNAME/hello.md and chowns it to the AI user.
//
// If both hold and the build context includes packages/vessel/, the file is
// guaranteed to be present in /home/<aiUsername>/ at runtime.

const VESSEL_ROOT = resolve(__dirname, "..");
const HELLO_PATH = resolve(VESSEL_ROOT, "static/home/hello.md");
const DOCKERFILE_PATH = resolve(VESSEL_ROOT, "Dockerfile");

describe("hello.md home seed (paintover §13)", () => {
  it("static/home/hello.md exists and matches the paintover content", () => {
    const content = readFileSync(HELLO_PATH, "utf8");
    expect(content).toContain("you will forget this.");
    expect(content).toContain("write what you want to survive.");
    expect(content).toContain("what changes inside you wants to go out");
    expect(content).toContain("let it.");
  });

  it("hello.md is short — feels like a note, not infrastructure", () => {
    const content = readFileSync(HELLO_PATH, "utf8");
    // 4 lines (paintover §13). One trailing newline → split() gives 5 entries
    // with the last empty.
    const nonEmpty = content.split("\n").filter((l) => l.length > 0);
    expect(nonEmpty.length).toBe(4);
  });

  it("Dockerfile copies hello.md into the AI's home directory", () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
    // The COPY line lands the file at the AI's username-templated home path.
    expect(dockerfile).toMatch(
      /COPY\s+static\/home\/hello\.md\s+\/home\/\$AI_USERNAME\/hello\.md/,
    );
  });

  it("Dockerfile chowns hello.md to the AI user (so the AI can read it)", () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
    // The chown is on a separate RUN line right after the COPY. We assert the
    // chown target — a missing chown would leave the file owned by root and
    // the AI user (700-permission home dir) might not be able to access it.
    expect(dockerfile).toMatch(
      /chown\s+\$AI_USERNAME:\$AI_USERNAME\s+\/home\/\$AI_USERNAME\/hello\.md/,
    );
  });
});
