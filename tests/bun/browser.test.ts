import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import {
  applyBrowserCommand,
  applyBrowserPromptInput,
  browserMode,
  clampSelection,
  keyToBrowserCommand,
  keyToBrowserPromptInput,
  moveSelection,
  selectByPrefix,
  selectedEntry,
  type BrowserState,
} from "../../src/browser/state.ts";
import {
  diffFrames,
  formatTransferSize,
  frameToString,
  renderBrowser,
  renderBrowserFrame,
  ScreenBuffer,
} from "../../src/browser/render.ts";
import { runBrowser } from "../../src/browser/terminal.ts";
import type { StorageSession } from "../../src/storage.ts";
import type { TransferOptions } from "../../src/types.ts";

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
    expect(keyToBrowserCommand("h")).toBe("back");
    expect(keyToBrowserCommand("", { name: "left" })).toBe("back");
    expect(keyToBrowserCommand("p")).toBe("parent");
    expect(keyToBrowserCommand("/")).toBe("search");
    expect(keyToBrowserCommand("d")).toBe("delete");
    expect(keyToBrowserCommand("m")).toBe("mkdir");
    expect(keyToBrowserCommand("u")).toBe("toggle-upload");
    expect(keyToBrowserCommand("", { name: "c", ctrl: true })).toBe("quit");
    expect(keyToBrowserCommand("\x03")).toBe("quit");
  });

  test("returns effects for commands that need storage work", () => {
    expect(applyBrowserCommand(state, "open").effect).toEqual({ type: "open-directory", path: "src" });
    expect(applyBrowserCommand({ ...state, selected: 1 }, "open").state.status).toBe("Download README.md to local directory? y/n");
    expect(applyBrowserCommand(state, "back").effect).toEqual({ type: "back" });
    expect(applyBrowserCommand(state, "parent").effect).toEqual({ type: "parent" });
  });

  test("selects entries by case-insensitive prefix", () => {
    const selected = selectByPrefix(state, "read");
    expect(selectedEntry(selected)?.name).toBe("README.md");
    expect(selectedEntry(selectByPrefix(selected, "missing"))?.name).toBe("README.md");
  });

  test("handles search prompt input without storage effects", () => {
    const started = applyBrowserCommand(state, "search").state;
    const typed = applyBrowserPromptInput(started, { type: "text", value: "r" });
    const submitted = applyBrowserPromptInput(typed.state, { type: "submit" });

    expect(keyToBrowserPromptInput("", { name: "backspace" })).toEqual({ type: "backspace" });
    expect(selectedEntry(typed.state)?.name).toBe("README.md");
    expect(typed.state.status).toBe("Search: r");
    expect(typed.effect).toEqual({ type: "none" });
    expect(submitted.state.prompt).toBeUndefined();
    expect(submitted.state.status).toBe(state.status);
  });

  test("prompts before deleting files and rejects directories", () => {
    const directoryDelete = applyBrowserCommand(state, "delete");
    const fileDelete = applyBrowserCommand({ ...state, selected: 1 }, "delete");
    const confirmed = applyBrowserPromptInput(fileDelete.state, { type: "text", value: "y" });

    expect(directoryDelete.state.status).toBe("Cannot delete directories");
    expect(fileDelete.state.status).toBe("Delete README.md? y/n");
    expect(confirmed.effect).toEqual({ type: "delete-file", path: "README.md", name: "README.md" });
    expect(confirmed.state.prompt).toBeUndefined();
  });

  test("prompts before downloading selected files", () => {
    const fileOpen = applyBrowserCommand({ ...state, selected: 1 }, "open");
    const confirmed = applyBrowserPromptInput(fileOpen.state, { type: "text", value: "y" });
    const cancelled = applyBrowserPromptInput(fileOpen.state, { type: "text", value: "n" });

    expect(fileOpen.state.status).toBe("Download README.md to local directory? y/n");
    expect(confirmed.effect).toEqual({ type: "download-file", path: "README.md", name: "README.md", size: 512 });
    expect(confirmed.state.prompt).toBeUndefined();
    expect(cancelled.effect).toEqual({ type: "none" });
    expect(cancelled.state.status).toBe("Download cancelled");
  });

  test("toggles upload mode through effects", () => {
    const enter = applyBrowserCommand(state, "toggle-upload");
    const exit = applyBrowserCommand({ ...state, mode: "upload" }, "toggle-upload");

    expect(browserMode(state)).toBe("normal");
    expect(enter.effect).toEqual({ type: "enter-upload-mode" });
    expect(exit.effect).toEqual({ type: "exit-upload-mode" });
  });

  test("prompts before uploading selected local files", () => {
    const uploadState: BrowserState = { ...state, mode: "upload", selected: 1 };
    const fileOpen = applyBrowserCommand(uploadState, "open");
    const confirmed = applyBrowserPromptInput(fileOpen.state, { type: "text", value: "y" });
    const cancelled = applyBrowserPromptInput(fileOpen.state, { type: "text", value: "n" });

    expect(fileOpen.state.status).toBe("Upload README.md to remote directory? y/n");
    expect(confirmed.effect).toEqual({ type: "upload-file", path: "README.md", name: "README.md", size: 512 });
    expect(confirmed.state.prompt).toBeUndefined();
    expect(cancelled.effect).toEqual({ type: "none" });
    expect(cancelled.state.status).toBe("Upload cancelled");
  });

  test("blocks remote mutation commands in upload mode", () => {
    const uploadState: BrowserState = { ...state, mode: "upload", selected: 1 };

    expect(applyBrowserCommand(uploadState, "delete").state.status).toBe("Upload mode: select a file or press U to exit");
    expect(applyBrowserCommand(uploadState, "mkdir").state.status).toBe("Upload mode: select a file or press U to exit");
  });

  test("collects mkdir prompt input into a storage effect", () => {
    let transition = applyBrowserCommand(state, "mkdir");
    transition = applyBrowserPromptInput(transition.state, { type: "text", value: "n" });
    transition = applyBrowserPromptInput(transition.state, { type: "text", value: "e" });
    transition = applyBrowserPromptInput(transition.state, { type: "text", value: "w" });
    transition = applyBrowserPromptInput(transition.state, { type: "submit" });

    expect(transition.effect).toEqual({ type: "mkdir", path: "new" });
    expect(transition.state.status).toBe("Creating directory: new");
  });

  test("opens expanded help as a prompt and closes it without storage effects", () => {
    const opened = applyBrowserCommand(state, "help");
    const closed = applyBrowserPromptInput(opened.state, { type: "submit" });

    expect(opened.state.prompt).toEqual({ type: "help", previousStatus: "2 items" });
    expect(opened.state.status).toBe("Key Commands");
    expect(opened.effect).toEqual({ type: "none" });
    expect(closed.state.prompt).toBeUndefined();
    expect(closed.state.status).toBe("2 items");
    expect(closed.effect).toEqual({ type: "none" });
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
    expect(rendered).toContain("(Press 'r' to refresh)");
    expect(rendered).toContain("0 items");
  });

  test("renders expanded help dialog", () => {
    const helpState = applyBrowserCommand(state, "help").state;
    const rendered = renderBrowser(helpState, { width: 90, height: 24 });

    expect(rendered).toContain("Key Commands");
    expect(rendered).toContain("Navigation Controls:");
    expect(rendered).toContain("File Operations:");
    expect(rendered).toContain("Press any key to close");
  });

  test("renders confirmation and mkdir prompt dialogs", () => {
    const downloadPrompt = applyBrowserCommand({ ...state, selected: 1 }, "open").state;
    const deletePrompt = applyBrowserCommand({ ...state, selected: 1 }, "delete").state;
    let mkdirPrompt = applyBrowserCommand(state, "mkdir").state;
    mkdirPrompt = applyBrowserPromptInput(mkdirPrompt, { type: "text", value: "n" }).state;
    mkdirPrompt = applyBrowserPromptInput(mkdirPrompt, { type: "text", value: "e" }).state;
    mkdirPrompt = applyBrowserPromptInput(mkdirPrompt, { type: "text", value: "w" }).state;

    const renderedDownload = renderBrowser(downloadPrompt, { width: 90, height: 18 });
    const renderedDelete = renderBrowser(deletePrompt, { width: 90, height: 18 });
    const renderedMkdir = renderBrowser(mkdirPrompt, { width: 90, height: 18 });

    expect(renderedDownload).toContain("Confirm?");
    expect(renderedDownload).toContain("Download README.md to local directory?");
    expect(renderedDownload).toContain("Confirm? (y/n)");
    expect(renderedDelete).toContain("Delete README.md? This cannot be undone.");
    expect(renderedMkdir).toContain("Create Directory");
    expect(renderedMkdir).toContain("Enter directory name:");
    expect(renderedMkdir).toContain(">new");
    expect(renderedMkdir).toContain("Enter to confirm, Esc to cancel");
  });

  test("renders transfer progress dialog", () => {
    const rendered = renderBrowser({
      ...state,
      transfer: { type: "download", name: "README.md", bytes: 256, total: 512 },
      status: "Downloading: README.md",
    }, { width: 90, height: 18 });

    expect(formatTransferSize(1024 * 1024)).toBe("1.0 MB");
    expect(rendered).toContain("Downloading");
    expect(rendered).toContain("File: README.md");
    expect(rendered).toContain("Transferred: 256 B of 512 B");
    expect(rendered).toContain("50%");
    expect(rendered).toContain("Press q or Esc to cancel");
  });

  test("can render ANSI colors for terminal frames", () => {
    const normal = frameToString(renderBrowserFrame(state, { width: 80, height: 10 }, { colors: true }));
    const upload = frameToString(renderBrowserFrame({ ...state, mode: "upload" }, { width: 80, height: 10 }, { colors: true }));

    expect(normal).toContain("\x1b[1;37;44mLocal Storage");
    expect(normal).toContain("\x1b[1;36;7m> D src");
    expect(normal).toContain("\x1b[32m  F README.md");
    expect(upload).toContain("\x1b[1;37;41mLocal Storage");
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

class FakeInput extends EventEmitter {
  isRaw = false;

  setRawMode(value: boolean): void {
    this.isRaw = value;
  }

  resume(): void {}

  pause(): void {}
}

class FakeOutput extends EventEmitter {
  columns = 90;
  rows = 18;
  writes: string[] = [];
  value = "";

  write(data: string): boolean {
    this.writes.push(data);
    this.value += data;
    return true;
  }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("runBrowser transfers", () => {
  test("shows listing errors inside the browser instead of rejecting startup", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let listCalls = 0;

    const session = {
      name: "Broken Remote",
      basePath: "/",
      async list() {
        listCalls += 1;
        throw new Error("list failed");
      },
      async download() {},
      async upload() {},
      async delete() {
        return false;
      },
      async mkdir() {
        return false;
      },
      async close() {},
      resolve(path: string) {
        return path;
      },
    };

    const running = runBrowser(session as unknown as StorageSession, {
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
    });

    await waitFor(() => output.value.includes("Loading..."), "initial loading frame");
    await waitFor(() => output.value.includes("Error: list failed"), "listing error status");

    input.emit("keypress", "q", { name: "q" });
    await running;

    expect(listCalls).toBe(1);
    expect(input.isRaw).toBe(false);
    expect(output.value).toContain("\x1b[?1049h");
    expect(output.value).toContain("\x1b[?1049l");
  });

  test("redraws the current frame when the terminal is resized", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.columns = 50;
    output.rows = 8;

    const session = {
      name: "Remote",
      basePath: "/",
      async list() {
        return [{ path: "file.txt", name: "file.txt", type: "file" as const, size: 4 }];
      },
      async download() {},
      async upload() {},
      async delete() {
        return false;
      },
      async mkdir() {
        return false;
      },
      async close() {},
      resolve(path: string) {
        return path;
      },
    };

    const running = runBrowser(session as unknown as StorageSession, {
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
    });

    await waitFor(() => output.value.includes("file.txt"), "initial browser render");
    const writesBeforeResize = output.writes.length;
    output.columns = 100;
    output.rows = 12;
    output.emit("resize");
    await waitFor(() => output.writes.length > writesBeforeResize, "browser resize redraw");

    const resizeWrite = output.writes[output.writes.length - 1];
    expect(resizeWrite).toContain("\x1b[H\x1b[2J");
    expect(resizeWrite).toContain("file.txt");

    input.emit("keypress", "q", { name: "q" });
    await running;
  });

  test("shows download progress and cancels active transfers before q quits", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    let downloadSignal: AbortSignal | undefined;
    let downloadStarted = false;

    const session = {
      name: "Remote",
      basePath: "/",
      async list() {
        return [{ path: "big.bin", name: "big.bin", type: "file" as const, size: 10 }];
      },
      async download(_remotePath: string, _localPath: string, options: TransferOptions = {}) {
        downloadStarted = true;
        downloadSignal = options.signal;
        options.onProgress?.({ bytes: 5, total: 10 });
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      },
      async upload() {},
      async delete() {
        return false;
      },
      async mkdir() {
        return false;
      },
      async close() {},
      resolve(path: string) {
        return path;
      },
    };

    const running = runBrowser(session as unknown as StorageSession, {
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
    });

    await waitFor(() => output.value.includes("big.bin"), "initial browser render");
    input.emit("keypress", "\r", { name: "return" });
    await waitFor(() => output.value.includes("Download big.bin to local directory? y/n"), "download confirmation");
    input.emit("keypress", "y", { name: "y" });
    await waitFor(() => downloadStarted && output.value.includes("Transferred: 5 B of 10 B"), "download progress");

    input.emit("keypress", "q", { name: "q" });
    await waitFor(() => downloadSignal?.aborted === true, "download abort");
    await waitFor(() => output.value.includes("Download of big.bin was canceled"), "download cancellation status");

    input.emit("keypress", "q", { name: "q" });
    await running;

    expect(input.isRaw).toBe(false);
    expect(output.value).toContain("\x1b[?1049h");
    expect(output.value).toContain("\x1b[?1049l");
  });
});
