"""Client plugins for ftpc."""

from typing import List, Type

from ftpc.clients.client import Client
from ftpc.clients.localclient import LocalClient
from ftpc.clients.ftpclient import FtpClient

# Async client infrastructure
from ftpc.clients.async_client import AsyncClient
from ftpc.clients.async_wrapper import AsyncClientWrapper

# Sync client implementations (wrapped with AsyncClientWrapper for async use)
_client_classes: List[Type[Client]] = [
    LocalClient,
    FtpClient,
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

__all__ = (
    ['Client', 'AsyncClient', 'AsyncClientWrapper']
    + [cls.__name__ for cls in _client_classes]
)
