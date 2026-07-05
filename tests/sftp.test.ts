import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2";
import {
  SftpClient,
  createKnownHostsVerifier,
  expandHomePath,
  type SftpBackend,
} from "../src/clients/sftp.ts";
import { ListingError, TransferError } from "../src/errors.ts";

function stats(options: {
  directory?: boolean;
  size?: number;
  mtime?: number;
}): Stats {
  return {
    mode: 0,
    uid: 0,
    gid: 0,
    size: options.size ?? 0,
    atime: 0,
    mtime: options.mtime ?? 0,
    isDirectory: () => options.directory === true,
    isFile: () => options.directory !== true,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function entry(filename: string, attrs: Stats): FileEntryWithStats {
  return { filename, longname: filename, attrs };
}

class FakeSftpBackend implements SftpBackend {
  connectCalls: ConnectConfig[] = [];
  readdirCalls: string[] = [];
  fastGetCalls: Array<{ remotePath: string; localPath: string }> = [];
  fastPutCalls: Array<{ localPath: string; remotePath: string }> = [];
  unlinkCalls: string[] = [];
  mkdirCalls: string[] = [];
  closed = false;
  remoteFiles = new Map<string, string>();

  constructor(private readonly listing: FileEntryWithStats[] = []) {}

  async connect(options: ConnectConfig): Promise<void> {
    this.connectCalls.push(options);
  }

  async readdir(path: string): Promise<FileEntryWithStats[]> {
    this.readdirCalls.push(path);
    return this.listing;
  }

  async fastGet(
    remotePath: string,
    localPath: string,
    options?: {
      step?: (total: number, chunk: number, totalSize: number) => void;
    },
  ): Promise<void> {
    this.fastGetCalls.push({ remotePath, localPath });
    const content = this.remoteFiles.get(remotePath);
    if (content === undefined) {
      throw new Error(`missing remote ${remotePath}`);
    }
    await writeFile(localPath, content);
    options?.step?.(content.length, content.length, content.length);
  }

  async fastPut(
    localPath: string,
    remotePath: string,
    options?: {
      step?: (total: number, chunk: number, totalSize: number) => void;
    },
  ): Promise<void> {
    this.fastPutCalls.push({ localPath, remotePath });
    const content = await readFile(localPath, "utf8");
    this.remoteFiles.set(remotePath, content);
    options?.step?.(content.length, content.length, content.length);
  }

  async unlink(path: string): Promise<void> {
    this.unlinkCalls.push(path);
    if (!this.remoteFiles.delete(path)) {
      throw new Error(`missing remote ${path}`);
    }
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path);
  }

  close(): void {
    this.closed = true;
  }
}

class FailingConnectSftpBackend extends FakeSftpBackend {
  override async connect(options: ConnectConfig): Promise<void> {
    this.connectCalls.push(options);
    throw new Error("connect failed");
  }
}

async function thrownBy(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected action to fail");
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-sftp-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeKnownHosts(
  host = "sftp.example.com",
  key = "trusted-key",
): Promise<string> {
  const path = join(tempDir, "known_hosts");
  await writeFile(path, `${host} ssh-ed25519 ${key}\n`);
  return path;
}

describe("SftpClient", () => {
  test("connects lazily and maps directory listings", async () => {
    const backend = new FakeSftpBackend([
      entry("docs", stats({ directory: true, mtime: 1780000000 })),
      entry("readme.txt", stats({ size: 123, mtime: 1780000001 })),
    ]);
    const client = new SftpClient({
      host: "sftp.example.com",
      port: 2222,
      knownHostsPath: await writeKnownHosts("[sftp.example.com]:2222"),
      username: "user",
      password: "secret",
      name: "example",
      backend,
    });

    const files = await client.list("/pub");

    expect(client.name()).toBe("example");
    expect(backend.connectCalls).toEqual([
      {
        host: "sftp.example.com",
        port: 2222,
        username: "user",
        password: "secret",
        readyTimeout: 5000,
        hostVerifier: expect.any(Function),
      },
    ]);
    expect(backend.readdirCalls).toEqual(["/pub"]);
    expect(files).toEqual([
      {
        path: "docs",
        name: "docs",
        type: "directory",
        size: undefined,
        modifiedTime: new Date(1780000000 * 1000),
      },
      {
        path: "readme.txt",
        name: "readme.txt",
        type: "file",
        size: 123,
        modifiedTime: new Date(1780000001 * 1000),
      },
    ]);
  });

  test("downloads, uploads, deletes, creates directories, and closes", async () => {
    const backend = new FakeSftpBackend();
    backend.remoteFiles.set("/remote/source.txt", "from sftp");
    backend.remoteFiles.set("/remote/delete.txt", "delete me");
    const client = new SftpClient({
      host: "sftp.example.com",
      knownHostsPath: await writeKnownHosts(),
      backend,
    });
    const localDownload = join(tempDir, "downloaded.txt");
    const localUpload = join(tempDir, "upload.txt");
    await writeFile(localUpload, "to sftp");
    const progress: Array<{ bytes: number; total?: number }> = [];

    await client.download("/remote/source.txt", localDownload, {
      onProgress: (value) => progress.push(value),
    });
    await client.upload(localUpload, "/remote/upload.txt", {
      onProgress: (value) => progress.push(value),
    });
    const deleted = await client.deleteFile("/remote/delete.txt");
    const missingDelete = await client.deleteFile("/remote/missing.txt");
    const madeDirectory = await client.mkdir("/remote/new-dir");
    await client.close();

    expect(await readFile(localDownload, "utf8")).toBe("from sftp");
    expect(backend.remoteFiles.get("/remote/upload.txt")).toBe("to sftp");
    expect(deleted).toBe(true);
    expect(missingDelete).toBe(false);
    expect(madeDirectory).toBe(true);
    expect(progress).toEqual([
      { bytes: 9, total: 9 },
      { bytes: 7, total: 7 },
    ]);
    expect(backend.fastGetCalls).toEqual([
      { remotePath: "/remote/source.txt", localPath: localDownload },
    ]);
    expect(backend.fastPutCalls).toEqual([
      { localPath: localUpload, remotePath: "/remote/upload.txt" },
    ]);
    expect(backend.unlinkCalls).toEqual([
      "/remote/delete.txt",
      "/remote/missing.txt",
    ]);
    expect(backend.mkdirCalls).toEqual(["/remote/new-dir"]);
    expect(backend.closed).toBe(true);
  });

  test("wraps lazy connection failures in operation errors", async () => {
    const backend = new FailingConnectSftpBackend();
    const client = new SftpClient({
      host: "sftp.example.com",
      knownHostsPath: await writeKnownHosts(),
      backend,
    });
    const localUpload = join(tempDir, "upload.txt");
    await writeFile(localUpload, "to sftp");

    const listError = await thrownBy(() => client.list("/pub"));
    const downloadError = await thrownBy(() =>
      client.download("/remote/source.txt", join(tempDir, "downloaded.txt")),
    );
    const uploadError = await thrownBy(() =>
      client.upload(localUpload, "/remote/upload.txt"),
    );

    expect(listError).toBeInstanceOf(ListingError);
    expect(listError.message).toBe(
      "Failed to list directory '/pub': connect failed",
    );
    expect(downloadError).toBeInstanceOf(TransferError);
    expect(downloadError.message).toBe(
      "Failed to download '/remote/source.txt' from SFTP host 'sftp.example.com': connect failed",
    );
    expect(uploadError).toBeInstanceOf(TransferError);
    expect(uploadError.message).toBe(
      `Failed to upload '${localUpload}' to SFTP host 'sftp.example.com': connect failed`,
    );
  });

  test("closes the SFTP session when an in-flight transfer is aborted", async () => {
    let startedTransfer!: () => void;
    let failTransfer!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      startedTransfer = resolve;
    });
    class HangingSftpBackend extends FakeSftpBackend {
      override async fastGet(
        remotePath: string,
        localPath: string,
      ): Promise<void> {
        this.fastGetCalls.push({ remotePath, localPath });
        startedTransfer();
        await new Promise<void>((_resolve, reject) => {
          failTransfer = reject;
        });
      }
    }

    const backend = new HangingSftpBackend();
    const client = new SftpClient({
      host: "sftp.example.com",
      knownHostsPath: await writeKnownHosts(),
      backend,
    });
    const controller = new AbortController();
    const transfer = client.download(
      "/remote/source.txt",
      join(tempDir, "downloaded.txt"),
      {
        signal: controller.signal,
      },
    );

    await started;
    controller.abort(new Error("cancelled"));
    expect(backend.closed).toBe(true);
    failTransfer(new Error("socket closed"));

    await expect(transfer).rejects.toThrow("cancelled");
  });

  test("connects through a SOCKS5 proxy socket when configured", async () => {
    const backend = new FakeSftpBackend();
    const proxySocket = new Socket();
    const proxyCalls: unknown[] = [];
    const client = new SftpClient({
      host: "sftp.example.com",
      port: 2222,
      knownHostsPath: await writeKnownHosts("[sftp.example.com]:2222"),
      username: "user",
      password: "secret",
      proxy: { host: "proxy.example.com", port: 1080 },
      proxyConnector: async (options) => {
        proxyCalls.push(options);
        return proxySocket;
      },
      backend,
    });

    await client.list("/");
    await client.close();

    expect(proxyCalls).toEqual([
      {
        proxy: { host: "proxy.example.com", port: 1080 },
        targetHost: "sftp.example.com",
        targetPort: 2222,
      },
    ]);
    expect(backend.connectCalls[0]).toMatchObject({
      host: "sftp.example.com",
      port: 2222,
      username: "user",
      password: "secret",
      readyTimeout: 5000,
    });
    expect(backend.connectCalls[0]!.sock).toBe(proxySocket);
    expect(proxySocket.destroyed).toBe(true);
  });

  test("verifies SFTP host keys against known_hosts", async () => {
    const verifier = await createKnownHostsVerifier(
      await writeKnownHosts("[sftp.example.com]:2222", "a2V5LWJvZHk="),
      "sftp.example.com",
      2222,
    );

    expect(verifier(Buffer.from("key-body"))).toBe(true);
    expect(verifier(Buffer.from("other-key"))).toBe(false);
  });

  test("expands home-relative private key filenames and passes password as key passphrase", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const sshDir = join(tempDir, ".ssh");
      const keyPath = join(sshDir, "id_rsa");
      await mkdir(sshDir);
      await writeFile(keyPath, "private key body");

      const backend = new FakeSftpBackend();
      const client = new SftpClient({
        host: "sftp.example.com",
        username: "user",
        password: "key-passphrase",
        keyFilename: "~/.ssh/id_rsa",
        knownHostsPath: await writeKnownHosts(),
        backend,
      });

      await client.list("/");

      expect(expandHomePath("~/.ssh/id_rsa")).toBe(keyPath);
      expect(backend.connectCalls[0]).toMatchObject({
        host: "sftp.example.com",
        port: 22,
        username: "user",
        password: "key-passphrase",
        privateKey: "private key body",
        passphrase: "key-passphrase",
        hostVerifier: expect.any(Function),
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
