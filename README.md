# ftpc

ftpc is a simple TUI file transfer client that supports multiple storage backends.
It is designed to be simple and hackable, and doubles as a quick-and-dirty library
to access the storage backends programmatically.

The project was born out of frusration for Microsoft's tools to access Azure storage,
most of my needs are relatively simple and I have no need for software that's complex
and slow.

A substantial part of the development was assisted by artificial intelligence tools,
and the projects doubles as a training ground to see how far these tools can be pushed.

This project is not "vibe coded". I am pushing
myself to explore various AI tools more than I normally would, but the priority is to
make something useful for myself (and hopefully others.) If the AI gets stuck, can't
complete a task or makes a mess of it, I step in and fix the problem.
Purity is _not_ a goal.


## Supported backends
- Local filesystem
- FTP/FTPS with TLS support
- SFTP
- S3 compatible
- Azure Data Lake Storage Gen2

## Installation

### Basic Installation
```bash
pip install -e .
```

### Full Installation (all backends)
```bash
pip install -e ".[all]"
```

### Installing Specific Backends

For Azure support:
```bash
pip install azure-storage-file-datalake azure-identity
```

For AWS S3 support:
```bash
pip install boto3
```

For SFTP support:
```bash
pip install paramiko
```

## Configuration

FTPC uses a TOML configuration file to manage connection details. By default, it looks for `~/.ftpcconf.toml`.

If no configuration file exists, ftpc will automatically create a default one with a local filesystem remote. You can find a sample configuration in [`ftpc/sample_config.toml`](ftpc/sample_config.toml).

### Configuration Options

Each remote connection is defined as a section in the TOML file with a `type` field specifying the storage backend.

#### Local Client

```toml
[local]
type = "local"
# No additional configuration needed for local file access
```

#### FTP Client

```toml
[ftp]
type = "ftp"
url = "ftp://ftp.example.com"       # Required: FTP server URL
username = "user"                   # Optional: Username (default: "anonymous")
password = "password"               # Optional: Password (default: "anonymous@")
tls = false                         # Optional: Enable TLS/SSL (default: false)
```

#### SFTP Client

```toml
[sftp]
type = "sftp"
url = "sftp.example.com"            # Required: SFTP server hostname
port = 22                           # Optional: SSH port (default: 22)
username = "user"                   # Optional: Username for authentication
password = "password"               # Optional: Password (either password or key_filename required)
key_filename = "/path/to/private_key"  # Optional: Path to private key file
```

#### AWS S3 Client

```toml
[s3]
type = "s3"
url = "s3://my-bucket"              # Optional: S3 URL (alternative to bucket_name)
bucket_name = "my-bucket"           # Optional: S3 bucket name (alternative to url)
region_name = "us-west-2"           # Optional: AWS region
endpoint_url = "https://s3.amazonaws.com"  # Optional: Custom S3 endpoint (for S3-compatible services)
aws_access_key_id = "ACCESS_KEY"    # Optional: AWS access key (uses environment/credentials if not specified)
aws_secret_access_key = "SECRET_KEY"  # Optional: AWS secret key (uses environment/credentials if not specified)
```

**Note:** AWS credentials are typically loaded from environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) or `~/.aws/credentials` file. Only specify credentials in the config if needed.

#### Azure Data Lake Storage Gen2 Client

```toml
[azure]
type = "azure"
url = "mystorageaccount.dfs.core.windows.net"  # Required: Azure storage account URL
filesystem = "myfilesystem"         # Required: Azure filesystem name
connection_string = "DefaultEndpointsProtocol=https;..."  # Optional: Full connection string
account_key = "ACCOUNT_KEY"         # Optional: Storage account key
```

**Note:** Azure authentication typically uses environment variables or Azure CLI login. Only specify `connection_string` or `account_key` if needed for direct authentication.

### Example Configuration File

```toml
# Complete example showing all supported backends
[local]
type = "local"

[my-ftp]
type = "ftp"
url = "ftp://ftp.example.com"
username = "user"
password = "password"
tls = true

[my-sftp]
type = "sftp"
url = "sftp.example.com"
username = "user"
key_filename = "/home/user/.ssh/id_rsa"

[my-s3]
type = "s3"
url = "s3://my-bucket"
region_name = "us-west-2"

[my-azure]
type = "azure"
url = "mystorageaccount.dfs.core.windows.net"
filesystem = "myfilesystem"
```

## Usage

```bash
python -m ftpc [--config CONFIG_FILE] <remote> [path]
```

- `--config`: Optional path to configuration file (defaults to `~/.ftpcconf.toml`)
- `remote`: Name of the remote connection from your config file
- `path`: Optional starting path (defaults to root '/')

Examples:
```bash
# Connect to defined S3 remote and start at root path
python -m ftpc s3

# Connect to defined FTP remote and start at specific path
python -m ftpc ftp /public/files

# Use a specific config file
python -m ftpc --config ./my-config.toml azure /documents
```

## Keyboard Controls

| Key           | Action                              |
|---------------|-------------------------------------|
| Arrow keys    | Navigate file list                  |
| Enter         | Enter directory or download file    |
| Left Arrow    | Go back in history                  |
| p             | Go to parent directory              |
| r             | Refresh current directory           |
| u             | Toggle upload mode                  |
| d             | Delete selected file                |
| /             | Search for files                    |
| ?             | Show help dialog                    |
| q             | Quit application                    |

## Library Usage

ftpc can be used as a library for programmatic access to storage backends via the `Storage` facade.

### Quick Start

```python
from ftpc import Storage

# Async usage with URL
async with Storage.connect("s3://my-bucket") as store:
    files = await store.list()
    await store.download("remote/file.txt", "local.txt")
    await store.upload("local.txt", "remote/backup.txt")

# Sync usage with URL
with Storage.connect_sync("sftp://user:pass@host.com/home") as store:
    files = store.list()
    store.upload("data.csv", "backup.csv")
```

### Supported URL Formats

| Protocol | Format | Example |
|----------|--------|---------|
| Local | `file:///path` or `/path` | `/home/user/data` |
| FTP | `ftp://[user:pass@]host[:port]/path` | `ftp://ftp.example.com/pub` |
| FTPS | `ftps://[user:pass@]host[:port]/path` | `ftps://user:pass@secure.example.com` |
| SFTP | `sftp://[user:pass@]host[:port]/path` | `sftp://user@host.com/home/user` |
| S3 | `s3://bucket/path` | `s3://my-bucket/data` |
| Azure Data Lake | `azure://account.dfs.core.windows.net/filesystem/path` | `azure://myaccount.dfs.core.windows.net/myfs` |
| Azure Blob | `blob://account.blob.core.windows.net/container/path` | `blob://myaccount.blob.core.windows.net/mycontainer` |

### Named Constructors

For more control over connection parameters, use named constructors:

```python
from ftpc import Storage

# S3 with explicit configuration
async with Storage.s3(
    bucket="my-bucket",
    region="us-east-1",
    access_key_id="...",
    secret_access_key="..."
) as store:
    await store.list()

# FTP with TLS
with Storage.ftp(
    host="ftp.example.com",
    username="user",
    password="pass",
    tls=True
).sync() as store:
    store.list()

# SFTP with key authentication
with Storage.sftp(
    host="server.example.com",
    username="user",
    key_filename="/path/to/key"
).sync() as store:
    store.list()

# Azure Data Lake
async with Storage.azure(
    account_url="https://myaccount.dfs.core.windows.net",
    filesystem="myfilesystem",
    account_key="..."
) as store:
    await store.list()

# Local filesystem
with Storage.local("/home/user/data").sync() as store:
    files = store.list()
```

### Available Operations

All storage sessions provide these methods:

| Method | Description |
|--------|-------------|
| `list(path=None)` | List files/directories (defaults to base path) |
| `download(remote, local, progress=None)` | Download a file |
| `upload(local, remote, progress=None)` | Upload a file |
| `delete(path)` | Delete a file |
| `mkdir(path)` | Create a directory |

The `progress` callback receives bytes transferred and returns `False` to cancel.

## Claude Code Skills

This repository includes skills for [Claude Code](https://claude.ai/code) that enable AI agents to interact with remote storage backends.

### Available Skills

| Skill | Description |
|-------|-------------|
| `ftpc-storage` | Read-only access to storage backends. List directories, download files, inspect metadata. |
| `ftpc-storage-write` | Full read-write access. Upload, delete, and create directories in addition to read operations. |

### Installation

Copy the skill directories from `skills/` to your Claude Code skills directory:

```bash
cp -r skills/ftpc-storage ~/.claude/skills/
cp -r skills/ftpc-storage-write ~/.claude/skills/
```

The skills provide AI agents with documented patterns for using the `ftpc` library to access local filesystems, FTP/SFTP servers, S3 buckets, and Azure storage.
