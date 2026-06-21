import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, runInteractiveBrowseLoop } from "../../src/cli.ts";
import { DEFAULT_CONFIG_TEXT, parseConfigText } from "../../src/config.ts";
import { Storage } from "../../src/storage.ts";

class Capture {
  value = "";

  write(data: string): void {
    this.value += data;
  }
}

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-cli-"));
  configPath = join(tempDir, "config.toml");
  await writeFile(configPath, "[local]\ntype = \"local\"\n");
  await writeFile(join(tempDir, "source.txt"), "hello cli");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("cli", () => {
  test("lists configured remotes", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await main(["--config", configPath, "remotes"], { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.value).toContain("local\tlocal");
    expect(stderr.value).toBe("");
  });

  test("creates and reports the first-run default config path", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const defaultConfigPath = join(tempDir, "first-run", "config.toml");

    const code = await main(["remotes"], { stdout, stderr }, { defaultConfigPath });

    expect(code).toBe(0);
    expect(stdout.value).toContain("local\tlocal");
    expect(stderr.value).toContain(`Created default configuration at ${defaultConfigPath}`);
    expect(await readFile(defaultConfigPath, "utf8")).toBe(DEFAULT_CONFIG_TEXT);
  });

  test("missing custom config path is not auto-created", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const missingConfigPath = join(tempDir, "missing", "config.toml");

    const code = await main(["--config", missingConfigPath, "remotes"], { stdout, stderr });

    expect(code).toBe(1);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("no such file or directory");
    await expect(stat(missingConfigPath)).rejects.toThrow();
  });

  test("runs local transfer commands", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const uploaded = join(tempDir, "uploaded.txt");
    const downloaded = join(tempDir, "downloaded.txt");

    expect(await main(["--config", configPath, "put", `file://${tempDir}`, join(tempDir, "source.txt"), "uploaded.txt"], { stdout, stderr })).toBe(0);
    expect(await main(["--config", configPath, "get", `file://${tempDir}`, "uploaded.txt", downloaded], { stdout, stderr })).toBe(0);
    expect(await readFile(downloaded, "utf8")).toBe("hello cli");
    expect(await readFile(uploaded, "utf8")).toBe("hello cli");
  });

  test("lists local files with descriptor output", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await main(["--config", configPath, "ls", `file://${tempDir}`], { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.value).toContain("F");
    expect(stdout.value).toContain("source.txt");
    expect(stderr.value).toBe("");
  });

  test("prints configuration warnings for storage commands", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    await writeFile(configPath, `
[local]
type = "local"

[broken]
url = "missing-type"
`);

    const code = await main(["--config", configPath, "ls", `file://${tempDir}`], { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.value).toContain("source.txt");
    expect(stderr.value).toContain("Warning: Remote 'broken' missing required 'type' field - skipping");
  });

  test("creates and removes local files from CLI commands", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const deleteMe = join(tempDir, "delete-me.txt");
    await writeFile(deleteMe, "remove");

    expect(await main(["--config", configPath, "mkdir", `file://${tempDir}`, "created"], { stdout, stderr })).toBe(0);
    expect((await stat(join(tempDir, "created"))).isDirectory()).toBe(true);

    expect(await main(["--config", configPath, "rm", `file://${tempDir}`, "delete-me.txt"], { stdout, stderr })).toBe(0);
    await expect(stat(deleteMe)).rejects.toThrow();
    expect(stderr.value).toBe("");
  });

  test("returns a non-zero code when rm or mkdir cannot complete", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    await mkdir(join(tempDir, "already-there"));

    expect(await main(["--config", configPath, "rm", `file://${tempDir}`, "missing.txt"], { stdout, stderr })).toBe(1);
    expect(stderr.value).toContain("Could not delete missing.txt");

    stderr.value = "";
    expect(await main(["--config", configPath, "mkdir", `file://${tempDir}`, "already-there"], { stdout, stderr })).toBe(1);
    expect(stderr.value).toContain("Could not create already-there");
  });

  test("uses a bare local path as the browse connection", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await main(["--config", configPath, tempDir], { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.value).toContain("source.txt");
    expect(stderr.value).toContain("Interactive browser requires a TTY");
  });

  test("interactive browse returns to the selector after a browser session", async () => {
    const config = parseConfigText("[local]\ntype = \"local\"\n");
    const selectorDefaults: string[] = [];
    const connections: string[] = [];
    const browsedPaths: Array<string | undefined> = [];
    const store = Storage.local(tempDir);

    await runInteractiveBrowseLoop(config, undefined, "initial", {
      async select(_config, defaultPath) {
        selectorDefaults.push(defaultPath);
        if (selectorDefaults.length === 1) {
          return { remote: "local", path: "selected" };
        }
        return undefined;
      },
      async browse(_store, initialPath) {
        browsedPaths.push(initialPath);
      },
      connect(connection) {
        connections.push(connection);
        return store;
      },
    });

    expect(selectorDefaults).toEqual(["initial", "/"]);
    expect(connections).toEqual(["local"]);
    expect(browsedPaths).toEqual([store.resolve("selected")]);
  });

  test("interactive browse with an initial connection preserves the store base path", async () => {
    const config = parseConfigText("[local]\ntype = \"local\"\n");
    const browsedPaths: Array<string | undefined> = [];
    const effectivePaths: string[] = [];
    const store = Storage.local("nested/base");

    await runInteractiveBrowseLoop(config, "local", undefined, {
      async select() {
        return undefined;
      },
      async browse(openedStore, initialPath) {
        browsedPaths.push(initialPath);
        effectivePaths.push(initialPath ?? openedStore.basePath);
      },
      connect() {
        return store;
      },
    });

    expect(browsedPaths).toEqual([undefined]);
    expect(effectivePaths).toEqual(["nested/base"]);
  });

  test("interactive browse with configured local relative path starts from the process cwd", async () => {
    const config = parseConfigText("[local]\ntype = \"local\"\n");
    const browsedPaths: Array<string | undefined> = [];
    const selectedDir = join(tempDir, "selected");
    const originalCwd = process.cwd();
    await mkdir(selectedDir);

    try {
      process.chdir(tempDir);
      await runInteractiveBrowseLoop(config, "local", "selected", {
        async select() {
          return undefined;
        },
        async browse(_store, initialPath) {
          browsedPaths.push(initialPath);
        },
        connect() {
          return Storage.local("/");
        },
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(browsedPaths).toEqual([selectedDir]);
  });

  test("reports bad config, missing remotes, unsupported protocols, and usage errors", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const badConfigPath = join(tempDir, "bad-config.toml");
    await writeFile(badConfigPath, "[local]\ntype = \n");

    expect(await main(["--config", badConfigPath, "remotes"], { stdout, stderr })).toBe(1);
    expect(stderr.value).toContain("Failed to parse TOML configuration");

    stderr.value = "";
    expect(await main(["--config", configPath, "ls", "missing"], { stdout, stderr })).toBe(1);
    expect(stderr.value).toContain("Remote 'missing' not found");

    stderr.value = "";
    expect(await main(["--config", configPath, "ls", "gopher://example.com"], { stdout, stderr })).toBe(1);
    expect(stderr.value).toContain("Unsupported protocol: gopher");

    stderr.value = "";
    expect(await main(["--config"], { stdout, stderr })).toBe(1);
    expect(stderr.value).toContain("--config requires a path");

    stderr.value = "";
    expect(await main(["--config", configPath, "get", `file://${tempDir}`, "only-remote"], { stdout, stderr })).toBe(1);
    expect(stderr.value).toContain("get requires <connection> <remote-path> <local-path>");
  });
});
