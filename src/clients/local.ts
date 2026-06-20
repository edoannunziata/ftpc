import { copyFile, lstat, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FileDescriptor, StorageClient, TransferOptions } from "../types.ts";
import { ListingError } from "../errors.ts";

export class LocalClient implements StorageClient {
  name(): string {
    return "Local Storage";
  }

  async list(path: string): Promise<FileDescriptor[]> {
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch (error) {
      throw new ListingError(`Failed to list directory '${path}': ${(error as Error).message}`);
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

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    await copyFile(remotePath, localPath);
    const info = await stat(remotePath);
    options.onProgress?.({ bytes: info.size, total: info.size });
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    await copyFile(localPath, remotePath);
    const info = await stat(remotePath);
    options.onProgress?.({ bytes: info.size, total: info.size });
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
