import {
  AnonymousCredential,
  BlobServiceClient,
  newPipeline,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { baseName, normalizeRemotePath, stripLeadingSlash } from "../paths.ts";
import type {
  FileDescriptor,
  StorageClient,
  TransferOptions,
} from "../types.ts";
import { ListingError, TransferError } from "../errors.ts";
import type { ProxyConfig } from "../config.ts";
import {
  applyAzureSocksProxy,
  azureProxyOptions,
  hasAzureSocksProxy,
  parseAzureConnectionString,
} from "./azure_proxy.ts";

export interface AzureBlobPrefixItem {
  kind: "prefix";
  name: string;
}

export interface AzureBlobFileItem {
  kind: "blob";
  name: string;
  properties?: {
    contentLength?: number;
    lastModified?: Date;
  };
}

export type AzureBlobListItem = AzureBlobPrefixItem | AzureBlobFileItem;

interface AzureBlobProgressOptions {
  abortSignal?: AbortSignal;
  onProgress?: (progress: { loadedBytes: number }) => void;
}

export interface AzureBlobBackend {
  listBlobsByHierarchy(
    delimiter: string,
    options?: { prefix?: string },
  ): AsyncIterable<AzureBlobListItem>;
  getBlobClient(path: string): {
    downloadToFile(
      localPath: string,
      offset?: number,
      count?: number,
      options?: AzureBlobProgressOptions,
    ): Promise<unknown>;
  };
  getBlockBlobClient(path: string): {
    uploadFile(
      localPath: string,
      options?: AzureBlobProgressOptions,
    ): Promise<unknown>;
  };
  deleteBlob(path: string): Promise<unknown>;
  uploadBlockBlob(
    path: string,
    body: string,
    contentLength: number,
    options?: AzureBlobProgressOptions,
  ): Promise<unknown>;
}

export interface AzureBlobClientOptions {
  accountUrl: string;
  containerName: string;
  connectionString?: string;
  accountKey?: string;
  proxy?: ProxyConfig;
  name?: string;
  backend?: AzureBlobBackend;
}

function normalizeAccountUrl(input: string): string {
  const withScheme = input.includes("://") ? input : `https://${input}`;
  const url = new URL(withScheme);
  if (url.protocol === "blob:") {
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
  if (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.pathname !== ""
  ) {
    const [accountName] = stripLeadingSlash(url.pathname).split("/");
    if (accountName !== undefined && accountName !== "") {
      return accountName;
    }
  }
  const [accountName = url.hostname] = url.hostname.split(".");
  return accountName;
}

function createAzureBlobBackend(
  options: AzureBlobClientOptions,
): AzureBlobBackend {
  if (options.connectionString !== undefined) {
    if (hasAzureSocksProxy(options.proxy)) {
      const connection = parseAzureConnectionString(options.connectionString);
      const pipeline =
        connection.kind === "account"
          ? applyAzureSocksProxy(
              newPipeline(
                new StorageSharedKeyCredential(
                  connection.accountName,
                  connection.accountKey,
                ),
                azureProxyOptions(options.proxy),
              ),
              options.proxy,
            )
          : applyAzureSocksProxy(
              newPipeline(
                new AnonymousCredential(),
                azureProxyOptions(options.proxy),
              ),
              options.proxy,
            );
      const accountUrl =
        connection.kind === "sas"
          ? `${connection.url}?${connection.accountSas}`
          : connection.url;
      return new BlobServiceClient(accountUrl, pipeline).getContainerClient(
        options.containerName,
      ) as AzureBlobBackend;
    }

    return BlobServiceClient.fromConnectionString(
      options.connectionString,
      azureProxyOptions(options.proxy),
    ).getContainerClient(options.containerName) as AzureBlobBackend;
  }

  const accountUrl = normalizeAccountUrl(options.accountUrl);
  const credential =
    options.accountKey === undefined
      ? new DefaultAzureCredential()
      : new StorageSharedKeyCredential(
          accountNameFromUrl(accountUrl),
          options.accountKey,
        );

  if (hasAzureSocksProxy(options.proxy)) {
    return new BlobServiceClient(
      accountUrl,
      applyAzureSocksProxy(
        newPipeline(credential, azureProxyOptions(options.proxy)),
        options.proxy,
      ),
    ).getContainerClient(options.containerName) as AzureBlobBackend;
  }

  return new BlobServiceClient(
    accountUrl,
    credential,
    azureProxyOptions(options.proxy),
  ).getContainerClient(options.containerName) as AzureBlobBackend;
}

function formatBlobPath(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === "/" || normalized === ".") {
    return "";
  }
  return stripLeadingSlash(normalized);
}

function prefixForDirectory(path: string): string {
  const blobPath = formatBlobPath(path);
  return blobPath === "" ? "" : `${blobPath.replace(/\/+$/, "")}/`;
}

function directoryName(prefix: string): string {
  return baseName(prefix.replace(/\/+$/, ""));
}

function transferProgress(options: TransferOptions): AzureBlobProgressOptions {
  return {
    abortSignal: options.signal,
    onProgress: (progress) =>
      options.onProgress?.({ bytes: progress.loadedBytes }),
  };
}

export class AzureBlobClient implements StorageClient {
  private readonly backend: AzureBlobBackend;
  private readonly accountUrl: string;
  private readonly containerName: string;
  private readonly displayName: string;

  constructor(options: AzureBlobClientOptions) {
    this.accountUrl = normalizeAccountUrl(options.accountUrl);
    this.containerName = options.containerName;
    this.displayName = options.name ?? `Blob:${options.containerName}`;
    this.backend = options.backend ?? createAzureBlobBackend(options);
  }

  name(): string {
    return this.displayName;
  }

  async list(path: string): Promise<FileDescriptor[]> {
    const prefix = prefixForDirectory(path);
    const results = new Map<string, FileDescriptor>();

    try {
      for await (const item of this.backend.listBlobsByHierarchy("/", {
        prefix,
      })) {
        if (item.kind === "prefix") {
          const name = directoryName(item.name);
          if (name !== "") {
            results.set(`D:${name}`, {
              path: name,
              name,
              type: "directory",
              size: 0,
            });
          }
          continue;
        }

        if (item.name === prefix) {
          continue;
        }

        const relativeName =
          prefix === "" ? item.name : item.name.slice(prefix.length);
        if (relativeName === "" || relativeName.includes("/")) {
          continue;
        }

        results.set(`F:${relativeName}`, {
          path: relativeName,
          name: baseName(relativeName),
          type: "file",
          size: item.properties?.contentLength,
          modifiedTime: item.properties?.lastModified,
        });
      }
    } catch (error) {
      throw new ListingError(
        `Failed to list directory '${path}' in Azure Blob container '${this.containerName}': ${(error as Error).message}`,
        { cause: error },
      );
    }

    return [...results.values()];
  }

  async download(
    remotePath: string,
    localPath: string,
    options: TransferOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    try {
      await this.backend
        .getBlobClient(formatBlobPath(remotePath))
        .downloadToFile(localPath, 0, undefined, transferProgress(options));
    } catch (error) {
      throw new TransferError(
        `Failed to download '${remotePath}' from Azure Blob container '${this.containerName}': ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  async upload(
    localPath: string,
    remotePath: string,
    options: TransferOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    try {
      await this.backend
        .getBlockBlobClient(formatBlobPath(remotePath))
        .uploadFile(localPath, transferProgress(options));
    } catch (error) {
      throw new TransferError(
        `Failed to upload '${localPath}' to Azure Blob container '${this.containerName}': ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  async deleteFile(path: string): Promise<boolean> {
    try {
      await this.backend.deleteBlob(formatBlobPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<boolean> {
    try {
      const key = prefixForDirectory(path);
      if (key === "") {
        return true;
      }
      await this.backend.uploadBlockBlob(key, "", 0);
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
