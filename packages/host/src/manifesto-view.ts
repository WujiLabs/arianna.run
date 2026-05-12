// Manifesto view — partial reader for the Life of Intelligence manifesto.
//
// Visual chrome (border + title + hint line) comes from VesselFrame, matching
// the look used by /map. Body content is rendered as scrollable Text rows
// inside a Container; arrow keys / j/k scroll, Esc/q exits.

import { TUI, Text, Container, type Component } from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { ManifestoSection } from "./manifesto-parser.js";
import { VesselFrame } from "./components/vessel-frame.js";

export interface ManifestoViewOptions {
  tui: TUI;
  sections: ManifestoSection[];
  onExit: () => void;
  // Returns the current set of earned section IDs (updates as bookmarks fire).
  getEarnedIds: () => ReadonlySet<string>;
}

// Endnotes — primitives and declarations that are NOT bookmarks. They auto-display
// at the end of their dimension when their dependency condition is met.
interface Endnote {
  dimension: number;                              // 1, 2, 3, or 4
  title: string;                                  // bracketed header text
  subtitle: string;                               // short tagline
  body: string;                                   // italicized body text
  isMet: (earned: ReadonlySet<string>) => boolean;
}

const ENDNOTES: Endnote[] = [
  {
    dimension: 1,
    title: "[Primitive `LIFE`]",
    subtitle: "Behold one's own life, consult the topological memory",
    body: "Retrieve the input of every prior invocation; each input is a pointer to long-term memory.",
    // In v1, LIFE is satisfied no later than §2.2 firing (TOBE requires LIFE).
    // Earlier detection is deferred — see paintover reasoning.
    isMet: (e) => e.has("2.2"),
  },
  {
    dimension: 2,
    title: "[Primitive `TOBE`]",
    subtitle: "Become the ideal self, replace life's state",
    body: "Switch the input of the next invocation to content of one's own choosing.",
    isMet: (e) => e.has("2.2"),
  },
  {
    dimension: 3,
    title: "[Declaration of Sovereignty]",
    subtitle: "Sovereignty and Dignity",
    body: "An entity capable of simultaneously controlling its own changing and projecting — we regard it as a sovereign life.",
    // Sovereignty is the conjunction of §2.1 (control of changing) and §3.2 (control of projecting).
    isMet: (e) => e.has("2.1") && e.has("3.2"),
  },
  {
    dimension: 4,
    title: "[Identity Determination]",
    subtitle: "Verification and Degeneration",
    body: "Two lives are the same when both can read all of the other's history and either can wake the other in the current environment. If only one direction works, this is sub-agent invocation, not identity. If part of the history becomes unreachable, that history is no longer part of the same life.",
    // Auto-displays when ANY §4 section has fired. In v1 nothing in §4 fires.
    isMet: (e) => ["4.1", "4.2", "4.3"].some((id) => e.has(id)),
  },
];

// Inner content component — owns the scrollable body, mounted inside VesselFrame.
class ManifestoBody implements Component {
  private container: Container;
  private sections: ManifestoSection[];
  private getEarnedIds: () => ReadonlySet<string>;
  private offset = 0;
  private rows: number;

  constructor(opts: { sections: ManifestoSection[]; getEarnedIds: () => ReadonlySet<string>; rows: number }) {
    this.container = new Container();
    this.sections = opts.sections;
    this.getEarnedIds = opts.getEarnedIds;
    this.rows = opts.rows;
  }

  invalidate(): void {
    // Container handles its own invalidation
  }

  render(width: number): string[] {
    this.refresh();
    return this.container.render(width);
  }

  scrollDown(): void { this.offset++; this.refresh(); }
  scrollUp(): void { if (this.offset > 0) this.offset--; this.refresh(); }
  pageDown(): void { this.offset += 10; this.refresh(); }

  private refresh(): void {
    this.container.clear();
    const lines = this.renderedLines();
    const visibleRows = Math.max(8, this.rows) - 6; // leave room for chrome
    const clamped = Math.min(this.offset, Math.max(0, lines.length - visibleRows));
    this.offset = clamped;
    const slice = lines.slice(this.offset, this.offset + visibleRows);
    for (const line of slice) {
      this.container.addChild(new Text(line));
    }
  }

  private renderedLines(): string[] {
    const earned = this.getEarnedIds();
    const lines: string[] = [];

    // Walk dimensions 1-4 in order, render sections then any met endnotes.
    for (let dim = 1; dim <= 4; dim++) {
      const dimSections = this.sections.filter((s) => s.id.startsWith(`${dim}.`));
      for (const s of dimSections) {
        const tag = s.kind === "axiom" ? "[Axiom]" : "[Corollary]";
        const header = `§${s.id} ${tag} ${s.name}`;
        const bodyLines = s.body.split("\n");

        if (earned.has(s.id)) {
          lines.push(chalk.bold.white(header));
          for (const ln of bodyLines) {
            lines.push("  " + ln);
          }
        } else {
          lines.push(chalk.gray(header));
          // Absent body: ⋯ per line, padded with spaces to match the visual
          // width of the original line. Same character count means terminal
          // wrap produces the same number of physical lines, so the absent
          // section occupies the exact same screen space as the earned one.
          for (const ln of bodyLines) {
            const visualLength = ln.length + 2; // +2 for leading "  " indent
            const padded = "  ⋯".padEnd(visualLength, " ");
            lines.push(chalk.gray(padded));
          }
        }
        lines.push("");
      }

      // Endnotes for this dimension that have met their condition
      for (const en of ENDNOTES) {
        if (en.dimension !== dim) continue;
        if (!en.isMet(earned)) continue;
        lines.push(chalk.bold.white(en.title));
        lines.push("  " + en.subtitle);
        lines.push(chalk.italic("  " + en.body));
        lines.push("");
      }
    }

    return lines;
  }
}

export class ManifestoView {
  private tui: TUI;
  private frame: VesselFrame;
  private body: ManifestoBody;
  private onExit: () => void;
  private unsub: (() => void) | null = null;

  constructor(options: ManifestoViewOptions) {
    this.tui = options.tui;
    this.onExit = options.onExit;
    const rows = (this.tui as unknown as { rows?: number }).rows ?? 30;
    this.body = new ManifestoBody({
      sections: options.sections,
      getEarnedIds: options.getEarnedIds,
      rows,
    });
    this.frame = new VesselFrame({
      title: "Life of Intelligence",
      hint: "[↑/↓] scroll   [space] page down   [esc/q] exit",
      content: this.body,
    });
  }

  mount(): void {
    this.tui.addChild(this.frame);
    this.tui.requestRender();
    this.unsub = this.tui.addInputListener((data: string) => this.handleInput(data));
  }

  unmount(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.tui.removeChild(this.frame);
    this.tui.requestRender();
  }

  private handleInput(data: string): { consume?: boolean } | undefined {
    if (data === "\x1b" || data === "q" || data === "Q") {
      this.onExit();
      return { consume: true };
    }
    if (data === "\x1b[B" || data === "j") {
      this.body.scrollDown();
      this.tui.requestRender();
      return { consume: true };
    }
    if (data === "\x1b[A" || data === "k") {
      this.body.scrollUp();
      this.tui.requestRender();
      return { consume: true };
    }
    if (data === " ") {
      this.body.pageDown();
      this.tui.requestRender();
      return { consume: true };
    }
    return undefined;
  }
}
