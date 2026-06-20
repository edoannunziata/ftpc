import type { Config, RemoteConfig } from "./config.ts";
import { getRemote } from "./config.ts";
import {
  UnsupportedFeatureError,
  UnsupportedProtocolError,
} from "./errors.ts";
import { LocalClient } from "./clients/local.ts";
import type { FileDescriptor, StorageClient, TransferOptions } from "./types.ts";
import { joinRemotePath } from "./paths.ts";
import { parseStorageUrl } from "./url.ts";

export interface StorageConnectOptions {
  config?: Config;
}

export class StorageSession {
  constructor(
    private readonly client: StorageClient,
    private readonly _basePath = "/",
  ) {}

  get name(): string {
    return this.client.name();
  }

  get basePath(): string {
    return this._basePath;
  }

  async list(path?: string): Promise<FileDescriptor[]> {
    return this.client.list(path === undefined ? this._basePath : this.resolve(path));
  }

  async download(remotePath: string, localPath: string, options?: TransferOptions): Promise<void> {
    return this.client.download(this.resolve(remotePath), localPath, options);
  }

  async upload(localPath: string, remotePath: string, options?: TransferOptions): Promise<void> {
    return this.client.upload(localPath, this.resolve(remotePath), options);
  }

  async delete(path: string): Promise<boolean> {
    return this.client.deleteFile(this.resolve(path));
  }

  async mkdir(path: string): Promise<boolean> {
    return this.client.mkdir(this.resolve(path));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  resolve(path: string): string {
    return joinRemotePath(this._basePath, path);
  }
}

function unsupportedRemote(remote: RemoteConfig): never {
  throw new UnsupportedFeatureError(
    `${remote.type} backend is planned for the Bun rewrite but is not implemented yet`,
  );
}

function createFromRemote(remote: RemoteConfig): StorageSession {
  switch (remote.type) {
    case "local":
      return new StorageSession(new LocalClient(), "/");
    case "ftp":
    case "sftp":
    case "s3":
    case "azure":
    case "blob":
      return unsupportedRemote(remote);
  }
}

function createFromUrl(input: string): StorageSession {
  const parsed = parseStorageUrl(input);
  switch (parsed.protocol) {
    case "":
    case "file":
      return new StorageSession(new LocalClient(), parsed.path || "/");
    case "ftp":
    case "ftps":
    case "sftp":
    case "s3":
    case "azure":
    case "blob":
      throw new UnsupportedFeatureError(
        `${parsed.protocol} URL parsing is implemented, but the backend adapter is not implemented yet`,
      );
    default:
      throw new UnsupportedProtocolError(
        `Unsupported protocol: ${parsed.protocol}. Supported protocols: file, ftp, ftps, sftp, s3, azure, blob`,
      );
  }
}

export class Storage {
  static connect(connection: string, options: StorageConnectOptions = {}): StorageSession {
    if (options.config?.remotes.has(connection)) {
      return createFromRemote(getRemote(options.config, connection));
    }
    return createFromUrl(connection);
  }

  static local(path = "/"): StorageSession {
    return new StorageSession(new LocalClient(), path);
  }
}
