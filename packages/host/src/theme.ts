// Minimal theme adapter mirroring the shape used by pi-coding-agent's
// interactive mode. Backed by chalk. Color names match the upstream so vendored
// components compile with only an import path swap.
//
// We don't try to match pi-coding-agent's full palette — just the names that
// the vendored tree-selector and helper components reference.

import chalk from "chalk";
import type { EditorTheme, SelectListTheme } from "@mariozechner/pi-tui";

type Colorer = (text: string) => string;

const FG: Record<string, Colorer> = {
  // Names used by tree-selector / dynamic-border / keybinding-hints / vessel-frame
  border: chalk.gray,
  borderAccent: chalk.gray,
  muted: chalk.gray,
  dim: chalk.dim,
  accent: chalk.cyan,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  customMessageLabel: chalk.magenta,
};

const BG: Record<string, Colorer> = {
  selectedBg: chalk.bgBlackBright,
};

function pickFg(name: string): Colorer {
  return FG[name] ?? ((text: string) => text);
}

function pickBg(name: string): Colorer {
  return BG[name] ?? ((text: string) => text);
}

export const theme = {
  fg(name: string, text: string): string {
    return pickFg(name)(text);
  },
  bg(name: string, text: string): string {
    return pickBg(name)(text);
  },
  bold(text: string): string {
    return chalk.bold(text);
  },
  italic(text: string): string {
    return chalk.italic(text);
  },
  dim(text: string): string {
    return chalk.dim(text);
  },
};

export function getSelectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}

export function getEditorTheme(): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg("border", text),
    selectList: getSelectListTheme(),
  };
}

