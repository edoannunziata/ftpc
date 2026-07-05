# ftpc

ftpc is a Bun and TypeScript terminal file-transfer client with a small library API
for moving files across local storage, FTP/FTPS, SFTP, S3-compatible storage,
Azure Data Lake Storage Gen2, and Azure Blob Storage.

## Quick Start

Install a packaged build from an immutable release tag:

```bash
curl -fsSL https://raw.githubusercontent.com/edoannunziata/ftpc/ftpc-<commit-sha>/install.sh | FTPC_TAG="ftpc-<commit-sha>" bash
```

Use a different install directory or repo when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/edoannunziata/ftpc/ftpc-<commit-sha>/install.sh | FTPC_TAG="ftpc-<commit-sha>" FTPC_INSTALL_DIR="$HOME/.local/bin" bash
curl -fsSL https://raw.githubusercontent.com/edoannunziata/ftpc/ftpc-<commit-sha>/install.sh | FTPC_TAG="ftpc-<commit-sha>" FTPC_REPO="owner/ftpc" bash
```

Build from source:

```bash
bun install
bun run typecheck
bun test tests
```

Run the CLI directly during development:

```bash
bun run src/index.ts --help
bun run src/index.ts remotes
bun run src/index.ts browse
```

Build a standalone Bun executable:

```bash
bun run build:exe
./dist/ftpc --help
```

Create release packages locally:

```bash
bun run package
```

## CLI

```text
ftpc [--config PATH] browse [remote] [path]
ftpc [--config PATH] remotes
ftpc [--config PATH] ls <connection> [path]
ftpc [--config PATH] get <connection> <remote-path> <local-path>
ftpc [--config PATH] put <connection> <local-path> <remote-path>
ftpc [--config PATH] rm <connection> <remote-path>
ftpc [--config PATH] mkdir <connection> <remote-path>
```

`connection` can be a configured remote name or a storage URL. With the default
config path, ftpc creates `~/.ftpcconf.toml` on first run. A custom `--config`
path must already exist.

Examples:

```bash
bun run src/index.ts ls file:///tmp
bun run src/index.ts put my-ftp ./report.csv /incoming/report.csv
bun run src/index.ts get s3://bucket/archive/data.csv ./data.csv
bun run src/index.ts browse my-azure /reports
```

When `browse` runs in a non-interactive terminal, it falls back to a one-shot
directory listing. In a TTY, it opens the interactive browser and remote
selector.

## Configuration

ftpc reads TOML configuration from `~/.ftpcconf.toml` by default. Each top-level
table is a named remote and must include a `type`.

```toml
[local]
type = "local"

[my-ftp]
type = "ftp"
url = "ftp.example.com"
port = 21
username = "user"
password = "password"
tls = true

[my-sftp]
type = "sftp"
url = "sftp.example.com"
port = 22
username = "user"
password = "password"
# key_filename = "~/.ssh/id_rsa"
# known_hosts_path = "~/.ssh/known_hosts"
# host_key_sha256 = "SHA256:base64-encoded-host-key-fingerprint"

[my-s3]
type = "s3"
url = "s3://my-bucket/prefix"
region_name = "us-east-1"
endpoint_url = "https://s3.amazonaws.com"
aws_access_key_id = "ACCESS_KEY"
aws_secret_access_key = "SECRET_KEY"

[my-azure]
type = "azure"
url = "mystorageaccount.dfs.core.windows.net"
filesystem = "myfilesystem"
connection_string = "DefaultEndpointsProtocol=https;AccountName=..."
# account_key = "ACCOUNT_KEY"

[my-blob]
type = "blob"
url = "mystorageaccount.blob.core.windows.net"
container = "mycontainer"
connection_string = "DefaultEndpointsProtocol=https;AccountName=..."
# account_key = "ACCOUNT_KEY"
```

FTP, SFTP, S3, Azure Data Lake, and Azure Blob remotes support proxy settings.
The protocol defaults to SOCKS5, and can also be set to HTTP or HTTPS:

```toml
[my-ftp.proxy]
host = "proxy.example.com"
protocol = "socks5"
port = 1080
username = "proxyuser"
password = "proxypass"
```

## Storage URLs

| Backend         | URL format                                             | Example                                            |
| --------------- | ------------------------------------------------------ | -------------------------------------------------- |
| Local           | `file:///path` or `/path`                              | `file:///tmp/data`                                 |
| FTP             | `ftp://[user:pass@]host[:port]/path`                   | `ftp://ftp.example.com/pub`                        |
| FTPS            | `ftps://[user:pass@]host[:port]/path`                  | `ftps://secure.example.com`                        |
| SFTP            | `sftp://[user:pass@]host[:port]/path`                  | `sftp://user@host/home/user`                       |
| S3              | `s3://bucket/path`                                     | `s3://my-bucket/reports`                           |
| Azure Data Lake | `azure://account.dfs.core.windows.net/filesystem/path` | `azure://acct.dfs.core.windows.net/fs/base`        |
| Azure Blob      | `blob://account.blob.core.windows.net/container/path`  | `blob://acct.blob.core.windows.net/container/base` |

## Library API

```ts
import { Storage } from "./src/index.ts";

const store = Storage.connect("s3://my-bucket/reports");

try {
  const entries = await store.list();
  for (const entry of entries) {
    console.log(entry.type, entry.name, entry.size);
  }

  await store.download("daily.csv", "./daily.csv");
  await store.upload("./summary.csv", "summary.csv");
  await store.mkdir("archive");
  await store.delete("old.csv");
} finally {
  await store.close();
}
```

Named constructors are available when configuration is easier to provide in
code:

```ts
const ftp = Storage.ftp("ftp.example.com", {
  username: "user",
  password: "password",
  tls: true,
  basePath: "/incoming",
});

const blob = Storage.azureBlob("account.blob.core.windows.net", "container", {
  accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
  basePath: "/reports",
});
```

All sessions expose:

| Method                                      | Description                            |
| ------------------------------------------- | -------------------------------------- |
| `list(path?)`                               | List files and directories.            |
| `download(remotePath, localPath, options?)` | Download one file.                     |
| `upload(localPath, remotePath, options?)`   | Upload one file.                       |
| `delete(path)`                              | Delete one remote file.                |
| `mkdir(path)`                               | Create one remote directory or prefix. |
| `close()`                                   | Close backend resources.               |

Transfer options support an `AbortSignal` and an `onProgress` callback.

## Interactive Browser

| Key                 | Action                                   |
| ------------------- | ---------------------------------------- |
| `j` / down          | Move selection down                      |
| `k` / up            | Move selection up                        |
| `g` / `G`           | Jump to first or last entry              |
| `l` / right / enter | Enter directory or confirm file download |
| `h` / left          | Go back                                  |
| `p`                 | Go to parent directory                   |
| `/`                 | Search by filename prefix                |
| `d`                 | Delete selected file after confirmation  |
| `m`                 | Create a directory                       |
| `u`                 | Toggle upload mode                       |
| `r`                 | Refresh                                  |
| `?`                 | Help                                     |
| `q`                 | Quit                                     |

## Tests

The default suite uses mocks and local temporary files:

```bash
bun test tests
```

Real backend integration tests are skipped unless explicitly enabled. Set
`FTPC_INTEGRATION=1` and the relevant `FTPC_INTEGRATION_*` environment
variables, then run:

```bash
FTPC_INTEGRATION=1 bun test tests/integration.test.ts
```
