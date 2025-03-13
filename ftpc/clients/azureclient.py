"""
Azure Data Lake Storage Gen2 client for ftpc.

This module requires the following dependencies:
    - azure-storage-file-datalake
    - azure-identity

If these dependencies are not installed, the client will not be available,
but the rest of the application will continue to work with other storage types.
"""
from pathlib import Path, PurePath, PurePosixPath
from typing import List, Optional, Callable
import importlib.util

# Check for Azure dependencies
AZURE_DEPS_MISSING = []
if importlib.util.find_spec("azure.storage.filedatalake") is None:
    AZURE_DEPS_MISSING.append("azure-storage-file-datalake")
if importlib.util.find_spec("azure.identity") is None:
    AZURE_DEPS_MISSING.append("azure-identity")

if not AZURE_DEPS_MISSING:
    # Only import Azure modules if dependencies are available
    from azure.storage.filedatalake import DataLakeServiceClient
    from azure.core.exceptions import ResourceNotFoundError, HttpResponseError
    from azure.identity import DefaultAzureCredential
else:
    # Define dummy exception classes to prevent syntax errors
    class ResourceNotFoundError(Exception): pass
    class HttpResponseError(Exception): pass
    class DefaultAzureCredential: pass

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType


class AzureClient(Client):
    """Client to interact with Azure Data Lake Storage Gen2.

    This client requires the following dependencies to be installed:
    - azure-storage-file-datalake
    - azure-identity

    If these dependencies are not installed, the application will display
    an appropriate error message when attempting to use this client.
    """

    # Check if dependencies are missing when class is defined
    if AZURE_DEPS_MISSING:
        missing_deps = ", ".join(AZURE_DEPS_MISSING)
        raise ImportError(
            f"Azure client requires additional dependencies: {missing_deps}. "
            f"Install with: pip install {' '.join(AZURE_DEPS_MISSING)}"
        )

    def __init__(
            self,
            account_url,
            *,
            filesystem_name,
            connection_string=None,
            account_key=None,
            credential=None,
            name=None
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
        """
        self.account_url = account_url
        self.filesystem_name = filesystem_name
        self.connection_string = connection_string
        self.account_key = account_key
        self._credential = credential
        self._name = name if name else f"Azure:{filesystem_name}"

        # These will be initialized in __enter__
        self.service_client = None
        self.filesystem_client = None

    def __enter__(self):
        """Connect to Azure Storage when entering the context."""
        # Initialize credential if not provided
        if not self._credential and not self.connection_string and not self.account_key:
            self._credential = DefaultAzureCredential()

        # Create service client based on provided auth method
        if self.connection_string:
            self.service_client = DataLakeServiceClient.from_connection_string(
                conn_str=self.connection_string
            )
        elif self.account_key:
            self.service_client = DataLakeServiceClient(
                account_url=self.account_url,
                credential=self.account_key
            )
        else:
            self.service_client = DataLakeServiceClient(
                account_url=self.account_url,
                credential=self._credential
            )

        # Get filesystem (container) client
        self.filesystem_client = self.service_client.get_file_system_client(
            file_system=self.filesystem_name
        )

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Clean up resources when exiting the context."""
        # Azure SDK handles connection pool cleanup automatically
        self.filesystem_client = None
        self.service_client = None

    def name(self) -> str:
        """Return a human-readable name for this client."""
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        """
        List files and directories in the specified Azure path.

        Args:
            path: The remote Azure path to list

        Returns:
            A list of FileDescriptor objects representing the files and directories
        """
        result = []

        # Convert path to string format that Azure ADLS expects
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
                        modified_time=None  # Directories don't have last modified time in ADLS
                    )
                else:
                    # Files in ADLS Gen2
                    fd = FileDescriptor(
                        path=PurePosixPath(name),
                        filetype=FileType.FILE,
                        size=path_item.content_length,
                        modified_time=path_item.last_modified
                    )
                result.append(fd)
        except (ResourceNotFoundError, HttpResponseError):
            # Handle not found or permission errors
            pass

        return result

    def get(self, remote: PurePath, local: Path, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Download a file from Azure to the local path.

        Args:
            remote: The remote path to the file to download
            local: The local path where the file will be saved
            progress_callback: Optional callback function that receives bytes downloaded so far
        """
        # Format path for Azure
        azure_path = self._format_path(remote)

        # Get file client
        file_client = self.filesystem_client.get_file_client(azure_path)

        # Download the file
        with open(local, 'wb') as local_file:
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

    def put(self, local: Path, remote: PurePath, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Upload a file from the local path to Azure.

        Args:
            local: The local path to the file to upload
            remote: The remote path where the file will be saved
            progress_callback: Optional callback function that receives bytes uploaded so far
        """
        # Format path for Azure
        azure_path = self._format_path(remote)

        # Get file client
        file_client = self.filesystem_client.get_file_client(azure_path)

        # Get local file size for progress reporting
        total_size = local.stat().st_size

        # Read the local file and upload in chunks for progress reporting
        with open(local, 'rb') as local_file:
            file_client.upload_data(local_file, overwrite=True, length=total_size)

            # Since Azure SDK doesn't provide chunk-by-chunk upload progress,
            # we'll just report completion at the end
            if progress_callback:
                progress_callback(total_size)

    def unlink(self, remote: PurePath) -> bool:
        """
        Delete a file at the specified remote Azure path.

        Args:
            remote: The remote path to the file to delete

        Returns:
            True if the file was successfully deleted, False otherwise
        """
        try:
            # Format path for Azure
            azure_path = self._format_path(remote)

            # Get file client and delete the file
            file_client = self.filesystem_client.get_file_client(azure_path)
            file_client.delete_file()

            return True
        except (ResourceNotFoundError, HttpResponseError):
            return False

    def _format_path(self, path: PurePath) -> str:
        """
        Format a path object to the format expected by Azure ADLS Gen2.

        Args:
            path: The path to format

        Returns:
            A string in the format expected by Azure ADLS Gen2
        """
        # Remove leading slash if present
        path_str = path.as_posix()
        if path_str == '/':
            return ''
        if path_str.startswith('/'):
            return path_str[1:]
        return path_str
