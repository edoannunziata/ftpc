import { emitKeypressEvents } from "node:readline";
import {
  isAbsolute as isLocalPathAbsolute,
  join as joinLocalPath,
  resolve as resolveLocalPath,
} from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import { joinRemotePath, parentRemotePath } from "../paths.ts";
import type {
  FileDescriptor,
  TransferOptions,
  TransferProgress,
} from "../types.ts";
import { Storage, type StorageSession } from "../storage.ts";
import { renderBrowserFrame, ScreenBuffer } from "./render.ts";
import {
  applyBrowserCommand,
  applyBrowserPromptInput,
  browserMode,
  keyToBrowserCommand,
  keyToBrowserPromptInput,
  withEntries,
  type BrowserKeyPress,
  type BrowserEffect,
  type BrowserState,
} from "./state.ts";

export interface BrowserRunOptions {
  input?: ReadStream;
  output?: WriteStream;
  initialPath?: string;
}

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l";
const EXIT_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";

type TransferKind = "download" | "upload";

interface ActiveTransfer {
  controller: AbortController;
  name: string;
  type: TransferKind;
}

interface QueuedKeypress {
  chunk: string;
  key: BrowserKeyPress;
}

async function loadEntries(
  session: StorageSession,
  cwd: string,
): Promise<FileDescriptor[]> {
  const entries = await session.list(cwd);
  return entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function initialBrowserPath(
  session: StorageSession,
  initialPath: string | undefined,
): string {
  const path = initialPath ?? session.basePath;
  if (session.name === "Local Storage" && !isLocalPathAbsolute(path)) {
    return resolveLocalPath(path);
  }
  return path;
}

export async function runBrowser(
  session: StorageSession,
  options: BrowserRunOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const previousRawMode = input.isRaw;
  const buffer = new ScreenBuffer();
  const remoteTitle = session.name;
  const uploadSession = Storage.local(process.cwd());
  let state: BrowserState = {
    title: remoteTitle,
    cwd: initialBrowserPath(session, options.initialPath),
    entries: [],
    loadingMessage: "Connecting...",
    mode: "normal",
    selected: 0,
    status: "",
  };
  let remoteCwd = state.cwd;
  let history: string[] = [];
  let activeTransfer: ActiveTransfer | undefined;
  let finishAfterTransfer = false;
  const queuedKeypresses: QueuedKeypress[] = [];
  let drainingKeypresses = false;
  let done = false;
  let resolveDone: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (): void => {
    done = true;
    resolveDone();
  };

  const draw = (): void => {
    output.write(
      buffer.render(
        renderBrowserFrame(
          state,
          {
            width: output.columns ?? 80,
            height: output.rows ?? 24,
          },
          { colors: true },
        ),
      ),
    );
  };

  const activeSession = (): StorageSession =>
    browserMode(state) === "upload" ? uploadSession : session;

  const refresh = async (status?: string): Promise<void> => {
    try {
      state = withEntries(
        state,
        await loadEntries(activeSession(), state.cwd),
        status,
      );
    } catch (error) {
      state = {
        ...state,
        entries: [],
        loadingMessage: undefined,
        selected: 0,
        prompt: undefined,
        status: `Error: ${(error as Error).message}`,
      };
    }
  };

  const setTransferProgress = (
    type: TransferKind,
    name: string,
    total: number | undefined,
    progress: TransferProgress,
  ): void => {
    state = {
      ...state,
      transfer: {
        type,
        name,
        bytes: progress.bytes,
        total: progress.total ?? total,
      },
      status: `${type === "download" ? "Downloading" : "Uploading"}: ${name}`,
    };
    draw();
  };

  const cancelActiveTransfer = (quitAfterCancel: boolean): boolean => {
    if (activeTransfer === undefined) {
      return false;
    }
    finishAfterTransfer = finishAfterTransfer || quitAfterCancel;
    if (!activeTransfer.controller.signal.aborted) {
      activeTransfer.controller.abort();
    }
    state = {
      ...state,
      transfer:
        state.transfer === undefined
          ? undefined
          : { ...state.transfer, cancelling: true },
      status: `Canceling ${activeTransfer.name}...`,
    };
    draw();
    return true;
  };

  const runTransfer = async (
    type: TransferKind,
    name: string,
    total: number | undefined,
    transfer: (options: TransferOptions) => Promise<void>,
    onSuccess: () => Promise<void> | void,
  ): Promise<void> => {
    const controller = new AbortController();
    activeTransfer = { controller, name, type };
    state = {
      ...state,
      prompt: undefined,
      transfer: { type, name, bytes: 0, total },
      status: `${type === "download" ? "Downloading" : "Uploading"}: ${name}`,
    };
    draw();

    try {
      await transfer({
        signal: controller.signal,
        onProgress: (progress) =>
          setTransferProgress(type, name, total, progress),
      });
      controller.signal.throwIfAborted();
      activeTransfer = undefined;
      state = { ...state, transfer: undefined };
      await onSuccess();
    } catch (error) {
      activeTransfer = undefined;
      const canceled =
        controller.signal.aborted || (error as Error).name === "AbortError";
      state = {
        ...state,
        transfer: undefined,
        status: canceled
          ? `${type === "download" ? "Download" : "Upload"} of ${name} was canceled`
          : `Error ${type === "download" ? "downloading" : "uploading"} ${name}: ${(error as Error).message}`,
      };
    } finally {
      activeTransfer = undefined;
      if (finishAfterTransfer) {
        finish();
      } else {
        draw();
      }
    }
  };

  output.write(ENTER_ALT_SCREEN);
  draw();
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  await refresh();
  draw();

  const runEffect = async (effect: BrowserEffect): Promise<void> => {
    switch (effect.type) {
      case "quit":
        finish();
        return;
      case "open-directory":
        history.push(state.cwd);
        state = {
          ...state,
          cwd: joinRemotePath(state.cwd, effect.path),
          selected: 0,
        };
        if (browserMode(state) === "normal") {
          remoteCwd = state.cwd;
        }
        await refresh();
        break;
      case "back": {
        const previous = history.pop();
        if (previous === undefined) {
          break;
        }
        state = {
          ...state,
          cwd: previous,
          selected: 0,
        };
        if (browserMode(state) === "normal") {
          remoteCwd = state.cwd;
        }
        await refresh();
        break;
      }
      case "parent":
        if (parentRemotePath(state.cwd) === state.cwd) {
          break;
        }
        history.push(state.cwd);
        state = {
          ...state,
          cwd: parentRemotePath(state.cwd),
          selected: 0,
        };
        if (browserMode(state) === "normal") {
          remoteCwd = state.cwd;
        }
        await refresh();
        break;
      case "refresh":
        await refresh("Refreshed");
        break;
      case "enter-upload-mode":
        remoteCwd = state.cwd;
        state = {
          ...state,
          cwd: process.cwd(),
          mode: "upload",
          prompt: undefined,
          selected: 0,
          status: "In upload mode - Press U to exit",
          title: "Select a file to upload",
        };
        history = [];
        await refresh("In upload mode - Press U to exit");
        break;
      case "exit-upload-mode":
        state = {
          ...state,
          cwd: remoteCwd,
          mode: "normal",
          prompt: undefined,
          selected: 0,
          status: "Exited upload mode",
          title: remoteTitle,
        };
        history = [];
        await refresh("Exited upload mode");
        break;
      case "delete-file": {
        const deleted = await session.delete(
          joinRemotePath(state.cwd, effect.path),
        );
        if (deleted) {
          await refresh(`Deleted: ${effect.name}`);
        } else {
          state = { ...state, status: `Failed to delete ${effect.name}` };
        }
        break;
      }
      case "download-file": {
        const localPath = joinLocalPath(process.cwd(), effect.name);
        await runTransfer(
          "download",
          effect.name,
          effect.size,
          (options) =>
            session.download(
              joinRemotePath(state.cwd, effect.path),
              localPath,
              options,
            ),
          () => {
            state = {
              ...state,
              status: `Downloaded: ${effect.name} to ${process.cwd()}`,
            };
          },
        );
        break;
      }
      case "upload-file": {
        const localPath = joinRemotePath(state.cwd, effect.path);
        await runTransfer(
          "upload",
          effect.name,
          effect.size,
          (options) =>
            session.upload(
              localPath,
              joinRemotePath(remoteCwd, effect.name),
              options,
            ),
          async () => {
            state = {
              ...state,
              cwd: remoteCwd,
              mode: "normal",
              prompt: undefined,
              selected: 0,
              status: `Uploaded: ${effect.name} to ${remoteCwd}`,
              title: remoteTitle,
            };
            await refresh(`Uploaded: ${effect.name} to ${remoteCwd}`);
          },
        );
        break;
      }
      case "mkdir": {
        const created = await session.mkdir(
          joinRemotePath(state.cwd, effect.path),
        );
        if (created) {
          await refresh(`Created directory: ${effect.path}`);
        } else {
          state = {
            ...state,
            status: `Failed to create directory: ${effect.path}`,
          };
        }
        break;
      }
      case "none":
        break;
    }
  };

  const handleKey = async (
    chunk: string,
    key: BrowserKeyPress = {},
  ): Promise<void> => {
    if (done) {
      return;
    }

    if (activeTransfer !== undefined) {
      if ((key.ctrl && key.name === "c") || chunk === "\x03") {
        cancelActiveTransfer(true);
        return;
      }
      if (
        keyToBrowserCommand(chunk, key) === "quit" ||
        key.name === "escape" ||
        chunk === "\x1b"
      ) {
        cancelActiveTransfer(false);
        return;
      }
      draw();
      return;
    }

    if ((key.ctrl && key.name === "c") || chunk === "\x03") {
      finish();
      return;
    }

    if (state.prompt !== undefined) {
      const input =
        state.prompt.type === "help"
          ? { type: "submit" as const }
          : keyToBrowserPromptInput(chunk, key);
      if (input !== undefined) {
        const transition = applyBrowserPromptInput(state, input);
        state = transition.state;
        await runEffect(transition.effect);
      }
      draw();
      return;
    }

    const transition = applyBrowserCommand(
      state,
      keyToBrowserCommand(chunk, key),
    );
    state = transition.state;
    await runEffect(transition.effect);

    if (done) {
      return;
    }

    draw();
  };

  const runKey = async (
    chunk: string,
    key: BrowserKeyPress = {},
  ): Promise<void> => {
    try {
      await handleKey(chunk, key);
    } catch (error) {
      state = {
        ...state,
        prompt: undefined,
        status: `Error: ${(error as Error).message}`,
      };
      draw();
    }
  };

  const drainQueuedKeypresses = async (): Promise<void> => {
    if (drainingKeypresses) {
      return;
    }

    drainingKeypresses = true;
    try {
      while (!done && queuedKeypresses.length > 0) {
        const next = queuedKeypresses.shift();
        if (next !== undefined) {
          await runKey(next.chunk, next.key);
        }
      }
    } finally {
      drainingKeypresses = false;
      if (!done && queuedKeypresses.length > 0) {
        void drainQueuedKeypresses();
      }
    }
  };

  const onKey = (chunk: string, key: BrowserKeyPress): void => {
    if (activeTransfer !== undefined) {
      void runKey(chunk, key);
      return;
    }

    queuedKeypresses.push({ chunk, key });
    void drainQueuedKeypresses();
  };

  const onResize = (): void => {
    if (!done) {
      draw();
    }
  };

  input.on("keypress", onKey);
  output.on("resize", onResize);

  try {
    await donePromise;
  } finally {
    input.off("keypress", onKey);
    output.off("resize", onResize);
    input.setRawMode(previousRawMode);
    input.pause();
    output.write(EXIT_ALT_SCREEN);
    await uploadSession.close();
  }
}
