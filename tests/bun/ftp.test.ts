import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FileInfo, FileType } from "basic-ftp";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { createFtpSocksSocket, FtpClient, patchFtpsUploadSocketEnd, type FtpBackend } from "../../src/clients/ftp.ts";
import { ListingError, TransferError } from "../../src/errors.ts";

function ftpFile(name: string, type: FileType, size: number, modifiedAt?: Date, rawModifiedAt = ""): FileInfo {
  const info = new FileInfo(name);
  info.type = type;
  info.size = size;
  info.modifiedAt = modifiedAt;
  info.rawModifiedAt = rawModifiedAt;
  return info;
}

class FakeFtpBackend implements FtpBackend {
  availableListCommands?: string[];
  accessCalls: Parameters<FtpBackend["access"]>[0][] = [];
  listCalls: Array<string | undefined> = [];
  downloadCalls: Array<{ localPath: string; remotePath: string }> = [];
  uploadCalls: Array<{ localPath: string; remotePath: string }> = [];
  removeCalls: string[] = [];
  sendCalls: string[] = [];
  closed = false;
  progressHandler: Parameters<FtpBackend["trackProgress"]>[0];
  remoteFiles = new Map<string, string>();
  mkdirFailures = new Set<string>();

  constructor(private readonly listing: FileInfo[] = []) {}

  async access(options: Parameters<FtpBackend["access"]>[0]): Promise<void> {
    this.accessCalls.push(options);
  }

  async list(path?: string): Promise<FileInfo[]> {
    this.listCalls.push(path);
    return this.listing;
  }

  async downloadTo(localPath: string, remotePath: string): Promise<void> {
    this.downloadCalls.push({ localPath, remotePath });
    const content = this.remoteFiles.get(remotePath);
    if (content === undefined) {
      throw new Error(`missing remote ${remotePath}`);
    }
    await writeFile(localPath, content);
    this.progressHandler?.({ bytes: content.length, bytesOverall: content.length, name: remotePath, type: "download" });
  }

  async uploadFrom(localPath: string, remotePath: string): Promise<void> {
    this.uploadCalls.push({ localPath, remotePath });
    const content = await readFile(localPath, "utf8");
    this.remoteFiles.set(remotePath, content);
    this.progressHandler?.({ bytes: content.length, bytesOverall: content.length, name: remotePath, type: "upload" });
  }

  async remove(path: string): Promise<void> {
    this.removeCalls.push(path);
    if (!this.remoteFiles.delete(path)) {
      throw new Error(`missing remote ${path}`);
    }
  }

  async send(command: string): Promise<void> {
    this.sendCalls.push(command);
    if (this.mkdirFailures.has(command)) {
      throw new Error(`failed command ${command}`);
    }
  }

  trackProgress(handler?: Parameters<FtpBackend["trackProgress"]>[0]): void {
    this.progressHandler = handler;
  }

  close(): void {
    this.closed = true;
  }
}

class FailingAccessFtpBackend extends FakeFtpBackend {
  override async access(options: Parameters<FtpBackend["access"]>[0]): Promise<void> {
    this.accessCalls.push(options);
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

class ScriptedSocket extends Duplex {
  writes: Buffer[] = [];

  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(): this {
    return this;
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  send(chunk: Buffer): void {
    this.push(chunk);
  }
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ftpc-ftp-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("FtpClient", () => {
  test("creates FTP sockets that connect through SOCKS5", async () => {
    const inner = new ScriptedSocket();
    const calls: unknown[] = [];
    const socket = createFtpSocksSocket({ host: "proxy.example.com", port: 1080 }, async (options) => {
      calls.push(options);
      return inner as unknown as Socket;
    });
    let connected = false;

    socket.connect({ host: "ftp.example.com", port: 2121 }, () => {
      connected = true;
    });
    await once(socket, "connect");
    expect(socket.remoteAddress).toBe("ftp.example.com");
    expect(socket.remotePort).toBe(2121);
    socket.write("USER anonymous\r\n");
    inner.send(Buffer.from("220 ready\r\n"));
    const [data] = await once(socket, "data") as [Buffer];

    expect(connected).toBe(true);
    expect(calls).toEqual([{
      proxy: { host: "proxy.example.com", port: 1080 },
      targetHost: "ftp.example.com",
      targetPort: 2121,
    }]);
    expect(inner.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["USER anonymous\r\n"]);
    expect(data.toString("utf8")).toBe("220 ready\r\n");
  });

  test("waits for the SOCKS5 socket to finish ending before reporting upload data completion", async () => {
    const inner = new ScriptedSocket();
    let finishInnerEnd: (() => void) | undefined;
    inner.end = ((...args: unknown[]) => {
      finishInnerEnd = args.find((arg): arg is () => void => typeof arg === "function");
      return inner;
    }) as typeof inner.end;
    const socket = createFtpSocksSocket({ host: "proxy.example.com", port: 1080 }, async () => inner as unknown as Socket);
    let ended = false;

    socket.connect({ host: "ftp.example.com", port: 2121 });
    await once(socket, "connect");
    socket.end("payload", () => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inner.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["payload"]);
    expect(ended).toBe(false);
    expect(finishInnerEnd).toBeInstanceOf(Function);
    finishInnerEnd?.();
    await once(socket, "finish");
    expect(ended).toBe(true);
  });

  test("uses Bun TLS shutdown for encrypted upload data sockets", async () => {
    let shutdownCalled = false;
    const socket = new ScriptedSocket() as ScriptedSocket & {
      encrypted: boolean;
      _handle: { shutdown(callback?: () => void): void };
    };
    socket.encrypted = true;
    socket._handle = {
      shutdown(callback?: () => void): void {
        shutdownCalled = true;
        callback?.();
      },
    };
    let ended = false;

    patchFtpsUploadSocketEnd(socket);
    socket.end("payload", () => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["payload"]);
    expect(shutdownCalled).toBe(true);
    expect(ended).toBe(true);
    expect(socket.destroyed).toBe(false);
  });

  test("waits for pending encrypted upload writes before Bun TLS shutdown", async () => {
    let shutdownCalled = false;
    let finishWrite: (() => void) | undefined;
    const socket = new ScriptedSocket() as ScriptedSocket & {
      encrypted: boolean;
      _handle: { shutdown(callback?: () => void): void };
    };
    socket.encrypted = true;
    socket._handle = {
      shutdown(callback?: () => void): void {
        shutdownCalled = true;
        callback?.();
      },
    };
    socket.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
      const callback = args.find((arg): arg is () => void => typeof arg === "function");
      socket.writes.push(Buffer.from(chunk));
      finishWrite = callback;
      return true;
    }) as typeof socket.write;
    const originalEnd = socket.end.bind(socket);
    let originalEndCalled = false;
    socket.end = ((...args: Parameters<typeof socket.end>) => {
      originalEndCalled = true;
      return originalEnd(...args);
    }) as typeof socket.end;
    let ended = false;

    patchFtpsUploadSocketEnd(socket);
    socket.write("payload");
    socket.end(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["payload"]);
    expect(shutdownCalled).toBe(false);
    expect(originalEndCalled).toBe(false);
    expect(ended).toBe(false);
    finishWrite?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownCalled).toBe(true);
    expect(originalEndCalled).toBe(true);
    expect(ended).toBe(true);
  });

  test("connects lazily and maps directory listings", async () => {
    const modifiedAt = new Date("2026-06-20T12:00:00.000Z");
    const backend = new FakeFtpBackend([
      ftpFile("docs", FileType.Directory, 0),
      ftpFile("readme.txt", FileType.File, 123, modifiedAt),
    ]);
    const client = new FtpClient({
      host: "ftp.example.com",
      port: 2121,
      username: "user",
      password: "secret",
      tls: true,
      name: "example",
      backend,
    });

    const files = await client.list("/pub");

    expect(client.name()).toBe("example");
    expect(backend.accessCalls).toEqual([{
      host: "ftp.example.com",
      port: 2121,
      user: "user",
      password: "secret",
      secure: true,
      secureOptions: {
        host: "ftp.example.com",
        servername: "ftp.example.com",
      },
    }]);
    expect(backend.listCalls).toEqual(["/pub"]);
    expect(files).toEqual([
      { path: "docs", name: "docs", type: "directory", size: 0, modifiedTime: undefined },
      { path: "readme.txt", name: "readme.txt", type: "file", size: 123, modifiedTime: modifiedAt },
    ]);
  });

  test("prefers plain LIST over LIST -a after connecting", async () => {
    const backend = new FakeFtpBackend([
      ftpFile("readme.txt", FileType.File, 123),
    ]);
    backend.availableListCommands = ["LIST -a", "LIST"];
    const client = new FtpClient({ host: "ftp.example.com", backend });

    await client.list("/");

    expect(backend.availableListCommands).toEqual(["LIST"]);
  });

  test("parses raw modification dates from FTP LIST directory listings", async () => {
    const currentYear = new Date().getUTCFullYear();
    const backend = new FakeFtpBackend([
      ftpFile("recent.txt", FileType.File, 10, undefined, "Jun 20 10:30"),
      ftpFile("older.txt", FileType.File, 20, undefined, "Dec 11 2025"),
      ftpFile("numeric.txt", FileType.File, 30, undefined, "2026-06-20 10:30"),
      ftpFile("dos.txt", FileType.File, 40, undefined, "06-20-26 10:30AM"),
    ]);
    const client = new FtpClient({ host: "ftp.example.com", backend });

    const files = await client.list("/");

    expect(files).toEqual([
      {
        path: "recent.txt",
        name: "recent.txt",
        type: "file",
        size: 10,
        modifiedTime: new Date(Date.UTC(currentYear, 5, 20, 10, 30)),
      },
      {
        path: "older.txt",
        name: "older.txt",
        type: "file",
        size: 20,
        modifiedTime: new Date("2025-12-11T00:00:00.000Z"),
      },
      {
        path: "numeric.txt",
        name: "numeric.txt",
        type: "file",
        size: 30,
        modifiedTime: new Date("2026-06-20T10:30:00.000Z"),
      },
      {
        path: "dos.txt",
        name: "dos.txt",
        type: "file",
        size: 40,
        modifiedTime: new Date("2026-06-20T10:30:00.000Z"),
      },
    ]);
  });

  test("downloads, uploads, deletes, creates directories, and closes", async () => {
    const backend = new FakeFtpBackend();
    backend.remoteFiles.set("/remote/source.txt", "from ftp");
    backend.remoteFiles.set("/remote/delete.txt", "delete me");
    const client = new FtpClient({ host: "ftp.example.com", backend });
    const localDownload = join(tempDir, "downloaded.txt");
    const localUpload = join(tempDir, "upload.txt");
    await writeFile(localUpload, "to ftp");
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
    backend.mkdirFailures.add("MKD /remote/existing-dir");
    const existingDirectory = await client.mkdir("/remote/existing-dir");
    await client.close();

    expect(await readFile(localDownload, "utf8")).toBe("from ftp");
    expect(backend.remoteFiles.get("/remote/upload.txt")).toBe("to ftp");
    expect(deleted).toBe(true);
    expect(missingDelete).toBe(false);
    expect(madeDirectory).toBe(true);
    expect(existingDirectory).toBe(false);
    expect(progress).toEqual([8, 6]);
    expect(backend.downloadCalls).toEqual([{ localPath: localDownload, remotePath: "/remote/source.txt" }]);
    expect(backend.uploadCalls).toEqual([{ localPath: localUpload, remotePath: "/remote/upload.txt" }]);
    expect(backend.removeCalls).toEqual(["/remote/delete.txt", "/remote/missing.txt"]);
    expect(backend.sendCalls).toEqual(["MKD /remote/new-dir", "MKD /remote/existing-dir"]);
    expect(backend.closed).toBe(true);
  });

  test("wraps lazy connection failures in operation errors", async () => {
    const backend = new FailingAccessFtpBackend();
    const client = new FtpClient({ host: "ftp.example.com", backend });
    const localUpload = join(tempDir, "upload.txt");
    await writeFile(localUpload, "to ftp");

    const listError = await thrownBy(() => client.list("/pub"));
    const downloadError = await thrownBy(() => client.download("/remote/source.txt", join(tempDir, "downloaded.txt")));
    const uploadError = await thrownBy(() => client.upload(localUpload, "/remote/upload.txt"));

    expect(listError).toBeInstanceOf(ListingError);
    expect(listError.message).toBe("Failed to list directory '/pub': connect failed");
    expect(downloadError).toBeInstanceOf(TransferError);
    expect(downloadError.message).toBe("Failed to download '/remote/source.txt' from FTP host 'ftp.example.com': connect failed");
    expect(uploadError).toBeInstanceOf(TransferError);
    expect(uploadError.message).toBe(`Failed to upload '${localUpload}' to FTP host 'ftp.example.com': connect failed`);
  });

  test("closes the FTP session when an in-flight transfer is aborted", async () => {
    let startedTransfer!: () => void;
    let failTransfer!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      startedTransfer = resolve;
    });
    class HangingFtpBackend extends FakeFtpBackend {
      override async downloadTo(localPath: string, remotePath: string): Promise<void> {
        this.downloadCalls.push({ localPath, remotePath });
        startedTransfer();
        await new Promise<void>((_resolve, reject) => {
          failTransfer = reject;
        });
      }
    }

    const backend = new HangingFtpBackend();
    const client = new FtpClient({ host: "ftp.example.com", backend });
    const controller = new AbortController();
    const transfer = client.download("/remote/source.txt", join(tempDir, "downloaded.txt"), {
      signal: controller.signal,
    });

    await started;
    controller.abort(new Error("cancelled"));
    expect(backend.closed).toBe(true);
    failTransfer(new Error("socket closed"));

    await expect(transfer).rejects.toThrow("cancelled");
  });
});
