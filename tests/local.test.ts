import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalClient } from "../src/clients/local.ts";

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

  test("preserves binary content and modified time when copying files", async () => {
    const client = new LocalClient();
    const source = join(tempDir, "binary.bin");
    const downloaded = join(tempDir, "binary-copy.bin");
    const payload = Buffer.from(
      Array.from({ length: 256 }, (_, index) => index),
    );
    const modified = new Date("2025-01-02T03:04:05.000Z");

    await writeFile(source, payload);
    await utimes(source, modified, modified);

    await client.download(source, downloaded);

    expect(Buffer.compare(await readFile(downloaded), payload)).toBe(0);
    expect(
      Math.abs((await stat(downloaded)).mtime.getTime() - modified.getTime()),
    ).toBeLessThan(1500);
  });

  test("can abort local transfers after partial progress", async () => {
    const client = new LocalClient();
    const source = join(tempDir, "large.bin");
    const downloaded = join(tempDir, "large-copy.bin");
    const payload = Buffer.alloc(1024 * 1024, 7);
    const controller = new AbortController();
    const progress: number[] = [];

    await writeFile(source, payload);

    await expect(
      client.download(source, downloaded, {
        signal: controller.signal,
        onProgress: ({ bytes }) => {
          progress.push(bytes);
          controller.abort(new Error("stop local copy"));
        },
      }),
    ).rejects.toThrow("stop local copy");

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]!).toBeLessThan(payload.byteLength);
    try {
      expect((await stat(downloaded)).size).toBeLessThan(payload.byteLength);
    } catch {
      // Depending on when the abort reaches the write stream, no destination file may remain.
    }
  });
});
