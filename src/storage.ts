import type { Config, ProxyConfig, RemoteConfig } from "./config.ts";
import { getRemote } from "./config.ts";
import { UnsupportedFeatureError, UnsupportedProtocolError } from "./errors.ts";
import { LocalClient } from "./clients/local.ts";
import { S3Client, type S3Backend } from "./clients/s3.ts";
import { FtpClient, type FtpBackend } from "./clients/ftp.ts";
import { SftpClient, type SftpBackend } from "./clients/sftp.ts";
import { AzureBlobClient, type AzureBlobBackend } from "./clients/azure_blob.ts";
import { AzureDataLakeClient, type AzureDataLakeBackend } from "./clients/azure_datalake.ts";
import type { FileDescriptor, StorageClient, TransferOptions } from "./types.ts";
import { joinRemotePath, stripLeadingSlash } from "./paths.ts";
import { parseStorageUrl, type ParsedStorageUrl } from "./url.ts";
import { ensureProxyUnsupported, throwProxyUnsupported } from "./proxy.ts";
import type { Socks5Connector } from "./socks5.ts";

export interface StorageConnectOptions {
  config?: Config;
  s3Backend?: S3Backend;
  s3ProxyConnector?: Socks5Connector;
  ftpBackend?: FtpBackend;
  ftpProxyConnector?: Socks5Connector;
  sftpBackend?: SftpBackend;
  sftpProxyConnector?: Socks5Connector;
  azureBlobBackend?: AzureBlobBackend;
  azureDataLakeBackend?: AzureDataLakeBackend;
}

interface NamedStorageOptions {
  name?: string;
  basePath?: string;
  proxy?: ProxyConfig;
}

export interface FtpStorageOptions extends NamedStorageOptions {
  port?: number;
  username?: string;
  password?: string;
  tls?: boolean;
  proxyConnector?: Socks5Connector;
  backend?: FtpBackend;
}

export interface SftpStorageOptions extends NamedStorageOptions {
  port?: number;
  username?: string;
  password?: string;
  keyFilename?: string;
  proxyConnector?: Socks5Connector;
  backend?: SftpBackend;
}

export interface S3StorageOptions extends NamedStorageOptions {
  regionName?: string;
  endpointUrl?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  proxyConnector?: Socks5Connector;
  backend?: S3Backend;
}

export interface AzureStorageOptions extends NamedStorageOptions {
  connectionString?: string;
  accountKey?: string;
  backend?: AzureDataLakeBackend;
}

export interface AzureBlobStorageOptions extends NamedStorageOptions {
  connectionString?: string;
  accountKey?: string;
  backend?: AzureBlobBackend;
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

function s3BasePathFromUrl(parsed: ParsedStorageUrl): string {
  return parsed.path === "" ? "/" : parsed.path;
}

function accountUrlFromParsed(parsed: ParsedStorageUrl): string {
  return `https://${parsed.host}${parsed.port === undefined ? "" : `:${parsed.port}`}`;
}

function resourceAndBasePathFromUrl(parsed: ParsedStorageUrl, protocol: string): { resourceName: string; basePath: string } {
  const parts = stripLeadingSlash(parsed.path).split("/").filter((part) => part !== "");
  const resourceName = parts.shift();
  if (resourceName === undefined) {
    throw new UnsupportedFeatureError(`${protocol} URL requires a ${protocol === "azure" ? "filesystem" : "container"} name in the path`);
  }

  return {
    resourceName,
    basePath: parts.length === 0 ? "/" : `/${parts.join("/")}`,
  };
}

function configuredBasePathFromAccountUrl(url: string, resourceName: string): string {
  const parsed = parseStorageUrl(url.includes("://") ? url : `https://${url}`);
  const parts = stripLeadingSlash(parsed.path).split("/").filter((part) => part !== "");
  if (parts[0] === resourceName) {
    parts.shift();
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function configuredAccountUrl(url: string, storageProtocol: "azure" | "blob", resourceName: string): string {
  const parsed = parseStorageUrl(url.includes("://") ? url : `https://${url}`);
  if (parsed.protocol === storageProtocol) {
    return accountUrlFromParsed(parsed);
  }

  const original = new URL(url.includes("://") ? url : `https://${url}`);
  const parts = stripLeadingSlash(original.pathname).split("/").filter((part) => part !== "");
  if (parts[0] === resourceName) {
    original.pathname = "";
  }
  original.hash = "";
  return original.toString().replace(/\/$/, "");
}

function createS3SessionFromRemote(
  remote: Extract<RemoteConfig, { type: "s3" }>,
  backend?: S3Backend,
  proxyConnector?: Socks5Connector,
): StorageSession {
  if (remote.url?.startsWith("s3://")) {
    const parsed = parseStorageUrl(remote.url);
    return new StorageSession(new S3Client({
      bucketName: parsed.host,
      name: remote.name,
      regionName: remote.regionName,
      endpointUrl: remote.endpointUrl,
      awsAccessKeyId: remote.awsAccessKeyId,
      awsSecretAccessKey: remote.awsSecretAccessKey,
      proxy: remote.proxy,
      proxyConnector,
      backend,
    }), s3BasePathFromUrl(parsed));
  }

  if (remote.bucketName === undefined) {
    throw new UnsupportedFeatureError(`S3 remote '${remote.name}' is missing a bucket name`);
  }

  return new StorageSession(new S3Client({
    bucketName: remote.bucketName,
    name: remote.name,
    regionName: remote.regionName,
    endpointUrl: remote.endpointUrl,
    awsAccessKeyId: remote.awsAccessKeyId,
    awsSecretAccessKey: remote.awsSecretAccessKey,
    proxy: remote.proxy,
    proxyConnector,
    backend,
  }), "/");
}

function createFtpSessionFromRemote(
  remote: Extract<RemoteConfig, { type: "ftp" }>,
  backend?: FtpBackend,
  proxyConnector?: Socks5Connector,
): StorageSession {
  const parsed = parseStorageUrl(remote.url.includes("://") ? remote.url : `ftp://${remote.url}`);
  return new StorageSession(new FtpClient({
    host: parsed.host || remote.url,
    port: remote.portExplicit ? remote.port : parsed.port ?? remote.port,
    username: remote.usernameExplicit ? remote.username : parsed.username ?? remote.username,
    password: remote.passwordExplicit ? remote.password : parsed.password ?? remote.password,
    tls: remote.tlsExplicit ? remote.tls : parsed.protocol === "ftps" || remote.tls,
    proxy: remote.proxy,
    proxyConnector,
    name: remote.name,
    backend,
  }), parsed.path === "" ? "/" : parsed.path);
}

function createSftpSessionFromRemote(
  remote: Extract<RemoteConfig, { type: "sftp" }>,
  backend?: SftpBackend,
  proxyConnector?: Socks5Connector,
): StorageSession {
  const parsed = parseStorageUrl(remote.url.includes("://") ? remote.url : `sftp://${remote.url}`);
  return new StorageSession(new SftpClient({
    host: parsed.host || remote.url,
    port: remote.portExplicit ? remote.port : parsed.port ?? remote.port,
    username: remote.username ?? parsed.username,
    password: remote.password ?? parsed.password,
    keyFilename: remote.keyFilename,
    proxy: remote.proxy,
    proxyConnector,
    name: remote.name,
    backend,
  }), parsed.path === "" ? "/" : parsed.path);
}

function createAzureDataLakeSessionFromRemote(remote: Extract<RemoteConfig, { type: "azure" }>, backend?: AzureDataLakeBackend): StorageSession {
  ensureProxyUnsupported(remote);
  return new StorageSession(new AzureDataLakeClient({
    accountUrl: configuredAccountUrl(remote.url, "azure", remote.filesystem),
    filesystemName: remote.filesystem,
    connectionString: remote.connectionString,
    accountKey: remote.accountKey,
    name: remote.name,
    backend,
  }), configuredBasePathFromAccountUrl(remote.url, remote.filesystem));
}

function createAzureBlobSessionFromRemote(remote: Extract<RemoteConfig, { type: "blob" }>, backend?: AzureBlobBackend): StorageSession {
  ensureProxyUnsupported(remote);
  return new StorageSession(new AzureBlobClient({
    accountUrl: configuredAccountUrl(remote.url, "blob", remote.container),
    containerName: remote.container,
    connectionString: remote.connectionString,
    accountKey: remote.accountKey,
    name: remote.name,
    backend,
  }), configuredBasePathFromAccountUrl(remote.url, remote.container));
}

function ensureNamedProxyUnsupported(type: string, name: string, proxy?: ProxyConfig): void {
  if (proxy !== undefined) {
    throwProxyUnsupported(type, name, proxy);
  }
}

function createFromRemote(remote: RemoteConfig, options: StorageConnectOptions): StorageSession {
  switch (remote.type) {
    case "local":
      return new StorageSession(new LocalClient(), "/");
    case "ftp":
      return createFtpSessionFromRemote(remote, options.ftpBackend, options.ftpProxyConnector);
    case "s3":
      return createS3SessionFromRemote(remote, options.s3Backend, options.s3ProxyConnector);
    case "sftp":
      return createSftpSessionFromRemote(remote, options.sftpBackend, options.sftpProxyConnector);
    case "azure":
      return createAzureDataLakeSessionFromRemote(remote, options.azureDataLakeBackend);
    case "blob":
      return createAzureBlobSessionFromRemote(remote, options.azureBlobBackend);
  }
}

function createFromUrl(input: string, options: StorageConnectOptions): StorageSession {
  const parsed = parseStorageUrl(input);
  switch (parsed.protocol) {
    case "":
    case "file":
      return new StorageSession(new LocalClient(), parsed.path || "/");
    case "s3":
      return new StorageSession(new S3Client({
        bucketName: parsed.host,
        backend: options.s3Backend,
      }), s3BasePathFromUrl(parsed));
    case "ftp":
    case "ftps":
      return new StorageSession(new FtpClient({
        host: parsed.host,
        port: parsed.port ?? 21,
        username: parsed.username ?? "anonymous",
        password: parsed.password ?? "anonymous@",
        tls: parsed.protocol === "ftps",
        backend: options.ftpBackend,
      }), parsed.path === "" ? "/" : parsed.path);
    case "sftp":
      return new StorageSession(new SftpClient({
        host: parsed.host,
        port: parsed.port ?? 22,
        username: parsed.username,
        password: parsed.password,
        backend: options.sftpBackend,
      }), parsed.path === "" ? "/" : parsed.path);
    case "azure": {
      const { resourceName, basePath } = resourceAndBasePathFromUrl(parsed, "azure");
      return new StorageSession(new AzureDataLakeClient({
        accountUrl: accountUrlFromParsed(parsed),
        filesystemName: resourceName,
        backend: options.azureDataLakeBackend,
      }), basePath);
    }
    case "blob": {
      const { resourceName, basePath } = resourceAndBasePathFromUrl(parsed, "blob");
      return new StorageSession(new AzureBlobClient({
        accountUrl: accountUrlFromParsed(parsed),
        containerName: resourceName,
        backend: options.azureBlobBackend,
      }), basePath);
    }
    default:
      throw new UnsupportedProtocolError(
        `Unsupported protocol: ${parsed.protocol}. Supported protocols: file, ftp, ftps, sftp, s3, azure, blob`,
      );
  }
}

function looksLikeStorageUrlOrPath(connection: string): boolean {
  return connection.startsWith("/")
    || connection === "."
    || connection === ".."
    || connection.startsWith("./")
    || connection.startsWith("../")
    || connection.includes("/")
    || connection.includes("://");
}

export class Storage {
  static connect(connection: string, options: StorageConnectOptions = {}): StorageSession {
    if (options.config?.remotes.has(connection)) {
      return createFromRemote(getRemote(options.config, connection), options);
    }
    if (options.config !== undefined && !looksLikeStorageUrlOrPath(connection)) {
      getRemote(options.config, connection);
    }
    return createFromUrl(connection, options);
  }

  static local(path = "/"): StorageSession {
    return new StorageSession(new LocalClient(), path);
  }

  static ftp(host: string, options: FtpStorageOptions = {}): StorageSession {
    const name = options.name ?? host;
    return new StorageSession(new FtpClient({
      host,
      port: options.port,
      username: options.username,
      password: options.password,
      tls: options.tls,
      proxy: options.proxy,
      proxyConnector: options.proxyConnector,
      name,
      backend: options.backend,
    }), options.basePath ?? "/");
  }

  static sftp(host: string, options: SftpStorageOptions = {}): StorageSession {
    const name = options.name ?? `SFTP:${host}`;
    return new StorageSession(new SftpClient({
      host,
      port: options.port,
      username: options.username,
      password: options.password,
      keyFilename: options.keyFilename,
      proxy: options.proxy,
      proxyConnector: options.proxyConnector,
      name,
      backend: options.backend,
    }), options.basePath ?? "/");
  }

  static s3(bucketName: string, options: S3StorageOptions = {}): StorageSession {
    const name = options.name ?? `S3:${bucketName}`;
    return new StorageSession(new S3Client({
      bucketName,
      name,
      regionName: options.regionName,
      endpointUrl: options.endpointUrl,
      awsAccessKeyId: options.awsAccessKeyId,
      awsSecretAccessKey: options.awsSecretAccessKey,
      proxy: options.proxy,
      proxyConnector: options.proxyConnector,
      backend: options.backend,
    }), options.basePath ?? "/");
  }

  static azure(accountUrl: string, filesystemName: string, options: AzureStorageOptions = {}): StorageSession {
    const name = options.name ?? `Azure:${filesystemName}`;
    ensureNamedProxyUnsupported("azure", name, options.proxy);
    return new StorageSession(new AzureDataLakeClient({
      accountUrl,
      filesystemName,
      connectionString: options.connectionString,
      accountKey: options.accountKey,
      name,
      backend: options.backend,
    }), options.basePath ?? "/");
  }

  static azureBlob(accountUrl: string, containerName: string, options: AzureBlobStorageOptions = {}): StorageSession {
    const name = options.name ?? `Blob:${containerName}`;
    ensureNamedProxyUnsupported("blob", name, options.proxy);
    return new StorageSession(new AzureBlobClient({
      accountUrl,
      containerName,
      connectionString: options.connectionString,
      accountKey: options.accountKey,
      name,
      backend: options.backend,
    }), options.basePath ?? "/");
  }

  static blob(accountUrl: string, containerName: string, options: AzureBlobStorageOptions = {}): StorageSession {
    return Storage.azureBlob(accountUrl, containerName, options);
  }
}
