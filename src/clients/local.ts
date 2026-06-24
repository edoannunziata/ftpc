import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  FileDescriptor,
  StorageClient,
  TransferOptions,
} from "../types.ts";
import { ListingError } from "../errors.ts";

const LOCAL_COPY_CHUNK_SIZE = 64 * 1024;

function normalizeStreamError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function copyLocalFile(
  sourcePath: string,
  destinationPath: string,
  options: TransferOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  const info = await stat(sourcePath);
  let bytes = 0;

  const readStream = createReadStream(sourcePath, {
    highWaterMark: LOCAL_COPY_CHUNK_SIZE,
  });
  const progressStream = new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      try {
        bytes += chunk.byteLength;
        options.onProgress?.({ bytes, total: info.size });
        options.signal?.throwIfAborted();
        callback(null, chunk);
      } catch (error) {
        callback(normalizeStreamError(error));
      }
    },
  });
  const writeStream = createWriteStream(destinationPath);

  try {
    if (options.signal) {
      await pipeline(readStream, progressStream, writeStream, {
        signal: options.signal,
      });
    } else {
      await pipeline(readStream, progressStream, writeStream);
    }
  } catch (error) {
    if (options.signal?.aborted) {
      options.signal.throwIfAborted();
    }
    throw error;
  }

  options.signal?.throwIfAborted();
  await chmod(destinationPath, info.mode);
  await utimes(destinationPath, info.atime, info.mtime);

  if (info.size === 0 || bytes !== info.size) {
    options.onProgress?.({ bytes: info.size, total: info.size });
  }
}

export class LocalClient implements StorageClient {
  name(): string {
    return "Local Storage";
  }

  async list(path: string): Promise<FileDescriptor[]> {
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch (error) {
      throw new ListingError(
        `Failed to list directory '${path}': ${(error as Error).message}`,
      );
    }

    const descriptors: FileDescriptor[] = [];
    for (const entry of entries) {
      const entryPath = join(path, entry);
      try {
        const info = await lstat(entryPath);
        let isDirectory = info.isDirectory();
        if (info.isSymbolicLink()) {
          try {
            isDirectory = (await stat(entryPath)).isDirectory();
          } catch {
            isDirectory = false;
          }
        }

        descriptors.push({
          path: entry,
          name: basename(entry),
          type: isDirectory ? "directory" : "file",
          size: info.size,
          modifiedTime: info.mtime,
        });
      } catch {
        // Match the Python client: entries that disappear or cannot be read are skipped.
      }
    }

    return descriptors;
  }

  async download(
    remotePath: string,
    localPath: string,
    options: TransferOptions = {},
  ): Promise<void> {
    await copyLocalFile(remotePath, localPath, options);
  }

  async upload(
    localPath: string,
    remotePath: string,
    options: TransferOptions = {},
  ): Promise<void> {
    await copyLocalFile(localPath, remotePath, options);
  }

  async deleteFile(path: string): Promise<boolean> {
    try {
      if (!(await stat(path)).isFile()) {
        return false;
      }
      await unlink(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<boolean> {
    try {
      await mkdir(path);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}
}
