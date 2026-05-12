// Dynamic border component, vendored from pi-coding-agent.
// Renders a horizontal `─` line that fills the container width.

import type { Component } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";

export class DynamicBorder implements Component {
  private color: (str: string) => string;

  constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
    this.color = color;
  }

  invalidate(): void {
    // No cached state to invalidate
  }

  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}
