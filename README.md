# FTPC (File Transfer Protocol Client)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A terminal-based (TUI) file transfer client that supports multiple storage backends, providing a unified interface for browsing, uploading, downloading, and managing files across different storage systems.

## Features

- **Multi-protocol support:**
  - Local filesystem
  - FTP/FTPS (with TLS support)
  - SFTP (SSH File Transfer Protocol)
  - AWS S3
  - Azure Data Lake Storage Gen2

- **Terminal UI (TUI) interface** with intuitive navigation:
  - File browsing with directory navigation
  - File operations (upload, download, delete)
  - Search functionality
  - History-based navigation

- **Configuration-based** connection management using TOML format
- **Modular design** with abstract client interfaces for extensibility

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

Example configuration:

```toml
# Local client configuration
[local]
type = "local"
# No specific configuration needed for local file access

# FTP client configuration
[ftp]
type = "ftp"
url = "ftp://ftp.example.com"
username = "user"
password = "password"
tls = false

# SFTP client configuration
[sftp]
type = "sftp"
url = "sftp.example.com"
username = "user"
password = "password"  # Can use password or key-based authentication
port = 22
key_filename = "/path/to/private_key"

# AWS S3 client configuration
[s3]
type = "s3"
url = "s3://my-bucket"  # Or use bucket_name instead of url
region_name = "us-west-2"
# AWS credentials are typically loaded from environment variables or ~/.aws/credentials
# Uncomment these lines if you need to specify credentials directly
# aws_access_key_id = "YOUR_ACCESS_KEY"
# aws_secret_access_key = "YOUR_SECRET_KEY"
endpoint_url = ""  # Optional: for S3-compatible services

# Azure Data Lake Storage Gen2 configuration
[azure]
type = "azure"
url = "mystorageaccount.dfs.core.windows.net"
filesystem = "myfilesystem"
# Authentication typically uses environment variables or Azure CLI login
# Can specify these if needed:
# connection_string = "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
# account_key = "..."
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

## Requirements

- Python 3.10+ (uses match statements and modern type annotations)
- Optional backend-specific dependencies as listed in the installation section

## Development

Type checking:
```bash
mypy ftpc
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.