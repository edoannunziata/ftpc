import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import type { Config } from "../config.ts";
import { ScreenBuffer } from "./render.ts";
import { renderRemoteSelectorFrame } from "./selector_render.ts";
import {
  applyRemoteSelectorCommand,
  applyRemoteSelectorPromptInput,
  initialRemoteSelectorState,
  keyToRemoteSelectorCommand,
  promptInputFromKey,
  remoteEntriesFromConfig,
  type RemoteSelectorEffect,
  type RemoteSelectorState,
} from "./selector.ts";
import type { BrowserKeyPress } from "./state.ts";

export interface RemoteSelection {
  remote: string;
  path: string;
}

export interface RemoteSelectorRunOptions {
  input?: ReadStream;
  output?: WriteStream;
  defaultPath?: string;
}

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[?25l";
const EXIT_ALT_SCREEN = "\x1b[?25h\x1b[?1049l";

export async function runRemoteSelector(
  config: Config,
  options: RemoteSelectorRunOptions = {},
): Promise<RemoteSelection | undefined> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const previousRawMode = input.isRaw;
  const buffer = new ScreenBuffer();
  let state: RemoteSelectorState = initialRemoteSelectorState(
    remoteEntriesFromConfig(config),
    options.defaultPath ?? "/",
  );
  let selection: RemoteSelection | undefined;

  const draw = (): void => {
    output.write(buffer.render(renderRemoteSelectorFrame(state, {
      width: output.columns ?? 80,
      height: output.rows ?? 24,
    }, { colors: true })));
  };

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

  const runEffect = (effect: RemoteSelectorEffect): void => {
    switch (effect.type) {
      case "quit":
        finish();
        break;
      case "select":
        selection = { remote: effect.remote, path: effect.path };
        finish();
        break;
      case "none":
        break;
    }
  };

  const handleKey = (chunk: string, key: BrowserKeyPress = {}): void => {
    if (done) {
      return;
    }

    if (state.prompt !== undefined) {
      const inputValue = state.prompt.type === "help" || state.prompt.type === "details"
        ? { type: "submit" as const }
        : promptInputFromKey(chunk, key);
      if (inputValue !== undefined) {
        const transition = applyRemoteSelectorPromptInput(state, inputValue);
        state = transition.state;
        runEffect(transition.effect);
      }
      if (!done) {
        draw();
      }
      return;
    }

    const transition = applyRemoteSelectorCommand(state, keyToRemoteSelectorCommand(chunk, key));
    state = transition.state;
    runEffect(transition.effect);

    if (!done) {
      draw();
    }
  };

  const onKey = (chunk: string, key: BrowserKeyPress): void => {
    handleKey(chunk, key);
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
  }

  return selection;
}
