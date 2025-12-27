"""Async Azure Blob Storage client implementation."""

from pathlib import Path, PurePath, PurePosixPath
from types import TracebackType
from typing import Any, Callable, Dict, List, Optional, TYPE_CHECKING
from typing_extensions import Self

from ftpc.clients.async_client import AsyncClient
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig

try:
    from azure.storage.blob.aio import BlobServiceClient, ContainerClient
    from azure.storage.blob import BlobPrefix
    from azure.core.exceptions import ResourceNotFoundError, HttpResponseError
    from azure.identity.aio import DefaultAzureCredential
    AZURE_BLOB_AVAILABLE = True
except ImportError:
    AZURE_BLOB_AVAILABLE = False

try:
    import aiofiles
    AIOFILES_AVAILABLE = True
except ImportError:
    AIOFILES_AVAILABLE = False


class AsyncAzureBlobClient(AsyncClient):
    """Async Azure Blob Storage client.

    Uses the Azure SDK's native async support for non-blocking operations.
    """

    def __init__(
        self,
        account_url: str,
        *,
        container_name: str,
        connection_string: Optional[str] = None,
        account_key: Optional[str] = None,
        credential: Optional[Any] = None,
        name: Optional[str] = None,
        proxy_config: Optional["ProxyConfig"] = None,
    ) -> None:
        """
        Initialize the async Azure Blob Storage client.

        Args:
            account_url: URL to the storage account
            container_name: Name of the container to use
            connection_string: Optional connection string for authentication
            account_key: Optional account key for authentication
            credential: Optional credential for authentication
            name: Human-readable name for this client
            proxy_config: Optional proxy configuration
        """
        if not AZURE_BLOB_AVAILABLE:
            raise ImportError(
                "azure-storage-blob is required for async Azure Blob support. "
                "Install with: pip install azure-storage-blob azure-identity"
            )

        self.account_url = account_url
        self.container_name = container_name
        self.connection_string = connection_string
        self.account_key = account_key
        self._credential = credential
        self._name = name if name else f"Blob:{container_name}"
        self.proxy_config = proxy_config

        self._service_client: Any = None
        self._container_client: Any = None
        self._owns_credential = False

    def name(self) -> str:
        """Return the client name."""
        return self._name

    def _build_proxy_url(self) -> str:
        """Build SOCKS5 proxy URL for Azure SDK."""
        assert self.proxy_config is not None, "Proxy config not set"
        if self.proxy_config.username and self.proxy_config.password:
            return (
                f"socks5h://{self.proxy_config.username}:{self.proxy_config.password}"
                f"@{self.proxy_config.host}:{self.proxy_config.port}"
            )
        return f"socks5h://{self.proxy_config.host}:{self.proxy_config.port}"

    async def __aenter__(self) -> Self:
        """Initialize the Azure client."""
        # Initialize credential if not provided
        if not self._credential and not self.connection_string and not self.account_key:
            self._credential = DefaultAzureCredential()
            self._owns_credential = True

        # Create transport with proxy if configured
        proxies: Optional[Dict[str, str]] = None
        if self.proxy_config:
            proxy_url = self._build_proxy_url()
            proxies = {"http": proxy_url, "https": proxy_url}

        # Create service client based on provided auth method
        if self.connection_string:
            self._service_client = BlobServiceClient.from_connection_string(
                conn_str=self.connection_string,
                proxies=proxies,
            )
        elif self.account_key:
            self._service_client = BlobServiceClient(
                account_url=self.account_url,
                credential=self.account_key,
                proxies=proxies,
            )
        else:
            self._service_client = BlobServiceClient(
                account_url=self.account_url,
                credential=self._credential,
                proxies=proxies,
            )

        # Get container client
        self._container_client = self._service_client.get_container_client(
            container=self.container_name
        )

        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Clean up the Azure client."""
        if self._service_client:
            await self._service_client.close()
            self._service_client = None
            self._container_client = None

        if self._owns_credential and self._credential:
            await self._credential.close()
            self._credential = None

    def _format_path(self, path: PurePath) -> str:
        """Format path for Azure (remove leading slash)."""
        path_str = path.as_posix()
        if path_str == "/":
            return ""
        if path_str.startswith("/"):
            return path_str[1:]
        return path_str

    async def ls(self, path: PurePath) -> List[FileDescriptor]:
        """List directory contents asynchronously."""
        assert self._container_client is not None, "Client not connected"
        result: List[FileDescriptor] = []

        blob_path = self._format_path(path)
        prefix = blob_path + "/" if blob_path else ""

        try:
            async for item in self._container_client.walk_blobs(
                name_starts_with=prefix, delimiter="/"
            ):
                if isinstance(item, BlobPrefix):
                    # This is a virtual directory
                    dir_name = item.name.rstrip("/")
                    dir_name = PurePosixPath(dir_name).name

                    fd = FileDescriptor(
                        path=PurePosixPath(dir_name),
                        filetype=FileType.DIRECTORY,
                        size=0,
                        modified_time=None,
                    )
                    result.append(fd)
                else:
                    # This is a blob (file)
                    if item.name == prefix:
                        continue

                    file_name = item.name
                    if prefix:
                        file_name = file_name[len(prefix):]

                    if "/" in file_name:
                        continue

                    fd = FileDescriptor(
                        path=PurePosixPath(file_name),
                        filetype=FileType.FILE,
                        size=item.size,
                        modified_time=item.last_modified,
                    )
                    result.append(fd)

        except (ResourceNotFoundError, HttpResponseError) as e:
            raise ListingError(f"Failed to list directory '{path}': {e}")

        return result

    async def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Download a file asynchronously with progress tracking."""
        assert self._container_client is not None, "Client not connected"

        blob_path = self._format_path(remote)
        bytes_read = 0

        try:
            blob_client = self._container_client.get_blob_client(blob_path)
            download_stream = await blob_client.download_blob()

            if AIOFILES_AVAILABLE:
                import aiofiles
                async with aiofiles.open(local, "wb") as local_file:
                    async for chunk in download_stream.chunks():
                        await local_file.write(chunk)
                        bytes_read += len(chunk)
                        if progress_callback:
                            if not progress_callback(bytes_read):
                                return
            else:
                with open(local, "wb") as local_file:
                    async for chunk in download_stream.chunks():
                        local_file.write(chunk)
                        bytes_read += len(chunk)
                        if progress_callback:
                            if not progress_callback(bytes_read):
                                return

        except (ResourceNotFoundError, HttpResponseError):
            pass

    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Upload a file asynchronously with progress tracking."""
        assert self._container_client is not None, "Client not connected"

        blob_path = self._format_path(remote)
        total_size = local.stat().st_size

        try:
            blob_client = self._container_client.get_blob_client(blob_path)

            if AIOFILES_AVAILABLE:
                import aiofiles
                async with aiofiles.open(local, "rb") as local_file:
                    content = await local_file.read()
                    await blob_client.upload_blob(content, overwrite=True, length=total_size)
            else:
                with open(local, "rb") as local_file:
                    content = local_file.read()
                    await blob_client.upload_blob(content, overwrite=True, length=total_size)

            if progress_callback:
                progress_callback(total_size)

        except (ResourceNotFoundError, HttpResponseError):
            pass

    async def unlink(self, remote: PurePath) -> bool:
        """Delete a file asynchronously."""
        assert self._container_client is not None, "Client not connected"

        try:
            blob_path = self._format_path(remote)
            blob_client = self._container_client.get_blob_client(blob_path)
            await blob_client.delete_blob()
            return True
        except (ResourceNotFoundError, HttpResponseError):
            return False

    async def mkdir(self, remote: PurePath) -> bool:
        """Create a directory asynchronously (creates a placeholder blob)."""
        assert self._container_client is not None, "Client not connected"

        try:
            blob_path = self._format_path(remote)
            if not blob_path.endswith("/"):
                blob_path += "/"

            blob_client = self._container_client.get_blob_client(blob_path)
            await blob_client.upload_blob(b"", overwrite=True)
            return True
        except (ResourceNotFoundError, HttpResponseError):
            return False
