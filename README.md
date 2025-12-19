# ftpc

ftpc is a simple TUI file transfer client that supports multiple storage backends.
It is designed to be simple and hackable, and doubles as a quick-and-dirty library
to access the storage backends programmatically.

The project was born out of frustration with Microsoft's tools to access Azure storage;
most of my needs are relatively simple and I have no need for software that's complex
and slow.

A substantial part of the development was assisted by artificial intelligence tools,
and the project doubles as a training ground to see how far these tools can be pushed.

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

### From Source (Development)
Clone the repository and install in editable mode:
```bash
git clone https://github.com/edoannunziata/ftpc.git
cd ftpc
pip install -e .
```

### Full Installation (all backends)
To install with all optional backend dependencies:
```bash
pip install -e ".[all]"
```

The basic installation includes support for **Local filesystem** and **FTP/FTPS** backends. The full installation adds support for SFTP, S3, and Azure.

### Installing Specific Backends

You can also install only the backends you need:

For Azure Data Lake Storage Gen2:
```bash
pip install azure-storage-file-datalake azure-identity
```

For AWS S3 (and S3-compatible services):
```bash
pip install boto3
```

For SFTP:
```bash
pip install paramiko
```

## Configuration

FTPC uses a TOML configuration file to manage connection details. By default, it looks for `~/.ftpcconf.toml`.

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
password = "password"               # Optional: Password for authentication
key_filename = "/path/to/private_key"  # Optional: Path to private key file
```

**Authentication:** You must provide either `password` or `key_filename` (or both). If using key-based authentication, ensure the private key file has appropriate permissions (typically `chmod 600`).

#### AWS S3 Client

```toml
[s3]
type = "s3"
url = "s3://my-bucket"              # S3 URL format (use this OR bucket_name)
bucket_name = "my-bucket"           # Bucket name (use this OR url)
region_name = "us-west-2"           # Optional: AWS region
endpoint_url = "https://s3.amazonaws.com"  # Optional: Custom endpoint (for S3-compatible services like MinIO)
aws_access_key_id = "ACCESS_KEY"    # Optional: AWS access key
aws_secret_access_key = "SECRET_KEY"  # Optional: AWS secret key
```

**Bucket specification:** Use either `url` (e.g., `s3://my-bucket`) or `bucket_name`, but not both. If both are provided, `url` takes precedence.

**Credentials:** AWS credentials are loaded in the following order of precedence:
1. Explicit `aws_access_key_id`/`aws_secret_access_key` in the config
2. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
3. AWS credentials file (`~/.aws/credentials`)

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
| Up/Down       | Navigate file list                  |
| Enter         | Enter directory or download file    |
| Left Arrow    | Go back in navigation history       |
| p             | Go to parent directory              |
| r             | Refresh current directory           |
| u             | Toggle upload mode                  |
| d             | Delete selected file                |
| /             | Search for files                    |
| ?             | Show help dialog                    |
| q             | Quit application                    |

**Navigation history:** The Left Arrow key navigates through previously visited directories (like a browser's back button), while `p` always moves to the immediate parent directory.

**Upload mode:** When upload mode is enabled (press `u`), pressing Enter on a file will upload it to the remote instead of downloading. Press `u` again to return to normal (download) mode.

## File Transfers

**Downloads:** Files are downloaded to the directory where ftpc was launched (your shell's current working directory). A confirmation dialog is shown before each download.

**Uploads:** When upload mode is enabled, files from the remote are replaced with local files of the same name from your current working directory.
