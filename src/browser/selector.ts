import type { Config, RemoteConfig } from "../config.ts";
import { keyToBrowserPromptInput, type BrowserKeyPress, type BrowserPromptInput } from "./state.ts";

export interface RemoteSelectorEntry {
  name: string;
  type: string;
  details: string[];
}

export interface RemoteSelectorState {
  title: string;
  entries: RemoteSelectorEntry[];
  selected: number;
  status: string;
  defaultPath: string;
  prompt?: RemoteSelectorPrompt;
}

export type RemoteSelectorPrompt =
  | { type: "details"; title: string; lines: string[]; previousStatus: string }
  | { type: "help"; previousStatus: string }
  | { type: "path"; input: string; currentPath: string }
  | { type: "search"; input: string; previousStatus: string };

export type RemoteSelectorCommand =
  | "details"
  | "down"
  | "first"
  | "help"
  | "last"
  | "none"
  | "open-path"
  | "quit"
  | "search"
  | "select"
  | "up";

export type RemoteSelectorEffect =
  | { type: "none" }
  | { type: "quit" }
  | { type: "select"; remote: string; path: string };

export interface RemoteSelectorTransition {
  state: RemoteSelectorState;
  effect: RemoteSelectorEffect;
}

export function remoteEntriesFromConfig(config: Config): RemoteSelectorEntry[] {
  return [...config.remotes.values()]
    .map((remote) => ({
      name: remote.name,
      type: remote.type,
      details: remoteDetails(remote),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function remoteDetails(remote: RemoteConfig): string[] {
  const details = [
    `Name: ${remote.name}`,
    `Type: ${remote.type}`,
  ];

  switch (remote.type) {
    case "local":
      break;
    case "ftp":
      details.push(`URL: ${redactUrlCredentials(remote.url)}`, `Username: ${remote.username}`, `Port: ${remote.port}`, `TLS: ${remote.tls ? "yes" : "no"}`);
      break;
    case "sftp":
      details.push(`URL: ${redactUrlCredentials(remote.url)}`, `Port: ${remote.port}`);
      if (remote.username !== undefined) {
        details.push(`Username: ${remote.username}`);
      }
      if (remote.keyFilename !== undefined) {
        details.push(`Key: ${remote.keyFilename}`);
      }
      break;
    case "s3":
      if (remote.url !== undefined) {
        details.push(`URL: ${remote.url}`);
      }
      if (remote.bucketName !== undefined) {
        details.push(`Bucket: ${remote.bucketName}`);
      }
      if (remote.endpointUrl !== undefined) {
        details.push(`Endpoint: ${remote.endpointUrl}`);
      }
      if (remote.regionName !== undefined) {
        details.push(`Region: ${remote.regionName}`);
      }
      break;
    case "azure":
      details.push(`URL: ${remote.url}`, `Filesystem: ${remote.filesystem}`);
      break;
    case "blob":
      details.push(`URL: ${remote.url}`, `Container: ${remote.container}`);
      break;
  }

  if (remote.proxy !== undefined) {
    details.push(`Proxy: ${remote.proxy.host}:${remote.proxy.port}`);
  }

  return details;
}

function redactUrlCredentials(input: string): string {
  const schemeIndex = input.indexOf("://");
  const authorityStart = schemeIndex === -1 ? 0 : schemeIndex + 3;
  const remainder = input.slice(authorityStart);
  const authorityEndOffset = remainder.search(/[/?#]/);
  const authorityEnd = authorityEndOffset === -1 ? input.length : authorityStart + authorityEndOffset;
  const authority = input.slice(authorityStart, authorityEnd);
  const credentialEnd = authority.lastIndexOf("@");

  if (credentialEnd === -1) {
    return input;
  }

  return `${input.slice(0, authorityStart)}***@${authority.slice(credentialEnd + 1)}${input.slice(authorityEnd)}`;
}

export function initialRemoteSelectorState(entries: RemoteSelectorEntry[], defaultPath = "/"): RemoteSelectorState {
  return {
    title: "Select Remote",
    entries,
    selected: 0,
    status: "Enter select, o path, i details, / search, q quit",
    defaultPath,
  };
}

export function clampRemoteSelection(selected: number, entryCount: number): number {
  if (entryCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(selected, entryCount - 1));
}

export function selectedRemoteEntry(state: RemoteSelectorState): RemoteSelectorEntry | undefined {
  return state.entries[clampRemoteSelection(state.selected, state.entries.length)];
}

export function moveRemoteSelection(state: RemoteSelectorState, delta: number): RemoteSelectorState {
  return {
    ...state,
    selected: clampRemoteSelection(state.selected + delta, state.entries.length),
  };
}

export function selectRemoteByPrefix(state: RemoteSelectorState, prefix: string): RemoteSelectorState {
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

export function keyToRemoteSelectorCommand(chunk: string, key: BrowserKeyPress = {}): RemoteSelectorCommand {
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
      return "select";
    case "i":
      return "details";
    case "o":
      return "open-path";
    case "/":
      return "search";
    case "?":
      return "help";
    default:
      return "none";
  }
}

function pathOrDefault(path: string, defaultPath: string): string {
  const trimmed = path.trim();
  return trimmed === "" ? defaultPath : trimmed;
}

function appendPromptInput(input: string, value: string): string {
  if (value.length !== 1 || value < " ") {
    return input;
  }
  return `${input}${value}`;
}

function withSearchPrompt(state: RemoteSelectorState, input: string, previousStatus: string): RemoteSelectorState {
  return selectRemoteByPrefix({
    ...state,
    prompt: { type: "search", input, previousStatus },
    status: `Search: ${input}`,
  }, input);
}

function selectCurrentRemote(state: RemoteSelectorState, path: string): RemoteSelectorTransition {
  const entry = selectedRemoteEntry(state);
  if (entry === undefined) {
    return {
      state: { ...state, status: "No remote selected" },
      effect: { type: "none" },
    };
  }
  return {
    state,
    effect: { type: "select", remote: entry.name, path },
  };
}

export function applyRemoteSelectorPromptInput(
  state: RemoteSelectorState,
  input: BrowserPromptInput,
): RemoteSelectorTransition {
  const prompt = state.prompt;
  if (prompt === undefined) {
    return { state, effect: { type: "none" } };
  }

  switch (prompt.type) {
    case "help":
    case "details":
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
    case "path": {
      if (input.type === "cancel") {
        return {
          state: { ...state, prompt: undefined, status: "Open with path cancelled" },
          effect: { type: "none" },
        };
      }
      if (input.type === "submit") {
        return selectCurrentRemote({ ...state, prompt: undefined }, pathOrDefault(prompt.input, prompt.currentPath));
      }
      const nextInput = input.type === "backspace"
        ? prompt.input.slice(0, -1)
        : input.type === "text"
          ? appendPromptInput(prompt.input, input.value)
          : prompt.input;
      return {
        state: { ...state, prompt: { ...prompt, input: nextInput }, status: `Open path: ${nextInput}` },
        effect: { type: "none" },
      };
    }
  }
}

export function promptInputFromKey(chunk: string, key: BrowserKeyPress = {}): BrowserPromptInput | undefined {
  return keyToBrowserPromptInput(chunk, key);
}

export function applyRemoteSelectorCommand(
  state: RemoteSelectorState,
  command: RemoteSelectorCommand,
): RemoteSelectorTransition {
  switch (command) {
    case "quit":
      return { state, effect: { type: "quit" } };
    case "down":
      return { state: moveRemoteSelection(state, 1), effect: { type: "none" } };
    case "up":
      return { state: moveRemoteSelection(state, -1), effect: { type: "none" } };
    case "first":
      return { state: { ...state, selected: 0 }, effect: { type: "none" } };
    case "last":
      return {
        state: { ...state, selected: clampRemoteSelection(state.entries.length - 1, state.entries.length) },
        effect: { type: "none" },
      };
    case "select":
      return selectCurrentRemote(state, state.defaultPath);
    case "details": {
      const entry = selectedRemoteEntry(state);
      if (entry === undefined) {
        return {
          state: { ...state, status: "No remote selected" },
          effect: { type: "none" },
        };
      }
      return {
        state: {
          ...state,
          prompt: {
            type: "details",
            title: `Remote: ${entry.name}`,
            lines: entry.details,
            previousStatus: state.status,
          },
          status: `Remote: ${entry.name}`,
        },
        effect: { type: "none" },
      };
    }
    case "open-path":
      return {
        state: {
          ...state,
          prompt: { type: "path", input: "", currentPath: state.defaultPath },
          status: "Open path: ",
        },
        effect: { type: "none" },
      };
    case "search":
      return {
        state: { ...state, prompt: { type: "search", input: "", previousStatus: state.status }, status: "Search: " },
        effect: { type: "none" },
      };
    case "help":
      return {
        state: { ...state, prompt: { type: "help", previousStatus: state.status }, status: "Remote Selector Help" },
        effect: { type: "none" },
      };
    case "none":
      return { state, effect: { type: "none" } };
  }
}
