import {
  fullScreenView,
  overlayDialog,
  styledFrame,
  truncate,
  type BrowserDimensions,
  type RenderOptions,
  type ScreenFrame,
  type StyledLine,
} from "./render.ts";
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

function formatRemoteEntry(
  entry: RemoteSelectorEntry,
  selected: boolean,
  width: number,
): string {
  const typeLabel = `[${entry.type}]`;
  const prefix = selected ? ">  " : "   ";
  const nameWidth = Math.max(1, width - typeLabel.length - prefix.length - 1);
  return truncate(
    `${prefix}${truncate(entry.name, nameWidth)} ${typeLabel}`,
    width,
  );
}

function remoteEntryLine(
  entry: RemoteSelectorEntry,
  selected: boolean,
  width: number,
): StyledLine {
  const text = formatRemoteEntry(entry, selected, width);
  if (!selected) {
    return { text };
  }
  return {
    text,
    segments: [
      { text: text.slice(0, 1), style: "selection-marker" },
      { text: text.slice(1), style: "selected-text" },
    ],
  };
}

function firstVisibleIndex(state: RemoteSelectorState, rows: number): number {
  const selected = clampRemoteSelection(state.selected, state.entries.length);
  return Math.max(
    0,
    Math.min(selected - rows + 1, state.entries.length - rows),
  );
}

export function renderRemoteSelectorFrame(
  state: RemoteSelectorState,
  dimensions: BrowserDimensions,
  options: RenderOptions = {},
): ScreenFrame {
  const width = Math.max(20, dimensions.width);
  const height = Math.max(6, dimensions.height);

  if (state.prompt?.type === "help") {
    return styledFrame(
      width,
      height,
      fullScreenView(
        { width, height },
        "Remote Selector Help",
        REMOTE_SELECTOR_HELP_LINES,
        "press any key to continue",
        "selector-bar",
      ),
      options,
    );
  }

  const entryRows = Math.max(1, height - 2);
  const selected = clampRemoteSelection(state.selected, state.entries.length);
  const firstVisible = firstVisibleIndex(state, entryRows);

  let lines: StyledLine[] = [
    {
      text: truncate(`${state.title}  ${state.defaultPath}`, width),
      style: "selector-bar",
      fill: true,
    },
  ];

  if (state.entries.length === 0) {
    lines.push({
      text: truncate("  No remotes configured", width),
      style: "muted",
    });
  } else {
    const visible = state.entries.slice(firstVisible, firstVisible + entryRows);
    for (const [index, entry] of visible.entries()) {
      const isSelected = firstVisible + index === selected;
      lines.push(remoteEntryLine(entry, isSelected, width));
    }
  }

  while (lines.length < height - 1) {
    lines.push({ text: "" });
  }

  lines.push({
    text: state.status,
    style: "selector-bar",
    fill: true,
  });

  if (state.prompt?.type === "details") {
    lines = overlayDialog(
      lines,
      { width, height },
      state.prompt.title,
      state.prompt.lines,
    );
  } else if (state.prompt?.type === "path") {
    lines = overlayDialog(
      lines,
      { width, height },
      "Open with Path",
      [`Current: ${state.prompt.currentPath}`, `>${state.prompt.input}`],
      "Enter to confirm, Esc to cancel",
    );
  }

  return styledFrame(width, height, lines, options);
}
