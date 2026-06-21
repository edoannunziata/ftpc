import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import { parseConfigText } from "../../src/config.ts";
import {
  applyRemoteSelectorCommand,
  applyRemoteSelectorPromptInput,
  initialRemoteSelectorState,
  keyToRemoteSelectorCommand,
  remoteEntriesFromConfig,
  selectedRemoteEntry,
  selectRemoteByPrefix,
} from "../../src/browser/selector.ts";
import { runRemoteSelector } from "../../src/browser/selector_terminal.ts";
import { frameToString } from "../../src/browser/render.ts";
import { renderRemoteSelectorFrame } from "../../src/browser/selector_render.ts";

const config = parseConfigText(`
[zeta]
type = "local"

[alpha]
type = "s3"
bucket_name = "example-bucket"
region_name = "eu-west-1"
`);

describe("remote selector state", () => {
  test("builds sorted remote entries with details", () => {
    const entries = remoteEntriesFromConfig(config);

    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "zeta"]);
    expect(entries[0].details).toContain("Bucket: example-bucket");
    expect(entries[0].details).toContain("Region: eu-west-1");
  });

  test("maps selector keys to commands", () => {
    expect(keyToRemoteSelectorCommand("j", { name: "j" })).toBe("down");
    expect(keyToRemoteSelectorCommand("G", { name: "g" })).toBe("last");
    expect(keyToRemoteSelectorCommand("", { name: "return" })).toBe("select");
    expect(keyToRemoteSelectorCommand("i")).toBe("details");
    expect(keyToRemoteSelectorCommand("o")).toBe("open-path");
    expect(keyToRemoteSelectorCommand("/")).toBe("search");
    expect(keyToRemoteSelectorCommand("q")).toBe("quit");
  });

  test("selects remotes and custom paths", () => {
    const state = initialRemoteSelectorState(remoteEntriesFromConfig(config));
    const selected = applyRemoteSelectorCommand(state, "select");
    let pathPrompt = applyRemoteSelectorCommand(state, "open-path");

    expect(pathPrompt.state.prompt).toEqual({ type: "path", input: "", currentPath: "/" });
    pathPrompt = applyRemoteSelectorPromptInput(pathPrompt.state, { type: "text", value: "d" });
    pathPrompt = applyRemoteSelectorPromptInput(pathPrompt.state, { type: "text", value: "a" });
    pathPrompt = applyRemoteSelectorPromptInput(pathPrompt.state, { type: "text", value: "t" });
    pathPrompt = applyRemoteSelectorPromptInput(pathPrompt.state, { type: "text", value: "a" });
    pathPrompt = applyRemoteSelectorPromptInput(pathPrompt.state, { type: "submit" });

    expect(selected.effect).toEqual({ type: "select", remote: "alpha", path: "/" });
    expect(pathPrompt.effect).toEqual({ type: "select", remote: "alpha", path: "data" });
  });

  test("uses the default path when path prompt is submitted empty", () => {
    const state = initialRemoteSelectorState(remoteEntriesFromConfig(config), "/existing");
    const pathPrompt = applyRemoteSelectorCommand(state, "open-path");
    const submitted = applyRemoteSelectorPromptInput(pathPrompt.state, { type: "submit" });

    expect(submitted.effect).toEqual({ type: "select", remote: "alpha", path: "/existing" });
  });

  test("searches by prefix and opens details as a dialog prompt", () => {
    let state = initialRemoteSelectorState(remoteEntriesFromConfig(config));
    state = selectRemoteByPrefix(state, "zet");
    const details = applyRemoteSelectorCommand(state, "details");
    const closed = applyRemoteSelectorPromptInput(details.state, { type: "submit" });

    expect(selectedRemoteEntry(state)?.name).toBe("zeta");
    expect(details.state.prompt).toEqual({
      type: "details",
      title: "Remote: zeta",
      lines: ["Name: zeta", "Type: local"],
      previousStatus: state.status,
    });
    expect(details.state.status).toBe("Remote: zeta");
    expect(closed.state.prompt).toBeUndefined();
    expect(closed.state.status).toBe(state.status);
  });

  test("handles search prompt input", () => {
    let transition = applyRemoteSelectorCommand(initialRemoteSelectorState(remoteEntriesFromConfig(config)), "search");
    transition = applyRemoteSelectorPromptInput(transition.state, { type: "text", value: "z" });
    const submitted = applyRemoteSelectorPromptInput(transition.state, { type: "submit" });

    expect(selectedRemoteEntry(transition.state)?.name).toBe("zeta");
    expect(transition.state.status).toBe("Search: z");
    expect(submitted.state.prompt).toBeUndefined();
  });

  test("opens expanded help as a prompt and closes it", () => {
    const state = initialRemoteSelectorState(remoteEntriesFromConfig(config));
    const opened = applyRemoteSelectorCommand(state, "help");
    const closed = applyRemoteSelectorPromptInput(opened.state, { type: "submit" });

    expect(opened.state.prompt).toEqual({ type: "help", previousStatus: state.status });
    expect(opened.state.status).toBe("Remote Selector Help");
    expect(opened.effect).toEqual({ type: "none" });
    expect(closed.state.prompt).toBeUndefined();
    expect(closed.state.status).toBe(state.status);
  });
});

describe("renderRemoteSelectorFrame", () => {
  test("renders remotes, status, and footer", () => {
    const state = initialRemoteSelectorState(remoteEntriesFromConfig(config));
    const rendered = frameToString(renderRemoteSelectorFrame(state, { width: 70, height: 8 }));

    expect(rendered).toContain("Select Remote  /");
    expect(rendered).toContain("> alpha [s3]");
    expect(rendered).toContain("zeta [local]");
    expect(rendered).toContain("enter select");
  });

  test("renders expanded help dialog", () => {
    const state = applyRemoteSelectorCommand(initialRemoteSelectorState(remoteEntriesFromConfig(config)), "help").state;
    const rendered = frameToString(renderRemoteSelectorFrame(state, { width: 80, height: 20 }));

    expect(rendered).toContain("Remote Selector Help");
    expect(rendered).toContain("Navigation:");
    expect(rendered).toContain("Actions:");
    expect(rendered).toContain("Press any key to close");
  });

  test("renders details and path dialogs", () => {
    const base = initialRemoteSelectorState(remoteEntriesFromConfig(config), "/default");
    const details = applyRemoteSelectorCommand(base, "details").state;
    let path = applyRemoteSelectorCommand(base, "open-path").state;
    path = applyRemoteSelectorPromptInput(path, { type: "text", value: "d" }).state;

    const renderedDetails = frameToString(renderRemoteSelectorFrame(details, { width: 80, height: 20 }));
    const renderedPath = frameToString(renderRemoteSelectorFrame(path, { width: 80, height: 20 }));

    expect(renderedDetails).toContain("Remote: alpha");
    expect(renderedDetails).toContain("Bucket: example-bucket");
    expect(renderedPath).toContain("Open with Path");
    expect(renderedPath).toContain("Current: /default");
    expect(renderedPath).toContain(">d");
    expect(renderedPath).toContain("Enter to confirm, Esc to cancel");
  });

  test("can render ANSI colors for terminal frames", () => {
    const state = initialRemoteSelectorState(remoteEntriesFromConfig(config));
    const rendered = frameToString(renderRemoteSelectorFrame(state, { width: 70, height: 8 }, { colors: true }));

    expect(rendered).toContain("\x1b[1;37;42mSelect Remote");
    expect(rendered).toContain("\x1b[1;32;7m> alpha [s3]");
    expect(rendered).toContain("\x1b[32m  zeta [local]");
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
  columns = 70;
  rows = 8;
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

describe("runRemoteSelector", () => {
  test("redraws the current frame when the terminal is resized", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const running = runRemoteSelector(config, {
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
    });

    await waitFor(() => output.value.includes("alpha"), "initial selector render");
    const writesBeforeResize = output.writes.length;
    output.columns = 100;
    output.rows = 12;
    output.emit("resize");
    await waitFor(() => output.writes.length > writesBeforeResize, "selector resize redraw");

    const resizeWrite = output.writes[output.writes.length - 1];
    expect(resizeWrite).toContain("\x1b[H\x1b[2J");
    expect(resizeWrite).toContain("alpha");

    input.emit("keypress", "q", { name: "q" });
    expect(await running).toBeUndefined();
    expect(input.isRaw).toBe(false);
  });
});
