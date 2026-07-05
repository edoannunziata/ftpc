import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  S3Client,
  type S3Backend,
  type S3ListResponse,
} from "../src/clients/s3.ts";

class FakeAwsS3Client {
  readonly commands: unknown[] = [];
  destroyed = false;

  constructor(private readonly responses: unknown[] = []) {}

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response ?? {};
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeS3Backend implements S3Backend {
  objects = new Map<string, Uint8Array>();
  listCalls: Array<{
    prefix?: string;
    delimiter?: string;
    continuationToken?: string;
  }> = [];
  deleteCalls: string[] = [];

  constructor(private readonly listResponses: S3ListResponse[] = []) {}

  async list(
    input?: {
      prefix?: string;
      delimiter?: string;
      continuationToken?: string;
    } | null,
  ): Promise<S3ListResponse> {
    this.listCalls.push(input ?? {});
    return this.listResponses[this.listCalls.length - 1] ?? { contents: [] };
  }

  file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } {
    return {
      arrayBuffer: async () => {
        const bytes = this.objects.get(path);
        if (bytes === undefined) {
          throw new Error(`missing object ${path}`);
        }
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return copy.buffer;
      },
    };
  }

  async write(
    path: string,
    data: Parameters<S3Backend["write"]>[1],
  ): Promise<number> {
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
    } else {
      throw new Error("unsupported fake S3 write data");
    }
    this.objects.set(path, bytes);
    return bytes.byteLength;
  }

  async delete(path: string): Promise<void> {
    this.deleteCalls.push(path);
    if (!this.objects.delete(path)) {
      throw new Error(`missing object ${path}`);
    }
  }
}

function commandInput(command: unknown): unknown {
  return (command as { input: unknown }).input;
}

function notFoundError(): Error {
  return Object.assign(new Error("not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-s3-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("S3Client", () => {
  test("uses AWS SDK list commands and maps output", async () => {
    const aws = new FakeAwsS3Client([
      {
        CommonPrefixes: [{ Prefix: "base/photos/" }],
        Contents: [
          { Key: "base/", Size: 0 },
          {
            Key: "base/report.txt",
            Size: 42,
            LastModified: new Date("2026-06-20T10:30:00.000Z"),
          },
          { Key: "base/nested/ignored.txt", Size: 99 },
        ],
      },
    ]);
    const client = new S3Client({
      bucketName: "bucket",
      sdkClient: aws as unknown as AwsS3Client,
    });

    const files = await client.list("/base");

    expect(aws.commands[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(commandInput(aws.commands[0])).toEqual({
      Bucket: "bucket",
      Prefix: "base/",
      Delimiter: "/",
      ContinuationToken: undefined,
    });
    expect(files).toEqual([
      { path: "photos", name: "photos", type: "directory", size: 0 },
      {
        path: "report.txt",
        name: "report.txt",
        type: "file",
        size: 42,
        modifiedTime: new Date("2026-06-20T10:30:00.000Z"),
      },
    ]);
  });

  test("continues truncated AWS SDK listings", async () => {
    const aws = new FakeAwsS3Client([
      {
        Contents: [{ Key: "first.txt", Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: "next",
      },
      {
        Contents: [{ Key: "second.txt", Size: 2 }],
      },
    ]);
    const client = new S3Client({
      bucketName: "bucket",
      sdkClient: aws as unknown as AwsS3Client,
    });

    const files = await client.list("/");

    expect(files.map((file) => file.name)).toEqual(["first.txt", "second.txt"]);
    expect(aws.commands.map(commandInput)).toEqual([
      {
        Bucket: "bucket",
        Prefix: "",
        Delimiter: "/",
        ContinuationToken: undefined,
      },
      {
        Bucket: "bucket",
        Prefix: "",
        Delimiter: "/",
        ContinuationToken: "next",
      },
    ]);
  });

  test("uses AWS SDK object commands for transfer helpers", async () => {
    const aws = new FakeAwsS3Client([
      {
        Body: {
          transformToByteArray: async () => new TextEncoder().encode("from s3"),
        },
      },
      {},
      {},
      {},
      notFoundError(),
    ]);
    const client = new S3Client({
      bucketName: "bucket",
      sdkClient: aws as unknown as AwsS3Client,
    });
    const localDownload = join(tempDir, "downloaded.txt");

    await client.download("/remote/source.txt", localDownload);
    const madeDirectory = await client.mkdir("/remote/new-dir");
    const deleted = await client.deleteFile("/remote/delete.txt");
    const missingDelete = await client.deleteFile("/remote/missing.txt");
    await client.close();

    expect(await readFile(localDownload, "utf8")).toBe("from s3");
    expect(madeDirectory).toBe(true);
    expect(deleted).toBe(true);
    expect(missingDelete).toBe(false);
    expect(aws.destroyed).toBe(true);
    expect(aws.commands.map((command) => command?.constructor.name)).toEqual([
      "GetObjectCommand",
      "PutObjectCommand",
      "HeadObjectCommand",
      "DeleteObjectCommand",
      "HeadObjectCommand",
    ]);
    expect(commandInput(aws.commands[0])).toEqual({
      Bucket: "bucket",
      Key: "remote/source.txt",
    });
    expect(commandInput(aws.commands[1])).toEqual({
      Bucket: "bucket",
      Key: "remote/new-dir/",
      Body: "",
    });
    expect(commandInput(aws.commands[2])).toEqual({
      Bucket: "bucket",
      Key: "remote/delete.txt",
    });
    expect(commandInput(aws.commands[3])).toEqual({
      Bucket: "bucket",
      Key: "remote/delete.txt",
    });
    expect(commandInput(aws.commands[4])).toEqual({
      Bucket: "bucket",
      Key: "remote/missing.txt",
    });
    expect(aws.commands[0]).toBeInstanceOf(GetObjectCommand);
    expect(aws.commands[1]).toBeInstanceOf(PutObjectCommand);
    expect(aws.commands[2]).toBeInstanceOf(HeadObjectCommand);
    expect(aws.commands[3]).toBeInstanceOf(DeleteObjectCommand);
    expect(aws.commands[4]).toBeInstanceOf(HeadObjectCommand);
  });

  test("lists objects as files and common prefixes as virtual directories", async () => {
    const backend = new FakeS3Backend([
      {
        commonPrefixes: [{ prefix: "base/photos/" }],
        contents: [
          { key: "base/", size: 0 },
          {
            key: "base/report.txt",
            size: 42,
            lastModified: "2026-06-20T10:30:00.000Z",
          },
          { key: "base/nested/ignored.txt", size: 99 },
        ],
      },
    ]);
    const client = new S3Client({ bucketName: "bucket", backend });

    const files = await client.list("/base");

    expect(backend.listCalls).toEqual([
      { prefix: "base/", delimiter: "/", continuationToken: undefined },
    ]);
    expect(files).toEqual([
      { path: "photos", name: "photos", type: "directory", size: 0 },
      {
        path: "report.txt",
        name: "report.txt",
        type: "file",
        size: 42,
        modifiedTime: new Date("2026-06-20T10:30:00.000Z"),
      },
    ]);
  });

  test("continues backend listings", async () => {
    const backend = new FakeS3Backend([
      {
        contents: [{ key: "first.txt", size: 1 }],
        isTruncated: true,
        nextContinuationToken: "next",
      },
      {
        contents: [{ key: "second.txt", size: 2 }],
      },
    ]);
    const client = new S3Client({ bucketName: "bucket", backend });

    const files = await client.list("/");

    expect(files.map((file) => file.name)).toEqual(["first.txt", "second.txt"]);
    expect(backend.listCalls).toEqual([
      { prefix: "", delimiter: "/", continuationToken: undefined },
      { prefix: "", delimiter: "/", continuationToken: "next" },
    ]);
  });

  test("downloads, uploads, deletes, and creates directory placeholders", async () => {
    const backend = new FakeS3Backend();
    backend.objects.set(
      "remote/source.txt",
      new TextEncoder().encode("from s3"),
    );
    backend.objects.set(
      "remote/delete.txt",
      new TextEncoder().encode("delete me"),
    );
    const client = new S3Client({ bucketName: "bucket", backend });
    const localDownload = join(tempDir, "downloaded.txt");
    const localUpload = join(tempDir, "upload.txt");
    await writeFile(localUpload, "to s3");
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

    expect(await readFile(localDownload, "utf8")).toBe("from s3");
    expect(
      new TextDecoder().decode(backend.objects.get("remote/upload.txt")),
    ).toBe("to s3");
    expect(deleted).toBe(true);
    expect(missingDelete).toBe(false);
    expect(madeDirectory).toBe(true);
    expect(
      new TextDecoder().decode(backend.objects.get("remote/new-dir/")),
    ).toBe("");
    expect(progress).toEqual([7, 5]);
    expect(backend.deleteCalls).toEqual([
      "remote/delete.txt",
      "remote/missing.txt",
    ]);
  });
});
