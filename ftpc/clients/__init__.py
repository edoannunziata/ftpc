"""Client plugins for ftpc."""

from typing import List, Type

from ftpc.clients.client import Client
from ftpc.clients.localclient import LocalClient
from ftpc.clients.ftpclient import FtpClient

# Async client base classes (always available)
from ftpc.clients.async_client import AsyncClient
from ftpc.clients.async_wrapper import AsyncClientWrapper
from ftpc.clients.async_local_client import AsyncLocalClient

# Attempt to import optional clients based on available dependencies
_client_classes: List[Type[Client]] = [
    LocalClient,
    FtpClient,
]

_async_client_classes: List[Type[AsyncClient]] = [
    AsyncLocalClient,
]

# Try to import Azure client
try:
    from ftpc.clients.azureclient import AzureClient
    _client_classes.append(AzureClient)
except ImportError:
    pass

# Try to import S3 client
try:
    from ftpc.clients.s3client import S3Client
    _client_classes.append(S3Client)
except ImportError:
    pass

# Try to import SFTP client
try:
    from ftpc.clients.sftpclient import SftpClient
    _client_classes.append(SftpClient)
except ImportError:
    pass

# Try to import Azure Blob client
try:
    from ftpc.clients.azureblobclient import AzureBlobClient
    _client_classes.append(AzureBlobClient)
except ImportError:
    pass

# Try to import async FTP client (requires aioftp)
try:
    from ftpc.clients.async_ftp_client import AsyncFtpClient
    _async_client_classes.append(AsyncFtpClient)
except ImportError:
    pass

# Try to import async SFTP client (requires asyncssh)
try:
    from ftpc.clients.async_sftp_client import AsyncSftpClient
    _async_client_classes.append(AsyncSftpClient)
except ImportError:
    pass

# Try to import async S3 client (requires aioboto3)
try:
    from ftpc.clients.async_s3_client import AsyncS3Client
    _async_client_classes.append(AsyncS3Client)
except ImportError:
    pass

# Try to import async Azure clients (requires azure SDK with async support)
try:
    from ftpc.clients.async_azure_client import AsyncAzureClient
    _async_client_classes.append(AsyncAzureClient)
except ImportError:
    pass

try:
    from ftpc.clients.async_azure_blob_client import AsyncAzureBlobClient
    _async_client_classes.append(AsyncAzureBlobClient)
except ImportError:
    pass

__all__ = (
    ['Client', 'AsyncClient', 'AsyncClientWrapper']
    + [cls.__name__ for cls in _client_classes]
    + [cls.__name__ for cls in _async_client_classes]
)

