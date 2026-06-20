import { TOML } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ConfigError, RemoteNotFoundError, ValidationError } from "./errors.ts";

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
  username: string;
  password: string;
  tls: boolean;
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
  username?: string;
  password?: string;
  keyFilename?: string;
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

export const DEFAULT_CONFIG_TEXT = `# ftpc configuration file

[local]
type = "local"
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(data: Record<string, unknown>, key: string, label: string): string {
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
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new ValidationError(`${label} port must be an integer between 1 and 65535`);
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

function parseRemote(name: string, data: Record<string, unknown>): RemoteConfig {
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
        username: optionalString(data.username) ?? "anonymous",
        password: optionalString(data.password) ?? "anonymous@",
        tls: optionalBoolean(data.tls, false),
        proxy,
      };
    case "s3": {
      const url = optionalString(data.url);
      const bucketName = url?.startsWith("s3://")
        ? url.slice("s3://".length)
        : optionalString(data.bucket_name);
      if (!bucketName && !url) {
        throw new ValidationError("S3 configuration requires either 'url' or 'bucket_name'");
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
      const password = optionalString(data.password);
      const keyFilename = optionalString(data.key_filename);
      if (!password && !keyFilename) {
        throw new ValidationError("SFTP configuration requires either 'password' or 'key_filename'");
      }
      return {
        name,
        type: "sftp",
        url: requiredString(data, "url", "SFTP configuration"),
        port: portNumber(data.port, 22, "SFTP"),
        username: optionalString(data.username),
        password,
        keyFilename,
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
      throw new ValidationError(`Unknown remote type '${remoteType}' for remote '${name}'`);
  }
}

export function parseConfigText(text: string): Config {
  let parsed: unknown;
  try {
    parsed = TOML.parse(text);
  } catch (error) {
    throw new ConfigError(`Failed to parse TOML configuration: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new ValidationError("Configuration must be a TOML table");
  }

  const remotes = new Map<string, RemoteConfig>();
  const warnings: string[] = [];

  for (const [name, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      warnings.push(`Remote '${name}' configuration must be a dictionary - skipping`);
      continue;
    }
    if (typeof value.type !== "string") {
      warnings.push(`Remote '${name}' missing required 'type' field - skipping`);
      continue;
    }
    try {
      remotes.set(name, parseRemote(name, value));
    } catch (error) {
      warnings.push(`Invalid configuration for remote '${name}': ${(error as Error).message} - skipping`);
    }
  }

  if (remotes.size === 0) {
    throw new ValidationError("Configuration must contain at least one remote");
  }

  return { remotes, warnings };
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<Config> {
  if (!existsSync(path) && path === DEFAULT_CONFIG_PATH) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, DEFAULT_CONFIG_TEXT, "utf8");
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
  throw new RemoteNotFoundError(`Remote '${name}' not found in configuration. Available remotes: ${available}`);
}

export function listRemotes(config: Config): Record<string, string> {
  return Object.fromEntries([...config.remotes].map(([name, remote]) => [name, remote.type]));
}
