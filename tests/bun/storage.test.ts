import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfigText } from "../../src/config.ts";
import { UnsupportedFeatureError } from "../../src/errors.ts";
import { Storage } from "../../src/storage.ts";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-storage-"));
  await writeFile(join(tempDir, "a.txt"), "alpha");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Storage", () => {
  test("connects to local file URLs and resolves relative paths", async () => {
    const store = Storage.connect(`file://${tempDir}`);
    const files = await store.list();
    expect(files.map((file) => file.name)).toContain("a.txt");

    await store.upload(join(tempDir, "a.txt"), "b.txt");
    expect(await readFile(join(tempDir, "b.txt"), "utf8")).toBe("alpha");
  });

  test("connects to configured local remote", async () => {
    const config = parseConfigText("[local]\ntype = \"local\"\n");
    const store = Storage.connect("local", { config });
    const rootFiles = await store.list(tempDir);
    expect(rootFiles.map((file) => file.name)).toContain("a.txt");
  });

  test("remote backend names are parsed but not implemented yet", () => {
    const config = parseConfigText("[s3]\ntype = \"s3\"\nbucket_name = \"bucket\"\n");
    expect(() => Storage.connect("s3", { config })).toThrow(UnsupportedFeatureError);
  });
});
