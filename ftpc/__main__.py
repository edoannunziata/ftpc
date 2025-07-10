import argparse
import os
from pathlib import PurePath

from ftpc.clients.client import Client
from ftpc.clients.ftpclient import FtpClient
from ftpc.clients.localclient import LocalClient
from ftpc.tui import Tui
from ftpc.config import Config, ConfigError, RemoteNotFoundError, ValidationError
from ftpc.config.remotes import FtpConfig, LocalConfig, S3Config, AzureConfig, SftpConfig

try:
    from ftpc.clients.azureclient import AzureClient

    AZURE_AVAILABLE = True
except ImportError:
    AZURE_AVAILABLE = False

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


def config_file_type(path):
    """Custom FileType that doesn't error if default file doesn't exist."""
    default_config_path = os.path.expanduser("~/.ftpcconf.toml")
    # If it's the default path and doesn't exist, we'll handle the error later
    if path == default_config_path and not os.path.exists(path):
        return None
    return open(path, "rb")


def main():
    """Main entry point for the ftpc application."""
    parser = argparse.ArgumentParser(
        prog="ftpc", description="connect to file storage services"
    )

    default_config_path = os.path.expanduser("~/.ftpcconf.toml")

    parser.add_argument("--config", type=config_file_type, default=default_config_path)
    parser.add_argument("remote")
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

        # Get the requested remote configuration
        try:
            remote_config = config.get_remote(args.remote)
        except RemoteNotFoundError as e:
            raise Exit(str(e))

        # Create client based on configuration type
        client: Client | None
        match remote_config.type:
            case "ftp":
                ftp_config = remote_config  # type: FtpConfig
                client = FtpClient(
                    ftp_config.url,
                    tls=ftp_config.tls,
                    username=ftp_config.username,
                    password=ftp_config.password,
                    name=ftp_config.name,
                )
            case "local":
                client = LocalClient()
            case "azure":
                if not AZURE_AVAILABLE:
                    raise Exit(
                        "fatal error: Azure support requires additional dependencies.\n"
                        "Install with: pip install azure-storage-file-datalake azure-identity"
                    )

                azure_config = remote_config  # type: AzureConfig
                client = AzureClient(
                    azure_config.url,
                    filesystem_name=azure_config.filesystem,
                    connection_string=azure_config.connection_string,
                    account_key=azure_config.account_key,
                    name=azure_config.name,
                )
            case "s3":
                if not S3_AVAILABLE:
                    raise Exit(
                        "fatal error: S3 support requires additional dependencies.\n"
                        "Install with: pip install boto3"
                    )

                s3_config = remote_config  # type: S3Config
                client = S3Client(
                    bucket_name=s3_config.get_bucket_name(),
                    endpoint_url=s3_config.endpoint_url,
                    aws_access_key_id=s3_config.aws_access_key_id,
                    aws_secret_access_key=s3_config.aws_secret_access_key,
                    region_name=s3_config.region_name,
                    name=s3_config.name,
                )
            case "sftp":
                if not SFTP_AVAILABLE:
                    raise Exit(
                        "fatal error: SFTP support requires additional dependencies.\n"
                        "Install with: pip install paramiko"
                    )

                sftp_config = remote_config  # type: SftpConfig
                client = SftpClient(
                    sftp_config.url,
                    port=sftp_config.port,
                    username=sftp_config.username,
                    password=sftp_config.password,
                    key_filename=sftp_config.key_filename,
                    name=sftp_config.name,
                )
            case _:
                raise Exit(
                    f"fatal error: unknown remote type '{remote_config.type}' for remote {args.remote}."
                )

        tui = Tui(client, cwd=PurePath(args.path))
        tui.start()

    except Exit as e:
        print(e)
    finally:
        if args.config is not None:
            args.config.close()


if __name__ == "__main__":
    main()
