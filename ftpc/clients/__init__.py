"""Client plugins for ftpc."""

from typing import List, Type
import importlib

from ftpc.clients.client import Client
from ftpc.clients.localclient import LocalClient
from ftpc.clients.ftpclient import FtpClient

# Attempt to import optional clients based on available dependencies
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

__all__ = ['Client'] + [cls.__name__ for cls in _client_classes]

