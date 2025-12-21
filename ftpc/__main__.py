import argparse
import os
import sys
from pathlib import PurePath
from typing import IO, Optional

from ftpc.clients.client import Client
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
    """Create a client based on remote configuration type."""
    match remote_config.type:
        case "ftp":
            assert isinstance(remote_config, FtpConfig)
            return FtpClient(
                remote_config.url,
                tls=remote_config.tls,
                username=remote_config.username,
                password=remote_config.password,
                name=remote_config.name,
                proxy_config=remote_config.proxy,
            )
        case "local":
            return LocalClient()
        case "azure":
            if not AZURE_AVAILABLE:
                raise Exit(
                    "fatal error: Azure support requires additional dependencies.\n"
                    "Install with: pip install azure-storage-file-datalake azure-identity"
                )

            assert isinstance(remote_config, AzureConfig)
            return AzureClient(
                remote_config.url,
                filesystem_name=remote_config.filesystem,
                connection_string=remote_config.connection_string,
                account_key=remote_config.account_key,
                name=remote_config.name,
                proxy_config=remote_config.proxy,
            )
        case "s3":
            if not S3_AVAILABLE:
                raise Exit(
                    "fatal error: S3 support requires additional dependencies.\n"
                    "Install with: pip install boto3"
                )

            assert isinstance(remote_config, S3Config)
            return S3Client(
                bucket_name=remote_config.get_bucket_name(),
                endpoint_url=remote_config.endpoint_url,
                aws_access_key_id=remote_config.aws_access_key_id,
                aws_secret_access_key=remote_config.aws_secret_access_key,
                region_name=remote_config.region_name,
                name=remote_config.name,
                proxy_config=remote_config.proxy,
            )
        case "sftp":
            if not SFTP_AVAILABLE:
                raise Exit(
                    "fatal error: SFTP support requires additional dependencies.\n"
                    "Install with: pip install paramiko"
                )

            assert isinstance(remote_config, SftpConfig)
            return SftpClient(
                remote_config.url,
                port=remote_config.port,
                username=remote_config.username,
                password=remote_config.password,
                key_filename=remote_config.key_filename,
                name=remote_config.name,
                proxy_config=remote_config.proxy,
            )
        case "blob":
            if not BLOB_AVAILABLE:
                raise Exit(
                    "fatal error: Azure Blob support requires additional dependencies.\n"
                    "Install with: pip install azure-storage-blob azure-identity"
                )

            assert isinstance(remote_config, BlobConfig)
            return AzureBlobClient(
                remote_config.url,
                container_name=remote_config.container,
                connection_string=remote_config.connection_string,
                account_key=remote_config.account_key,
                name=remote_config.name,
                proxy_config=remote_config.proxy,
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

        client = create_client(remote_config, remote_name)

        tui = Tui(client, cwd=PurePath(path))
        tui.start()

        # Reset for next iteration - show selector
        remote_name = None
        path = "/"


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
            # Default config file doesn't exist
            raise Exit(
                f"Configuration file not found at {default_config_path}. Please create it first."
            )

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
