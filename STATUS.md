# ftpc Bun Migration Status

Date: 2026-06-21

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
- Storage URL parsing added in `src/url.ts`, including file URLs, absolute
  paths, and protocol-less local paths.
- TOML config loading, validation, and first-run default config creation added
  in `src/config.ts`, including commented examples for all supported backends.
  FTP configured remotes now preserve whether credentials were explicitly set
  so embedded URL credentials can be used without losing anonymous defaults or
  explicit TOML override behavior. They also preserve explicit TLS intent so
  `ftps://` configured URLs enable FTPS unless `tls` is explicitly set.
- Async local filesystem backend added in `src/clients/local.ts`.
- Local filesystem transfers now stream with chunk progress, `AbortSignal`
  cancellation, and source metadata preservation for mode and timestamps.
- FTP/FTPS backend added in `src/clients/ftp.ts` using `basic-ftp`,
  including listing, download, upload, delete, mkdir, and explicit FTPS
  support. FTP mkdir now sends a single `MKD` command instead of using
  recursive directory creation, matching the old Python client's failure
  behavior for existing directories or missing parents.
- SFTP backend added in `src/clients/sftp.ts` using `ssh2`, including listing,
  download, upload, delete, mkdir, password auth, private-key auth, and
  home-relative private-key paths. When both `password` and `key_filename` are
  configured, the password is also passed as the private-key passphrase, matching
  Paramiko's encrypted-key behavior. Configured SFTP remotes now accept
  URL-embedded credentials as valid authentication and pass them through unless
  explicit TOML credentials are set.
- S3 backend added in `src/clients/s3.ts` using Bun's native `S3Client`,
  including virtual-directory listing, download, upload, delete, and mkdir
  placeholder support.
- Anonymous S3 support added via unsigned REST requests when no explicit S3
  credentials are configured, matching the old Python client's unsigned mode.
- Azure Data Lake backend added in `src/clients/azure_datalake.ts` using the
  official Azure JS SDK, including listing, download, upload, delete, mkdir,
  connection-string auth, account-key auth, and default Azure identity auth.
- Azure Blob backend added in `src/clients/azure_blob.ts` using the official
  Azure JS SDK, including virtual-directory listing, download, upload, delete,
  mkdir placeholder support, connection-string auth, account-key auth, and
  default Azure identity auth.
- Storage session/factory layer added in `src/storage.ts`.
- Programmatic `Storage` facade named constructors added for local, FTP/FTPS,
  SFTP, S3, Azure Data Lake, and Azure Blob sessions.
- Scriptable CLI commands added in `src/cli.ts`.
- CLI parity coverage added for remotes, ls, get, put, rm, mkdir, bad config,
  missing remotes, unsupported protocols, and usage errors. Async command
  failures are now normalized to stderr plus exit code 1, and configuration
  warnings are emitted consistently across commands.
- SOCKS5 proxy configuration parsing is covered. FTP/FTPS and SFTP remotes now
  support SOCKS5 proxy transport. Anonymous S3 unsigned REST requests also
  support SOCKS5 proxy transport, while credentialed S3, Azure Data Lake, and
  Azure Blob remotes fail consistently with a clear unsupported-transport error
  before opening native SDK sessions.
- Initial terminal browser implementation added under `src/browser/`, with
  pure browser state/commands separated from rendering and terminal I/O.
- Browser renderer lifecycle fixes added: quitting with `q` now exits cleanly,
  and full-height frames no longer emit a trailing newline that can scroll the
  terminal and corrupt line-diff rendering.
- Browser startup now enters the terminal UI immediately with a loading status
  before the first directory listing completes. Listing failures during startup
  or refresh are shown in-browser as status errors instead of rejecting the
  whole interactive session.
- Browser prefix search, upload mode, and file-operation state/effects added
  using the existing pure state/effect architecture. Download, upload, delete,
  and mkdir prompts now render as centered dialogs, matching the old TUI's
  confirmation and input-dialog workflow.
- Browser remote selector added for interactive `ftpc browse` with no remote,
  including navigation, prefix search, details, custom open path, quit, and
  returning to the selector after a browser session exits. Direct interactive
  browse with no explicit path now preserves the selected storage session's
  base path instead of forcing `/`. Configured local remotes now also resolve
  user-supplied relative browse paths from the process current working
  directory, matching the old Python TUI's local path behavior.
- Browser and remote selector ANSI colors plus expanded help dialogs added,
  matching the old TUI's colored bars, colored entries, and key-command help
  overlays. Empty browser directories now include the old refresh hint. The
  remote selector now also shows remote details and custom-path entry as
  dialogs instead of squeezing that information into the status line.
- Browser and remote selector terminal runners now redraw on TTY resize events,
  matching the old curses `KEY_RESIZE` handling without adding resize logic to
  the pure state layers.
- Browser transfer progress overlay added for downloads and uploads. Active
  transfers now show bytes/percentage and can be canceled with `q` or Escape;
  Ctrl-C cancels the active transfer and exits after it unwinds. FTP and SFTP
  adapters now close their transport when an in-flight transfer is aborted so
  browser cancellation is wired through to the remote session.
- FTP and SFTP adapters now normalize lazy connection failures into
  operation-level listing or transfer errors, preserving the command/browser
  context in failure messages.
- Gated real-service integration tests added in
  `tests/bun/integration.test.ts` for FTP, FTPS, SFTP, S3, Azure Data Lake, and
  Azure Blob. They run only when `FTPC_INTEGRATION=1` and the relevant backend
  environment variables are present, and are skipped by default. The SFTP
  integration helper now routes URL-embedded credentials through the configured
  remote path, including no-scheme `user:pass@host/path` URLs. Azure Data Lake
  and Azure Blob integration helpers now also derive filesystem/container names
  from no-scheme account URLs with path prefixes.
- Bun tests added under `tests/bun`.
- `node_modules/` added to `.gitignore`; `dist/` was already ignored.

Verification currently passes:

- `bun run typecheck`
- `bun test tests/bun`
- `bun run build:exe`
- compiled binary smoke checks for version, local listing, upload, download,
  and mkdir
- compiled binary smoke checks for clean CLI bad-config error handling
- compiled binary PTY smoke checks for browser quit with `q` and remote
  selector custom-path selection
- compiled binary PTY smoke checks for browser and remote-selector expanded
  help dialogs with ANSI colors

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
URL parsing exists for FTP, FTPS, SFTP, S3, Azure Data Lake, and Azure Blob, and
all planned storage adapters now have Bun implementations behind the shared
storage interface.

## Remaining Work

Next migration slices:

1. Run the gated integration tests against real FTP/FTPS, SFTP, S3, Azure Data
   Lake, and Azure Blob services and fix any service-specific failures.
2. Remove Python packaging only after Bun parity and compiled-binary checks are
   strong enough.

## Gated Integration Test Environment

The real-service tests are skipped unless `FTPC_INTEGRATION=1` is set. Each
backend also needs its own URL:

- `FTPC_INTEGRATION_FTP_URL`
- `FTPC_INTEGRATION_FTPS_URL`
- `FTPC_INTEGRATION_SFTP_URL`
- `FTPC_INTEGRATION_S3_URL`
- `FTPC_INTEGRATION_AZURE_URL`
- `FTPC_INTEGRATION_BLOB_URL`

Optional backend-specific settings:

- FTP/FTPS: `FTPC_INTEGRATION_FTP_USERNAME`,
  `FTPC_INTEGRATION_FTP_PASSWORD`, `FTPC_INTEGRATION_FTPS_USERNAME`,
  `FTPC_INTEGRATION_FTPS_PASSWORD`
- SFTP: `FTPC_INTEGRATION_SFTP_USERNAME`,
  `FTPC_INTEGRATION_SFTP_PASSWORD`, `FTPC_INTEGRATION_SFTP_KEY_FILENAME`
- S3: `FTPC_INTEGRATION_S3_REGION`,
  `FTPC_INTEGRATION_S3_ENDPOINT_URL`,
  `FTPC_INTEGRATION_S3_AWS_ACCESS_KEY_ID`,
  `FTPC_INTEGRATION_S3_AWS_SECRET_ACCESS_KEY`
- Azure Data Lake: `FTPC_INTEGRATION_AZURE_FILESYSTEM`,
  `FTPC_INTEGRATION_AZURE_CONNECTION_STRING`,
  `FTPC_INTEGRATION_AZURE_ACCOUNT_KEY`
- Azure Blob: `FTPC_INTEGRATION_BLOB_CONTAINER`,
  `FTPC_INTEGRATION_BLOB_CONNECTION_STRING`,
  `FTPC_INTEGRATION_BLOB_ACCOUNT_KEY`

## Known Intentional Gaps

- SOCKS5 proxy transport is implemented for FTP/FTPS, SFTP, and anonymous S3
  unsigned REST requests. Credentialed S3 still uses Bun's native S3 transport,
  which is not proxied yet. Azure Data Lake and Azure Blob proxy transport are
  not implemented in the Bun adapters yet.
- Anonymous S3 access has a mocked unsigned REST implementation, but has not
  yet been verified against a real public bucket in this workspace.
- Remote adapters have mocked tests and skipped-by-default real-service tests,
  but the real-service tests have not yet been run in this workspace.
- The browser can list, navigate, refresh, search by prefix, download files
  after confirmation, enter upload mode to browse local files and upload after
  confirmation, delete files after confirmation, create directories, and quit in
  a real TTY. Confirmation and directory-name prompts render as centered
  dialogs. It preserves the old `h`/left history-back behavior separately from
  `p` parent-directory navigation. Interactive `ftpc browse` with no remote now
  opens a selector for configured remotes. Rendering is separated from browser
  behavior and has a screen-frame diff primitive for a flicker-resistant
  renderer. The renderer now serializes exactly the terminal frame height
  without a scrolling newline and covers colored terminal frames plus expanded
  help, remote-details, custom-path, confirmation, and mkdir dialogs, and the
  empty-directory refresh hint. Browser and selector sessions redraw when the
  terminal emits a resize event. Browser startup and refresh listing errors
  remain inside the browser UI so the user can quit or retry. Download and
  upload progress dialogs are present and can cancel active transfers through
  `AbortSignal`; FTP and SFTP abort by closing their sessions, local transfers
  abort their stream pipeline, while native whole-object S3 operations may only
  observe aborts before or after the underlying call.
