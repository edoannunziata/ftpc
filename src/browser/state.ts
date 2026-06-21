import type { FileDescriptor } from "../types.ts";

export interface BrowserKeyPress {
  name?: string;
  ctrl?: boolean;
}

export interface BrowserState {
  title: string;
  cwd: string;
  entries: FileDescriptor[];
  mode?: BrowserMode;
  selected: number;
  status: string;
  prompt?: BrowserPrompt;
  transfer?: BrowserTransfer;
}

export type BrowserMode = "normal" | "upload";

export type BrowserTransferKind = "download" | "upload";

export interface BrowserTransfer {
  type: BrowserTransferKind;
  name: string;
  bytes: number;
  total?: number;
  cancelling?: boolean;
}

export type BrowserPrompt =
  | { type: "confirm-delete"; path: string; name: string }
  | { type: "confirm-download"; path: string; name: string; size?: number }
  | { type: "confirm-upload"; path: string; name: string; size?: number }
  | { type: "help"; previousStatus: string }
  | { type: "mkdir"; input: string }
  | { type: "search"; input: string; previousStatus: string };

export type BrowserCommand =
  | "back"
  | "delete"
  | "down"
  | "first"
  | "help"
  | "last"
  | "mkdir"
  | "none"
  | "open"
  | "parent"
  | "quit"
  | "refresh"
  | "search"
  | "toggle-upload"
  | "up";

export type BrowserEffect =
  | { type: "back" }
  | { type: "delete-file"; path: string; name: string }
  | { type: "download-file"; path: string; name: string; size?: number }
  | { type: "enter-upload-mode" }
  | { type: "exit-upload-mode" }
  | { type: "mkdir"; path: string }
  | { type: "none" }
  | { type: "open-directory"; path: string }
  | { type: "parent" }
  | { type: "quit" }
  | { type: "refresh" }
  | { type: "upload-file"; path: string; name: string; size?: number };

export type BrowserPromptInput =
  | { type: "backspace" }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "text"; value: string };

export interface BrowserTransition {
  state: BrowserState;
  effect: BrowserEffect;
}

export function clampSelection(selected: number, entryCount: number): number {
  if (entryCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(selected, entryCount - 1));
}

export function moveSelection(state: BrowserState, delta: number): BrowserState {
  return {
    ...state,
    selected: clampSelection(state.selected + delta, state.entries.length),
  };
}

export function selectedEntry(state: BrowserState): FileDescriptor | undefined {
  return state.entries[clampSelection(state.selected, state.entries.length)];
}

export function browserMode(state: BrowserState): BrowserMode {
  return state.mode ?? "normal";
}

export function selectByPrefix(state: BrowserState, prefix: string): BrowserState {
  if (prefix === "") {
    return state;
  }

  const normalized = prefix.toLocaleLowerCase();
  const index = state.entries.findIndex((entry) => entry.name.toLocaleLowerCase().startsWith(normalized));
  if (index === -1) {
    return state;
  }
  return { ...state, selected: index };
}

export function keyToBrowserCommand(chunk: string, key: BrowserKeyPress = {}): BrowserCommand {
  if ((key.ctrl && key.name === "c") || chunk === "\x03") {
    return "quit";
  }
  if (chunk === "G") {
    return "last";
  }

  switch (key.name ?? chunk) {
    case "q":
      return "quit";
    case "down":
    case "j":
      return "down";
    case "up":
    case "k":
      return "up";
    case "g":
      return "first";
    case "right":
    case "l":
    case "return":
      return "open";
    case "left":
    case "h":
      return "back";
    case "p":
      return "parent";
    case "r":
      return "refresh";
    case "?":
      return "help";
    case "/":
      return "search";
    case "d":
      return "delete";
    case "m":
      return "mkdir";
    case "u":
      return "toggle-upload";
    default:
      return "none";
  }
}

export function keyToBrowserPromptInput(chunk: string, key: BrowserKeyPress = {}): BrowserPromptInput | undefined {
  if ((key.ctrl && key.name === "c") || chunk === "\x03") {
    return { type: "cancel" };
  }

  switch (key.name ?? chunk) {
    case "escape":
      return { type: "cancel" };
    case "return":
      return { type: "submit" };
    case "backspace":
      return { type: "backspace" };
    default:
      break;
  }

  if (chunk === "\x1b") {
    return { type: "cancel" };
  }
  if (chunk === "\r" || chunk === "\n") {
    return { type: "submit" };
  }
  if (chunk === "\x7f" || chunk === "\b") {
    return { type: "backspace" };
  }
  if (chunk.length === 1 && chunk >= " ") {
    return { type: "text", value: chunk };
  }
  return undefined;
}

export function withEntries(state: BrowserState, entries: FileDescriptor[], status?: string): BrowserState {
  return {
    ...state,
    entries,
    selected: clampSelection(state.selected, entries.length),
    prompt: undefined,
    status: status ?? `${entries.length} item${entries.length === 1 ? "" : "s"}`,
  };
}

function appendPromptInput(input: string, value: string): string {
  if (value.length !== 1 || value < " ") {
    return input;
  }
  return `${input}${value}`;
}

function withSearchPrompt(state: BrowserState, input: string, previousStatus: string): BrowserState {
  return selectByPrefix({
    ...state,
    prompt: { type: "search", input, previousStatus },
    status: `Search: ${input}`,
  }, input);
}

export function applyBrowserPromptInput(state: BrowserState, input: BrowserPromptInput): BrowserTransition {
  const prompt = state.prompt;
  if (prompt === undefined) {
    return { state, effect: { type: "none" } };
  }

  switch (prompt.type) {
    case "help":
      return {
        state: { ...state, prompt: undefined, status: prompt.previousStatus },
        effect: { type: "none" },
      };
    case "search": {
      if (input.type === "cancel" || input.type === "submit") {
        return {
          state: { ...state, prompt: undefined, status: prompt.previousStatus },
          effect: { type: "none" },
        };
      }
      const nextInput = input.type === "backspace"
        ? prompt.input.slice(0, -1)
        : input.type === "text"
          ? appendPromptInput(prompt.input, input.value)
          : prompt.input;
      return {
        state: withSearchPrompt(state, nextInput, prompt.previousStatus),
        effect: { type: "none" },
      };
    }
    case "mkdir": {
      if (input.type === "cancel") {
        return {
          state: { ...state, prompt: undefined, status: "Directory creation cancelled" },
          effect: { type: "none" },
        };
      }
      if (input.type === "submit") {
        const path = prompt.input.trim();
        if (path === "") {
          return {
            state: { ...state, prompt: undefined, status: "Directory creation cancelled" },
            effect: { type: "none" },
          };
        }
        return {
          state: { ...state, prompt: undefined, status: `Creating directory: ${path}` },
          effect: { type: "mkdir", path },
        };
      }
      const nextInput = input.type === "backspace"
        ? prompt.input.slice(0, -1)
        : input.type === "text"
          ? appendPromptInput(prompt.input, input.value)
          : prompt.input;
      return {
        state: { ...state, prompt: { type: "mkdir", input: nextInput }, status: `Create directory: ${nextInput}` },
        effect: { type: "none" },
      };
    }
    case "confirm-delete": {
      if (input.type === "cancel" || (input.type === "text" && input.value.toLocaleLowerCase() === "n")) {
        return {
          state: { ...state, prompt: undefined, status: "Deletion cancelled" },
          effect: { type: "none" },
        };
      }
      if (input.type === "text" && input.value.toLocaleLowerCase() === "y") {
        return {
          state: { ...state, prompt: undefined, status: `Deleting: ${prompt.name}` },
          effect: { type: "delete-file", path: prompt.path, name: prompt.name },
        };
      }
      return { state, effect: { type: "none" } };
    }
    case "confirm-download": {
      if (input.type === "cancel" || (input.type === "text" && input.value.toLocaleLowerCase() === "n")) {
        return {
          state: { ...state, prompt: undefined, status: "Download cancelled" },
          effect: { type: "none" },
        };
      }
      if (input.type === "text" && input.value.toLocaleLowerCase() === "y") {
        return {
          state: { ...state, prompt: undefined, status: `Downloading: ${prompt.name}` },
          effect: { type: "download-file", path: prompt.path, name: prompt.name, size: prompt.size },
        };
      }
      return { state, effect: { type: "none" } };
    }
    case "confirm-upload": {
      if (input.type === "cancel" || (input.type === "text" && input.value.toLocaleLowerCase() === "n")) {
        return {
          state: { ...state, prompt: undefined, status: "Upload cancelled" },
          effect: { type: "none" },
        };
      }
      if (input.type === "text" && input.value.toLocaleLowerCase() === "y") {
        return {
          state: { ...state, prompt: undefined, status: `Uploading: ${prompt.name}` },
          effect: { type: "upload-file", path: prompt.path, name: prompt.name, size: prompt.size },
        };
      }
      return { state, effect: { type: "none" } };
    }
  }
}

export function applyBrowserCommand(state: BrowserState, command: BrowserCommand): BrowserTransition {
  switch (command) {
    case "back":
      return { state, effect: { type: "back" } };
    case "quit":
      return { state, effect: { type: "quit" } };
    case "down":
      return { state: moveSelection(state, 1), effect: { type: "none" } };
    case "up":
      return { state: moveSelection(state, -1), effect: { type: "none" } };
    case "first":
      return { state: { ...state, selected: 0 }, effect: { type: "none" } };
    case "last":
      return {
        state: { ...state, selected: clampSelection(state.entries.length - 1, state.entries.length) },
        effect: { type: "none" },
      };
    case "open": {
      const entry = selectedEntry(state);
      if (entry?.type === "directory") {
        return { state, effect: { type: "open-directory", path: entry.path } };
      }
      if (entry !== undefined) {
        if (browserMode(state) === "upload") {
          return {
            state: {
              ...state,
              prompt: { type: "confirm-upload", path: entry.path, name: entry.name, size: entry.size },
              status: `Upload ${entry.name} to remote directory? y/n`,
            },
            effect: { type: "none" },
          };
        }
        return {
          state: {
            ...state,
            prompt: { type: "confirm-download", path: entry.path, name: entry.name, size: entry.size },
            status: `Download ${entry.name} to local directory? y/n`,
          },
          effect: { type: "none" },
        };
      }
      return { state, effect: { type: "none" } };
    }
    case "parent":
      return { state, effect: { type: "parent" } };
    case "refresh":
      return { state, effect: { type: "refresh" } };
    case "search":
      return {
        state: {
          ...state,
          prompt: { type: "search", input: "", previousStatus: state.status },
          status: "Search: ",
        },
        effect: { type: "none" },
      };
    case "delete": {
      if (browserMode(state) === "upload") {
        return {
          state: { ...state, status: "Upload mode: select a file or press U to exit" },
          effect: { type: "none" },
        };
      }
      const entry = selectedEntry(state);
      if (entry === undefined) {
        return { state: { ...state, status: "No file selected" }, effect: { type: "none" } };
      }
      if (entry.type === "directory") {
        return { state: { ...state, status: "Cannot delete directories" }, effect: { type: "none" } };
      }
      return {
        state: {
          ...state,
          prompt: { type: "confirm-delete", path: entry.path, name: entry.name },
          status: `Delete ${entry.name}? y/n`,
        },
        effect: { type: "none" },
      };
    }
    case "mkdir":
      if (browserMode(state) === "upload") {
        return {
          state: { ...state, status: "Upload mode: select a file or press U to exit" },
          effect: { type: "none" },
        };
      }
      return {
        state: { ...state, prompt: { type: "mkdir", input: "" }, status: "Create directory: " },
        effect: { type: "none" },
      };
    case "toggle-upload":
      return {
        state,
        effect: browserMode(state) === "upload" ? { type: "exit-upload-mode" } : { type: "enter-upload-mode" },
      };
    case "help":
      return {
        state: { ...state, prompt: { type: "help", previousStatus: state.status }, status: "Key Commands" },
        effect: { type: "none" },
      };
    case "none":
      return { state, effect: { type: "none" } };
  }
}
