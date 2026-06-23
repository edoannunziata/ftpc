import { Client as BasicFtpClient } from "basic-ftp";
import type { FileInfo } from "basic-ftp";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import type { ProxyConfig } from "../config.ts";
import { baseName, normalizeRemotePath } from "../paths.ts";
import { connectSocks5, type Socks5Connector } from "../socks5.ts";
import type { FileDescriptor, StorageClient, TransferOptions } from "../types.ts";
import { ListingError, TransferError } from "../errors.ts";

export interface FtpBackend {
  availableListCommands?: string[];
  access(options: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    secure?: boolean | "implicit";
  }): Promise<unknown>;
  list(path?: string): Promise<FileInfo[]>;
  downloadTo(localPath: string, remotePath: string): Promise<unknown>;
  uploadFrom(localPath: string, remotePath: string): Promise<unknown>;
  remove(path: string, ignoreErrorCodes?: boolean): Promise<unknown>;
  send(command: string): Promise<unknown>;
  trackProgress(handler?: (info: { bytes: number; bytesOverall: number; name?: string; type?: string }) => void): void;
  close(): void;
}

export interface FtpClientOptions {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  tls?: boolean;
  proxy?: ProxyConfig;
  proxyConnector?: Socks5Connector;
  name?: string;
  backend?: FtpBackend;
}

interface SocketConnectOptions {
  host?: string;
  port?: number;
}

const FTP_TIMEOUT_MS = 30_000;

class FtpSocksSocket extends Duplex {
  private inner: Socket | undefined;
  private keepAlive: { enable?: boolean; initialDelay?: number } | undefined;
  private timeout: { timeout: number; callback?: () => void } | undefined;

  constructor(
    private readonly proxy: ProxyConfig,
    private readonly connector: Socks5Connector,
  ) {
    super();
  }

  get remoteAddress(): string | undefined {
    return this.inner?.remoteAddress;
  }

  get remotePort(): number | undefined {
    return this.inner?.remotePort;
  }

  get remoteFamily(): string | undefined {
    return this.inner?.remoteFamily;
  }

  get localPort(): number | undefined {
    return this.inner?.localPort;
  }

  get bytesRead(): number {
    return this.inner?.bytesRead ?? 0;
  }

  get bytesWritten(): number {
    return this.inner?.bytesWritten ?? 0;
  }

  connect(options: SocketConnectOptions, callback?: () => void): this {
    const targetHost = options.host ?? "localhost";
    const targetPort = options.port ?? 21;

    void this.connector({
      proxy: this.proxy,
      targetHost,
      targetPort,
    }).then((socket) => {
      this.attach(socket);
      this.emit("connect");
      callback?.();
    }, (error: Error) => {
      this.destroy(error);
    });

    return this;
  }

  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    this.keepAlive = { enable, initialDelay };
    this.inner?.setKeepAlive(enable, initialDelay);
    return this;
  }

  setNoDelay(noDelay?: boolean): this {
    this.inner?.setNoDelay(noDelay);
    return this;
  }

  setTimeout(timeout?: number, callback?: () => void): this {
    const timeoutMs = timeout ?? 0;
    this.timeout = { timeout: timeoutMs, callback };
    this.inner?.setTimeout(timeoutMs, callback);
    return this;
  }

  override _read(): void {}

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.inner === undefined) {
      callback(new Error("SOCKS5 FTP socket is not connected"));
      return;
    }
    this.inner.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.inner?.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner?.destroy();
    callback(error);
  }

  private attach(socket: Socket): void {
    this.inner = socket;
    if (this.keepAlive !== undefined) {
      socket.setKeepAlive(this.keepAlive.enable, this.keepAlive.initialDelay);
    }
    if (this.timeout !== undefined) {
      socket.setTimeout(this.timeout.timeout, this.timeout.callback);
    }
    socket.on("data", (chunk) => {
      this.push(chunk);
    });
    socket.once("end", () => {
      this.push(null);
      this.emit("end");
    });
    socket.once("close", (hadError) => {
      this.emit("close", hadError);
    });
    socket.once("error", (error) => {
      this.destroy(error);
    });
    socket.once("timeout", () => {
      this.emit("timeout");
    });
  }
}

export function createFtpSocksSocket(proxy: ProxyConfig, connector: Socks5Connector = connectSocks5): Socket {
  return new FtpSocksSocket(proxy, connector) as unknown as Socket;
}

function createBasicFtpBackend(proxy?: ProxyConfig, proxyConnector?: Socks5Connector): FtpBackend {
  const backend = new BasicFtpClient(FTP_TIMEOUT_MS);
  if (proxy !== undefined) {
    backend.ftp._newSocket = () => createFtpSocksSocket(proxy, proxyConnector);
  }
  return backend;
}

function preferPlainListFallback(backend: FtpBackend): void {
  if (backend.availableListCommands === undefined) {
    return;
  }

  const commands = backend.availableListCommands.filter((command) => command !== "LIST -a");
  if (!commands.includes("LIST")) {
    commands.push("LIST");
  }
  backend.availableListCommands = commands;
}

function formatPath(path: string): string {
  const normalized = normalizeRemotePath(path);
  return normalized === "." ? "/" : normalized;
}

const MONTHS = new Map([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

function monthIndex(value: string): number | undefined {
  return MONTHS.get(value.slice(0, 3).toLowerCase());
}

function normalizedYear(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return undefined;
  }
  if (value.length === 2) {
    return parsed >= 69 ? 1900 + parsed : 2000 + parsed;
  }
  return parsed;
}

function utcDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date | undefined {
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return date;
}

function parseFtpRawModifiedAt(rawModifiedAt: string): Date | undefined {
  const value = rawModifiedAt.trim().replace(/\s+/g, " ");
  if (value === "") {
    return undefined;
  }

  let match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/);
  if (match !== null) {
    return utcDate(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10),
      Number.parseInt(match[4], 10),
      Number.parseInt(match[5], 10),
      Number.parseInt(match[6], 10),
    );
  }

  match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match !== null) {
    return utcDate(
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10) - 1,
      Number.parseInt(match[3], 10),
      Number.parseInt(match[4], 10),
      Number.parseInt(match[5], 10),
      match[6] === undefined ? 0 : Number.parseInt(match[6], 10),
    );
  }

  match = value.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/);
  if (match !== null) {
    const month = monthIndex(match[1]);
    if (month !== undefined) {
      return utcDate(Number.parseInt(match[3], 10), month, Number.parseInt(match[2], 10));
    }
  }

  match = value.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (match !== null) {
    const month = monthIndex(match[1]);
    if (month !== undefined) {
      return utcDate(
        new Date().getUTCFullYear(),
        month,
        Number.parseInt(match[2], 10),
        Number.parseInt(match[3], 10),
        Number.parseInt(match[4], 10),
      );
    }
  }

  match = value.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (match !== null) {
    const month = monthIndex(match[2]);
    if (month !== undefined) {
      return utcDate(Number.parseInt(match[3], 10), month, Number.parseInt(match[1], 10));
    }
  }

  match = value.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/);
  if (match !== null) {
    const month = monthIndex(match[2]);
    if (month !== undefined) {
      return utcDate(
        new Date().getUTCFullYear(),
        month,
        Number.parseInt(match[1], 10),
        Number.parseInt(match[3], 10),
        Number.parseInt(match[4], 10),
      );
    }
  }

  match = value.match(/^(\d{2})-(\d{2})-(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)$/i);
  if (match !== null) {
    const year = normalizedYear(match[3]);
    if (year !== undefined) {
      const hour = Number.parseInt(match[4], 10);
      if (hour < 1 || hour > 12) {
        return undefined;
      }
      const hour24 = (hour % 12) + (match[6].toUpperCase() === "PM" ? 12 : 0);
      return utcDate(
        year,
        Number.parseInt(match[1], 10) - 1,
        Number.parseInt(match[2], 10),
        hour24,
        Number.parseInt(match[5], 10),
      );
    }
  }

  return undefined;
}

function descriptorFromInfo(info: FileInfo): FileDescriptor {
  const type = info.isDirectory ? "directory" : "file";
  return {
    path: info.name,
    name: baseName(info.name),
    type,
    size: info.size,
    modifiedTime: info.modifiedAt ?? parseFtpRawModifiedAt(info.rawModifiedAt),
  };
}

export class FtpClient implements StorageClient {
  private readonly backend: FtpBackend;
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly tls: boolean;
  private readonly displayName: string;
  private readonly proxy: ProxyConfig | undefined;
  private readonly proxyConnector: Socks5Connector | undefined;
  private connected = false;

  constructor(options: FtpClientOptions) {
    this.host = options.host;
    this.port = options.port ?? 21;
    this.username = options.username ?? "anonymous";
    this.password = options.password ?? "anonymous@";
    this.tls = options.tls ?? false;
    this.proxy = options.proxy;
    this.proxyConnector = options.proxyConnector;
    this.displayName = options.name ?? options.host;
    this.backend = options.backend ?? createBasicFtpBackend(this.proxy, this.proxyConnector);
  }

  name(): string {
    return this.displayName;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.backend.access({
      host: this.host,
      port: this.port,
      user: this.username,
      password: this.password,
      secure: this.tls,
    });
    preferPlainListFallback(this.backend);
    this.connected = true;
  }

  private watchAbort(signal: AbortSignal | undefined): () => void {
    signal?.throwIfAborted();
    if (signal === undefined) {
      return () => {};
    }

    const abort = (): void => {
      this.backend.close();
      this.connected = false;
    };
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  async list(path: string): Promise<FileDescriptor[]> {
    try {
      await this.ensureConnected();
      return (await this.backend.list(formatPath(path))).map(descriptorFromInfo);
    } catch (error) {
      throw new ListingError(`Failed to list directory '${path}': ${(error as Error).message}`, { cause: error });
    }
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    const cleanupAbort = this.watchAbort(options.signal);
    try {
      await this.ensureConnected();
      this.backend.trackProgress(({ bytes }) => {
        options.onProgress?.({ bytes });
      });
      await this.backend.downloadTo(localPath, formatPath(remotePath));
      options.signal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) {
        options.signal.throwIfAborted();
      }
      throw new TransferError(`Failed to download '${remotePath}' from FTP host '${this.host}': ${(error as Error).message}`, { cause: error });
    } finally {
      this.backend.trackProgress();
      cleanupAbort();
    }
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    const cleanupAbort = this.watchAbort(options.signal);
    try {
      await this.ensureConnected();
      this.backend.trackProgress(({ bytes }) => {
        options.onProgress?.({ bytes });
      });
      await this.backend.uploadFrom(localPath, formatPath(remotePath));
      options.signal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) {
        options.signal.throwIfAborted();
      }
      throw new TransferError(`Failed to upload '${localPath}' to FTP host '${this.host}': ${(error as Error).message}`, { cause: error });
    } finally {
      this.backend.trackProgress();
      cleanupAbort();
    }
  }

  async deleteFile(path: string): Promise<boolean> {
    await this.ensureConnected();
    try {
      await this.backend.remove(formatPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<boolean> {
    await this.ensureConnected();
    try {
      await this.backend.send(`MKD ${formatPath(path)}`);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.backend.close();
    this.connected = false;
  }
}
