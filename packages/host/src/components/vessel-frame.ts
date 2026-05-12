// VesselFrame — chrome wrapper for modal views (/map, /manifesto).
//
// Mirrors the visual style of pi-coding-agent's interactive-mode tree selector:
//
//   ┌─ (top spacer)
//   ─────────────── (top border)
//     Title in bold              ← title row
//     ↑/↓: move  esc: exit       ← hint row in muted gray
//   ─────────────── (separator border)
//   ┌─ (spacer)
//     <content>                  ← caller-supplied
//   ─┘ (spacer)
//   ─────────────── (bottom border)
//
// The content is any pi-tui Component the caller passes in. VesselFrame
// composes the chrome around it and exposes a Container so the host can mount
// it like any other view.

import { Container, Spacer, Text, type Component } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";
import { DynamicBorder } from "./dynamic-border.js";

export interface VesselFrameOptions {
  title: string;
  hint?: string;
  content: Component;
}

export class VesselFrame extends Container {
  constructor(options: VesselFrameOptions) {
    super();

    const { title, hint, content } = options;

    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.addChild(new Text(theme.bold("  " + title), 1, 0));
    if (hint) {
      this.addChild(new Text(theme.fg("muted", "  " + hint), 0, 0));
    }
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(content);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }
}
