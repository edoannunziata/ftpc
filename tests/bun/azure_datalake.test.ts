import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AzureDataLakeClient, type AzureDataLakeBackend, type AzureDataLakePathItem } from "../../src/clients/azure_datalake.ts";

class FakeAzureDataLakeBackend implements AzureDataLakeBackend {
  files = new Map<string, string>();
  listCalls: Array<{ path?: string; recursive?: boolean }> = [];
  readCalls: Array<{ path: string; localPath: string }> = [];
  uploadCalls: Array<{ path: string; localPath: string }> = [];
  deleteCalls: string[] = [];
  mkdirCalls: string[] = [];

  constructor(private readonly listing: AzureDataLakePathItem[] = []) {}

  async *listPaths(options: { path?: string; recursive?: boolean } = {}): AsyncIterable<AzureDataLakePathItem> {
    this.listCalls.push(options);
    for (const item of this.listing) {
      yield item;
    }
  }

  getFileClient(path: string): ReturnType<AzureDataLakeBackend["getFileClient"]> {
    return {
      readToFile: async (localPath, _offset, _count, options) => {
        this.readCalls.push({ path, localPath });
        const content = this.files.get(path);
        if (content === undefined) {
          throw new Error(`missing file ${path}`);
        }
        await writeFile(localPath, content);
        options?.onProgress?.({ loadedBytes: content.length });
      },
      uploadFile: async (localPath, options) => {
        this.uploadCalls.push({ path, localPath });
        const content = await readFile(localPath, "utf8");
        this.files.set(path, content);
        options?.onProgress?.({ loadedBytes: content.length });
      },
      delete: async () => {
        this.deleteCalls.push(path);
        if (!this.files.delete(path)) {
          throw new Error(`missing file ${path}`);
        }
      },
    };
  }

  getDirectoryClient(path: string): ReturnType<AzureDataLakeBackend["getDirectoryClient"]> {
    return {
      create: async () => {
        this.mkdirCalls.push(path);
      },
    };
  }
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-azure-datalake-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("AzureDataLakeClient", () => {
  test("lists paths as file descriptors", async () => {
    const backend = new FakeAzureDataLakeBackend([
      { name: "base/docs", isDirectory: true },
      { name: "base/report.txt", contentLength: 42, lastModified: new Date("2026-06-21T09:00:00.000Z") },
      { name: "base/nested/ignored.txt", contentLength: 99 },
    ]);
    const client = new AzureDataLakeClient({
      accountUrl: "account.dfs.core.windows.net",
      filesystemName: "filesystem",
      backend,
    });

    const files = await client.list("/base");

    expect(backend.listCalls).toEqual([{ path: "base", recursive: false }]);
    expect(files).toEqual([
      { path: "docs", name: "docs", type: "directory", size: 0, modifiedTime: undefined },
      { path: "report.txt", name: "report.txt", type: "file", size: 42, modifiedTime: new Date("2026-06-21T09:00:00.000Z") },
    ]);
  });

  test("downloads, uploads, deletes, creates directories, and reports progress", async () => {
    const backend = new FakeAzureDataLakeBackend();
    backend.files.set("remote/source.txt", "from lake");
    backend.files.set("remote/delete.txt", "delete me");
    const client = new AzureDataLakeClient({
      accountUrl: "https://account.dfs.core.windows.net",
      filesystemName: "filesystem",
      backend,
    });
    const localDownload = join(tempDir, "downloaded.txt");
    const localUpload = join(tempDir, "upload.txt");
    await writeFile(localUpload, "to lake");
    const progress: number[] = [];

    await client.download("/remote/source.txt", localDownload, {
      onProgress: ({ bytes }) => progress.push(bytes),
    });
    await client.upload(localUpload, "/remote/upload.txt", {
      onProgress: ({ bytes }) => progress.push(bytes),
    });
    const deleted = await client.deleteFile("/remote/delete.txt");
    const missingDelete = await client.deleteFile("/remote/missing.txt");
    const madeDirectory = await client.mkdir("/remote/new-dir");

    expect(await readFile(localDownload, "utf8")).toBe("from lake");
    expect(backend.files.get("remote/upload.txt")).toBe("to lake");
    expect(deleted).toBe(true);
    expect(missingDelete).toBe(false);
    expect(madeDirectory).toBe(true);
    expect(progress).toEqual([9, 7]);
    expect(backend.readCalls).toEqual([{ path: "remote/source.txt", localPath: localDownload }]);
    expect(backend.uploadCalls).toEqual([{ path: "remote/upload.txt", localPath: localUpload }]);
    expect(backend.deleteCalls).toEqual(["remote/delete.txt", "remote/missing.txt"]);
    expect(backend.mkdirCalls).toEqual(["remote/new-dir"]);
  });
});
