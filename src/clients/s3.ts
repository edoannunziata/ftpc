import { writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { baseName, normalizeRemotePath, stripLeadingSlash } from "../paths.ts";
import type { FileDescriptor, StorageClient, TransferOptions } from "../types.ts";
import { ListingError, TransferError } from "../errors.ts";
import type { ProxyConfig } from "../config.ts";
import { throwProxyUnsupported } from "../proxy.ts";
import { connectSocks5, type Socks5Connector } from "../socks5.ts";

type S3WriteData = Parameters<Bun.S3Client["write"]>[1];
type S3Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface S3ObjectSummary {
  key: string;
  size?: number;
  lastModified?: string | Date;
}

export interface S3ListResponse {
  commonPrefixes?: { prefix: string }[];
  contents?: S3ObjectSummary[];
  isTruncated?: boolean;
  nextContinuationToken?: string;
}

export interface S3Backend {
  list(input?: { prefix?: string; delimiter?: string; continuationToken?: string } | null): Promise<S3ListResponse>;
  file(path: string): { arrayBuffer(): Promise<ArrayBuffer> };
  write(path: string, data: S3WriteData): Promise<number>;
  delete(path: string): Promise<void>;
}

export interface S3ClientOptions {
  bucketName: string;
  name?: string;
  regionName?: string;
  endpointUrl?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  proxy?: ProxyConfig;
  proxyConnector?: Socks5Connector;
  fetch?: S3Fetch;
  backend?: S3Backend;
}

function createBunS3Backend(options: S3ClientOptions): S3Backend {
  return new Bun.S3Client({
    bucket: options.bucketName,
    region: options.regionName,
    endpoint: options.endpointUrl,
    accessKeyId: options.awsAccessKeyId,
    secretAccessKey: options.awsSecretAccessKey,
  });
}

function hasExplicitCredentials(options: S3ClientOptions): boolean {
  return options.awsAccessKeyId !== undefined || options.awsSecretAccessKey !== undefined;
}

function createDefaultS3Backend(options: S3ClientOptions): S3Backend {
  if (!hasExplicitCredentials(options)) {
    return createUnsignedS3Backend(options);
  }

  if (options.proxy !== undefined) {
    throwProxyUnsupported("s3", options.name ?? `S3:${options.bucketName}`, options.proxy);
  }

  return createBunS3Backend(options);
}

function decodeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function firstXmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match === null ? undefined : decodeXml(match[1]);
}

function xmlSections(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
    .map((match) => match[1]);
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function unsignedS3BaseUrl(options: S3ClientOptions): string {
  if (options.endpointUrl !== undefined) {
    return `${trimTrailingSlash(options.endpointUrl)}/${encodeURIComponent(options.bucketName)}`;
  }

  const regionPart = options.regionName === undefined ? "" : `.${options.regionName}`;
  return `https://${options.bucketName}.s3${regionPart}.amazonaws.com`;
}

function objectUrl(baseUrl: string, key: string): string {
  const encodedKey = encodeKey(key);
  return encodedKey === "" ? `${baseUrl}/` : `${baseUrl}/${encodedKey}`;
}

function parseListResponse(xml: string): S3ListResponse {
  return {
    commonPrefixes: xmlSections(xml, "CommonPrefixes")
      .map((section) => firstXmlValue(section, "Prefix"))
      .filter((prefix): prefix is string => prefix !== undefined)
      .map((prefix) => ({ prefix })),
    contents: xmlSections(xml, "Contents")
      .map((section) => {
        const key = firstXmlValue(section, "Key");
        if (key === undefined) {
          return undefined;
        }
        const size = firstXmlValue(section, "Size");
        const lastModified = firstXmlValue(section, "LastModified");
        const object: S3ObjectSummary = { key };
        if (size !== undefined) {
          object.size = Number(size);
        }
        if (lastModified !== undefined) {
          object.lastModified = lastModified;
        }
        return object;
      })
      .filter((object): object is S3ObjectSummary => object !== undefined),
    isTruncated: firstXmlValue(xml, "IsTruncated") === "true",
    nextContinuationToken: firstXmlValue(xml, "NextContinuationToken"),
  };
}

async function responseError(response: Response): Promise<Error> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const detail = body === "" ? response.statusText : body;
  return new Error(`HTTP ${response.status}: ${detail}`);
}

function targetPort(url: URL): number {
  if (url.port !== "") {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function hostHeader(url: URL): string {
  const port = url.port;
  if (port === "" || (url.protocol === "https:" && port === "443") || (url.protocol === "http:" && port === "80")) {
    return url.hostname;
  }
  return `${url.hostname}:${port}`;
}

function waitForSecureConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("secureConnect", onSecureConnect);
      socket.off("error", onError);
    };
    const onSecureConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    socket.once("secureConnect", onSecureConnect);
    socket.once("error", onError);
  });
}

async function openSocksHttpSocket(url: URL, proxy: ProxyConfig, connector: Socks5Connector): Promise<Socket> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported S3 proxy URL protocol '${url.protocol}'`);
  }

  const socket = await connector({
    proxy,
    targetHost: url.hostname,
    targetPort: targetPort(url),
  });

  if (url.protocol === "http:") {
    return socket;
  }

  const tlsSocket = connectTls({
    socket,
    servername: url.hostname,
  });
  await waitForSecureConnect(tlsSocket);
  return tlsSocket;
}

async function bodyToBytes(body: RequestInit["body"] | ArrayBuffer | undefined): Promise<Uint8Array> {
  if (body === undefined || body === null) {
    return new Uint8Array();
  }

  const buffer = await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer();
  return new Uint8Array(buffer);
}

async function fetchBodyBytes(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
  if (init?.body !== undefined) {
    return bodyToBytes(init.body);
  }
  if (input instanceof Request && input.body !== null) {
    return bodyToBytes(await input.arrayBuffer());
  }
  return new Uint8Array();
}

function mergedHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  const initHeaders = new Headers(init?.headers);
  initHeaders.forEach((value, key) => {
    headers.set(key, value);
  });
  return headers;
}

async function readSocket(socket: Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      throw new Error("Invalid chunked HTTP response from S3");
    }

    const sizeText = body.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) {
      throw new Error("Invalid chunk size in HTTP response from S3");
    }
    offset = lineEnd + 2;

    if (size === 0) {
      return Buffer.concat(chunks);
    }
    if (offset + size > body.length) {
      throw new Error("Truncated chunked HTTP response from S3");
    }

    chunks.push(body.subarray(offset, offset + size));
    offset += size;
    if (body.subarray(offset, offset + 2).toString("ascii") !== "\r\n") {
      throw new Error("Invalid chunk terminator in HTTP response from S3");
    }
    offset += 2;
  }

  throw new Error("Missing final chunk in HTTP response from S3");
}

function parseHttpResponse(buffer: Buffer): Response {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error("Invalid HTTP response from S3 proxy connection");
  }

  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const statusMatch = lines[0].match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/);
  if (statusMatch === null) {
    throw new Error("Invalid HTTP status line from S3 proxy connection");
  }

  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    headers.append(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }

  let body = buffer.subarray(headerEnd + 4);
  if (headers.get("transfer-encoding")?.toLowerCase().split(",").map((value) => value.trim()).includes("chunked") === true) {
    body = decodeChunkedBody(body);
  } else {
    const contentLength = headers.get("content-length");
    if (contentLength !== null) {
      body = body.subarray(0, Number(contentLength));
    }
  }

  return new Response(body, {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers,
  });
}

async function socksFetchOnce(
  input: string | URL | Request,
  init: RequestInit | undefined,
  proxy: ProxyConfig,
  connector: Socks5Connector,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const headers = mergedHeaders(input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const hasRequestBody = init?.body !== undefined || (input instanceof Request && input.body !== null);
  const body = await fetchBodyBytes(input, init);

  if (!headers.has("host")) {
    headers.set("Host", hostHeader(url));
  }
  if (!headers.has("connection")) {
    headers.set("Connection", "close");
  }
  if (hasRequestBody && !headers.has("content-length")) {
    headers.set("Content-Length", String(body.byteLength));
  }

  const path = `${url.pathname === "" ? "/" : url.pathname}${url.search}`;
  const headerLines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => {
    headerLines.push(`${key}: ${value}`);
  });

  const socket = await openSocksHttpSocket(url, proxy, connector);
  try {
    const response = readSocket(socket);
    socket.end(Buffer.concat([
      Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n`, "utf8"),
      Buffer.from(body),
    ]));
    return parseHttpResponse(await response);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function shouldFollowRedirect(response: Response, init?: RequestInit): boolean {
  if (init?.redirect === "manual" || init?.redirect === "error") {
    return false;
  }
  return response.status === 301 || response.status === 302 || response.status === 303
    || response.status === 307 || response.status === 308;
}

function createSocksFetch(proxy: ProxyConfig, connector: Socks5Connector = connectSocks5): S3Fetch {
  return async (input, init) => {
    let currentInput = input;
    let currentInit = init;

    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await socksFetchOnce(currentInput, currentInit, proxy, connector);
      const location = response.headers.get("location");
      if (!shouldFollowRedirect(response, currentInit) || location === null) {
        return response;
      }
      if (redirects === 5) {
        throw new Error("Too many redirects while fetching S3 object through SOCKS5 proxy");
      }

      const previousUrl = new URL(currentInput instanceof Request ? currentInput.url : currentInput.toString());
      currentInput = new URL(location, previousUrl);
      if (response.status === 303) {
        currentInit = { ...currentInit, method: "GET", body: undefined };
      }
    }

    throw new Error("Too many redirects while fetching S3 object through SOCKS5 proxy");
  };
}

export function createUnsignedS3Backend(options: S3ClientOptions): S3Backend {
  const baseUrl = unsignedS3BaseUrl(options);
  const fetcher = options.fetch ?? (options.proxy === undefined
    ? fetch
    : createSocksFetch(options.proxy, options.proxyConnector));

  return {
    async list(input = {}): Promise<S3ListResponse> {
      const url = new URL(baseUrl);
      url.searchParams.set("list-type", "2");
      if (input?.prefix !== undefined && input.prefix !== "") {
        url.searchParams.set("prefix", input.prefix);
      }
      if (input?.delimiter !== undefined) {
        url.searchParams.set("delimiter", input.delimiter);
      }
      if (input?.continuationToken !== undefined) {
        url.searchParams.set("continuation-token", input.continuationToken);
      }

      const response = await fetcher(url);
      if (!response.ok) {
        throw await responseError(response);
      }
      return parseListResponse(await response.text());
    },
    file(path) {
      return {
        async arrayBuffer(): Promise<ArrayBuffer> {
          const response = await fetcher(objectUrl(baseUrl, path));
          if (!response.ok) {
            throw await responseError(response);
          }
          return response.arrayBuffer();
        },
      };
    },
    async write(path, data): Promise<number> {
      const response = await fetcher(objectUrl(baseUrl, path), {
        method: "PUT",
        body: data as RequestInit["body"],
      });
      if (!response.ok) {
        throw await responseError(response);
      }
      if (typeof data === "string") {
        return new TextEncoder().encode(data).byteLength;
      }
      if (data instanceof Blob) {
        return data.size;
      }
      if (data instanceof ArrayBuffer) {
        return data.byteLength;
      }
      if (ArrayBuffer.isView(data)) {
        return data.byteLength;
      }
      return 0;
    },
    async delete(path): Promise<void> {
      const response = await fetcher(objectUrl(baseUrl, path), { method: "DELETE" });
      if (!response.ok) {
        throw await responseError(response);
      }
    },
  };
}

function formatKey(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === "/" || normalized === ".") {
    return "";
  }
  return stripLeadingSlash(normalized);
}

function prefixForDirectory(path: string): string {
  const key = formatKey(path);
  return key === "" ? "" : `${key.replace(/\/+$/, "")}/`;
}

function directoryName(prefix: string): string {
  return baseName(prefix.replace(/\/+$/, ""));
}

function modifiedDate(value: string | Date | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value : new Date(value);
}

async function readAllObjects(backend: S3Backend, prefix: string): Promise<S3ListResponse[]> {
  const responses: S3ListResponse[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await backend.list({
      prefix,
      delimiter: "/",
      continuationToken,
    });
    responses.push(response);
    continuationToken = response.isTruncated === true ? response.nextContinuationToken : undefined;
  } while (continuationToken !== undefined);

  return responses;
}

export class S3Client implements StorageClient {
  private readonly backend: S3Backend;
  private readonly bucketName: string;
  private readonly displayName: string;

  constructor(options: S3ClientOptions) {
    this.bucketName = options.bucketName;
    this.displayName = options.name ?? `S3:${options.bucketName}`;
    this.backend = options.backend ?? createDefaultS3Backend(options);
  }

  name(): string {
    return this.displayName;
  }

  async list(path: string): Promise<FileDescriptor[]> {
    const prefix = prefixForDirectory(path);
    const results = new Map<string, FileDescriptor>();

    try {
      for (const response of await readAllObjects(this.backend, prefix)) {
        for (const commonPrefix of response.commonPrefixes ?? []) {
          const name = directoryName(commonPrefix.prefix);
          if (name !== "") {
            results.set(`D:${name}`, {
              path: name,
              name,
              type: "directory",
              size: 0,
            });
          }
        }

        for (const object of response.contents ?? []) {
          if (object.key === prefix) {
            continue;
          }

          const relativeKey = prefix === "" ? object.key : object.key.slice(prefix.length);
          if (relativeKey === "" || relativeKey.includes("/")) {
            continue;
          }

          results.set(`F:${relativeKey}`, {
            path: relativeKey,
            name: baseName(relativeKey),
            type: "file",
            size: object.size,
            modifiedTime: modifiedDate(object.lastModified),
          });
        }
      }
    } catch (error) {
      throw new ListingError(`Failed to list directory '${path}': ${(error as Error).message}`, { cause: error });
    }

    return [...results.values()];
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const key = formatKey(remotePath);
    try {
      const buffer = await this.backend.file(key).arrayBuffer();
      options.signal?.throwIfAborted();
      await writeFile(localPath, new Uint8Array(buffer));
      options.onProgress?.({ bytes: buffer.byteLength, total: buffer.byteLength });
    } catch (error) {
      throw new TransferError(`Failed to download '${remotePath}' from S3 bucket '${this.bucketName}': ${(error as Error).message}`, { cause: error });
    }
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const source = Bun.file(localPath);
    const key = formatKey(remotePath);
    try {
      const bytes = await this.backend.write(key, source);
      options.onProgress?.({ bytes, total: bytes });
    } catch (error) {
      throw new TransferError(`Failed to upload '${localPath}' to S3 bucket '${this.bucketName}': ${(error as Error).message}`, { cause: error });
    }
  }

  async deleteFile(path: string): Promise<boolean> {
    try {
      await this.backend.delete(formatKey(path));
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
      await this.backend.write(key, "");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}
}
