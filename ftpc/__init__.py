"""FTPC - A unified client for remote storage backends.

This package provides easy-to-use interfaces for connecting to various
storage backends including local filesystem, FTP/FTPS, SFTP, S3,
Azure Data Lake, and Azure Blob Storage.

Quick Start:
    from ftpc import Storage

    # Async with URL
    async with Storage.connect("s3://my-bucket") as store:
        files = await store.list("/")

    # Sync with URL
    with Storage.connect_sync("sftp://user:pass@host") as store:
        files = store.list("/")

    # Named constructors
    async with Storage.s3(bucket="my-bucket") as store:
        await store.upload("local.txt", "/remote.txt")
"""

from ftpc.storage import (
    Storage,
    StorageBuilder,
    SyncStorageSession,
    AsyncStorageSession,
    connect,
    connect_sync,
)
from ftpc.exceptions import (
    StorageError,
    StorageConnectionError,
    UnsupportedProtocolError,
    MissingDependencyError,
)

__all__ = [
    # Main facade
    "Storage",
    # Session types
    "StorageBuilder",
    "SyncStorageSession",
    "AsyncStorageSession",
    # Exceptions
    "StorageError",
    "StorageConnectionError",
    "UnsupportedProtocolError",
    "MissingDependencyError",
    # Convenience functions
    "connect",
    "connect_sync",
]

__version__ = "0.1.0"
