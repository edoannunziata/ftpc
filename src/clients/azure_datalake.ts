import {
  DataLakeServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-file-datalake";
import { DefaultAzureCredential } from "@azure/identity";
import { baseName, normalizeRemotePath, stripLeadingSlash } from "../paths.ts";
import type { FileDescriptor, StorageClient, TransferOptions } from "../types.ts";
import { ListingError, TransferError } from "../errors.ts";

export interface AzureDataLakePathItem {
  name?: string;
  isDirectory?: boolean;
  lastModified?: Date;
  contentLength?: number;
}

interface AzureDataLakeProgressOptions {
  abortSignal?: AbortSignal;
  onProgress?: (progress: { loadedBytes: number }) => void;
}

export interface AzureDataLakeBackend {
  listPaths(options?: { path?: string; recursive?: boolean }): AsyncIterable<AzureDataLakePathItem>;
  getFileClient(path: string): {
    readToFile(localPath: string, offset?: number, count?: number, options?: AzureDataLakeProgressOptions): Promise<unknown>;
    uploadFile(localPath: string, options?: AzureDataLakeProgressOptions): Promise<unknown>;
    delete(): Promise<unknown>;
  };
  getDirectoryClient(path: string): {
    create(): Promise<unknown>;
  };
}

export interface AzureDataLakeClientOptions {
  accountUrl: string;
  filesystemName: string;
  connectionString?: string;
  accountKey?: string;
  name?: string;
  backend?: AzureDataLakeBackend;
}

function normalizeAccountUrl(input: string): string {
  const withScheme = input.includes("://") ? input : `https://${input}`;
  const url = new URL(withScheme);
  if (url.protocol === "azure:") {
    url.protocol = "https:";
  }
  url.hash = "";
  if (url.pathname === "/") {
    url.pathname = "";
  }
  return url.toString().replace(/\/$/, "");
}

function accountNameFromUrl(accountUrl: string): string {
  const url = new URL(accountUrl);
  if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.pathname !== "") {
    const [accountName] = stripLeadingSlash(url.pathname).split("/");
    if (accountName !== "") {
      return accountName;
    }
  }
  return url.hostname.split(".")[0] ?? url.hostname;
}

function createAzureDataLakeBackend(options: AzureDataLakeClientOptions): AzureDataLakeBackend {
  if (options.connectionString !== undefined) {
    return DataLakeServiceClient
      .fromConnectionString(options.connectionString)
      .getFileSystemClient(options.filesystemName) as AzureDataLakeBackend;
  }

  const accountUrl = normalizeAccountUrl(options.accountUrl);
  const credential = options.accountKey === undefined
    ? new DefaultAzureCredential()
    : new StorageSharedKeyCredential(accountNameFromUrl(accountUrl), options.accountKey);

  return new DataLakeServiceClient(accountUrl, credential)
    .getFileSystemClient(options.filesystemName) as AzureDataLakeBackend;
}

function formatDataLakePath(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === "/" || normalized === ".") {
    return "";
  }
  return stripLeadingSlash(normalized);
}

function relativePath(listedPath: string, listedDirectory: string): string {
  if (listedDirectory === "") {
    return listedPath;
  }
  if (listedPath === listedDirectory) {
    return "";
  }
  if (!listedPath.startsWith(`${listedDirectory}/`)) {
    return "";
  }
  return stripLeadingSlash(listedPath.slice(listedDirectory.length));
}

function transferProgress(options: TransferOptions): AzureDataLakeProgressOptions {
  return {
    abortSignal: options.signal,
    onProgress: (progress) => options.onProgress?.({ bytes: progress.loadedBytes }),
  };
}

export class AzureDataLakeClient implements StorageClient {
  private readonly backend: AzureDataLakeBackend;
  private readonly accountUrl: string;
  private readonly filesystemName: string;
  private readonly displayName: string;

  constructor(options: AzureDataLakeClientOptions) {
    this.accountUrl = normalizeAccountUrl(options.accountUrl);
    this.filesystemName = options.filesystemName;
    this.displayName = options.name ?? `Azure:${options.filesystemName}`;
    this.backend = options.backend ?? createAzureDataLakeBackend(options);
  }

  name(): string {
    return this.displayName;
  }

  async list(path: string): Promise<FileDescriptor[]> {
    const directory = formatDataLakePath(path);
    const results: FileDescriptor[] = [];

    try {
      for await (const item of this.backend.listPaths({ path: directory, recursive: false })) {
        if (item.name === undefined) {
          continue;
        }

        const itemPath = relativePath(item.name, directory);
        if (itemPath === "" || itemPath.includes("/")) {
          continue;
        }

        const isDirectory = item.isDirectory === true;
        results.push({
          path: itemPath,
          name: baseName(itemPath),
          type: isDirectory ? "directory" : "file",
          size: isDirectory ? 0 : item.contentLength,
          modifiedTime: item.lastModified,
        });
      }
    } catch (error) {
      throw new ListingError(`Failed to list directory '${path}' in Azure Data Lake filesystem '${this.filesystemName}': ${(error as Error).message}`, { cause: error });
    }

    return results;
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    try {
      await this.backend.getFileClient(formatDataLakePath(remotePath)).readToFile(localPath, 0, undefined, transferProgress(options));
    } catch (error) {
      throw new TransferError(`Failed to download '${remotePath}' from Azure Data Lake filesystem '${this.filesystemName}': ${(error as Error).message}`, { cause: error });
    }
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    try {
      await this.backend.getFileClient(formatDataLakePath(remotePath)).uploadFile(localPath, transferProgress(options));
    } catch (error) {
      throw new TransferError(`Failed to upload '${localPath}' to Azure Data Lake filesystem '${this.filesystemName}': ${(error as Error).message}`, { cause: error });
    }
  }

  async deleteFile(path: string): Promise<boolean> {
    try {
      await this.backend.getFileClient(formatDataLakePath(path)).delete();
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<boolean> {
    try {
      const key = formatDataLakePath(path);
      if (key === "") {
        return true;
      }
      await this.backend.getDirectoryClient(key).create();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}

  url(): string {
    return this.accountUrl;
  }
}
