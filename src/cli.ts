import { basename } from "node:path";
import { ConfigError, StorageError } from "./errors.ts";
import { DEFAULT_CONFIG_PATH, loadConfig, listRemotes } from "./config.ts";
import { Storage } from "./storage.ts";
import type { FileDescriptor } from "./types.ts";
import { runBrowser } from "./browser/terminal.ts";

const VERSION = "0.1.0";
const COMMANDS = new Set(["browse", "remotes", "ls", "get", "put", "rm", "mkdir"]);

interface CliIo {
  stdin?: { isTTY?: boolean };
  stdout: { write(data: string): unknown; isTTY?: boolean };
  stderr: { write(data: string): unknown };
}

interface ParsedGlobalArgs {
  configPath: string;
  args: string[];
}

function writeLine(stream: CliIo["stdout"], line = ""): void {
  stream.write(`${line}\n`);
}

function usage(): string {
  return `Usage:
  ftpc [--config PATH] browse [remote] [path]
  ftpc [--config PATH] remotes
  ftpc [--config PATH] ls <connection> [path]
  ftpc [--config PATH] get <connection> <remote-path> <local-path>
  ftpc [--config PATH] put <connection> <local-path> <remote-path>
  ftpc [--config PATH] rm <connection> <remote-path>
  ftpc [--config PATH] mkdir <connection> <remote-path>

Connections may be configured remote names or storage URLs.`;
}

function parseGlobalArgs(argv: string[]): ParsedGlobalArgs {
  const args: string[] = [];
  let configPath = DEFAULT_CONFIG_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new ConfigError("--config requires a path");
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    args.push(arg);
  }

  return { configPath, args };
}

function formatDescriptor(descriptor: FileDescriptor): string {
  const marker = descriptor.type === "directory" ? "D" : "F";
  const size = descriptor.type === "file" && descriptor.size !== undefined
    ? String(descriptor.size).padStart(10, " ")
    : " ".repeat(10);
  const modified = descriptor.modifiedTime?.toISOString().slice(0, 16).replace("T", " ") ?? " ".repeat(16);
  return `${marker} ${size} ${modified} ${descriptor.name}`;
}

async function withStorage<T>(
  connection: string,
  configPath: string,
  action: (store: ReturnType<typeof Storage.connect>) => Promise<T>,
): Promise<T> {
  const config = await loadConfig(configPath);
  const store = Storage.connect(connection, { config });
  try {
    return await action(store);
  } finally {
    await store.close();
  }
}

async function commandRemotes(configPath: string, io: CliIo): Promise<number> {
  const config = await loadConfig(configPath);
  for (const warning of config.warnings) {
    writeLine(io.stderr, `Warning: ${warning}`);
  }
  for (const [name, type] of Object.entries(listRemotes(config))) {
    writeLine(io.stdout, `${name}\t${type}`);
  }
  return 0;
}

async function commandLs(configPath: string, args: string[], io: CliIo): Promise<number> {
  const [connection, path] = args;
  if (connection === undefined) {
    throw new ConfigError("ls requires <connection>");
  }
  await withStorage(connection, configPath, async (store) => {
    const files = await store.list(path);
    files.sort((left, right) => left.name.localeCompare(right.name));
    for (const file of files) {
      writeLine(io.stdout, formatDescriptor(file));
    }
  });
  return 0;
}

async function commandGet(configPath: string, args: string[], _io: CliIo): Promise<number> {
  const [connection, remotePath, localPath] = args;
  if (connection === undefined || remotePath === undefined || localPath === undefined) {
    throw new ConfigError("get requires <connection> <remote-path> <local-path>");
  }
  await withStorage(connection, configPath, async (store) => {
    await store.download(remotePath, localPath);
  });
  return 0;
}

async function commandPut(configPath: string, args: string[], _io: CliIo): Promise<number> {
  const [connection, localPath, remotePath] = args;
  if (connection === undefined || localPath === undefined || remotePath === undefined) {
    throw new ConfigError("put requires <connection> <local-path> <remote-path>");
  }
  await withStorage(connection, configPath, async (store) => {
    await store.upload(localPath, remotePath);
  });
  return 0;
}

async function commandRm(configPath: string, args: string[], io: CliIo): Promise<number> {
  const [connection, remotePath] = args;
  if (connection === undefined || remotePath === undefined) {
    throw new ConfigError("rm requires <connection> <remote-path>");
  }
  const deleted = await withStorage(connection, configPath, async (store) => store.delete(remotePath));
  if (!deleted) {
    writeLine(io.stderr, `Could not delete ${remotePath}`);
    return 1;
  }
  return 0;
}

async function commandMkdir(configPath: string, args: string[], io: CliIo): Promise<number> {
  const [connection, remotePath] = args;
  if (connection === undefined || remotePath === undefined) {
    throw new ConfigError("mkdir requires <connection> <remote-path>");
  }
  const created = await withStorage(connection, configPath, async (store) => store.mkdir(remotePath));
  if (!created) {
    writeLine(io.stderr, `Could not create ${remotePath}`);
    return 1;
  }
  return 0;
}

async function commandBrowse(configPath: string, args: string[], io: CliIo): Promise<number> {
  const [connection = "local", path] = args;
  const isInteractive = io.stdin === process.stdin && io.stdout === process.stdout
    && process.stdin.isTTY === true && process.stdout.isTTY === true;

  if (!isInteractive) {
    writeLine(io.stderr, "Interactive browser requires a TTY; showing a one-shot listing.");
    return commandLs(configPath, path === undefined ? [connection] : [connection, path], io);
  }

  await withStorage(connection, configPath, async (store) => {
    await runBrowser(store, {
      input: process.stdin,
      output: process.stdout,
      initialPath: path === undefined ? undefined : store.resolve(path),
    });
  });
  return 0;
}

export async function main(argv = Bun.argv.slice(2), io: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      writeLine(io.stdout, usage());
      return 0;
    }
    if (argv.includes("--version") || argv.includes("-v")) {
      writeLine(io.stdout, VERSION);
      return 0;
    }

    const { configPath, args } = parseGlobalArgs(argv);
    const requested = args[0];
    const command = requested !== undefined && COMMANDS.has(requested) ? requested : "browse";
    const commandArgs = command === requested ? args.slice(1) : args;

    switch (command) {
      case "remotes":
        return commandRemotes(configPath, io);
      case "ls":
        return commandLs(configPath, commandArgs, io);
      case "get":
        return commandGet(configPath, commandArgs, io);
      case "put":
        return commandPut(configPath, commandArgs, io);
      case "rm":
        return commandRm(configPath, commandArgs, io);
      case "mkdir":
        return commandMkdir(configPath, commandArgs, io);
      case "browse":
        return commandBrowse(configPath, commandArgs, io);
      default:
        throw new ConfigError(`Unknown command: ${basename(command)}`);
    }
  } catch (error) {
    const message = error instanceof StorageError ? error.message : (error as Error).message;
    writeLine(io.stderr, message);
    return 1;
  }
}
