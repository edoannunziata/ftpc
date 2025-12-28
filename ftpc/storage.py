"""Storage facade for simplified access to remote storage backends.

This module provides a unified, easy-to-use interface for connecting to various
storage backends without needing to understand the underlying client implementations.

Example usage:

    # Async context manager with URL
    async with Storage.connect("s3://my-bucket") as store:
        files = await store.list("/")
        await store.download("/remote/file.txt", "local.txt")

    # Sync context manager with URL
    with Storage.connect_sync("sftp://user:pass@host/path") as store:
        store.upload("local.txt", "/remote/file.txt")

    # Named constructors for explicit configuration
    async with Storage.s3(bucket="my-bucket", region="us-east-1") as store:
        await store.list("/")

    # Sync usage with named constructors
    with Storage.ftp(host="ftp.example.com", username="user", password="pass").sync() as store:
        store.list("/")
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePath
from types import TracebackType
from typing import (
    AsyncIterator,
    Callable,
    Iterator,
    List,
    Optional,
    Union,
    TYPE_CHECKING,
)
from typing_extensions import Self
from urllib.parse import urlparse, unquote

from ftpc.clients.client import Client
from ftpc.clients.async_wrapper import AsyncClientWrapper
from ftpc.clients.localclient import LocalClient
from ftpc.clients.ftpclient import FtpClient
from ftpc.exceptions import MissingDependencyError, UnsupportedProtocolError
from ftpc.filedescriptor import FileDescriptor

if TYPE_CHECKING:
    from ftpc.config.remotes import ProxyConfig


# Optional dependency flags
try:
    from ftpc.clients.s3client import S3Client

    _S3_AVAILABLE = True
except ImportError:
    _S3_AVAILABLE = False

try:
    from ftpc.clients.sftpclient import SftpClient

    _SFTP_AVAILABLE = True
except ImportError:
    _SFTP_AVAILABLE = False

try:
    from ftpc.clients.azureclient import AzureClient

    _AZURE_AVAILABLE = True
except ImportError:
    _AZURE_AVAILABLE = False

try:
    from ftpc.clients.azureblobclient import AzureBlobClient

    _BLOB_AVAILABLE = True
except ImportError:
    _BLOB_AVAILABLE = False


@dataclass
class ParsedURL:
    """Parsed components of a storage URL."""

    protocol: str
    host: str
    port: Optional[int]
    username: Optional[str]
    password: Optional[str]
    path: str


def _parse_storage_url(url: str) -> ParsedURL:
    """Parse a storage URL into its components.

    Supported URL formats:
        - ftp://[user[:pass]@]host[:port][/path]
        - ftps://[user[:pass]@]host[:port][/path]
        - sftp://[user[:pass]@]host[:port][/path]
        - s3://bucket[/path]
        - azure://account.dfs.core.windows.net/filesystem[/path]
        - blob://account.blob.core.windows.net/container[/path]
        - file:///path or /path (local filesystem)
    """
    # Handle local paths without protocol
    if url.startswith("/"):
        return ParsedURL(
            protocol="file",
            host="",
            port=None,
            username=None,
            password=None,
            path=url,
        )

    parsed = urlparse(url)
    protocol = parsed.scheme.lower()

    # Extract credentials if present
    username = unquote(parsed.username) if parsed.username else None
    password = unquote(parsed.password) if parsed.password else None

    # Handle port
    port = parsed.port

    # Get host and path
    host = parsed.hostname or ""
    path = parsed.path or "/"

    return ParsedURL(
        protocol=protocol,
        host=host,
        port=port,
        username=username,
        password=password,
        path=path,
    )


def _create_client_from_url(url: str) -> tuple[Client, str]:
    """Create a sync client from a URL string.

    Returns:
        Tuple of (client, initial_path)
    """
    parsed = _parse_storage_url(url)

    if parsed.protocol in ("file", ""):
        return LocalClient(), parsed.path

    elif parsed.protocol in ("ftp", "ftps"):
        return (
            FtpClient(
                url=parsed.host,
                port=parsed.port or 21,
                tls=(parsed.protocol == "ftps"),
                username=parsed.username or "anonymous",
                password=parsed.password or "anonymous@",
            ),
            parsed.path,
        )

    elif parsed.protocol == "sftp":
        if not _SFTP_AVAILABLE:
            raise MissingDependencyError(
                "SFTP support requires paramiko. Install with: pip install paramiko"
            )
        return (
            SftpClient(
                host=parsed.host,
                port=parsed.port or 22,
                username=parsed.username,
                password=parsed.password,
            ),
            parsed.path,
        )

    elif parsed.protocol == "s3":
        if not _S3_AVAILABLE:
            raise MissingDependencyError(
                "S3 support requires boto3. Install with: pip install boto3"
            )
        # For S3, the host is the bucket name
        return S3Client(bucket_name=parsed.host), parsed.path

    elif parsed.protocol == "azure":
        if not _AZURE_AVAILABLE:
            raise MissingDependencyError(
                "Azure Data Lake support requires azure-storage-file-datalake. "
                "Install with: pip install azure-storage-file-datalake azure-identity"
            )
        # URL format: azure://account.dfs.core.windows.net/filesystem/path
        # The host contains the account URL, path starts with /filesystem
        account_url = f"https://{parsed.host}"
        path_parts = parsed.path.strip("/").split("/", 1)
        filesystem = path_parts[0] if path_parts else ""
        remaining_path = "/" + path_parts[1] if len(path_parts) > 1 else "/"

        return (
            AzureClient(
                account_url=account_url,
                filesystem_name=filesystem,
            ),
            remaining_path,
        )

    elif parsed.protocol == "blob":
        if not _BLOB_AVAILABLE:
            raise MissingDependencyError(
                "Azure Blob support requires azure-storage-blob. "
                "Install with: pip install azure-storage-blob azure-identity"
            )
        # URL format: blob://account.blob.core.windows.net/container/path
        account_url = f"https://{parsed.host}"
        path_parts = parsed.path.strip("/").split("/", 1)
        container = path_parts[0] if path_parts else ""
        remaining_path = "/" + path_parts[1] if len(path_parts) > 1 else "/"

        return (
            AzureBlobClient(
                account_url=account_url,
                container_name=container,
            ),
            remaining_path,
        )

    else:
        raise UnsupportedProtocolError(
            f"Unsupported protocol: {parsed.protocol}. "
            f"Supported protocols: file, ftp, ftps, sftp, s3, azure, blob"
        )


class SyncStorageSession:
    """Synchronous storage session providing file operations.

    This class wraps a sync Client and provides a simplified interface
    for common file operations.
    """

    def __init__(self, client: Client, base_path: str = "/") -> None:
        self._client = client
        self._base_path = PurePath(base_path)
        self._entered = False

    def __enter__(self) -> Self:
        self._client.__enter__()
        self._entered = True
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        if self._entered:
            self._client.__exit__(exc_type, exc_val, exc_tb)
            self._entered = False

    @property
    def name(self) -> str:
        """Human-readable name for this storage."""
        return self._client.name()

    def list(self, path: Union[str, PurePath, None] = None) -> List[FileDescriptor]:
        """List files and directories at the given path.

        Args:
            path: Remote path to list. If None (default), lists the base path.
                  Relative paths are resolved against base_path.
                  Absolute paths are used as-is.

        Returns:
            List of FileDescriptor objects
        """
        if path is None:
            return self._client.ls(self._base_path)
        resolved = self._resolve_path(path)
        return self._client.ls(resolved)

    def download(
        self,
        remote_path: Union[str, PurePath],
        local_path: Union[str, Path],
        progress: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Download a file from remote storage.

        Args:
            remote_path: Path to remote file
            local_path: Path to save file locally
            progress: Optional callback receiving bytes downloaded, returns False to cancel
        """
        resolved = self._resolve_path(remote_path)
        local = Path(local_path) if isinstance(local_path, str) else local_path
        self._client.get(resolved, local, progress)

    def upload(
        self,
        local_path: Union[str, Path],
        remote_path: Union[str, PurePath],
        progress: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Upload a file to remote storage.

        Args:
            local_path: Path to local file
            remote_path: Path to save file remotely
            progress: Optional callback receiving bytes uploaded, returns False to cancel
        """
        resolved = self._resolve_path(remote_path)
        local = Path(local_path) if isinstance(local_path, str) else local_path
        self._client.put(local, resolved, progress)

    def delete(self, path: Union[str, PurePath]) -> bool:
        """Delete a file at the given path.

        Args:
            path: Path to file to delete

        Returns:
            True if deletion succeeded, False otherwise
        """
        resolved = self._resolve_path(path)
        return self._client.unlink(resolved)

    def mkdir(self, path: Union[str, PurePath]) -> bool:
        """Create a directory at the given path.

        Args:
            path: Path where directory should be created

        Returns:
            True if creation succeeded, False otherwise
        """
        resolved = self._resolve_path(path)
        return self._client.mkdir(resolved)

    def _resolve_path(self, path: Union[str, PurePath]) -> PurePath:
        """Resolve a path relative to the base path."""
        if isinstance(path, str):
            path = PurePath(path)
        if path.is_absolute():
            return path
        return self._base_path / path


class AsyncStorageSession:
    """Asynchronous storage session providing file operations.

    This class wraps an AsyncClient and provides a simplified interface
    for common file operations.
    """

    def __init__(
        self,
        client: Client,
        base_path: str = "/",
        executor: Optional[ThreadPoolExecutor] = None,
    ) -> None:
        self._sync_client = client
        self._async_client: Optional[AsyncClientWrapper] = None
        self._base_path = PurePath(base_path)
        self._executor = executor
        self._entered = False

    async def __aenter__(self) -> Self:
        self._async_client = AsyncClientWrapper(self._sync_client, self._executor)
        await self._async_client.__aenter__()
        self._entered = True
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        if self._entered and self._async_client:
            await self._async_client.__aexit__(exc_type, exc_val, exc_tb)
            self._entered = False

    @property
    def name(self) -> str:
        """Human-readable name for this storage."""
        if self._async_client:
            return self._async_client.name()
        return self._sync_client.name()

    async def list(
        self, path: Union[str, PurePath, None] = None
    ) -> List[FileDescriptor]:
        """List files and directories at the given path.

        Args:
            path: Remote path to list. If None (default), lists the base path.
                  Relative paths are resolved against base_path.
                  Absolute paths are used as-is.

        Returns:
            List of FileDescriptor objects
        """
        assert self._async_client is not None, "Session not entered"
        if path is None:
            return await self._async_client.ls(self._base_path)
        resolved = self._resolve_path(path)
        return await self._async_client.ls(resolved)

    async def download(
        self,
        remote_path: Union[str, PurePath],
        local_path: Union[str, Path],
        progress: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Download a file from remote storage.

        Args:
            remote_path: Path to remote file
            local_path: Path to save file locally
            progress: Optional callback receiving bytes downloaded, returns False to cancel
        """
        assert self._async_client is not None, "Session not entered"
        resolved = self._resolve_path(remote_path)
        local = Path(local_path) if isinstance(local_path, str) else local_path
        await self._async_client.get(resolved, local, progress)

    async def upload(
        self,
        local_path: Union[str, Path],
        remote_path: Union[str, PurePath],
        progress: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Upload a file to remote storage.

        Args:
            local_path: Path to local file
            remote_path: Path to save file remotely
            progress: Optional callback receiving bytes uploaded, returns False to cancel
        """
        assert self._async_client is not None, "Session not entered"
        resolved = self._resolve_path(remote_path)
        local = Path(local_path) if isinstance(local_path, str) else local_path
        await self._async_client.put(local, resolved, progress)

    async def delete(self, path: Union[str, PurePath]) -> bool:
        """Delete a file at the given path.

        Args:
            path: Path to file to delete

        Returns:
            True if deletion succeeded, False otherwise
        """
        assert self._async_client is not None, "Session not entered"
        resolved = self._resolve_path(path)
        return await self._async_client.unlink(resolved)

    async def mkdir(self, path: Union[str, PurePath]) -> bool:
        """Create a directory at the given path.

        Args:
            path: Path where directory should be created

        Returns:
            True if creation succeeded, False otherwise
        """
        assert self._async_client is not None, "Session not entered"
        resolved = self._resolve_path(path)
        return await self._async_client.mkdir(resolved)

    def _resolve_path(self, path: Union[str, PurePath]) -> PurePath:
        """Resolve a path relative to the base path."""
        if isinstance(path, str):
            path = PurePath(path)
        if path.is_absolute():
            return path
        return self._base_path / path


class StorageBuilder:
    """Builder for creating storage sessions with explicit configuration.

    Use the named constructors on the Storage class to create builders,
    then call .sync() or use as async context manager to get a session.
    """

    def __init__(self, client: Client, base_path: str = "/") -> None:
        self._client = client
        self._base_path = base_path

    def sync(self) -> SyncStorageSession:
        """Get a synchronous storage session.

        Returns:
            SyncStorageSession that can be used as a context manager
        """
        return SyncStorageSession(self._client, self._base_path)

    async def __aenter__(self) -> AsyncStorageSession:
        """Enter async context - creates and enters an AsyncStorageSession."""
        self._async_session = AsyncStorageSession(self._client, self._base_path)
        return await self._async_session.__aenter__()

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Exit async context."""
        await self._async_session.__aexit__(exc_type, exc_val, exc_tb)


class Storage:
    """Unified facade for accessing remote storage backends.

    This class provides simple, consistent access to various storage backends
    including local filesystem, FTP/FTPS, SFTP, S3, Azure Data Lake, and Azure Blob.

    Connection Methods:
        - connect(url): Async context manager using URL connection string
        - connect_sync(url): Sync context manager using URL connection string

    Named Constructors (return StorageBuilder for flexible sync/async usage):
        - Storage.local(): Local filesystem
        - Storage.ftp(...): FTP/FTPS server
        - Storage.sftp(...): SFTP server
        - Storage.s3(...): S3-compatible storage
        - Storage.azure(...): Azure Data Lake Gen2
        - Storage.azure_blob(...): Azure Blob Storage

    URL Formats:
        - file:///path or /path - Local filesystem
        - ftp://[user:pass@]host[:port]/path - FTP
        - ftps://[user:pass@]host[:port]/path - FTPS (FTP over TLS)
        - sftp://[user:pass@]host[:port]/path - SFTP
        - s3://bucket/path - AWS S3
        - azure://account.dfs.core.windows.net/filesystem/path - Azure Data Lake
        - blob://account.blob.core.windows.net/container/path - Azure Blob

    Examples:
        # Async with URL
        async with Storage.connect("s3://my-bucket") as store:
            files = await store.list("/")
            await store.download("/file.txt", "local.txt")

        # Sync with URL
        with Storage.connect_sync("ftp://ftp.example.com") as store:
            files = store.list("/")

        # Named constructor (async)
        async with Storage.s3(bucket="my-bucket", region="us-east-1") as store:
            await store.upload("local.txt", "/remote.txt")

        # Named constructor (sync)
        with Storage.ftp(host="ftp.example.com", username="user").sync() as store:
            store.list("/")
    """

    @staticmethod
    @asynccontextmanager
    async def connect(url: str) -> AsyncIterator[AsyncStorageSession]:
        """Connect to storage using a URL connection string (async).

        Args:
            url: Connection URL (see class docstring for formats)

        Yields:
            AsyncStorageSession for performing file operations

        Raises:
            UnsupportedProtocolError: If the URL protocol is not supported
            MissingDependencyError: If required dependencies are not installed
            StorageConnectionError: If connection fails
        """
        client, base_path = _create_client_from_url(url)
        session = AsyncStorageSession(client, base_path)
        async with session:
            yield session

    @staticmethod
    @contextmanager
    def connect_sync(url: str) -> Iterator[SyncStorageSession]:
        """Connect to storage using a URL connection string (sync).

        Args:
            url: Connection URL (see class docstring for formats)

        Yields:
            SyncStorageSession for performing file operations

        Raises:
            UnsupportedProtocolError: If the URL protocol is not supported
            MissingDependencyError: If required dependencies are not installed
            StorageConnectionError: If connection fails
        """
        client, base_path = _create_client_from_url(url)
        session = SyncStorageSession(client, base_path)
        with session:
            yield session

    @staticmethod
    def local(path: str = "/") -> StorageBuilder:
        """Create a local filesystem storage.

        Args:
            path: Base path for operations (default: root)

        Returns:
            StorageBuilder for sync/async usage
        """
        return StorageBuilder(LocalClient(), path)

    @staticmethod
    def ftp(
        host: str,
        *,
        port: int = 21,
        username: str = "anonymous",
        password: str = "anonymous@",
        tls: bool = False,
        proxy: Optional["ProxyConfig"] = None,
    ) -> StorageBuilder:
        """Create an FTP/FTPS storage connection.

        Args:
            host: FTP server hostname
            port: FTP server port (default: 21)
            username: Username for authentication
            password: Password for authentication
            tls: Use FTPS (FTP over TLS) if True
            proxy: Optional SOCKS5 proxy configuration

        Returns:
            StorageBuilder for sync/async usage
        """
        client = FtpClient(
            url=host,
            port=port,
            username=username,
            password=password,
            tls=tls,
            proxy_config=proxy,
        )
        return StorageBuilder(client)

    @staticmethod
    def sftp(
        host: str,
        *,
        port: int = 22,
        username: Optional[str] = None,
        password: Optional[str] = None,
        key_filename: Optional[str] = None,
        proxy: Optional["ProxyConfig"] = None,
    ) -> StorageBuilder:
        """Create an SFTP storage connection.

        Args:
            host: SFTP server hostname
            port: SFTP server port (default: 22)
            username: Username for authentication
            password: Password for authentication
            key_filename: Path to private key file
            proxy: Optional SOCKS5 proxy configuration

        Returns:
            StorageBuilder for sync/async usage

        Raises:
            MissingDependencyError: If paramiko is not installed
        """
        if not _SFTP_AVAILABLE:
            raise MissingDependencyError(
                "SFTP support requires paramiko. Install with: pip install paramiko"
            )
        client = SftpClient(
            host=host,
            port=port,
            username=username,
            password=password,
            key_filename=key_filename,
            proxy_config=proxy,
        )
        return StorageBuilder(client)

    @staticmethod
    def s3(
        bucket: str,
        *,
        region: Optional[str] = None,
        endpoint_url: Optional[str] = None,
        access_key_id: Optional[str] = None,
        secret_access_key: Optional[str] = None,
        proxy: Optional["ProxyConfig"] = None,
    ) -> StorageBuilder:
        """Create an S3-compatible storage connection.

        Args:
            bucket: S3 bucket name
            region: AWS region (optional)
            endpoint_url: Custom endpoint URL for S3-compatible services
            access_key_id: AWS access key ID (uses default credentials if not provided)
            secret_access_key: AWS secret access key
            proxy: Optional SOCKS5 proxy configuration

        Returns:
            StorageBuilder for sync/async usage

        Raises:
            MissingDependencyError: If boto3 is not installed
        """
        if not _S3_AVAILABLE:
            raise MissingDependencyError(
                "S3 support requires boto3. Install with: pip install boto3"
            )
        client = S3Client(
            bucket_name=bucket,
            region_name=region,
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            proxy_config=proxy,
        )
        return StorageBuilder(client)

    @staticmethod
    def azure(
        account_url: str,
        filesystem: str,
        *,
        connection_string: Optional[str] = None,
        account_key: Optional[str] = None,
        proxy: Optional["ProxyConfig"] = None,
    ) -> StorageBuilder:
        """Create an Azure Data Lake Gen2 storage connection.

        Args:
            account_url: Azure storage account URL
                         (e.g., 'https://account.dfs.core.windows.net')
            filesystem: Name of the filesystem (container)
            connection_string: Optional connection string for authentication
            account_key: Optional account key for authentication
            proxy: Optional SOCKS5 proxy configuration

        Returns:
            StorageBuilder for sync/async usage

        Raises:
            MissingDependencyError: If azure-storage-file-datalake is not installed
        """
        if not _AZURE_AVAILABLE:
            raise MissingDependencyError(
                "Azure Data Lake support requires azure-storage-file-datalake. "
                "Install with: pip install azure-storage-file-datalake azure-identity"
            )
        client = AzureClient(
            account_url=account_url,
            filesystem_name=filesystem,
            connection_string=connection_string,
            account_key=account_key,
            proxy_config=proxy,
        )
        return StorageBuilder(client)

    @staticmethod
    def azure_blob(
        account_url: str,
        container: str,
        *,
        connection_string: Optional[str] = None,
        account_key: Optional[str] = None,
        proxy: Optional["ProxyConfig"] = None,
    ) -> StorageBuilder:
        """Create an Azure Blob Storage connection.

        Args:
            account_url: Azure storage account URL
                         (e.g., 'https://account.blob.core.windows.net')
            container: Name of the blob container
            connection_string: Optional connection string for authentication
            account_key: Optional account key for authentication
            proxy: Optional SOCKS5 proxy configuration

        Returns:
            StorageBuilder for sync/async usage

        Raises:
            MissingDependencyError: If azure-storage-blob is not installed
        """
        if not _BLOB_AVAILABLE:
            raise MissingDependencyError(
                "Azure Blob support requires azure-storage-blob. "
                "Install with: pip install azure-storage-blob azure-identity"
            )
        client = AzureBlobClient(
            account_url=account_url,
            container_name=container,
            connection_string=connection_string,
            account_key=account_key,
            proxy_config=proxy,
        )
        return StorageBuilder(client)


# Convenience aliases
connect = Storage.connect
connect_sync = Storage.connect_sync
