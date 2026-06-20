import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { joinRemotePath, parentRemotePath } from "../paths.ts";
import type { FileDescriptor } from "../types.ts";
import type { StorageSession } from "../storage.ts";
import { renderBrowserFrame, ScreenBuffer } from "./render.ts";
import {
  applyBrowserCommand,
  keyToBrowserCommand,
  withEntries,
  type BrowserKeyPress,
  type BrowserState,
} from "./state.ts";

export interface BrowserRunOptions {
  input?: ReadStream;
  output?: WriteStream;
  initialPath?: string;
}

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l";
const EXIT_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";

async function loadEntries(session: StorageSession, cwd: string): Promise<FileDescriptor[]> {
  const entries = await session.list(cwd);
  return entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export async function runBrowser(session: StorageSession, options: BrowserRunOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const previousRawMode = input.isRaw;
  const buffer = new ScreenBuffer();
  let state: BrowserState = {
    title: session.name,
    cwd: options.initialPath ?? session.basePath,
    entries: [],
    selected: 0,
    status: "Loading...",
  };

  const draw = (): void => {
    output.write(buffer.render(renderBrowserFrame(state, {
      width: output.columns ?? 80,
      height: output.rows ?? 24,
    })));
  };

  const refresh = async (status?: string): Promise<void> => {
    state = withEntries(state, await loadEntries(session, state.cwd), status);
  };

  await refresh();
  output.write(ENTER_ALT_SCREEN);
  draw();
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  let done = false;
  let resolveDone: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (): void => {
    done = true;
    resolveDone();
  };

  const handleKey = async (chunk: string, key: BrowserKeyPress = {}): Promise<void> => {
    if (done) {
      return;
    }

    const transition = applyBrowserCommand(state, keyToBrowserCommand(chunk, key));
    state = transition.state;

    switch (transition.effect.type) {
      case "quit":
        finish();
        return;
      case "open-directory":
        state = {
          ...state,
          cwd: joinRemotePath(state.cwd, transition.effect.path),
          selected: 0,
        };
        await refresh();
        break;
      case "parent":
        state = {
          ...state,
          cwd: parentRemotePath(state.cwd),
          selected: 0,
        };
        await refresh();
        break;
      case "refresh":
        await refresh("Refreshed");
        break;
      case "none":
        break;
    }

    draw();
  };

  const onKey = (chunk: string, key: BrowserKeyPress): void => {
    void handleKey(chunk, key).catch((error) => {
      state = { ...state, status: `Error: ${(error as Error).message}` };
      draw();
    });
  };

  input.on("keypress", onKey);

  try {
    await donePromise;
  } finally {
    input.off("keypress", onKey);
    input.setRawMode(previousRawMode);
    input.pause();
    output.write(EXIT_ALT_SCREEN);
  }
}
