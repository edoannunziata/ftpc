from pathlib import Path, PurePath, PurePosixPath
from typing import List, Optional, Callable, TYPE_CHECKING

from azure.storage.blob import BlobServiceClient, ContainerClient, BlobPrefix
from azure.core.exceptions import ResourceNotFoundError, HttpResponseError
from azure.identity import DefaultAzureCredential

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig


class AzureBlobClient(Client):
    def __init__(
        self,
        account_url,
        *,
        container_name,
        connection_string=None,
        account_key=None,
        credential=None,
        name=None,
        proxy_config: Optional["ProxyConfig"] = None,
    ):
        """
        Initialize the Azure Blob Storage client.

        Args:
            account_url: URL to the storage account (e.g., 'https://accountname.blob.core.windows.net')
            container_name: Name of the container to use
            connection_string: Optional connection string for authentication
            account_key: Optional account key for authentication
            credential: Optional credential for authentication (e.g., DefaultAzureCredential())
            name: Optional human-readable name for this client
            proxy_config: Optional SOCKS5 proxy configuration
        """
        self.account_url = account_url
        self.container_name = container_name
        self.connection_string = connection_string
        self.account_key = account_key
        self._credential = credential
        self._name = name if name else f"Blob:{container_name}"
        self.proxy_config = proxy_config

        # These will be initialized in __enter__
        self.service_client: Optional[BlobServiceClient] = None
        self.container_client: Optional[ContainerClient] = None

    def __enter__(self):
        # Initialize credential if not provided
        if not self._credential and not self.connection_string and not self.account_key:
            self._credential = DefaultAzureCredential()

        # Create transport with proxy if configured
        if self.proxy_config:
            proxy_url = self._build_proxy_url()
            proxies = {"http": proxy_url, "https": proxy_url}

        # Create service client based on provided auth method
        if self.connection_string:
            self.service_client = BlobServiceClient.from_connection_string(
                conn_str=self.connection_string,
                proxies=proxies,
            )
        elif self.account_key:
            self.service_client = BlobServiceClient(
                account_url=self.account_url,
                credential=self.account_key,
                proxies=proxies,
            )
        else:
            self.service_client = BlobServiceClient(
                account_url=self.account_url,
                credential=self._credential,
                proxies=proxies,
            )

        # Get container client
        self.container_client = self.service_client.get_container_client(
            container=self.container_name
        )

        return self

    def _build_proxy_url(self) -> str:
        """Build SOCKS5 proxy URL for Azure SDK."""
        if self.proxy_config.username and self.proxy_config.password:
            return (
                f"socks5h://{self.proxy_config.username}:{self.proxy_config.password}"
                f"@{self.proxy_config.host}:{self.proxy_config.port}"
            )
        return f"socks5h://{self.proxy_config.host}:{self.proxy_config.port}"

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.container_client = None
        self.service_client = None

    def name(self) -> str:
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        result = []

        # Convert path to string format that Blob Storage expects
        blob_path = self._format_path(path)

        # For the root directory, we need an empty prefix
        prefix = blob_path + "/" if blob_path else ""

        try:
            # Use walk_blobs to get both blobs and virtual directories
            for item in self.container_client.walk_blobs(
                name_starts_with=prefix, delimiter="/"
            ):
                if isinstance(item, BlobPrefix):
                    # This is a virtual directory (prefix)
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
                    # Skip the directory placeholder itself if present
                    if item.name == prefix:
                        continue

                    # Extract just the name component
                    file_name = item.name
                    if prefix:
                        file_name = file_name[len(prefix) :]

                    # Skip if this is a nested path (shouldn't happen with delimiter)
                    if "/" in file_name:
                        continue

                    fd = FileDescriptor(
                        path=PurePosixPath(file_name),
                        filetype=FileType.FILE,
                        size=item.size,
                        modified_time=item.last_modified,
                    )
                    result.append(fd)

        except (ResourceNotFoundError, HttpResponseError):
            pass

        return result

    def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ):
        blob_path = self._format_path(remote)

        try:
            blob_client = self.container_client.get_blob_client(blob_path)

            # Download the blob
            with open(local, "wb") as local_file:
                download_stream = blob_client.download_blob()

                bytes_read = 0
                for chunk in download_stream.chunks():
                    local_file.write(chunk)
                    bytes_read += len(chunk)

                    # Report progress if callback is provided
                    if progress_callback:
                        if not progress_callback(bytes_read):
                            # User canceled the download
                            break

        except (ResourceNotFoundError, HttpResponseError):
            pass

    def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ):
        blob_path = self._format_path(remote)

        try:
            blob_client = self.container_client.get_blob_client(blob_path)

            # Get local file size for progress reporting
            total_size = local.stat().st_size

            # Upload the blob
            with open(local, "rb") as local_file:
                blob_client.upload_blob(local_file, overwrite=True, length=total_size)

                # Since Azure SDK doesn't provide chunk-by-chunk upload progress,
                # we'll just report completion at the end
                if progress_callback:
                    progress_callback(total_size)

        except (ResourceNotFoundError, HttpResponseError):
            pass

    def unlink(self, remote: PurePath) -> bool:
        try:
            blob_path = self._format_path(remote)
            blob_client = self.container_client.get_blob_client(blob_path)
            blob_client.delete_blob()
            return True
        except (ResourceNotFoundError, HttpResponseError):
            return False

    def mkdir(self, remote: PurePath) -> bool:
        try:
            # Blob Storage doesn't have real directories, but we can create a
            # placeholder blob with a trailing slash to simulate a directory
            blob_path = self._format_path(remote)
            if not blob_path.endswith("/"):
                blob_path += "/"

            blob_client = self.container_client.get_blob_client(blob_path)
            blob_client.upload_blob(b"", overwrite=True)
            return True
        except (ResourceNotFoundError, HttpResponseError):
            return False

    def _format_path(self, path: PurePath) -> str:
        # Remove leading slash if present
        path_str = path.as_posix()
        if path_str == "/":
            return ""
        if path_str.startswith("/"):
            return path_str[1:]
        return path_str
