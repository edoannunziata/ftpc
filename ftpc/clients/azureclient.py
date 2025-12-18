from pathlib import Path, PurePath, PurePosixPath
from typing import List, Optional, Callable, TYPE_CHECKING

from azure.storage.filedatalake import DataLakeServiceClient
from azure.core.exceptions import ResourceNotFoundError, HttpResponseError
from azure.core.pipeline.transport import RequestsTransport
from azure.identity import DefaultAzureCredential

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig


class AzureClient(Client):
    def __init__(
        self,
        account_url,
        *,
        filesystem_name,
        connection_string=None,
        account_key=None,
        credential=None,
        name=None,
        proxy_config: Optional["ProxyConfig"] = None,
    ):
        """
        Initialize the Azure Data Lake Storage Gen2 client.

        Args:
            account_url: URL to the storage account (e.g., 'https://accountname.dfs.core.windows.net')
            filesystem_name: Name of the filesystem (container) to use
            connection_string: Optional connection string for authentication
            account_key: Optional account key for authentication
            credential: Optional credential for authentication (e.g., DefaultAzureCredential())
            name: Optional human-readable name for this client
            proxy_config: Optional SOCKS5 proxy configuration
        """
        self.account_url = account_url
        self.filesystem_name = filesystem_name
        self.connection_string = connection_string
        self.account_key = account_key
        self._credential = credential
        self._name = name if name else f"Azure:{filesystem_name}"
        self.proxy_config = proxy_config

        # These will be initialized in __enter__
        self.service_client = None
        self.filesystem_client = None

    def __enter__(self):
        # Initialize credential if not provided
        if not self._credential and not self.connection_string and not self.account_key:
            self._credential = DefaultAzureCredential()

        # Create transport with proxy if configured
        transport = None
        if self.proxy_config:
            proxy_url = self._build_proxy_url()
            proxies = {"http": proxy_url, "https": proxy_url}
            transport = RequestsTransport(proxies=proxies)

        # Create service client based on provided auth method
        if self.connection_string:
            self.service_client = DataLakeServiceClient.from_connection_string(
                conn_str=self.connection_string,
                transport=transport,
            )
        elif self.account_key:
            self.service_client = DataLakeServiceClient(
                account_url=self.account_url,
                credential=self.account_key,
                transport=transport,
            )
        else:
            self.service_client = DataLakeServiceClient(
                account_url=self.account_url,
                credential=self._credential,
                transport=transport,
            )

        # Get filesystem (container) client
        self.filesystem_client = self.service_client.get_file_system_client(
            file_system=self.filesystem_name
        )

        return self

    def _build_proxy_url(self) -> str:
        """Build SOCKS5 proxy URL for Azure SDK."""
        if self.proxy_config.username and self.proxy_config.password:
            return (
                f"socks5://{self.proxy_config.username}:{self.proxy_config.password}"
                f"@{self.proxy_config.host}:{self.proxy_config.port}"
            )
        return f"socks5://{self.proxy_config.host}:{self.proxy_config.port}"

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.filesystem_client = None
        self.service_client = None

    def name(self) -> str:
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        result = []

        azure_path = self._format_path(path)

        try:
            # List all paths in the directory
            paths = self.filesystem_client.get_paths(path=azure_path, recursive=False)

            for path_item in paths:
                # Extract just the name component (not the full path)
                name = PurePosixPath(path_item.name).name
                if path_item.is_directory:
                    # Directories in ADLS Gen2
                    fd = FileDescriptor(
                        path=PurePosixPath(name),
                        filetype=FileType.DIRECTORY,
                        size=0,  # Directories don't have a size in ADLS
                        modified_time=None,  # Directories don't have last modified time in ADLS
                    )
                else:
                    # Files in ADLS Gen2
                    fd = FileDescriptor(
                        path=PurePosixPath(name),
                        filetype=FileType.FILE,
                        size=path_item.content_length,
                        modified_time=path_item.last_modified,
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
        azure_path = self._format_path(remote)

        file_client = self.filesystem_client.get_file_client(azure_path)

        # Download the file
        with open(local, "wb") as local_file:
            download = file_client.download_file()

            bytes_read = 0
            for chunk in download.chunks():
                local_file.write(chunk)
                bytes_read += len(chunk)

                # Report progress if callback is provided
                if progress_callback:
                    if not progress_callback(bytes_read):
                        # User canceled the download
                        break

    def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ):
        # Format path for Azure
        azure_path = self._format_path(remote)

        # Get file client
        file_client = self.filesystem_client.get_file_client(azure_path)

        # Get local file size for progress reporting
        total_size = local.stat().st_size

        # Read the local file and upload in chunks for progress reporting
        with open(local, "rb") as local_file:
            file_client.upload_data(local_file, overwrite=True, length=total_size)

            # Since Azure SDK doesn't provide chunk-by-chunk upload progress,
            # we'll just report completion at the end
            if progress_callback:
                progress_callback(total_size)

    def unlink(self, remote: PurePath) -> bool:
        try:
            # Format path for Azure
            azure_path = self._format_path(remote)

            # Get file client and delete the file
            file_client = self.filesystem_client.get_file_client(azure_path)
            file_client.delete_file()

            return True
        except (ResourceNotFoundError, HttpResponseError):
            return False

    def mkdir(self, remote: PurePath) -> bool:
        try:
            # Format path for Azure
            azure_path = self._format_path(remote)

            # Get directory client and create the directory
            directory_client = self.filesystem_client.get_directory_client(azure_path)
            directory_client.create_directory()

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
