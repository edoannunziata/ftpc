# ftpc Bun Rewrite Plan

## Summary

Rewrite `ftpc` as a Bun/TypeScript application following the lean shape of
`../icsemu`: ESM modules in `src/`, `bun test`, and
`bun build --compile --outfile dist/ftpc`.

The new app will preserve the current modular storage design, keep all current
backends as first-class targets, and replace the ncurses-first UI with a
scriptable CLI plus a small built-in terminal browser.

## Key Changes

- Use an async-only TypeScript storage core with backend adapters for `local`,
  `ftp`, `sftp`, `s3`, `azure`, and `blob`.
- Preserve the existing TOML config format at `~/.ftpcconf.toml`; parse with
  `Bun.TOML.parse`, validate into typed remote configs, and keep warning
  behavior for invalid remotes.
- Add CLI commands:
  - `ftpc browse [remote] [path]`
  - `ftpc remotes`
  - `ftpc ls <connection> [path]`
  - `ftpc get <connection> <remote-path> <local-path>`
  - `ftpc put <connection> <local-path> <remote-path>`
  - `ftpc rm <connection> <remote-path>`
  - `ftpc mkdir <connection> <remote-path>`
- Keep `ftpc [remote] [path]` as a compatibility shortcut for `browse`.
- `connection` means either a configured remote name or a URL such as
  `s3://bucket/path`, `ftp://host/path`, `file:///path`,
  `azure://account.dfs.core.windows.net/fs/path`, or
  `blob://account.blob.core.windows.net/container/path`.

## Public Interfaces

```ts
export type FileType = "file" | "directory";

export interface FileDescriptor {
  path: string;
  name: string;
  type: FileType;
  size?: number;
  modifiedTime?: Date;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { bytes: number; total?: number }) => void;
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
```

Use `StorageSession` above the raw client for base-path resolution, URL
constructors, named remote constructors, and consistent error wrapping. Drop the
Python sync/async dual API; Bun v1 is async-only.

## Dependencies

- Use Bun and Node built-ins for CLI parsing, file I/O, TOML, test runner, ANSI
  terminal drawing, path utilities, streams, and process handling.
- Use `Bun.S3Client` for S3-compatible storage instead of AWS SDK packages.
- Add runtime deps only where protocol complexity is worth it: `basic-ftp` for
  FTP/FTPS, `ssh2` for SFTP, `@azure/storage-blob`,
  `@azure/storage-file-datalake`, and `@azure/identity`.
- Add dev deps `@types/bun`, `typescript`, and `@types/ssh2` if `ssh2` types are
  not bundled.
- Do not add `commander`, `yargs`, a TOML package, a curses package, or an AWS
  SDK dependency.

## Implementation Plan

- Scaffold `package.json`, `tsconfig.json`, `src/index.ts`, and scripts:
  `dev`, `test`, `typecheck`, `build:exe`.
- Port domain types, errors, path normalization, URL parsing, config loading,
  and default config creation first.
- Implement `LocalClient` and the storage session/factory layer before remote
  backends.
- Implement remote adapters behind the same `StorageClient` interface:
  - FTP/FTPS via `basic-ftp`
  - SFTP via `ssh2`
  - S3 via `Bun.S3Client`, grouping listed keys into virtual directories
  - Azure Data Lake and Blob via official Azure JS clients
- Build the CLI on the storage session only, with stable exit codes and stderr
  error messages.
- Build the browser as an ANSI/raw-mode terminal view with the current key
  model: arrows or `j/k`, enter/`l`, `h`, `p`, `r`, `/`, `u`, `d`, `m`, `?`,
  `q`.
- Keep Python files until Bun parity tests and compiled-binary smoke tests pass;
  remove Python packaging in the final migration step.

## Test Plan

- Port existing unit coverage to `bun:test`: file descriptors, URL parsing,
  config validation/warnings, local backend, and storage session path
  resolution.
- Add mocked adapter tests for FTP, SFTP, S3, Azure Data Lake, and Azure Blob.
- Add CLI tests for `remotes`, `ls`, `get`, `put`, `rm`, `mkdir`, bad config,
  missing remote, and unsupported protocol.
- Add browser tests around selection/search/navigation using an in-memory fake
  client.
- Add gated integration tests for real services via env vars, skipped by
  default.
- Required verification before deleting Python: `bun test`, `bun run typecheck`,
  `bun run build:exe`, `dist/ftpc --version`, and a compiled-binary local
  transfer smoke test.

## Proxy And Anonymous Access

- Proxy support is a parity target, but not part of the first implementation
  slice. The current Python config has one `proxy` shape, while FTP, SFTP,
  S3, and Azure need different transport plumbing. Until each adapter is
  implemented and tested, the Bun app should parse proxy config and fail
  clearly if a backend cannot use it.
- Anonymous S3 access is also a parity target. The Python S3 adapter can make
  unsigned boto3 requests when no credentials are configured; Bun's native S3
  API must be verified for that behavior before the rewrite promises public
  bucket parity. If native S3 cannot support it, use AWS SDK v3 only for the
  S3 adapter feature gap.

## Assumptions

- v1 preserves all current storage backends.
- The new browser should preserve the workflow, not pixel-match curses.
- Cross-platform binaries are a release target, but first implementation
  validates the host platform binary before adding target matrix builds.

## Source Anchors

- [Bun single-file executables](https://bun.sh/docs/bundler/executables)
- [Bun TOML support](https://bun.sh/docs/runtime/toml)
- [Bun S3 API](https://bun.sh/docs/runtime/s3)
- [Bun test runner](https://bun.sh/docs/test)
- [Azure Blob JS client](https://learn.microsoft.com/en-us/javascript/api/overview/azure/storage-blob-readme?view=azure-node-latest)
- [Azure Data Lake JS client](https://learn.microsoft.com/en-us/javascript/api/overview/azure/storage-file-datalake-readme?view=azure-node-latest)
- [basic-ftp](https://github.com/patrickjuchli/basic-ftp)
- [ssh2](https://github.com/mscdex/ssh2)
