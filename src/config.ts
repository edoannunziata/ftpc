import { TOML } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ConfigError, RemoteNotFoundError, ValidationError } from "./errors.ts";
import { parseStorageUrl } from "./url.ts";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".ftpcconf.toml");

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface BaseRemoteConfig {
  name: string;
  type: string;
  proxy?: ProxyConfig;
}

export interface LocalConfig extends BaseRemoteConfig {
  type: "local";
}

export interface FtpConfig extends BaseRemoteConfig {
  type: "ftp";
  url: string;
  port: number;
  portExplicit: boolean;
  username: string;
  usernameExplicit: boolean;
  password: string;
  passwordExplicit: boolean;
  tls: boolean;
  tlsExplicit: boolean;
}

export interface S3Config extends BaseRemoteConfig {
  type: "s3";
  bucketName?: string;
  url?: string;
  regionName?: string;
  endpointUrl?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

export interface AzureConfig extends BaseRemoteConfig {
  type: "azure";
  url: string;
  filesystem: string;
  connectionString?: string;
  accountKey?: string;
}

export interface SftpConfig extends BaseRemoteConfig {
  type: "sftp";
  url: string;
  port: number;
  portExplicit: boolean;
  username?: string;
  password?: string;
  keyFilename?: string;
  hostKeySha256?: string;
}

export interface BlobConfig extends BaseRemoteConfig {
  type: "blob";
  url: string;
  container: string;
  connectionString?: string;
  accountKey?: string;
}

export type RemoteConfig =
  | LocalConfig
  | FtpConfig
  | S3Config
  | AzureConfig
  | SftpConfig
  | BlobConfig;

export interface Config {
  remotes: Map<string, RemoteConfig>;
  warnings: string[];
}

export interface LoadConfigOptions {
  createDefault?: boolean;
}

export const DEFAULT_CONFIG_TEXT = `# ftpc configuration file
# See https://github.com/edoannunziata/ftpc for documentation

# Local filesystem browser
[local]
type = "local"

# Example FTP configuration:
# [my-ftp-server]
# type = "ftp"
# url = "ftp.example.com"
# port = 21
# username = "user"
# password = "password"
# tls = true

# Example SFTP configuration:
# [my-sftp-server]
# type = "sftp"
# url = "sftp.example.com"
# port = 22
# username = "user"
# password = "password"
# key_filename = "~/.ssh/id_rsa"
# host_key_sha256 = "SHA256:base64-encoded-host-key-fingerprint"

# Example S3 configuration:
# [my-s3-bucket]
# type = "s3"
# bucket_name = "my-bucket"
# region_name = "us-east-1"
# endpoint_url = "https://s3.amazonaws.com"
# aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"
# aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

# Example Azure Data Lake Storage Gen2 configuration:
# [my-azure-datalake]
# type = "azure"
# url = "mystorageaccount.dfs.core.windows.net"
# filesystem = "myfilesystem"
# connection_string = "DefaultEndpointsProtocol=https;AccountName=..."
# account_key = "your-account-key"

# Example Azure Blob Storage configuration:
# [my-azure-blob]
# type = "blob"
# url = "mystorageaccount.blob.core.windows.net"
# container = "mycontainer"
# connection_string = "DefaultEndpointsProtocol=https;AccountName=..."
# account_key = "your-account-key"

# SOCKS5 proxy configuration is implemented for FTP, SFTP, and anonymous S3
# unsigned REST requests. Credentialed S3, Azure Data Lake, and Azure Blob proxy
# configurations fail clearly until native SDK proxy transport is added.
#
# [my-ftp-with-proxy]
# type = "ftp"
# url = "ftp.example.com"
# username = "user"
# password = "password"
# [my-ftp-with-proxy.proxy]
# host = "proxy.example.com"
# port = 1080
# username = "proxyuser"
# password = "proxypass"
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(
  data: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = data[key];
  if (typeof value !== "string" || value === "") {
    throw new ValidationError(`${label} requires '${key}' field`);
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function portNumber(value: unknown, fallback: number, label: string): number {
  const port = value === undefined ? fallback : value;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  ) {
    throw new ValidationError(
      `${label} port must be an integer between 1 and 65535`,
    );
  }
  return port as number;
}

function parseProxy(data: Record<string, unknown>): ProxyConfig | undefined {
  if (!isRecord(data.proxy)) {
    return undefined;
  }
  const host = requiredString(data.proxy, "host", "Proxy configuration");
  return {
    host,
    port: portNumber(data.proxy.port, 1080, "Proxy"),
    username: optionalString(data.proxy.username),
    password: optionalString(data.proxy.password),
  };
}

function parseUrlWithDefaultProtocol(
  url: string,
  protocol: "ftp" | "sftp",
  label: string,
): ReturnType<typeof parseStorageUrl> {
  try {
    return parseStorageUrl(url.includes("://") ? url : `${protocol}://${url}`);
  } catch (error) {
    throw new ValidationError(
      `Invalid ${label} URL '${url}': ${(error as Error).message}`,
    );
  }
}

function parseRemote(
  name: string,
  data: Record<string, unknown>,
): RemoteConfig {
  const remoteType = data.type;
  if (typeof remoteType !== "string") {
    throw new ValidationError(`Remote '${name}' missing required 'type' field`);
  }

  const proxy = parseProxy(data);

  switch (remoteType) {
    case "local":
      return { name, type: "local", proxy };
    case "ftp":
      return {
        name,
        type: "ftp",
        url: requiredString(data, "url", "FTP configuration"),
        port: portNumber(data.port, 21, "FTP"),
        portExplicit: data.port !== undefined,
        username: optionalString(data.username) ?? "anonymous",
        usernameExplicit: data.username !== undefined,
        password: optionalString(data.password) ?? "anonymous@",
        passwordExplicit: data.password !== undefined,
        tls: optionalBoolean(data.tls, false),
        tlsExplicit: data.tls !== undefined,
        proxy,
      };
    case "s3": {
      const url = optionalString(data.url);
      let bucketName = optionalString(data.bucket_name);
      if (url?.startsWith("s3://")) {
        try {
          bucketName = parseStorageUrl(url).host;
        } catch (error) {
          throw new ValidationError(
            `Invalid S3 URL '${url}': ${(error as Error).message}`,
          );
        }
      }
      if (!bucketName && !url) {
        throw new ValidationError(
          "S3 configuration requires either 'url' or 'bucket_name'",
        );
      }
      return {
        name,
        type: "s3",
        bucketName,
        url,
        regionName: optionalString(data.region_name),
        endpointUrl: optionalString(data.endpoint_url),
        awsAccessKeyId: optionalString(data.aws_access_key_id),
        awsSecretAccessKey: optionalString(data.aws_secret_access_key),
        proxy,
      };
    }
    case "azure":
      return {
        name,
        type: "azure",
        url: requiredString(data, "url", "Azure configuration"),
        filesystem: requiredString(data, "filesystem", "Azure configuration"),
        connectionString: optionalString(data.connection_string),
        accountKey: optionalString(data.account_key),
        proxy,
      };
    case "sftp": {
      const url = requiredString(data, "url", "SFTP configuration");
      const parsed = parseUrlWithDefaultProtocol(url, "sftp", "SFTP");
      const password = optionalString(data.password);
      const keyFilename = optionalString(data.key_filename);
      if (!password && !keyFilename && parsed.password === undefined) {
        throw new ValidationError(
          "SFTP configuration requires either 'password' or 'key_filename'",
        );
      }
      return {
        name,
        type: "sftp",
        url,
        port: portNumber(data.port, 22, "SFTP"),
        portExplicit: data.port !== undefined,
        username: optionalString(data.username),
        password,
        keyFilename,
        hostKeySha256: optionalString(data.host_key_sha256),
        proxy,
      };
    }
    case "blob":
      return {
        name,
        type: "blob",
        url: requiredString(data, "url", "Blob configuration"),
        container: requiredString(data, "container", "Blob configuration"),
        connectionString: optionalString(data.connection_string),
        accountKey: optionalString(data.account_key),
        proxy,
      };
    default:
      throw new ValidationError(
        `Unknown remote type '${remoteType}' for remote '${name}'`,
      );
  }
}

export function parseConfigText(text: string): Config {
  let parsed: unknown;
  try {
    parsed = TOML.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Failed to parse TOML configuration: ${(error as Error).message}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new ValidationError("Configuration must be a TOML table");
  }

  const remotes = new Map<string, RemoteConfig>();
  const warnings: string[] = [];

  for (const [name, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      warnings.push(
        `Remote '${name}' configuration must be a dictionary - skipping`,
      );
      continue;
    }
    if (typeof value.type !== "string") {
      warnings.push(
        `Remote '${name}' missing required 'type' field - skipping`,
      );
      continue;
    }
    try {
      remotes.set(name, parseRemote(name, value));
    } catch (error) {
      warnings.push(
        `Invalid configuration for remote '${name}': ${(error as Error).message} - skipping`,
      );
    }
  }

  if (remotes.size === 0) {
    throw new ValidationError("Configuration must contain at least one remote");
  }

  return { remotes, warnings };
}

export async function createDefaultConfig(
  path = DEFAULT_CONFIG_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, DEFAULT_CONFIG_TEXT, "utf8");
}

export async function loadConfig(
  path = DEFAULT_CONFIG_PATH,
  options: LoadConfigOptions = {},
): Promise<Config> {
  if (
    !existsSync(path) &&
    (path === DEFAULT_CONFIG_PATH || options.createDefault === true)
  ) {
    await createDefaultConfig(path);
  }
  const text = await readFile(path, "utf8");
  return parseConfigText(text);
}

export function getRemote(config: Config, name: string): RemoteConfig {
  const remote = config.remotes.get(name);
  if (remote !== undefined) {
    return remote;
  }
  const available = [...config.remotes.keys()].join(", ");
  throw new RemoteNotFoundError(
    `Remote '${name}' not found in configuration. Available remotes: ${available}`,
  );
}

export function listRemotes(config: Config): Record<string, string> {
  return Object.fromEntries(
    [...config.remotes].map(([name, remote]) => [name, remote.type]),
  );
}
