import argparse
import importlib.resources
import os
import sys
from pathlib import PurePath
from typing import IO, Optional

from ftpc.clients.client import Client
from ftpc.clients.async_wrapper import AsyncClientWrapper
from ftpc.clients.ftpclient import FtpClient
from ftpc.clients.localclient import LocalClient
from ftpc.tui import Tui, RemoteSelector
from ftpc.config import Config, ConfigError, RemoteNotFoundError, ValidationError
from ftpc.config.base import BaseRemoteConfig
from ftpc.config.remotes import (
    FtpConfig,
    S3Config,
    AzureConfig,
    SftpConfig,
    BlobConfig,
    LocalConfig,
)

try:
    from ftpc.clients.azureclient import AzureClient

    AZURE_AVAILABLE = True
except ImportError:
    AZURE_AVAILABLE = False

try:
    from ftpc.clients.azureblobclient import AzureBlobClient

    BLOB_AVAILABLE = True
except ImportError:
    BLOB_AVAILABLE = False

try:
    from ftpc.clients.s3client import S3Client

    S3_AVAILABLE = True
except ImportError:
    S3_AVAILABLE = False

try:
    from ftpc.clients.sftpclient import SftpClient

    SFTP_AVAILABLE = True
except ImportError:
    SFTP_AVAILABLE = False


class Exit(Exception):
    pass


def create_client(remote_config: BaseRemoteConfig, remote_name: str) -> Client:
    match remote_config:
        case FtpConfig() as c:
            return FtpClient(
                c.url,
                port=c.port,
                tls=c.tls,
                username=c.username,
                password=c.password,
                name=c.name,
                proxy_config=c.proxy,
            )
        case LocalConfig():
            return LocalClient()
        case AzureConfig() as c:
            if not AZURE_AVAILABLE:
                raise Exit(
                    "fatal error: Azure support requires additional dependencies.\n"
                    "Install with: pip install azure-storage-file-datalake azure-identity"
                )

            return AzureClient(
                c.url,
                filesystem_name=c.filesystem,
                connection_string=c.connection_string,
                account_key=c.account_key,
                name=c.name,
                proxy_config=c.proxy,
            )
        case S3Config() as c:
            if not S3_AVAILABLE:
                raise Exit(
                    "fatal error: S3 support requires additional dependencies.\n"
                    "Install with: pip install boto3"
                )

            return S3Client(
                bucket_name=c.get_bucket_name(),
                endpoint_url=c.endpoint_url,
                aws_access_key_id=c.aws_access_key_id,
                aws_secret_access_key=c.aws_secret_access_key,
                region_name=c.region_name,
                name=c.name,
                proxy_config=c.proxy,
            )
        case SftpConfig() as c:
            if not SFTP_AVAILABLE:
                raise Exit(
                    "fatal error: SFTP support requires additional dependencies.\n"
                    "Install with: pip install paramiko"
                )

            return SftpClient(
                c.url,
                port=c.port,
                username=c.username,
                password=c.password,
                key_filename=c.key_filename,
                name=c.name,
                proxy_config=c.proxy,
            )
        case BlobConfig() as c:
            if not BLOB_AVAILABLE:
                raise Exit(
                    "fatal error: Azure Blob support requires additional dependencies.\n"
                    "Install with: pip install azure-storage-blob azure-identity"
                )

            return AzureBlobClient(
                c.url,
                container_name=c.container,
                connection_string=c.connection_string,
                account_key=c.account_key,
                name=c.name,
                proxy_config=c.proxy,
            )
        case _:
            raise Exit(
                f"fatal error: unknown remote type '{remote_config.type}' for remote {remote_name}."
            )


def run_tui_loop(config: Config, initial_remote: str | None, initial_path: str) -> None:
    """Main loop: show selector, connect to remote, repeat when user presses 'q'."""
    remote_name = initial_remote
    path = initial_path

    while True:
        # Show interactive selection menu if no remote specified
        if remote_name is None:
            selector = RemoteSelector(config.remotes)
            result = selector.start()
            if result is None:
                # User quit the selector - exit
                return
            remote_name, path = result

        # Get remote config and create client
        try:
            remote_config = config.get_remote(remote_name)
        except RemoteNotFoundError as e:
            raise Exit(str(e))

        sync_client = create_client(remote_config, remote_name)
        async_client = AsyncClientWrapper(sync_client)

        tui = Tui(async_client, cwd=PurePath(path))
        tui.start()

        # Reset for next iteration - show selector
        remote_name = None
        path = "/"


def create_default_config(path: str) -> None:
    """Create a default configuration file from the sample config."""
    sample = importlib.resources.files("ftpc").joinpath("sample_config.toml")
    content = sample.read_text()
    with open(path, "w") as f:
        f.write(content)


def config_file_type(path: str) -> Optional[IO[bytes]]:
    """Custom FileType that doesn't error if default file doesn't exist."""
    default_config_path = os.path.expanduser("~/.ftpcconf.toml")
    # If it's the default path and doesn't exist, we'll handle the error later
    if path == default_config_path and not os.path.exists(path):
        return None
    return open(path, "rb")


def main() -> None:
    """Main entry point for the ftpc application."""
    parser = argparse.ArgumentParser(
        prog="ftpc", description="connect to file storage services"
    )

    default_config_path = os.path.expanduser("~/.ftpcconf.toml")

    parser.add_argument("--config", type=config_file_type, default=default_config_path)
    parser.add_argument("remote", nargs="?", default=None)
    parser.add_argument("path", nargs="?", const="/", default="/")

    args = parser.parse_args()

    try:
        if args.config is None:
            # Default config file doesn't exist, create it
            create_default_config(default_config_path)
            print(f"Created default configuration at {default_config_path}", file=sys.stderr)
            args.config = open(default_config_path, "rb")

        # Load configuration using new Config system
        try:
            config = Config.from_file(args.config)
        except (ConfigError, ValidationError) as e:
            raise Exit(f"Configuration error: {e}")

        # Show configuration warnings if any
        warnings = config.get_warnings()
        if warnings:
            for warning in warnings:
                print(f"Warning: {warning}", file=sys.stderr)

        run_tui_loop(config, args.remote, args.path)

    except Exit as e:
        print(e)
    finally:
        if args.config is not None:
            args.config.close()


if __name__ == "__main__":
    main()
