import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join as joinLocalPath } from "node:path";
import { Client as Ssh2Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from "ssh2";
import type { ProxyConfig } from "../config.ts";
import { baseName, normalizeRemotePath } from "../paths.ts";
import { connectSocks5, type Socks5Connector } from "../socks5.ts";
import type { FileDescriptor, StorageClient, TransferOptions } from "../types.ts";
import { ListingError, TransferError } from "../errors.ts";

export interface SftpBackend {
  connect(options: ConnectConfig): Promise<void>;
  readdir(path: string): Promise<FileEntryWithStats[]>;
  fastGet(remotePath: string, localPath: string, options?: { step?: (total: number, chunk: number, totalSize: number) => void }): Promise<void>;
  fastPut(localPath: string, remotePath: string, options?: { step?: (total: number, chunk: number, totalSize: number) => void }): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  close(): void;
}

export interface SftpClientOptions {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  keyFilename?: string;
  proxy?: ProxyConfig;
  proxyConnector?: Socks5Connector;
  name?: string;
  backend?: SftpBackend;
}

function formatPath(path: string): string {
  const normalized = normalizeRemotePath(path);
  return normalized === "." ? "/" : normalized;
}

function descriptorFromEntry(entry: FileEntryWithStats): FileDescriptor {
  const isDirectory = entry.attrs.isDirectory();
  return {
    path: entry.filename,
    name: baseName(entry.filename),
    type: isDirectory ? "directory" : "file",
    size: isDirectory ? undefined : entry.attrs.size,
    modifiedTime: entry.attrs.mtime === undefined ? undefined : new Date(entry.attrs.mtime * 1000),
  };
}

class Ssh2SftpBackend implements SftpBackend {
  private client: Ssh2Client | undefined;
  private sftp: SFTPWrapper | undefined;

  async connect(options: ConnectConfig): Promise<void> {
    this.close();
    const client = new Ssh2Client();
    this.client = client;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        client.removeListener("ready", onReady);
        client.removeListener("error", onError);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onError = (error: Error): void => {
        fail(error);
      };
      const onReady = (): void => {
        client.sftp((error, sftp) => {
          if (error !== undefined) {
            fail(error);
            return;
          }
          settled = true;
          cleanup();
          this.sftp = sftp;
          resolve();
        });
      };

      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(options);
    });
  }

  async readdir(path: string): Promise<FileEntryWithStats[]> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(path, (error, list) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(list);
      });
    });
  }

  async fastGet(remotePath: string, localPath: string, options: { step?: (total: number, chunk: number, totalSize: number) => void } = {}): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, options, (error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async fastPut(localPath: string, remotePath: string, options: { step?: (total: number, chunk: number, totalSize: number) => void } = {}): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, options, (error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async unlink(path: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.unlink(path, (error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async mkdir(path: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.mkdir(path, (error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  close(): void {
    this.sftp?.end();
    this.client?.end();
    this.sftp = undefined;
    this.client = undefined;
  }

  private requireSftp(): SFTPWrapper {
    if (this.sftp === undefined) {
      throw new Error("SFTP session is not connected");
    }
    return this.sftp;
  }
}

function createSftpBackend(): SftpBackend {
  return new Ssh2SftpBackend();
}

export function expandHomePath(path: string): string {
  const home = process.env.HOME ?? homedir();
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return joinLocalPath(home, path.slice(2));
  }
  return path;
}

export class SftpClient implements StorageClient {
  private readonly backend: SftpBackend;
  private readonly host: string;
  private readonly port: number;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly keyFilename: string | undefined;
  private readonly proxy: ProxyConfig | undefined;
  private readonly proxyConnector: Socks5Connector;
  private readonly displayName: string;
  private proxySocket: Socket | undefined;
  private connected = false;

  constructor(options: SftpClientOptions) {
    this.host = options.host;
    this.port = options.port ?? 22;
    this.username = options.username;
    this.password = options.password;
    this.keyFilename = options.keyFilename;
    this.proxy = options.proxy;
    this.proxyConnector = options.proxyConnector ?? connectSocks5;
    this.displayName = options.name ?? `SFTP:${options.host}`;
    this.backend = options.backend ?? createSftpBackend();
  }

  name(): string {
    return this.displayName;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    const options: ConnectConfig = {
      host: this.host,
      port: this.port,
      readyTimeout: 5000,
    };
    if (this.username !== undefined) {
      options.username = this.username;
    }
    if (this.password !== undefined) {
      options.password = this.password;
    }
    if (this.keyFilename !== undefined) {
      options.privateKey = await readFile(expandHomePath(this.keyFilename), "utf8");
      if (this.password !== undefined) {
        options.passphrase = this.password;
      }
    }
    if (this.proxy !== undefined) {
      this.proxySocket = await this.proxyConnector({
        proxy: this.proxy,
        targetHost: this.host,
        targetPort: this.port,
      });
      options.sock = this.proxySocket;
    }

    try {
      await this.backend.connect(options);
      this.connected = true;
    } catch (error) {
      this.proxySocket?.destroy();
      this.proxySocket = undefined;
      throw error;
    }
  }

  private watchAbort(signal: AbortSignal | undefined): () => void {
    signal?.throwIfAborted();
    if (signal === undefined) {
      return () => {};
    }

    const abort = (): void => {
      this.backend.close();
      this.proxySocket?.destroy();
      this.proxySocket = undefined;
      this.connected = false;
    };
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  async list(path: string): Promise<FileDescriptor[]> {
    try {
      await this.ensureConnected();
      return (await this.backend.readdir(formatPath(path))).map(descriptorFromEntry);
    } catch (error) {
      throw new ListingError(`Failed to list directory '${path}': ${(error as Error).message}`, { cause: error });
    }
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    const cleanupAbort = this.watchAbort(options.signal);
    try {
      await this.ensureConnected();
      await this.backend.fastGet(formatPath(remotePath), localPath, {
        step: (bytes, _chunk, total) => options.onProgress?.({ bytes, total }),
      });
      options.signal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) {
        options.signal.throwIfAborted();
      }
      throw new TransferError(`Failed to download '${remotePath}' from SFTP host '${this.host}': ${(error as Error).message}`, { cause: error });
    } finally {
      cleanupAbort();
    }
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    const cleanupAbort = this.watchAbort(options.signal);
    try {
      await this.ensureConnected();
      await this.backend.fastPut(localPath, formatPath(remotePath), {
        step: (bytes, _chunk, total) => options.onProgress?.({ bytes, total }),
      });
      options.signal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) {
        options.signal.throwIfAborted();
      }
      throw new TransferError(`Failed to upload '${localPath}' to SFTP host '${this.host}': ${(error as Error).message}`, { cause: error });
    } finally {
      cleanupAbort();
    }
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.ensureConnected();
    try {
      await this.backend.unlink(formatPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<boolean> {
    await this.ensureConnected();
    try {
      await this.backend.mkdir(formatPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.backend.close();
    this.proxySocket?.destroy();
    this.proxySocket = undefined;
    this.connected = false;
  }
}
