# ftpc Bun Migration Status

Date: 2026-06-20

## Current State

The Bun rewrite has started alongside the existing Python package. The Python
implementation remains in place while the TypeScript implementation gains parity
slice by slice.

Completed so far:

- Accepted rewrite plan written to `REWRITE.md`.
- Bun project scaffold added with `package.json`, `tsconfig.json`, and
  `bun.lock`.
- TypeScript storage domain types added in `src/types.ts`.
- Shared storage errors added in `src/errors.ts`.
- Remote path helpers added in `src/paths.ts`.
- Storage URL parsing added in `src/url.ts`.
- TOML config loading and validation added in `src/config.ts`.
- Async local filesystem backend added in `src/clients/local.ts`.
- Storage session/factory layer added in `src/storage.ts`.
- Scriptable CLI commands added in `src/cli.ts`.
- Initial terminal browser implementation added under `src/browser/`, with
  pure browser state/commands separated from rendering and terminal I/O.
- Browser renderer lifecycle fixes added: quitting with `q` now exits cleanly,
  and full-height frames no longer emit a trailing newline that can scroll the
  terminal and corrupt line-diff rendering.
- Bun tests added under `tests/bun`.
- `node_modules/` added to `.gitignore`; `dist/` was already ignored.

Verification currently passes:

- `bun run typecheck`
- `bun test tests/bun`
- `bun run build:exe`
- compiled binary smoke checks for version, local listing, upload, and download
- compiled binary PTY smoke check for browser quit with `q`

## Implemented CLI Surface

- `ftpc remotes`
- `ftpc ls <connection> [path]`
- `ftpc get <connection> <remote-path> <local-path>`
- `ftpc put <connection> <local-path> <remote-path>`
- `ftpc rm <connection> <remote-path>`
- `ftpc mkdir <connection> <remote-path>`
- `ftpc browse [remote] [path]`
- `ftpc [remote] [path]` as a compatibility shortcut for `browse`

`connection` can already be a configured remote name or a local/file URL. Remote
URL parsing exists for FTP, FTPS, SFTP, S3, Azure Data Lake, and Azure Blob, but
their adapters are not implemented yet.

## Remaining Work

Next migration slices:

1. Add FTP/FTPS via `basic-ftp`.
2. Add SFTP via `ssh2`.
3. Add S3 via Bun's native S3 client.
4. Add Azure Blob and Azure Data Lake via the Azure JS SDK.
5. Add browser operations for download, upload mode, delete, mkdir, search, and
   remote selector parity.
6. Add gated integration tests for real remote services.
7. Remove Python packaging only after Bun parity and compiled-binary checks are
   strong enough.

## Known Intentional Gaps

- Proxy config is parsed but not usable yet.
- Anonymous S3 access is not verified yet.
- Remote backends currently throw clear `UnsupportedFeatureError` messages.
- The browser can list, navigate, refresh, and quit in a real TTY. Rendering is
  separated from browser behavior and has a screen-frame diff primitive for a
  future flicker-resistant renderer. The renderer now serializes exactly the
  terminal frame height without a scrolling newline. It does not yet cover
  transfer operations, upload mode, deletion, directory creation, search,
  colors, expanded help, or remote selector parity.
