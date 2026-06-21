import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { parseConfigText } from "../../src/config.ts";
import { UnsupportedFeatureError } from "../../src/errors.ts";
import { Storage } from "../../src/storage.ts";
import type { S3Backend, S3ListResponse } from "../../src/clients/s3.ts";
import type { FtpBackend } from "../../src/clients/ftp.ts";
import type { SftpBackend } from "../../src/clients/sftp.ts";
import type { AzureBlobBackend } from "../../src/clients/azure_blob.ts";
import type { AzureDataLakeBackend } from "../../src/clients/azure_datalake.ts";

let tempDir = "";

class ScriptedHttpSocket extends Duplex {
  readonly requests: Buffer[] = [];

  constructor(private readonly response: Buffer) {
    super();
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
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

function s3ListHttpResponse(): Buffer {
  const body = "<ListBucketResult><Contents><Key>base/file.txt</Key><Size>10</Size></Contents></ListBucketResult>";
  return Buffer.from([
    "HTTP/1.1 200 OK",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"), "utf8");
}

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

  test("connects to protocol-less local paths", async () => {
    const rootStore = Storage.connect(".");
    const rootFiles = await rootStore.list();
    expect(rootFiles.map((file) => file.name)).toContain("package.json");

    const config = parseConfigText("[local]\ntype = \"local\"\n");
    const srcStore = Storage.connect("./src", { config });
    const srcFiles = await srcStore.list();
    expect(srcFiles.map((file) => file.name)).toContain("storage.ts");
  });

  test("connects to configured local remote", async () => {
    const config = parseConfigText("[local]\ntype = \"local\"\n");
    const store = Storage.connect("local", { config });
    const rootFiles = await store.list(tempDir);
    expect(rootFiles.map((file) => file.name)).toContain("a.txt");
  });

  test("named constructors create sessions for remote backends", async () => {
    const s3Calls: Array<{ prefix?: string; delimiter?: string; continuationToken?: string }> = [];
    const s3Backend: S3Backend = {
      async list(input): Promise<S3ListResponse> {
        s3Calls.push(input ?? {});
        return {};
      },
      file() {
        return { async arrayBuffer() { return new ArrayBuffer(0); } };
      },
      async write() {
        return 0;
      },
      async delete() {},
    };
    const s3 = Storage.s3("bucket", { name: "named-s3", basePath: "/base", backend: s3Backend });
    expect(s3.name).toBe("named-s3");
    expect(await s3.list()).toEqual([]);
    expect(s3Calls).toEqual([{ prefix: "base/", delimiter: "/", continuationToken: undefined }]);

    const ftpAccessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const ftpListCalls: Array<string | undefined> = [];
    const ftpBackend: FtpBackend = {
      async access(options) {
        ftpAccessCalls.push(options);
      },
      async list(path) {
        ftpListCalls.push(path);
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };
    const ftp = Storage.ftp("ftp.example.com", {
      username: "me",
      password: "secret",
      tls: true,
      basePath: "/pub",
      backend: ftpBackend,
    });
    expect(ftp.name).toBe("ftp.example.com");
    expect(await ftp.list()).toEqual([]);
    expect(ftpAccessCalls).toEqual([{
      host: "ftp.example.com",
      port: 21,
      user: "me",
      password: "secret",
      secure: true,
    }]);
    expect(ftpListCalls).toEqual(["/pub"]);

    const sftpConnectCalls: Parameters<SftpBackend["connect"]>[0][] = [];
    const sftpReadCalls: string[] = [];
    const sftpBackend: SftpBackend = {
      async connect(options) {
        sftpConnectCalls.push(options);
      },
      async readdir(path) {
        sftpReadCalls.push(path);
        return [];
      },
      async fastGet() {},
      async fastPut() {},
      async unlink() {},
      async mkdir() {},
      close() {},
    };
    const sftp = Storage.sftp("sftp.example.com", {
      username: "me",
      password: "secret",
      basePath: "/home",
      backend: sftpBackend,
    });
    expect(sftp.name).toBe("SFTP:sftp.example.com");
    expect(await sftp.list()).toEqual([]);
    expect(sftpConnectCalls[0]).toMatchObject({
      host: "sftp.example.com",
      port: 22,
      username: "me",
      password: "secret",
      readyTimeout: 5000,
    });
    expect(sftpReadCalls).toEqual(["/home"]);

    const blobListCalls: Array<{ delimiter: string; prefix?: string }> = [];
    const blobBackend: AzureBlobBackend = {
      async *listBlobsByHierarchy(delimiter, options = {}) {
        blobListCalls.push({ delimiter, prefix: options.prefix });
      },
      getBlobClient() {
        return { async downloadToFile() {} };
      },
      getBlockBlobClient() {
        return { async uploadFile() {} };
      },
      async deleteBlob() {},
      async uploadBlockBlob() {},
    };
    const blob = Storage.azureBlob("account.blob.core.windows.net", "container", {
      basePath: "/base",
      backend: blobBackend,
    });
    expect(blob.name).toBe("Blob:container");
    expect(await blob.list()).toEqual([]);
    expect(blobListCalls).toEqual([{ delimiter: "/", prefix: "base/" }]);

    const lakeListCalls: Array<{ path?: string; recursive?: boolean }> = [];
    const lakeBackend: AzureDataLakeBackend = {
      async *listPaths(options = {}) {
        lakeListCalls.push(options);
      },
      getFileClient() {
        return {
          async readToFile() {},
          async uploadFile() {},
          async delete() {},
        };
      },
      getDirectoryClient() {
        return { async create() {} };
      },
    };
    const lake = Storage.azure("account.dfs.core.windows.net", "filesystem", {
      basePath: "/base",
      backend: lakeBackend,
    });
    expect(lake.name).toBe("Azure:filesystem");
    expect(await lake.list()).toEqual([]);
    expect(lakeListCalls).toEqual([{ path: "base", recursive: false }]);
  });

  test("named constructor proxy options fail clearly until proxy transport is implemented for Azure backends", () => {
    const proxy = { host: "proxy.example.com", port: 1080 };

    for (const [create, message] of [
      [() => Storage.azure("account.dfs.core.windows.net", "filesystem", { proxy }), "azure remote 'Azure:filesystem' uses SOCKS5 proxy proxy.example.com:1080"],
      [() => Storage.azureBlob("account.blob.core.windows.net", "container", { proxy }), "blob remote 'Blob:container' uses SOCKS5 proxy proxy.example.com:1080"],
    ] as const) {
      expect(create).toThrow(UnsupportedFeatureError);
      expect(create).toThrow(message);
    }
  });

  test("S3 named constructor supports SOCKS5 proxy transport for unsigned REST", async () => {
    const proxyCalls: unknown[] = [];
    const sockets: ScriptedHttpSocket[] = [];

    const store = Storage.s3("public-bucket", {
      basePath: "/base",
      endpointUrl: "http://storage.example.com",
      proxy: { host: "proxy.example.com", port: 1080 },
      proxyConnector: async (options) => {
        proxyCalls.push(options);
        const socket = new ScriptedHttpSocket(s3ListHttpResponse());
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });

    const files = await store.list();

    expect(files).toEqual([{ path: "file.txt", name: "file.txt", type: "file", size: 10, modifiedTime: undefined }]);
    expect(proxyCalls).toEqual([{
      proxy: { host: "proxy.example.com", port: 1080 },
      targetHost: "storage.example.com",
      targetPort: 80,
    }]);
    expect(sockets[0].requestText().startsWith(
      "GET /public-bucket?list-type=2&prefix=base%2F&delimiter=%2F HTTP/1.1\r\n",
    )).toBe(true);
  });

  test("S3 proxy with explicit credentials fails clearly", () => {
    const create = (): unknown => Storage.s3("bucket", {
      proxy: { host: "proxy.example.com", port: 1080 },
      awsAccessKeyId: "access",
      awsSecretAccessKey: "secret",
    });

    expect(create).toThrow(UnsupportedFeatureError);
    expect(create).toThrow("s3 remote 'S3:bucket' uses SOCKS5 proxy proxy.example.com:1080");
  });

  test("FTP named constructor supports SOCKS5 proxy transport", async () => {
    const proxyCalls: unknown[] = [];
    const accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const backend: FtpBackend = {
      async access(options) {
        accessCalls.push(options);
      },
      async list() {
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };

    const store = Storage.ftp("ftp.example.com", {
      proxy: { host: "proxy.example.com", port: 1080 },
      proxyConnector: async (options) => {
        proxyCalls.push(options);
        throw new Error("proxy connector should not run when backend is injected");
      },
      backend,
    });

    expect(await store.list()).toEqual([]);
    await store.close();

    expect(proxyCalls).toEqual([]);
    expect(accessCalls).toEqual([{
      host: "ftp.example.com",
      port: 21,
      user: "anonymous",
      password: "anonymous@",
      secure: false,
    }]);
  });

  test("SFTP named constructor supports SOCKS5 proxy transport", async () => {
    const proxySocket = new Socket();
    const proxyCalls: unknown[] = [];
    const connectCalls: Parameters<SftpBackend["connect"]>[0][] = [];
    const backend: SftpBackend = {
      async connect(options) {
        connectCalls.push(options);
      },
      async readdir() {
        return [];
      },
      async fastGet() {},
      async fastPut() {},
      async unlink() {},
      async mkdir() {},
      close() {},
    };

    const store = Storage.sftp("sftp.example.com", {
      proxy: { host: "proxy.example.com", port: 1080 },
      proxyConnector: async (options) => {
        proxyCalls.push(options);
        return proxySocket;
      },
      backend,
    });

    expect(await store.list()).toEqual([]);
    await store.close();

    expect(proxyCalls).toEqual([{
      proxy: { host: "proxy.example.com", port: 1080 },
      targetHost: "sftp.example.com",
      targetPort: 22,
    }]);
    expect(connectCalls[0].sock).toBe(proxySocket);
    expect(proxySocket.destroyed).toBe(true);
  });

  test("connects to S3 URLs and resolves base prefixes", async () => {
    const calls: Array<{ prefix?: string; delimiter?: string; continuationToken?: string }> = [];
    const backend: S3Backend = {
      async list(input): Promise<S3ListResponse> {
        calls.push(input ?? {});
        return {
          contents: [
            { key: "base/file.txt", size: 10, lastModified: "2026-06-20T12:00:00.000Z" },
          ],
        };
      },
      file() {
        return { async arrayBuffer() { return new ArrayBuffer(0); } };
      },
      async write() {
        return 0;
      },
      async delete() {},
    };

    const store = Storage.connect("s3://bucket/base", { s3Backend: backend });
    const files = await store.list();

    expect(files.map((file) => file.name)).toEqual(["file.txt"]);
    expect(calls).toEqual([{ prefix: "base/", delimiter: "/", continuationToken: undefined }]);
  });

  test("connects to configured S3 remotes", async () => {
    const config = parseConfigText("[s3]\ntype = \"s3\"\nbucket_name = \"bucket\"\n");
    const backend: S3Backend = {
      async list() {
        return {};
      },
      file() {
        return { async arrayBuffer() { return new ArrayBuffer(0); } };
      },
      async write() {
        return 0;
      },
      async delete() {},
    };

    const store = Storage.connect("s3", { config, s3Backend: backend });
    expect(store.name).toBe("s3");
    expect(await store.list()).toEqual([]);
  });

  test("connects to FTP URLs and resolves base paths", async () => {
    const accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const listCalls: Array<string | undefined> = [];
    const backend: FtpBackend = {
      async access(options) {
        accessCalls.push(options);
      },
      async list(path) {
        listCalls.push(path);
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };

    const store = Storage.connect("ftps://user:secret@example.com/base", { ftpBackend: backend });
    expect(store.name).toBe("example.com");
    expect(await store.list()).toEqual([]);
    expect(accessCalls).toEqual([{
      host: "example.com",
      port: 21,
      user: "user",
      password: "secret",
      secure: true,
    }]);
    expect(listCalls).toEqual(["/base"]);
  });

  test("connects to configured FTP remotes", async () => {
    const config = parseConfigText("[ftp]\ntype = \"ftp\"\nurl = \"ftp.example.com/pub\"\nusername = \"me\"\npassword = \"secret\"\ntls = true\n");
    const accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const backend: FtpBackend = {
      async access(options) {
        accessCalls.push(options);
      },
      async list() {
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };

    const store = Storage.connect("ftp", { config, ftpBackend: backend });
    expect(store.name).toBe("ftp");
    expect(await store.list()).toEqual([]);
    expect(accessCalls[0]).toMatchObject({
      host: "ftp.example.com",
      port: 21,
      user: "me",
      password: "secret",
      secure: true,
    });
  });

  test("configured FTP remotes use URL credentials unless explicit fields are set", async () => {
    const accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const backend: FtpBackend = {
      async access(options) {
        accessCalls.push(options);
      },
      async list() {
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };
    const config = parseConfigText(`
[from-url]
type = "ftp"
url = "ftp://url-user:url-pass@ftp.example.com/pub"

[explicit]
type = "ftp"
url = "ftp://url-user:url-pass@ftp.example.com/pub"
username = "config-user"
password = "config-pass"
`);

    expect(await Storage.connect("from-url", { config, ftpBackend: backend }).list()).toEqual([]);
    expect(await Storage.connect("explicit", { config, ftpBackend: backend }).list()).toEqual([]);

    expect(accessCalls.map((call) => ({ user: call.user, password: call.password }))).toEqual([
      { user: "url-user", password: "url-pass" },
      { user: "config-user", password: "config-pass" },
    ]);
  });

  test("configured FTP remotes use URL ports unless an explicit port field is set", async () => {
    const accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const backend: FtpBackend = {
      async access(options) {
        accessCalls.push(options);
      },
      async list() {
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };
    const config = parseConfigText(`
[from-url]
type = "ftp"
url = "ftp.example.com:2121/pub"

[explicit]
type = "ftp"
url = "ftp.example.com:2121/pub"
port = 2021
`);

    expect(await Storage.connect("from-url", { config, ftpBackend: backend }).list()).toEqual([]);
    expect(await Storage.connect("explicit", { config, ftpBackend: backend }).list()).toEqual([]);

    expect(accessCalls.map((call) => call.port)).toEqual([2121, 2021]);
  });

  test("configured FTP remotes use FTPS URL TLS unless an explicit tls field is set", async () => {
    const accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const backend: FtpBackend = {
      async access(options) {
        accessCalls.push(options);
      },
      async list() {
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };
    const config = parseConfigText(`
[from-url]
type = "ftp"
url = "ftps://ftp.example.com/pub"

[explicit]
type = "ftp"
url = "ftps://ftp.example.com/pub"
tls = false
`);

    expect(await Storage.connect("from-url", { config, ftpBackend: backend }).list()).toEqual([]);
    expect(await Storage.connect("explicit", { config, ftpBackend: backend }).list()).toEqual([]);

    expect(accessCalls.map((call) => call.secure)).toEqual([true, false]);
  });

  test("connects to SFTP URLs and resolves base paths", async () => {
    const connectCalls: Parameters<SftpBackend["connect"]>[0][] = [];
    const readdirCalls: string[] = [];
    const backend: SftpBackend = {
      async connect(options) {
        connectCalls.push(options);
      },
      async readdir(path) {
        readdirCalls.push(path);
        return [];
      },
      async fastGet() {},
      async fastPut() {},
      async unlink() {},
      async mkdir() {},
      close() {},
    };

    const store = Storage.connect("sftp://user:secret@example.com:2222/base", { sftpBackend: backend });
    expect(store.name).toBe("SFTP:example.com");
    expect(await store.list()).toEqual([]);
    expect(connectCalls).toEqual([{
      host: "example.com",
      port: 2222,
      username: "user",
      password: "secret",
      readyTimeout: 5000,
    }]);
    expect(readdirCalls).toEqual(["/base"]);
  });

  test("connects to configured SFTP remotes", async () => {
    const config = parseConfigText("[sftp]\ntype = \"sftp\"\nurl = \"sftp.example.com/home\"\nusername = \"me\"\npassword = \"secret\"\n");
    const connectCalls: Parameters<SftpBackend["connect"]>[0][] = [];
    const backend: SftpBackend = {
      async connect(options) {
        connectCalls.push(options);
      },
      async readdir() {
        return [];
      },
      async fastGet() {},
      async fastPut() {},
      async unlink() {},
      async mkdir() {},
      close() {},
    };

    const store = Storage.connect("sftp", { config, sftpBackend: backend });
    expect(store.name).toBe("sftp");
    expect(await store.list()).toEqual([]);
    expect(connectCalls[0]).toMatchObject({
      host: "sftp.example.com",
      port: 22,
      username: "me",
      password: "secret",
      readyTimeout: 5000,
    });
  });

  test("configured SFTP remotes use URL credentials unless explicit fields are set", async () => {
    const connectCalls: Parameters<SftpBackend["connect"]>[0][] = [];
    const backend: SftpBackend = {
      async connect(options) {
        connectCalls.push(options);
      },
      async readdir() {
        return [];
      },
      async fastGet() {},
      async fastPut() {},
      async unlink() {},
      async mkdir() {},
      close() {},
    };
    const config = parseConfigText(`
[from-url]
type = "sftp"
url = "sftp://url-user:url-pass@sftp.example.com/home"

[explicit]
type = "sftp"
url = "sftp://url-user:url-pass@sftp.example.com/home"
username = "config-user"
password = "config-pass"
`);

    expect(await Storage.connect("from-url", { config, sftpBackend: backend }).list()).toEqual([]);
    expect(await Storage.connect("explicit", { config, sftpBackend: backend }).list()).toEqual([]);

    expect(connectCalls.map((call) => ({ username: call.username, password: call.password }))).toEqual([
      { username: "url-user", password: "url-pass" },
      { username: "config-user", password: "config-pass" },
    ]);
  });

  test("configured SFTP remotes use URL ports unless an explicit port field is set", async () => {
    const connectCalls: Parameters<SftpBackend["connect"]>[0][] = [];
    const backend: SftpBackend = {
      async connect(options) {
        connectCalls.push(options);
      },
      async readdir() {
        return [];
      },
      async fastGet() {},
      async fastPut() {},
      async unlink() {},
      async mkdir() {},
      close() {},
    };
    const config = parseConfigText(`
[from-url]
type = "sftp"
url = "sftp.example.com:2223/home"
password = "secret"

[explicit]
type = "sftp"
url = "sftp.example.com:2223/home"
port = 2224
password = "secret"
`);

    expect(await Storage.connect("from-url", { config, sftpBackend: backend }).list()).toEqual([]);
    expect(await Storage.connect("explicit", { config, sftpBackend: backend }).list()).toEqual([]);

    expect(connectCalls.map((call) => call.port)).toEqual([2223, 2224]);
  });

  test("connects to Azure Blob URLs and resolves base paths", async () => {
    const listCalls: Array<{ delimiter: string; prefix?: string }> = [];
    const backend: AzureBlobBackend = {
      async *listBlobsByHierarchy(delimiter, options = {}) {
        listCalls.push({ delimiter, prefix: options.prefix });
        yield { kind: "blob", name: "base/file.txt", properties: { contentLength: 12 } };
      },
      getBlobClient() {
        return { async downloadToFile() {} };
      },
      getBlockBlobClient() {
        return { async uploadFile() {} };
      },
      async deleteBlob() {},
      async uploadBlockBlob() {},
    };

    const store = Storage.connect("blob://account.blob.core.windows.net/container/base", { azureBlobBackend: backend });
    const files = await store.list();

    expect(store.name).toBe("Blob:container");
    expect(files).toEqual([{ path: "file.txt", name: "file.txt", type: "file", size: 12, modifiedTime: undefined }]);
    expect(listCalls).toEqual([{ delimiter: "/", prefix: "base/" }]);
  });

  test("connects to configured Azure Blob remotes", async () => {
    const config = parseConfigText("[blob]\ntype = \"blob\"\nurl = \"blob://account.blob.core.windows.net/container/base\"\ncontainer = \"container\"\n");
    const listCalls: Array<{ delimiter: string; prefix?: string }> = [];
    const backend: AzureBlobBackend = {
      async *listBlobsByHierarchy(delimiter, options = {}) {
        listCalls.push({ delimiter, prefix: options.prefix });
      },
      getBlobClient() {
        return { async downloadToFile() {} };
      },
      getBlockBlobClient() {
        return { async uploadFile() {} };
      },
      async deleteBlob() {},
      async uploadBlockBlob() {},
    };

    const store = Storage.connect("blob", { config, azureBlobBackend: backend });
    expect(store.name).toBe("blob");
    expect(await store.list()).toEqual([]);
    expect(listCalls).toEqual([{ delimiter: "/", prefix: "base/" }]);
  });

  test("connects to Azure Data Lake URLs and resolves base paths", async () => {
    const listCalls: Array<{ path?: string; recursive?: boolean }> = [];
    const backend: AzureDataLakeBackend = {
      async *listPaths(options = {}) {
        listCalls.push(options);
        yield { name: "base/file.txt", contentLength: 12 };
      },
      getFileClient() {
        return {
          async readToFile() {},
          async uploadFile() {},
          async delete() {},
        };
      },
      getDirectoryClient() {
        return { async create() {} };
      },
    };

    const store = Storage.connect("azure://account.dfs.core.windows.net/filesystem/base", { azureDataLakeBackend: backend });
    const files = await store.list();

    expect(store.name).toBe("Azure:filesystem");
    expect(files).toEqual([{ path: "file.txt", name: "file.txt", type: "file", size: 12, modifiedTime: undefined }]);
    expect(listCalls).toEqual([{ path: "base", recursive: false }]);
  });

  test("connects to configured Azure Data Lake remotes", async () => {
    const config = parseConfigText("[lake]\ntype = \"azure\"\nurl = \"azure://account.dfs.core.windows.net/filesystem/base\"\nfilesystem = \"filesystem\"\n");
    const listCalls: Array<{ path?: string; recursive?: boolean }> = [];
    const backend: AzureDataLakeBackend = {
      async *listPaths(options = {}) {
        listCalls.push(options);
      },
      getFileClient() {
        return {
          async readToFile() {},
          async uploadFile() {},
          async delete() {},
        };
      },
      getDirectoryClient() {
        return { async create() {} };
      },
    };

    const store = Storage.connect("lake", { config, azureDataLakeBackend: backend });
    expect(store.name).toBe("lake");
    expect(await store.list()).toEqual([]);
    expect(listCalls).toEqual([{ path: "base", recursive: false }]);
  });

  test("configured SFTP proxy remotes use SOCKS5 proxy transport", async () => {
    const config = parseConfigText(`
[sftp]
type = "sftp"
url = "sftp.example.com"
password = "secret"

[sftp.proxy]
host = "proxy.example.com"
port = 1081
`);
    const proxySocket = new Socket();
    const proxyCalls: unknown[] = [];
    const connectCalls: Parameters<SftpBackend["connect"]>[0][] = [];
    const backend: SftpBackend = {
      async connect(options) {
        connectCalls.push(options);
      },
      async readdir() {
        return [];
      },
      async fastGet() {},
      async fastPut() {},
      async unlink() {},
      async mkdir() {},
      close() {},
    };

    const store = Storage.connect("sftp", {
      config,
      sftpBackend: backend,
      sftpProxyConnector: async (options) => {
        proxyCalls.push(options);
        return proxySocket;
      },
    });

    expect(await store.list()).toEqual([]);
    await store.close();

    expect(proxyCalls).toEqual([{
      proxy: { host: "proxy.example.com", port: 1081 },
      targetHost: "sftp.example.com",
      targetPort: 22,
    }]);
    expect(connectCalls[0].sock).toBe(proxySocket);
    expect(proxySocket.destroyed).toBe(true);
  });

  test("configured FTP proxy remotes accept SOCKS5 proxy transport settings", async () => {
    const config = parseConfigText(`
[ftp]
type = "ftp"
url = "ftp.example.com"

[ftp.proxy]
host = "proxy.example.com"
`);
    const accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
    const backend: FtpBackend = {
      async access(options) {
        accessCalls.push(options);
      },
      async list() {
        return [];
      },
      async downloadTo() {},
      async uploadFrom() {},
      async remove() {},
      async send() {},
      trackProgress() {},
      close() {},
    };

    const store = Storage.connect("ftp", {
      config,
      ftpBackend: backend,
      ftpProxyConnector: async () => {
        throw new Error("proxy connector should not run when backend is injected");
      },
    });

    expect(await store.list()).toEqual([]);
    await store.close();

    expect(accessCalls).toEqual([{
      host: "ftp.example.com",
      port: 21,
      user: "anonymous",
      password: "anonymous@",
      secure: false,
    }]);
  });

  test("configured S3 proxy remotes use SOCKS5 proxy transport for unsigned REST", async () => {
    const config = parseConfigText(`
[s3]
type = "s3"
bucket_name = "public-bucket"
endpoint_url = "http://storage.example.com"

[s3.proxy]
host = "proxy.example.com"
port = 1082
`);
    const proxyCalls: unknown[] = [];
    const sockets: ScriptedHttpSocket[] = [];

    const store = Storage.connect("s3", {
      config,
      s3ProxyConnector: async (options) => {
        proxyCalls.push(options);
        const socket = new ScriptedHttpSocket(s3ListHttpResponse());
        sockets.push(socket);
        return socket as unknown as Socket;
      },
    });

    const files = await store.list("/base");

    expect(files.map((file) => file.name)).toEqual(["file.txt"]);
    expect(proxyCalls).toEqual([{
      proxy: { host: "proxy.example.com", port: 1082 },
      targetHost: "storage.example.com",
      targetPort: 80,
    }]);
    expect(sockets[0].requestText().startsWith(
      "GET /public-bucket?list-type=2&prefix=base%2F&delimiter=%2F HTTP/1.1\r\n",
    )).toBe(true);
  });

  test("network proxy remotes fail clearly until proxy transport is implemented for Azure backends", () => {
    const config = parseConfigText(`
[lake]
type = "azure"
url = "account.dfs.core.windows.net"
filesystem = "data"

[lake.proxy]
host = "proxy.example.com"
port = 1083

[blob]
type = "blob"
url = "account.blob.core.windows.net"
container = "data"

[blob.proxy]
host = "proxy.example.com"
port = 1084
`);

    for (const [remoteName, proxyAddress] of [
      ["lake", "proxy.example.com:1083"],
      ["blob", "proxy.example.com:1084"],
    ] as const) {
      let thrown: unknown;
      try {
        Storage.connect(remoteName, { config });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnsupportedFeatureError);
      expect((thrown as Error).message).toContain(`remote '${remoteName}' uses SOCKS5 proxy ${proxyAddress}`);
    }
  });
});
