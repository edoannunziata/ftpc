"""Abstract base class for asynchronous storage clients."""

from abc import abstractmethod, ABCMeta
from contextlib import AbstractAsyncContextManager
from pathlib import Path, PurePath
from types import TracebackType
from typing import List, Optional, Callable
from typing_extensions import Self

from ftpc.filedescriptor import FileDescriptor


class AsyncClient(AbstractAsyncContextManager["AsyncClient"], metaclass=ABCMeta):
    """Abstract base class for all async storage backend clients.

    This mirrors the synchronous Client interface but with async methods.
    All storage backends should implement this interface for async operations.
    """

    @abstractmethod
    def name(self) -> str:
        """
        Name of the resource represented by the client.

        Returns:
            A string representing a human-readable name.
        """

    @abstractmethod
    async def ls(self, remote: PurePath) -> List[FileDescriptor]:
        """
        List files and directories at the specified remote path.

        Args:
            remote: The remote path to list

        Returns:
            A list of FileDescriptor objects representing files and directories
        """

    @abstractmethod
    async def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """
        Download a file from the remote path to the local path.

        Args:
            remote: The remote path to the file to download
            local: The local path where the file will be saved
            progress_callback: Optional callback function that receives the number
                             of bytes downloaded so far. Returns False to cancel.
        """

    @abstractmethod
    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """
        Upload a file from the local path to the remote path.

        Args:
            local: The local path to the file to upload
            remote: The remote path where the file will be saved
            progress_callback: Optional callback function that receives the number
                             of bytes uploaded so far. Returns False to cancel.
        """

    @abstractmethod
    async def unlink(self, remote: PurePath) -> bool:
        """
        Delete a file at the specified remote path.

        Args:
            remote: The remote path to the file to delete

        Returns:
            True if the file was successfully deleted, False otherwise
        """

    @abstractmethod
    async def mkdir(self, remote: PurePath) -> bool:
        """
        Create a directory at the specified remote path.

        Args:
            remote: The remote path where the directory should be created

        Returns:
            True if the directory was successfully created, False otherwise
        """

    async def __aenter__(self) -> Self:
        """Async context manager entry."""
        return self

    @abstractmethod
    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Async context manager exit - must be implemented to clean up resources."""
