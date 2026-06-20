import type { FileDescriptor } from "../types.ts";
import type { BrowserState } from "./state.ts";
import { clampSelection } from "./state.ts";

export interface BrowserDimensions {
  width: number;
  height: number;
}

export interface ScreenFrame {
  width: number;
  height: number;
  lines: string[];
}

const CLEAR_SCREEN = "\x1b[H\x1b[2J";
const CLEAR_LINE = "\x1b[2K";

function cursorTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

function truncate(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (text.length <= width) {
    return text;
  }
  if (width <= 3) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 3)}...`;
}

function formatSize(size: number | undefined): string {
  if (size === undefined) {
    return " ".repeat(9);
  }
  if (size < 1024) {
    return `${size}B`.padStart(9, " ");
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)}K`.padStart(9, " ");
  }
  return `${(size / (1024 * 1024)).toFixed(1)}M`.padStart(9, " ");
}

function formatEntry(entry: FileDescriptor, selected: boolean, width: number): string {
  const marker = selected ? ">" : " ";
  const type = entry.type === "directory" ? "D" : "F";
  const modified = entry.modifiedTime?.toISOString().slice(0, 16).replace("T", " ") ?? " ".repeat(16);
  const metadata = `${formatSize(entry.size)} ${modified}`;
  const nameWidth = Math.max(1, width - metadata.length - 6);
  return truncate(`${marker} ${type} ${truncate(entry.name, nameWidth)} ${metadata}`, width);
}

function firstVisibleIndex(state: BrowserState, rows: number): number {
  const selected = clampSelection(state.selected, state.entries.length);
  return Math.max(0, Math.min(selected - rows + 1, state.entries.length - rows));
}

export function renderBrowserFrame(state: BrowserState, dimensions: BrowserDimensions): ScreenFrame {
  const width = Math.max(20, dimensions.width);
  const height = Math.max(6, dimensions.height);
  const entryRows = Math.max(1, height - 4);
  const selected = clampSelection(state.selected, state.entries.length);
  const firstVisible = firstVisibleIndex(state, entryRows);

  const lines: string[] = [
    truncate(`${state.title}  ${state.cwd}`, width),
    truncate("=".repeat(width), width),
  ];

  if (state.entries.length === 0) {
    lines.push(truncate("  No files or directories found", width));
  } else {
    const visible = state.entries.slice(firstVisible, firstVisible + entryRows);
    for (const [index, entry] of visible.entries()) {
      lines.push(formatEntry(entry, firstVisible + index === selected, width));
    }
  }

  while (lines.length < height - 2) {
    lines.push("");
  }

  lines.push(truncate(state.status, width));
  lines.push(truncate("q quit  enter open  h parent  r refresh  j/k move  ? help", width));

  return {
    width,
    height,
    lines: lines.slice(0, height),
  };
}

export function frameToString(frame: ScreenFrame): string {
  return frame.lines.join("\n");
}

export function renderBrowser(state: BrowserState, dimensions: BrowserDimensions): string {
  return frameToString(renderBrowserFrame(state, dimensions));
}

export function diffFrames(previous: ScreenFrame | undefined, next: ScreenFrame): string {
  if (previous === undefined || previous.width !== next.width || previous.height !== next.height) {
    return `${CLEAR_SCREEN}${frameToString(next)}`;
  }

  let output = "";
  for (let index = 0; index < next.lines.length; index += 1) {
    if (previous.lines[index] !== next.lines[index]) {
      output += `${cursorTo(index + 1, 1)}${CLEAR_LINE}${next.lines[index]}`;
    }
  }
  return output;
}

export class ScreenBuffer {
  private previous: ScreenFrame | undefined;

  render(next: ScreenFrame): string {
    const output = diffFrames(this.previous, next);
    this.previous = next;
    return output;
  }

  reset(): void {
    this.previous = undefined;
  }
}
