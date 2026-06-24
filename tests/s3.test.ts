import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import {
  createUnsignedS3Backend,
  S3Client,
  type S3Backend,
  type S3ListResponse,
} from "../src/clients/s3.ts";

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

class ScriptedHttpSocket extends Duplex {
  readonly requests: Buffer[] = [];

  constructor(private readonly response: Buffer) {
    super();
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.requests.push(Buffer.from(chunk));
    queueMicrotask(() => {
      this.push(this.response);
      this.push(null);
    });
    callback();
  }

  requestText(): string {
    return Buffer.concat(this.requests).toString("utf8");
  }
}

function httpResponse(
  body: string,
  headers: Record<string, string> = {},
): Buffer {
  const bodyBytes = Buffer.from(body);
  return Buffer.from(
    [
      "HTTP/1.1 200 OK",
      `Content-Length: ${bodyBytes.byteLength}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      "",
      body,
    ].join("\r\n"),
    "utf8",
  );
}

function chunkedHttpResponse(body: string): Buffer {
  const bodyBytes = Buffer.from(body);
  return Buffer.from(
    [
      "HTTP/1.1 200 OK",
      "Transfer-Encoding: chunked",
      "",
      bodyBytes.byteLength.toString(16),
      body,
      "0",
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-s3-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("S3Client", () => {
  test("uses unsigned REST requests for anonymous listings", async () => {
    const requests: string[] = [];
    const backend = createUnsignedS3Backend({
      bucketName: "public-bucket",
      endpointUrl: "https://storage.example.com",
      fetch: async (input) => {
        requests.push(input.toString());
        return new Response(`
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>next-token</NextContinuationToken>
  <CommonPrefixes><Prefix>base/photos/</Prefix></CommonPrefixes>
  <Contents>
    <Key>base/report&amp;notes.txt</Key>
    <LastModified>2026-06-20T10:30:00.000Z</LastModified>
    <Size>42</Size>
  </Contents>
</ListBucketResult>`);
      },
    });

    const response = await backend.list({
      prefix: "base/",
      delimiter: "/",
      continuationToken: "old-token",
    });

    expect(requests).toEqual([
      "https://storage.example.com/public-bucket?list-type=2&prefix=base%2F&delimiter=%2F&continuation-token=old-token",
    ]);
    expect(response).toEqual({
      commonPrefixes: [{ prefix: "base/photos/" }],
      contents: [
        {
          key: "base/report&notes.txt",
          size: 42,
          lastModified: "2026-06-20T10:30:00.000Z",
        },
      ],
      isTruncated: true,
      nextContinuationToken: "next-token",
    });
  });

  test("uses unsigned REST requests for anonymous transfers", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const backend = createUnsignedS3Backend({
      bucketName: "public-bucket",
      endpointUrl: "https://storage.example.com/root/",
      fetch: async (input, init = {}) => {
        const method = init.method ?? "GET";
        requests.push({
          url: input.toString(),
          method,
          body: typeof init.body === "string" ? init.body : undefined,
        });
        if (method === "GET") {
          return new Response("from unsigned s3");
        }
        return new Response("", { status: method === "DELETE" ? 204 : 200 });
      },
    });

    const buffer = await backend.file("folder/file name.txt").arrayBuffer();
    const bytes = await backend.write("folder/upload.txt", "upload body");
    await backend.delete("folder/remove.txt");

    expect(new TextDecoder().decode(buffer)).toBe("from unsigned s3");
    expect(bytes).toBe("upload body".length);
    expect(requests).toEqual([
      {
        url: "https://storage.example.com/root/public-bucket/folder/file%20name.txt",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://storage.example.com/root/public-bucket/folder/upload.txt",
        method: "PUT",
        body: "upload body",
      },
      {
        url: "https://storage.example.com/root/public-bucket/folder/remove.txt",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  test("defaults to unsigned REST backend when credentials are not configured", async () => {
    const requests: string[] = [];
    const client = new S3Client({
      bucketName: "public-bucket",
      endpointUrl: "https://storage.example.com",
      fetch: async (input) => {
        requests.push(input.toString());
        return new Response(
          "<ListBucketResult><Contents><Key>file.txt</Key><Size>5</Size></Contents></ListBucketResult>",
        );
      },
    });

    const files = await client.list("/");

    expect(files).toEqual([
      {
        path: "file.txt",
        name: "file.txt",
        type: "file",
        size: 5,
        modifiedTime: undefined,
      },
    ]);
    expect(requests).toEqual([
      "https://storage.example.com/public-bucket?list-type=2&delimiter=%2F",
    ]);
  });

  test("routes unsigned anonymous listings through SOCKS5 proxy transport", async () => {
    const proxyCalls: unknown[] = [];
    const sockets: ScriptedHttpSocket[] = [];
    const backend = createUnsignedS3Backend({
      bucketName: "public-bucket",
      endpointUrl: "http://storage.example.com",
      proxy: { host: "proxy.example.com", port: 1080 },
      proxyConnector: async (options) => {
        proxyCalls.push(options);
        const socket = new ScriptedHttpSocket(
          chunkedHttpResponse(`
<ListBucketResult>
  <Contents><Key>file.txt</Key><Size>7</Size></Contents>
</ListBucketResult>`),
        );
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });

    const response = await backend.list({ delimiter: "/" });

    expect(proxyCalls).toEqual([
      {
        proxy: { host: "proxy.example.com", port: 1080 },
        targetHost: "storage.example.com",
        targetPort: 80,
      },
    ]);
    expect(response.contents).toEqual([{ key: "file.txt", size: 7 }]);
    expect(sockets).toHaveLength(1);
    const request = sockets[0]!.requestText();
    expect(
      request.startsWith(
        "GET /public-bucket?list-type=2&delimiter=%2F HTTP/1.1\r\n",
      ),
    ).toBe(true);
    expect(request.toLowerCase()).toContain("host: storage.example.com\r\n");
    expect(request.toLowerCase()).toContain("connection: close\r\n");
  });

  test("routes unsigned anonymous uploads through SOCKS5 proxy transport", async () => {
    const sockets: ScriptedHttpSocket[] = [];
    const backend = createUnsignedS3Backend({
      bucketName: "public-bucket",
      endpointUrl: "http://storage.example.com",
      proxy: { host: "proxy.example.com", port: 1080 },
      proxyConnector: async () => {
        const socket = new ScriptedHttpSocket(httpResponse(""));
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });

    const bytes = await backend.write("folder/upload.txt", "proxy body");
    const emptyBytes = await backend.write("folder/empty/", "");

    expect(bytes).toBe("proxy body".length);
    expect(emptyBytes).toBe(0);
    expect(sockets).toHaveLength(2);
    const request = sockets[0]!.requestText();
    expect(
      request.startsWith("PUT /public-bucket/folder/upload.txt HTTP/1.1\r\n"),
    ).toBe(true);
    expect(request.toLowerCase()).toContain("content-length: 10\r\n");
    expect(request.endsWith("\r\n\r\nproxy body")).toBe(true);
    const emptyRequest = sockets[1]!.requestText();
    expect(
      emptyRequest.startsWith("PUT /public-bucket/folder/empty/ HTTP/1.1\r\n"),
    ).toBe(true);
    expect(emptyRequest.toLowerCase()).toContain("content-length: 0\r\n");
    expect(emptyRequest.endsWith("\r\n\r\n")).toBe(true);
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

  test("continues truncated listings", async () => {
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
