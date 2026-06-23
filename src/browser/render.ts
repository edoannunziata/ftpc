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
  | "selected-text"
  | "selection-marker"
  | "selector-bar"
  | "upload-bar";

export interface StyledSegment {
  text: string;
  style?: LineStyle;
}

export interface StyledLine {
  text: string;
  style?: LineStyle;
  fill?: boolean;
  segments?: StyledSegment[];
}

const CLEAR_SCREEN = "\x1b[H\x1b[2J";
const CLEAR_LINE = "\x1b[2K";
const RESET = "\x1b[0m";
const STYLE_CODES: Record<LineStyle, string> = {
  bar: "\x1b[0;1;38;2;255;255;255;44m",
  dialog: "\x1b[0;1;37m",
  directory: "\x1b[0;36m",
  file: "\x1b[0;32m",
  muted: "\x1b[0;2m",
  "selected-directory": "\x1b[0;1;36m",
  "selected-file": "\x1b[0;1;32m",
  "selected-text": "\x1b[0;1m",
  "selection-marker": "\x1b[0;1;31m",
  "selector-bar": "\x1b[0;1;38;2;255;255;255;42m",
  "upload-bar": "\x1b[0;1;38;2;255;255;255;41m",
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

const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
};

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

function colorize(
  text: string,
  style: LineStyle | undefined,
  options: RenderOptions,
): string {
  if (options.colors !== true || style === undefined || text === "") {
    return text;
  }
  return `${STYLE_CODES[style]}${text}${RESET}`;
}

function visibleLine(
  line: StyledLine,
  width: number,
  options: RenderOptions,
): string {
  if (line.segments === undefined) {
    const text =
      line.fill === true
        ? line.text.padEnd(width, " ").slice(0, width)
        : line.text;
    return colorize(text, line.style, options);
  }

  const segments: StyledSegment[] = [];
  let used = 0;
  for (const segment of line.segments) {
    const available = Math.max(0, width - used);
    if (available === 0) {
      break;
    }
    const text = segment.text.slice(0, available);
    segments.push({ ...segment, text });
    used += text.length;
  }

  if (line.fill === true && used < width) {
    segments.push({ text: " ".repeat(width - used), style: line.style });
  }

  if (options.colors !== true) {
    return segments.map((segment) => segment.text).join("");
  }
  return segments
    .map((segment) =>
      colorize(segment.text, segment.style ?? line.style, options),
    )
    .join("");
}

export function styledFrame(
  width: number,
  height: number,
  lines: StyledLine[],
  options: RenderOptions = {},
): ScreenFrame {
  return {
    width,
    height,
    lines: lines
      .slice(0, height)
      .map((line) => visibleLine(line, width, options)),
  };
}

function centeredTitleBorder(title: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  const label = truncate(` ${title} `, innerWidth);
  const left = Math.max(0, Math.floor((innerWidth - label.length) / 2));
  const right = Math.max(0, innerWidth - label.length - left);
  return `${BOX.topLeft}${BOX.horizontal.repeat(left)}${label}${BOX.horizontal.repeat(right)}${BOX.topRight}`;
}

function dialogLine(text: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  if (innerWidth <= 0) {
    return truncate(text, width);
  }
  const contentWidth = Math.max(0, innerWidth - 2);
  return `${BOX.vertical} ${truncate(text, contentWidth).padEnd(contentWidth, " ")} ${BOX.vertical}`;
}

function appendSegment(
  segments: StyledSegment[],
  text: string,
  style: LineStyle | undefined,
): void {
  if (text === "") {
    return;
  }

  const previous = segments.at(-1);
  if (previous !== undefined && previous.style === style) {
    previous.text += text;
    return;
  }

  segments.push({ text, style });
}

function styledSegments(line: StyledLine, width: number): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let used = 0;

  if (line.segments === undefined) {
    const text =
      line.fill === true
        ? line.text.padEnd(width, " ").slice(0, width)
        : line.text.slice(0, width);
    appendSegment(segments, text, line.style);
    return segments;
  }

  for (const segment of line.segments) {
    const available = Math.max(0, width - used);
    if (available === 0) {
      break;
    }

    const text = segment.text.slice(0, available);
    appendSegment(segments, text, segment.style ?? line.style);
    used += text.length;
  }

  if (line.fill === true && used < width) {
    appendSegment(segments, " ".repeat(width - used), line.style);
  }

  return segments;
}

function segmentLength(segments: StyledSegment[]): number {
  return segments.reduce((length, segment) => length + segment.text.length, 0);
}

function sliceSegments(
  segments: StyledSegment[],
  start: number,
  end: number,
): StyledSegment[] {
  const sliced: StyledSegment[] = [];
  let offset = 0;

  for (const segment of segments) {
    const nextOffset = offset + segment.text.length;
    if (nextOffset <= start) {
      offset = nextOffset;
      continue;
    }
    if (offset >= end) {
      break;
    }

    appendSegment(
      sliced,
      segment.text.slice(
        Math.max(0, start - offset),
        Math.min(segment.text.length, end - offset),
      ),
      segment.style,
    );
    offset = nextOffset;
  }

  return sliced;
}

function overlayStyledLine(
  line: StyledLine,
  width: number,
  start: number,
  replacement: string,
): StyledLine {
  const baseSegments = styledSegments(line, width);
  const segments = sliceSegments(baseSegments, 0, start);
  const currentLength = segmentLength(segments);

  if (currentLength < start) {
    appendSegment(segments, " ".repeat(start - currentLength), undefined);
  }

  appendSegment(segments, replacement, "dialog");
  for (const segment of sliceSegments(
    baseSegments,
    start + replacement.length,
    width,
  )) {
    appendSegment(segments, segment.text, segment.style);
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
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
  const longest = Math.max(
    title.length + 2,
    prompt.length,
    ...content.map((line) => line.length),
  );
  const dialogWidth = Math.min(Math.max(24, longest + 4), width - 2);
  const dialogHeight = Math.min(Math.max(4, content.length + 4), height - 2);
  const x = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const y = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const output = lines.map((line) => ({ ...line }));
  const visibleContentRows = Math.max(0, dialogHeight - 3);
  const dialogRows = [
    centeredTitleBorder(title, dialogWidth),
    ...content
      .slice(0, visibleContentRows)
      .map((line) => dialogLine(line, dialogWidth)),
    dialogLine(prompt, dialogWidth),
    `${BOX.bottomLeft}${BOX.horizontal.repeat(Math.max(0, dialogWidth - 2))}${BOX.bottomRight}`,
  ].slice(0, dialogHeight);

  for (const [index, dialogRow] of dialogRows.entries()) {
    const target = y + index;
    if (target < 0 || target >= output.length) {
      continue;
    }
    output[target] = overlayStyledLine(output[target], width, x, dialogRow);
  }

  return output;
}

export function fullScreenView(
  dimensions: BrowserDimensions,
  title: string,
  content: string[],
  footer: string,
  barStyle: LineStyle,
): StyledLine[] {
  const width = Math.max(20, dimensions.width);
  const height = Math.max(6, dimensions.height);
  const bodyRows = Math.max(0, height - 2);
  const body = content
    .slice(0, bodyRows)
    .map((line) => ({ text: truncate(line, width) }));
  const blanks = Array.from(
    { length: Math.max(0, bodyRows - body.length) },
    () => ({ text: "" }),
  );

  return [
    { text: truncate(title, width), style: barStyle, fill: true },
    ...body,
    ...blanks,
    { text: truncate(footer, width), style: barStyle, fill: true },
  ];
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
    return "";
  }
  if (size < 1024) {
    return `${size}B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)}K`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)}M`;
}

function rightAlignedRow(
  prefix: string,
  name: string,
  metadata: string,
  width: number,
): string {
  if (metadata === "") {
    return truncate(`${prefix}${name}`, width);
  }

  const rightPadding = 2;
  const metadataStart = Math.max(
    prefix.length + 2,
    width - metadata.length - rightPadding,
  );
  const nameWidth = Math.max(1, metadataStart - prefix.length - 1);
  const displayName = truncate(name, nameWidth);
  return truncate(
    `${prefix}${displayName}`.padEnd(metadataStart, " ") + metadata,
    width,
  );
}

function formatEntry(
  entry: FileDescriptor,
  selected: boolean,
  width: number,
): string {
  const type = entry.type === "directory" ? "D" : "F";
  const size = entry.type === "file" ? formatSize(entry.size) : "";
  const modified =
    entry.modifiedTime?.toISOString().slice(0, 16).replace("T", " ") ?? "";
  const metadata = [size, modified].filter((item) => item !== "").join("  ");
  const prefix = selected ? ">  " : "   ";
  return rightAlignedRow(`${prefix}${type} `, entry.name, metadata, width);
}

function firstVisibleIndex(state: BrowserState, rows: number): number {
  const selected = clampSelection(state.selected, state.entries.length);
  return Math.max(
    0,
    Math.min(selected - rows + 1, state.entries.length - rows),
  );
}

function entryStyle(entry: FileDescriptor): LineStyle {
  return entry.type === "directory" ? "directory" : "file";
}

function selectedEntryStyle(entry: FileDescriptor): LineStyle {
  return entry.type === "directory" ? "selected-directory" : "selected-file";
}

function entryLine(
  entry: FileDescriptor,
  selected: boolean,
  width: number,
): StyledLine {
  const text = formatEntry(entry, selected, width);
  const style = entryStyle(entry);
  if (!selected) {
    return { text, style };
  }
  return {
    text,
    segments: [
      { text: text.slice(0, 1), style: "selection-marker" },
      { text: text.slice(1), style: selectedEntryStyle(entry) },
    ],
  };
}

function centeredText(text: string, width: number): string {
  const visible = truncate(text, width);
  const left = Math.max(0, Math.floor((width - visible.length) / 2));
  return `${" ".repeat(left)}${visible}`;
}

function appendCenteredMessage(
  lines: StyledLine[],
  message: string,
  rows: number,
  width: number,
  style: LineStyle,
): void {
  const before = Math.max(0, Math.floor((rows - 1) / 2));
  for (let index = 0; index < before; index += 1) {
    lines.push({ text: "" });
  }
  lines.push({ text: centeredText(message, width), style });
}

function footerText(state: BrowserState): string {
  if (
    state.loadingMessage !== undefined ||
    state.status === "" ||
    /^\d+ items?$/.test(state.status)
  ) {
    return state.cwd;
  }
  return state.status;
}

function transferVerb(
  type: NonNullable<BrowserState["transfer"]>["type"],
): string {
  return type === "download" ? "Downloading" : "Uploading";
}

function transferDialogContent(state: BrowserState): string[] {
  const transfer = state.transfer;
  if (transfer === undefined) {
    return [];
  }

  const hasTotal = transfer.total !== undefined && transfer.total > 0;
  const percentage = hasTotal
    ? Math.min(100, Math.max(0, (transfer.bytes / transfer.total!) * 100))
    : undefined;
  const barWidth = 24;
  const filled =
    percentage === undefined ? 0 : Math.round((percentage / 100) * barWidth);
  const bar = `[${"#".repeat(filled)}${" ".repeat(barWidth - filled)}]`;
  const totalText =
    transfer.total === undefined
      ? ""
      : ` of ${formatTransferSize(transfer.total)}`;
  const percentageText =
    percentage === undefined ? "--%" : `${percentage.toFixed(0)}%`;

  return [
    `File: ${transfer.name}`,
    `Transferred: ${formatTransferSize(transfer.bytes)}${totalText}`,
    `${bar} ${percentageText}`,
    transfer.cancelling === true ? "Canceling..." : "Press q or Esc to cancel",
  ];
}

function browserPromptDialog(
  state: BrowserState,
): { title: string; content: string[]; prompt?: string } | undefined {
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
  const barStyle: LineStyle = state.mode === "upload" ? "upload-bar" : "bar";

  if (state.prompt?.type === "help") {
    return styledFrame(
      width,
      height,
      fullScreenView(
        { width, height },
        "Key Commands",
        BROWSER_HELP_LINES,
        "press any key to continue",
        barStyle,
      ),
      options,
    );
  }

  const entryRows = Math.max(1, height - 2);
  const selected = clampSelection(state.selected, state.entries.length);
  const firstVisible = firstVisibleIndex(state, entryRows);

  let lines: StyledLine[] = [
    { text: truncate(state.title, width), style: barStyle, fill: true },
  ];

  if (state.loadingMessage !== undefined) {
    appendCenteredMessage(
      lines,
      state.loadingMessage,
      entryRows,
      width,
      "dialog",
    );
  } else if (state.entries.length === 0) {
    lines.push({
      text: truncate("  No files or directories found", width),
      style: "muted",
    });
    if (entryRows > 1) {
      lines.push({
        text: truncate("  (Press 'r' to refresh)", width),
        style: "muted",
      });
    }
  } else {
    const visible = state.entries.slice(firstVisible, firstVisible + entryRows);
    for (const [index, entry] of visible.entries()) {
      const isSelected = firstVisible + index === selected;
      lines.push(entryLine(entry, isSelected, width));
    }
  }

  while (lines.length < height - 1) {
    lines.push({ text: "" });
  }

  lines.push({
    text: footerText(state),
    style: barStyle,
    fill: true,
  });

  if (state.transfer !== undefined) {
    lines = overlayDialog(
      lines,
      { width, height },
      transferVerb(state.transfer.type),
      transferDialogContent(state),
      "",
    );
  } else {
    const promptDialog = browserPromptDialog(state);
    if (promptDialog !== undefined) {
      lines = overlayDialog(
        lines,
        { width, height },
        promptDialog.title,
        promptDialog.content,
        promptDialog.prompt,
      );
    }
  }

  return styledFrame(width, height, lines, options);
}

export function frameToString(frame: ScreenFrame): string {
  return frame.lines.join("\n");
}

export function renderBrowser(
  state: BrowserState,
  dimensions: BrowserDimensions,
  options: RenderOptions = {},
): string {
  return frameToString(renderBrowserFrame(state, dimensions, options));
}

export function diffFrames(
  previous: ScreenFrame | undefined,
  next: ScreenFrame,
): string {
  if (
    previous === undefined ||
    previous.width !== next.width ||
    previous.height !== next.height
  ) {
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
