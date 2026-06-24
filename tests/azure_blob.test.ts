import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AzureBlobClient,
  type AzureBlobBackend,
  type AzureBlobListItem,
} from "../src/clients/azure_blob.ts";

class FakeAzureBlobBackend implements AzureBlobBackend {
  objects = new Map<string, string>();
  listCalls: Array<{ delimiter: string; prefix?: string }> = [];
  deleteCalls: string[] = [];
  uploadBlockBlobCalls: Array<{
    path: string;
    body: string;
    contentLength: number;
  }> = [];

  constructor(private readonly listing: AzureBlobListItem[] = []) {}

  async *listBlobsByHierarchy(
    delimiter: string,
    options: { prefix?: string } = {},
  ): AsyncIterable<AzureBlobListItem> {
    this.listCalls.push({ delimiter, prefix: options.prefix });
    for (const item of this.listing) {
      yield item;
    }
  }

  getBlobClient(path: string): ReturnType<AzureBlobBackend["getBlobClient"]> {
    return {
      downloadToFile: async (localPath, _offset, _count, options) => {
        const content = this.objects.get(path);
        if (content === undefined) {
          throw new Error(`missing blob ${path}`);
        }
        await writeFile(localPath, content);
        options?.onProgress?.({ loadedBytes: content.length });
      },
    };
  }

  getBlockBlobClient(
    path: string,
  ): ReturnType<AzureBlobBackend["getBlockBlobClient"]> {
    return {
      uploadFile: async (localPath, options) => {
        const content = await readFile(localPath, "utf8");
        this.objects.set(path, content);
        options?.onProgress?.({ loadedBytes: content.length });
      },
    };
  }

  async deleteBlob(path: string): Promise<void> {
    this.deleteCalls.push(path);
    if (!this.objects.delete(path)) {
      throw new Error(`missing blob ${path}`);
    }
  }

  async uploadBlockBlob(
    path: string,
    body: string,
    contentLength: number,
  ): Promise<void> {
    this.uploadBlockBlobCalls.push({ path, body, contentLength });
    this.objects.set(path, body);
  }
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-azure-blob-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("AzureBlobClient", () => {
  test("lists blobs as files and blob prefixes as virtual directories", async () => {
    const backend = new FakeAzureBlobBackend([
      { kind: "prefix", name: "base/photos/" },
      { kind: "blob", name: "base/", properties: { contentLength: 0 } },
      {
        kind: "blob",
        name: "base/report.txt",
        properties: {
          contentLength: 42,
          lastModified: new Date("2026-06-21T08:30:00.000Z"),
        },
      },
      {
        kind: "blob",
        name: "base/nested/ignored.txt",
        properties: { contentLength: 99 },
      },
    ]);
    const client = new AzureBlobClient({
      accountUrl: "account.blob.core.windows.net",
      containerName: "container",
      backend,
    });

    const files = await client.list("/base");

    expect(backend.listCalls).toEqual([{ delimiter: "/", prefix: "base/" }]);
    expect(files).toEqual([
      { path: "photos", name: "photos", type: "directory", size: 0 },
      {
        path: "report.txt",
        name: "report.txt",
        type: "file",
        size: 42,
        modifiedTime: new Date("2026-06-21T08:30:00.000Z"),
      },
    ]);
  });

  test("downloads, uploads, deletes, and creates directory placeholders", async () => {
    const backend = new FakeAzureBlobBackend();
    backend.objects.set("remote/source.txt", "from blob");
    backend.objects.set("remote/delete.txt", "delete me");
    const client = new AzureBlobClient({
      accountUrl: "https://account.blob.core.windows.net",
      containerName: "container",
      backend,
    });
    const localDownload = join(tempDir, "downloaded.txt");
    const localUpload = join(tempDir, "upload.txt");
    await writeFile(localUpload, "to blob");
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

    expect(await readFile(localDownload, "utf8")).toBe("from blob");
    expect(backend.objects.get("remote/upload.txt")).toBe("to blob");
    expect(deleted).toBe(true);
    expect(missingDelete).toBe(false);
    expect(madeDirectory).toBe(true);
    expect(backend.objects.get("remote/new-dir/")).toBe("");
    expect(progress).toEqual([9, 7]);
    expect(backend.deleteCalls).toEqual([
      "remote/delete.txt",
      "remote/missing.txt",
    ]);
    expect(backend.uploadBlockBlobCalls).toEqual([
      { path: "remote/new-dir/", body: "", contentLength: 0 },
    ]);
  });
});
