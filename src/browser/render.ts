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

export interface RenderOptions {
  colors?: boolean;
}

export type LineStyle =
  | "bar"
  | "dialog"
  | "directory"
  | "file"
  | "muted"
  | "selected-directory"
  | "selected-file"
  | "selector-bar"
  | "upload-bar";

export interface StyledLine {
  text: string;
  style?: LineStyle;
  fill?: boolean;
}

const CLEAR_SCREEN = "\x1b[H\x1b[2J";
const CLEAR_LINE = "\x1b[2K";
const RESET = "\x1b[0m";
const STYLE_CODES: Record<LineStyle, string> = {
  bar: "\x1b[1;37;44m",
  dialog: "\x1b[1;37m",
  directory: "\x1b[36m",
  file: "\x1b[32m",
  muted: "\x1b[2m",
  "selected-directory": "\x1b[1;36;7m",
  "selected-file": "\x1b[1;32;7m",
  "selector-bar": "\x1b[1;37;42m",
  "upload-bar": "\x1b[1;37;41m",
};

const BROWSER_HELP_LINES = [
  "Navigation Controls:",
  "  j, DOWN    - Move selection down",
  "  k, UP      - Move selection up",
  "  g          - Go to first item",
  "  G          - Go to last item",
  "  l, RIGHT   - Enter directory",
  "  h, LEFT    - Go back to previous directory",
  "  p          - Go to parent directory",
  "  /          - Search for files by prefix",
  "",
  "File Operations:",
  "  ENTER      - Enter directory or download file",
  "  d          - Delete selected file",
  "  m          - Create new directory",
  "  u          - Enter/exit upload mode",
  "",
  "Other Commands:",
  "  r          - Refresh current directory",
  "  ?          - Show this help",
  "  q          - Quit program",
];

function cursorTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

export function truncate(text: string, width: number): string {
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

function visibleLine(line: StyledLine, width: number, options: RenderOptions): string {
  const text = line.fill === true ? line.text.padEnd(width, " ").slice(0, width) : line.text;
  if (options.colors !== true || line.style === undefined) {
    return text;
  }
  return `${STYLE_CODES[line.style]}${text}${RESET}`;
}

export function styledFrame(width: number, height: number, lines: StyledLine[], options: RenderOptions = {}): ScreenFrame {
  return {
    width,
    height,
    lines: lines.slice(0, height).map((line) => visibleLine(line, width, options)),
  };
}

function centeredTitleBorder(title: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  const label = truncate(` ${title} `, innerWidth);
  const left = Math.max(0, Math.floor((innerWidth - label.length) / 2));
  const right = Math.max(0, innerWidth - label.length - left);
  return `+${"-".repeat(left)}${label}${"-".repeat(right)}+`;
}

function dialogLine(text: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  if (innerWidth <= 0) {
    return truncate(text, width);
  }
  const contentWidth = Math.max(0, innerWidth - 2);
  return `| ${truncate(text, contentWidth).padEnd(contentWidth, " ")} |`;
}

function replaceAt(base: string, start: number, replacement: string, width: number): string {
  const padded = base.padEnd(width, " ").slice(0, width);
  return `${padded.slice(0, start)}${replacement}${padded.slice(start + replacement.length)}`;
}

export function overlayDialog(
  lines: StyledLine[],
  dimensions: BrowserDimensions,
  title: string,
  content: string[],
  prompt = "Press any key to close",
): StyledLine[] {
  const width = Math.max(20, dimensions.width);
  const height = Math.max(6, dimensions.height);
  const longest = Math.max(title.length + 2, prompt.length, ...content.map((line) => line.length));
  const dialogWidth = Math.min(Math.max(24, longest + 4), width - 2);
  const dialogHeight = Math.min(Math.max(4, content.length + 4), height - 2);
  const x = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const y = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const output = lines.map((line) => ({ ...line }));
  const visibleContentRows = Math.max(0, dialogHeight - 3);
  const dialogRows = [
    centeredTitleBorder(title, dialogWidth),
    ...content.slice(0, visibleContentRows).map((line) => dialogLine(line, dialogWidth)),
    dialogLine(prompt, dialogWidth),
    `+${"-".repeat(Math.max(0, dialogWidth - 2))}+`,
  ].slice(0, dialogHeight);

  for (const [index, dialogRow] of dialogRows.entries()) {
    const target = y + index;
    if (target < 0 || target >= output.length) {
      continue;
    }
    output[target] = {
      text: replaceAt(output[target].text, x, dialogRow, width),
      style: "dialog",
      fill: true,
    };
  }

  return output;
}

export function formatTransferSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

function entryStyle(entry: FileDescriptor, selected: boolean): LineStyle {
  if (selected) {
    return entry.type === "directory" ? "selected-directory" : "selected-file";
  }
  return entry.type === "directory" ? "directory" : "file";
}

function transferVerb(type: NonNullable<BrowserState["transfer"]>["type"]): string {
  return type === "download" ? "Downloading" : "Uploading";
}

function transferDialogContent(state: BrowserState): string[] {
  const transfer = state.transfer;
  if (transfer === undefined) {
    return [];
  }

  const hasTotal = transfer.total !== undefined && transfer.total > 0;
  const percentage = hasTotal ? Math.min(100, Math.max(0, (transfer.bytes / transfer.total!) * 100)) : undefined;
  const barWidth = 24;
  const filled = percentage === undefined ? 0 : Math.round((percentage / 100) * barWidth);
  const bar = `[${"#".repeat(filled)}${" ".repeat(barWidth - filled)}]`;
  const totalText = transfer.total === undefined ? "" : ` of ${formatTransferSize(transfer.total)}`;
  const percentageText = percentage === undefined ? "--%" : `${percentage.toFixed(0)}%`;

  return [
    `File: ${transfer.name}`,
    `Transferred: ${formatTransferSize(transfer.bytes)}${totalText}`,
    `${bar} ${percentageText}`,
    transfer.cancelling === true ? "Canceling..." : "Press q or Esc to cancel",
  ];
}

function browserPromptDialog(state: BrowserState): { title: string; content: string[]; prompt?: string } | undefined {
  const prompt = state.prompt;
  if (prompt === undefined) {
    return undefined;
  }

  switch (prompt.type) {
    case "confirm-delete":
      return {
        title: "Confirm?",
        content: [`Delete ${prompt.name}? This cannot be undone.`],
        prompt: "Confirm? (y/n)",
      };
    case "confirm-download":
      return {
        title: "Confirm?",
        content: [`Download ${prompt.name} to local directory?`],
        prompt: "Confirm? (y/n)",
      };
    case "confirm-upload":
      return {
        title: "Confirm?",
        content: [`Upload ${prompt.name} to remote directory?`],
        prompt: "Confirm? (y/n)",
      };
    case "mkdir":
      return {
        title: "Create Directory",
        content: ["Enter directory name:", `>${prompt.input}`],
        prompt: "Enter to confirm, Esc to cancel",
      };
    case "help":
    case "search":
      return undefined;
  }
}

export function renderBrowserFrame(
  state: BrowserState,
  dimensions: BrowserDimensions,
  options: RenderOptions = {},
): ScreenFrame {
  const width = Math.max(20, dimensions.width);
  const height = Math.max(6, dimensions.height);
  const entryRows = Math.max(1, height - 4);
  const selected = clampSelection(state.selected, state.entries.length);
  const firstVisible = firstVisibleIndex(state, entryRows);
  const barStyle: LineStyle = state.mode === "upload" ? "upload-bar" : "bar";

  let lines: StyledLine[] = [
    { text: truncate(`${state.title}  ${state.cwd}`, width), style: barStyle, fill: true },
    { text: truncate("=".repeat(width), width), style: barStyle, fill: true },
  ];

  if (state.entries.length === 0) {
    lines.push({ text: truncate("  No files or directories found", width), style: "muted" });
    if (entryRows > 1) {
      lines.push({ text: truncate("  (Press 'r' to refresh)", width), style: "muted" });
    }
  } else {
    const visible = state.entries.slice(firstVisible, firstVisible + entryRows);
    for (const [index, entry] of visible.entries()) {
      const isSelected = firstVisible + index === selected;
      lines.push({
        text: formatEntry(entry, isSelected, width),
        style: entryStyle(entry, isSelected),
        fill: isSelected,
      });
    }
  }

  while (lines.length < height - 2) {
    lines.push({ text: "" });
  }

  lines.push({ text: truncate(state.status, width), style: barStyle, fill: true });
  lines.push({
    text: truncate("q quit  enter open/get/put  u upload  / search  d delete  m mkdir  ? help", width),
    style: barStyle,
    fill: true,
  });

  if (state.transfer !== undefined) {
    lines = overlayDialog(lines, { width, height }, transferVerb(state.transfer.type), transferDialogContent(state), "");
  } else if (state.prompt?.type === "help") {
    lines = overlayDialog(lines, { width, height }, "Key Commands", BROWSER_HELP_LINES);
  } else {
    const promptDialog = browserPromptDialog(state);
    if (promptDialog !== undefined) {
      lines = overlayDialog(lines, { width, height }, promptDialog.title, promptDialog.content, promptDialog.prompt);
    }
  }

  return styledFrame(width, height, lines, options);
}

export function frameToString(frame: ScreenFrame): string {
  return frame.lines.join("\n");
}

export function renderBrowser(state: BrowserState, dimensions: BrowserDimensions, options: RenderOptions = {}): string {
  return frameToString(renderBrowserFrame(state, dimensions, options));
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
