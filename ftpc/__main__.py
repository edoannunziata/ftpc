import argparse
import tomllib
import importlib.util
import os
from pathlib import Path, PurePath

from ftpc.clients.client import Client
from ftpc.clients.ftpclient import FtpClient
from ftpc.clients.localclient import LocalClient
from ftpc.tui import Tui

# Check if Azure dependencies are available
AZURE_AVAILABLE = importlib.util.find_spec("azure.storage.filedatalake") is not None
if AZURE_AVAILABLE:
    try:
        from ftpc.clients.azureclient import AzureClient
    except ImportError:
        AZURE_AVAILABLE = False

# Check if S3 dependencies are available
S3_AVAILABLE = importlib.util.find_spec("boto3") is not None
if S3_AVAILABLE:
    try:
        from ftpc.clients.s3client import S3Client
    except ImportError:
        S3_AVAILABLE = False

# Check if SFTP dependencies are available
SFTP_AVAILABLE = importlib.util.find_spec("paramiko") is not None
if SFTP_AVAILABLE:
    try:
        from ftpc.clients.sftpclient import SftpClient
    except ImportError:
        SFTP_AVAILABLE = False

parser = argparse.ArgumentParser(
    prog='ftpc',
    description='connect to file storage services'
)

default_config_path = os.path.expanduser('~/.ftpcconf.toml')

# Custom FileType that doesn't error if default file doesn't exist
def config_file_type(path):
    # If it's the default path and doesn't exist, we'll handle the error later
    if path == default_config_path and not os.path.exists(path):
        return None
    return open(path, 'rb')

parser.add_argument(
    '--config',
    type=config_file_type,
    default=default_config_path
)
parser.add_argument('remote')
parser.add_argument('path', nargs='?', const='/', default='/')

args = parser.parse_args()


class Exit(Exception):
    pass


try:
    if args.config is None:
        # Default config file doesn't exist
        raise Exit(f"Configuration file not found at {default_config_path}. Please create it first.")
        
    config = tomllib.load(args.config)
    if args.remote not in config:
        raise Exit(f'fatal error: remote {args.remote} not in configuration file.')

    remote: dict = config[args.remote]
    if 'type' not in remote:
        raise Exit(f'fatal error: missing type in configuration section for remote {args.remote}.')
    
    # Only check for URL if not an S3 client
    if remote.get('type') != 's3' and 'url' not in remote:
        raise Exit(f'fatal error: missing url in configuration section for remote {args.remote}.')

    client: Client | None
    match remote.get('type'):
        case 'ftp':
            client = FtpClient(
                remote['url'],
                tls=remote.get('tls', False),
                username=remote.get('username', 'anonymous'),
                password=remote.get('password', 'anonymous@'),
                name=args.remote
            )
        case 'local':
            client = LocalClient()
        case 'azure':
            if not AZURE_AVAILABLE:
                raise Exit(
                    'fatal error: Azure support requires additional dependencies.\n'
                    'Install with: pip install azure-storage-file-datalake azure-identity'
                )

            # Check for required Azure-specific configuration
            if 'filesystem' not in remote:
                raise Exit(f'fatal error: missing filesystem in configuration section for Azure remote {args.remote}.')

            client = AzureClient(
                remote['url'],
                filesystem_name=remote['filesystem'],
                connection_string=remote.get('connection_string'),
                account_key=remote.get('account_key'),
                name=args.remote
            )
        case 's3':
            if not S3_AVAILABLE:
                raise Exit(
                    'fatal error: S3 support requires additional dependencies.\n'
                    'Install with: pip install boto3'
                )

            # Check for required S3-specific configuration
            bucket_name = None
            if 'url' in remote:
                # Parse URL in the format s3://bucket-name
                url = remote['url']
                if url.startswith('s3://'):
                    bucket_name = url[5:]  # Remove 's3://' prefix
                else:
                    raise Exit(f'fatal error: invalid S3 URL format in configuration for remote {args.remote}. Should be s3://bucket-name')
            elif 'bucket_name' in remote:
                bucket_name = remote['bucket_name']
            else:
                raise Exit(f'fatal error: missing url or bucket_name in configuration section for S3 remote {args.remote}.')

            client = S3Client(
                bucket_name=bucket_name,
                endpoint_url=remote.get('endpoint_url'),
                aws_access_key_id=remote.get('aws_access_key_id'),
                aws_secret_access_key=remote.get('aws_secret_access_key'),
                region_name=remote.get('region_name'),
                name=args.remote
            )
        case 'sftp':
            if not SFTP_AVAILABLE:
                raise Exit(
                    'fatal error: SFTP support requires additional dependencies.\n'
                    'Install with: pip install paramiko'
                )

            # Check for required SFTP-specific configuration
            client = SftpClient(
                remote['url'],
                port=remote.get('port', 22),
                username=remote.get('username'),
                password=remote.get('password'),
                key_filename=remote.get('key_filename'),
                name=args.remote
            )
        case _:
            raise Exit(f'fatal error: unknown type in configuration section for remote {args.remote}.')

    tui = Tui(client, cwd=PurePath(args.path))
    tui.start()

except Exit as e:
    print(e)
finally:
    if args.config is not None:
        args.config.close()

