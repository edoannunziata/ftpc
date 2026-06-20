import { describe, expect, test } from "bun:test";
import {
  applyBrowserCommand,
  clampSelection,
  keyToBrowserCommand,
  moveSelection,
  selectedEntry,
  type BrowserState,
} from "../../src/browser/state.ts";
import {
  diffFrames,
  frameToString,
  renderBrowser,
  renderBrowserFrame,
  ScreenBuffer,
} from "../../src/browser/render.ts";

const state: BrowserState = {
  title: "Local Storage",
  cwd: "/tmp/project",
  entries: [
    { path: "src", name: "src", type: "directory" },
    { path: "README.md", name: "README.md", type: "file", size: 512, modifiedTime: new Date("2026-06-20T10:30:00Z") },
  ],
  selected: 0,
  status: "2 items",
};

describe("browser state", () => {
  test("clamps selection to available entries", () => {
    expect(clampSelection(-5, 2)).toBe(0);
    expect(clampSelection(8, 2)).toBe(1);
    expect(clampSelection(8, 0)).toBe(0);
  });

  test("moves selection without leaving bounds", () => {
    expect(selectedEntry(moveSelection(state, 1))?.name).toBe("README.md");
    expect(selectedEntry(moveSelection(state, -1))?.name).toBe("src");
  });

  test("maps keys to pure browser commands", () => {
    expect(keyToBrowserCommand("j", { name: "j" })).toBe("down");
    expect(keyToBrowserCommand("q")).toBe("quit");
    expect(keyToBrowserCommand("G", { name: "g" })).toBe("last");
    expect(keyToBrowserCommand("", { name: "return" })).toBe("open");
    expect(keyToBrowserCommand("", { name: "c", ctrl: true })).toBe("quit");
    expect(keyToBrowserCommand("\x03")).toBe("quit");
  });

  test("returns effects for commands that need storage work", () => {
    expect(applyBrowserCommand(state, "open").effect).toEqual({ type: "open-directory", path: "src" });
    expect(applyBrowserCommand({ ...state, selected: 1 }, "open").state.status).toContain("Use ftpc get");
    expect(applyBrowserCommand(state, "parent").effect).toEqual({ type: "parent" });
  });
});

describe("renderBrowser", () => {
  test("renders current path, entries, and help", () => {
    const rendered = renderBrowser(state, { width: 80, height: 10 });

    expect(rendered).toContain("Local Storage  /tmp/project");
    expect(rendered).toContain("> D src");
    expect(rendered).toContain("F README.md");
    expect(rendered).toContain("q quit");
  });

  test("renders empty directory message", () => {
    const rendered = renderBrowser({ ...state, entries: [], status: "0 items" }, { width: 60, height: 8 });

    expect(rendered).toContain("No files or directories found");
    expect(rendered).toContain("0 items");
  });

  test("serializes exactly the frame height without a scrolling newline", () => {
    const frame = renderBrowserFrame(state, { width: 60, height: 8 });
    const serialized = frameToString(frame);

    expect(frame.lines).toHaveLength(8);
    expect(serialized.endsWith("\n")).toBe(false);
    expect(serialized.split("\n")).toHaveLength(8);
  });

  test("diffs frames line by line after the first render", () => {
    const first = renderBrowserFrame(state, { width: 60, height: 8 });
    const second = renderBrowserFrame({ ...state, status: "Refreshed" }, { width: 60, height: 8 });

    const initial = diffFrames(undefined, first);
    const diff = diffFrames(first, second);

    expect(initial).toContain("\x1b[H\x1b[2J");
    expect(diff).not.toContain("\x1b[H\x1b[2J");
    expect(diff).toContain("Refreshed");

    const buffer = new ScreenBuffer();
    expect(buffer.render(first)).toContain("\x1b[H\x1b[2J");
    expect(buffer.render(second)).toContain("Refreshed");
  });
});
