import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client as AwsS3Client,
  type ListObjectsV2CommandOutput,
  type PutObjectCommandInput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { baseName, normalizeRemotePath, stripLeadingSlash } from "../paths.ts";
import type {
  FileDescriptor,
  StorageClient,
  TransferOptions,
} from "../types.ts";
import { ListingError, TransferError } from "../errors.ts";
import type { ProxyConfig } from "../config.ts";
import { getProxyAgent } from "../proxy.ts";

export type S3WriteData = PutObjectCommandInput["Body"] | Blob | ArrayBuffer;

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
  list(
    input?: {
      prefix?: string;
      delimiter?: string;
      continuationToken?: string;
    } | null,
  ): Promise<S3ListResponse>;
  file(path: string): { arrayBuffer(): Promise<ArrayBuffer> };
  write(path: string, data: S3WriteData): Promise<number>;
  uploadFile?(
    localPath: string,
    path: string,
    options?: TransferOptions,
  ): Promise<number>;
  delete(path: string): Promise<void>;
  close?(): void;
}

export interface S3ClientOptions {
  bucketName: string;
  name?: string;
  regionName?: string;
  endpointUrl?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  proxy?: ProxyConfig;
  sdkClient?: AwsS3Client;
  backend?: S3Backend;
}

function hasExplicitCredentials(options: S3ClientOptions): boolean {
  return (
    options.awsAccessKeyId !== undefined ||
    options.awsSecretAccessKey !== undefined
  );
}

function credentials(options: S3ClientOptions): S3ClientConfig["credentials"] {
  if (!hasExplicitCredentials(options)) {
    return undefined;
  }
  if (
    options.awsAccessKeyId === undefined ||
    options.awsSecretAccessKey === undefined
  ) {
    throw new Error(
      "S3 credentials require both awsAccessKeyId and awsSecretAccessKey",
    );
  }
  return {
    accessKeyId: options.awsAccessKeyId,
    secretAccessKey: options.awsSecretAccessKey,
  };
}

function requestHandler(
  proxy: ProxyConfig | undefined,
): S3ClientConfig["requestHandler"] {
  if (proxy === undefined) {
    return undefined;
  }

  const agent = getProxyAgent(proxy);
  return new NodeHttpHandler({
    httpAgent: agent,
    httpsAgent: agent,
  });
}

function createAwsS3Backend(options: S3ClientOptions): S3Backend {
  const client =
    options.sdkClient ??
    new AwsS3Client({
      region:
        options.regionName ??
        (options.endpointUrl === undefined ? undefined : "us-east-1"),
      endpoint: options.endpointUrl,
      forcePathStyle: options.endpointUrl !== undefined ? true : undefined,
      credentials: credentials(options),
      requestHandler: requestHandler(options.proxy),
    });
  return new AwsS3Backend(client, options.bucketName);
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

function byteLength(data: S3WriteData): number {
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
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function writeBody(
  data: S3WriteData,
): Promise<PutObjectCommandInput["Body"]> {
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return data;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

async function readableBodyToArrayBuffer(body: unknown): Promise<ArrayBuffer> {
  if (body === undefined || body === null) {
    return new ArrayBuffer(0);
  }
  if (body instanceof ArrayBuffer) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return arrayBufferFromBytes(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  if (
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return arrayBufferFromBytes(await body.transformToByteArray());
  }
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as never));
    }
    return arrayBufferFromBytes(Buffer.concat(chunks));
  }
  throw new Error("Unsupported S3 response body type");
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    record.$metadata?.httpStatusCode === 404 ||
    record.name === "NotFound" ||
    record.name === "NoSuchKey"
  );
}

class AwsS3Backend implements S3Backend {
  constructor(
    private readonly client: AwsS3Client,
    private readonly bucketName: string,
  ) {}

  async list(
    input: {
      prefix?: string;
      delimiter?: string;
      continuationToken?: string;
    } | null = {},
  ): Promise<S3ListResponse> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: input?.prefix,
        Delimiter: input?.delimiter,
        ContinuationToken: input?.continuationToken,
      }),
    );

    return {
      commonPrefixes: response.CommonPrefixes?.map((prefix) => prefix.Prefix)
        .filter((prefix): prefix is string => prefix !== undefined)
        .map((prefix) => ({ prefix })),
      contents: response.Contents?.map(
        (object): S3ObjectSummary | undefined => {
          if (object.Key === undefined) {
            return undefined;
          }
          const summary: S3ObjectSummary = {
            key: object.Key,
          };
          if (object.Size !== undefined) {
            summary.size = object.Size;
          }
          if (object.LastModified !== undefined) {
            summary.lastModified = object.LastModified;
          }
          return summary;
        },
      ).filter((object): object is S3ObjectSummary => object !== undefined),
      isTruncated: response.IsTruncated,
      nextContinuationToken: response.NextContinuationToken,
    };
  }

  file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } {
    return {
      arrayBuffer: async () => {
        const response = await this.client.send(
          new GetObjectCommand({
            Bucket: this.bucketName,
            Key: path,
          }),
        );
        return readableBodyToArrayBuffer(response.Body);
      },
    };
  }

  async write(path: string, data: S3WriteData): Promise<number> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: path,
        Body: await writeBody(data),
      }),
    );
    return byteLength(data);
  }

  async uploadFile(
    localPath: string,
    path: string,
    options: TransferOptions = {},
  ): Promise<number> {
    const { size } = await stat(localPath);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucketName,
        Key: path,
        Body: createReadStream(localPath) as Readable,
      },
    });
    let loaded = 0;
    upload.on("httpUploadProgress", (progress) => {
      if (progress.loaded !== undefined) {
        loaded = progress.loaded;
        options.onProgress?.({ bytes: loaded, total: progress.total ?? size });
      }
    });
    await upload.done();
    if (loaded !== size) {
      options.onProgress?.({ bytes: size, total: size });
    }
    return size;
  }

  async delete(path: string): Promise<void> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: path,
        }),
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        throw error;
      }
      throw error;
    }

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: path,
      }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}

async function readAllObjects(
  backend: S3Backend,
  prefix: string,
): Promise<S3ListResponse[]> {
  const responses: S3ListResponse[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await backend.list({
      prefix,
      delimiter: "/",
      continuationToken,
    });
    responses.push(response);
    continuationToken =
      response.isTruncated === true
        ? response.nextContinuationToken
        : undefined;
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
    this.backend = options.backend ?? createAwsS3Backend(options);
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

          const relativeKey =
            prefix === "" ? object.key : object.key.slice(prefix.length);
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
      throw new ListingError(
        `Failed to list directory '${path}': ${(error as Error).message}`,
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
    const key = formatKey(remotePath);
    try {
      const buffer = await this.backend.file(key).arrayBuffer();
      options.signal?.throwIfAborted();
      await writeFile(localPath, new Uint8Array(buffer));
      options.onProgress?.({
        bytes: buffer.byteLength,
        total: buffer.byteLength,
      });
    } catch (error) {
      throw new TransferError(
        `Failed to download '${remotePath}' from S3 bucket '${this.bucketName}': ${(error as Error).message}`,
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
    const key = formatKey(remotePath);
    try {
      if (this.backend.uploadFile !== undefined) {
        await this.backend.uploadFile(localPath, key, options);
        return;
      }
      const source = Bun.file(localPath);
      const bytes = await this.backend.write(key, source);
      options.onProgress?.({ bytes, total: bytes });
    } catch (error) {
      throw new TransferError(
        `Failed to upload '${localPath}' to S3 bucket '${this.bucketName}': ${(error as Error).message}`,
        { cause: error },
      );
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
    const key = prefixForDirectory(path);
    try {
      await this.backend.write(key, "");
      return true;
    } catch (error) {
      throw new TransferError(
        `Failed to create directory placeholder '${path}' in S3 bucket '${this.bucketName}': ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    this.backend.close?.();
  }
}
