export type FileType = "file" | "directory";

export interface FileDescriptor {
  path: string;
  name: string;
  type: FileType;
  size?: number;
  modifiedTime?: Date;
}

export interface TransferProgress {
  bytes: number;
  total?: number;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

export interface StorageClient {
  name(): string;
  list(path: string): Promise<FileDescriptor[]>;
  download(remotePath: string, localPath: string, options?: TransferOptions): Promise<void>;
  upload(localPath: string, remotePath: string, options?: TransferOptions): Promise<void>;
  deleteFile(path: string): Promise<boolean>;
  mkdir(path: string): Promise<boolean>;
  close(): Promise<void>;
}
