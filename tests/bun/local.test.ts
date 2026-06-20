import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalClient } from "../../src/clients/local.ts";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-local-"));
  await writeFile(join(tempDir, "source.txt"), "hello");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("LocalClient", () => {
  test("lists files with metadata", async () => {
    const client = new LocalClient();
    const files = await client.list(tempDir);
    const source = files.find((file) => file.name === "source.txt");
    expect(source).toMatchObject({
      path: "source.txt",
      type: "file",
      size: 5,
    });
    expect(source?.modifiedTime).toBeInstanceOf(Date);
  });

  test("uploads, downloads, deletes, and creates directories", async () => {
    const client = new LocalClient();
    const uploaded = join(tempDir, "uploaded.txt");
    const downloaded = join(tempDir, "downloaded.txt");

    const progress: number[] = [];
    await client.upload(join(tempDir, "source.txt"), uploaded, {
      onProgress: ({ bytes }) => progress.push(bytes),
    });
    await client.download(uploaded, downloaded);

    expect(await readFile(downloaded, "utf8")).toBe("hello");
    expect(progress.at(-1)).toBe(5);
    expect(await client.mkdir(join(tempDir, "nested"))).toBe(true);
    expect(await client.deleteFile(uploaded)).toBe(true);
    expect(await client.deleteFile(join(tempDir, "nested"))).toBe(false);
  });
});
