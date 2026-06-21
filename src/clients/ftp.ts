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
  const backend = new BasicFtpClient(5000);
  if (proxy !== undefined) {
    backend.ftp._newSocket = () => createFtpSocksSocket(proxy, proxyConnector);
  }
  return backend;
}

function formatPath(path: string): string {
  const normalized = normalizeRemotePath(path);
  return normalized === "." ? "/" : normalized;
}

function descriptorFromInfo(info: FileInfo): FileDescriptor {
  const type = info.isDirectory ? "directory" : "file";
  return {
    path: info.name,
    name: baseName(info.name),
    type,
    size: info.size,
    modifiedTime: info.modifiedAt,
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
