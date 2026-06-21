import { overlayDialog, styledFrame, truncate, type BrowserDimensions, type RenderOptions, type ScreenFrame, type StyledLine } from "./render.ts";
import type { RemoteSelectorEntry, RemoteSelectorState } from "./selector.ts";
import { clampRemoteSelection } from "./selector.ts";

const REMOTE_SELECTOR_HELP_LINES = [
  "Navigation:",
  "  j, DOWN    - Move selection down",
  "  k, UP      - Move selection up",
  "  g          - Go to first item",
  "  G          - Go to last item",
  "  /          - Search by prefix",
  "",
  "Actions:",
  "  ENTER, l   - Connect to selected remote",
  "  i          - Show remote details",
  "  o          - Open with custom path",
  "",
  "Other:",
  "  ?          - Show this help",
  "  q          - Quit",
];

function formatRemoteEntry(entry: RemoteSelectorEntry, selected: boolean, width: number): string {
  const marker = selected ? ">" : " ";
  const typeLabel = `[${entry.type}]`;
  const nameWidth = Math.max(1, width - typeLabel.length - 5);
  return truncate(`${marker} ${truncate(entry.name, nameWidth)} ${typeLabel}`, width);
}

function firstVisibleIndex(state: RemoteSelectorState, rows: number): number {
  const selected = clampRemoteSelection(state.selected, state.entries.length);
  return Math.max(0, Math.min(selected - rows + 1, state.entries.length - rows));
}

export function renderRemoteSelectorFrame(
  state: RemoteSelectorState,
  dimensions: BrowserDimensions,
  options: RenderOptions = {},
): ScreenFrame {
  const width = Math.max(20, dimensions.width);
  const height = Math.max(6, dimensions.height);
  const entryRows = Math.max(1, height - 4);
  const selected = clampRemoteSelection(state.selected, state.entries.length);
  const firstVisible = firstVisibleIndex(state, entryRows);

  let lines: StyledLine[] = [
    { text: truncate(`${state.title}  ${state.defaultPath}`, width), style: "selector-bar", fill: true },
    { text: truncate("=".repeat(width), width), style: "selector-bar", fill: true },
  ];

  if (state.entries.length === 0) {
    lines.push({ text: truncate("  No remotes configured", width), style: "muted" });
  } else {
    const visible = state.entries.slice(firstVisible, firstVisible + entryRows);
    for (const [index, entry] of visible.entries()) {
      const isSelected = firstVisible + index === selected;
      lines.push({
        text: formatRemoteEntry(entry, isSelected, width),
        style: isSelected ? "selected-file" : "file",
        fill: isSelected,
      });
    }
  }

  while (lines.length < height - 2) {
    lines.push({ text: "" });
  }

  lines.push({ text: truncate(state.status, width), style: "selector-bar", fill: true });
  lines.push({
    text: truncate("q quit  enter select  o path  i details  / search  ? help", width),
    style: "selector-bar",
    fill: true,
  });

  if (state.prompt?.type === "help") {
    lines = overlayDialog(lines, { width, height }, "Remote Selector Help", REMOTE_SELECTOR_HELP_LINES);
  } else if (state.prompt?.type === "details") {
    lines = overlayDialog(lines, { width, height }, state.prompt.title, state.prompt.lines);
  } else if (state.prompt?.type === "path") {
    lines = overlayDialog(lines, { width, height }, "Open with Path", [
      `Current: ${state.prompt.currentPath}`,
      `>${state.prompt.input}`,
    ], "Enter to confirm, Esc to cancel");
  }

  return styledFrame(width, height, lines, options);
}
