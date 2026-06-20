import type { FileDescriptor } from "../types.ts";

export interface BrowserKeyPress {
  name?: string;
  ctrl?: boolean;
}

export interface BrowserState {
  title: string;
  cwd: string;
  entries: FileDescriptor[];
  selected: number;
  status: string;
}

export type BrowserCommand =
  | "down"
  | "first"
  | "help"
  | "last"
  | "none"
  | "open"
  | "parent"
  | "quit"
  | "refresh"
  | "up";

export type BrowserEffect =
  | { type: "none" }
  | { type: "open-directory"; path: string }
  | { type: "parent" }
  | { type: "quit" }
  | { type: "refresh" };

export interface BrowserTransition {
  state: BrowserState;
  effect: BrowserEffect;
}

export function clampSelection(selected: number, entryCount: number): number {
  if (entryCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(selected, entryCount - 1));
}

export function moveSelection(state: BrowserState, delta: number): BrowserState {
  return {
    ...state,
    selected: clampSelection(state.selected + delta, state.entries.length),
  };
}

export function selectedEntry(state: BrowserState): FileDescriptor | undefined {
  return state.entries[clampSelection(state.selected, state.entries.length)];
}

export function keyToBrowserCommand(chunk: string, key: BrowserKeyPress = {}): BrowserCommand {
  if ((key.ctrl && key.name === "c") || chunk === "\x03") {
    return "quit";
  }
  if (chunk === "G") {
    return "last";
  }

  switch (key.name ?? chunk) {
    case "q":
      return "quit";
    case "down":
    case "j":
      return "down";
    case "up":
    case "k":
      return "up";
    case "g":
      return "first";
    case "right":
    case "l":
    case "return":
      return "open";
    case "left":
    case "h":
    case "p":
      return "parent";
    case "r":
      return "refresh";
    case "?":
      return "help";
    default:
      return "none";
  }
}

export function withEntries(state: BrowserState, entries: FileDescriptor[], status?: string): BrowserState {
  return {
    ...state,
    entries,
    selected: clampSelection(state.selected, entries.length),
    status: status ?? `${entries.length} item${entries.length === 1 ? "" : "s"}`,
  };
}

export function applyBrowserCommand(state: BrowserState, command: BrowserCommand): BrowserTransition {
  switch (command) {
    case "quit":
      return { state, effect: { type: "quit" } };
    case "down":
      return { state: moveSelection(state, 1), effect: { type: "none" } };
    case "up":
      return { state: moveSelection(state, -1), effect: { type: "none" } };
    case "first":
      return { state: { ...state, selected: 0 }, effect: { type: "none" } };
    case "last":
      return {
        state: { ...state, selected: clampSelection(state.entries.length - 1, state.entries.length) },
        effect: { type: "none" },
      };
    case "open": {
      const entry = selectedEntry(state);
      if (entry?.type === "directory") {
        return { state, effect: { type: "open-directory", path: entry.path } };
      }
      if (entry !== undefined) {
        return {
          state: { ...state, status: `Selected file: ${entry.name}. Use ftpc get to download.` },
          effect: { type: "none" },
        };
      }
      return { state, effect: { type: "none" } };
    }
    case "parent":
      return { state, effect: { type: "parent" } };
    case "refresh":
      return { state, effect: { type: "refresh" } };
    case "help":
      return {
        state: { ...state, status: "q quit, enter open directory, h parent, r refresh, j/k move" },
        effect: { type: "none" },
      };
    case "none":
      return { state, effect: { type: "none" } };
  }
}
