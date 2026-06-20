import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../../src/cli.ts";

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

  test("uses a bare local path as the browse connection", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await main(["--config", configPath, tempDir], { stdout, stderr });

    expect(code).toBe(0);
    expect(stdout.value).toContain("source.txt");
    expect(stderr.value).toContain("Interactive browser requires a TTY");
  });
});
