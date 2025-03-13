from abc import abstractmethod, ABCMeta
from contextlib import AbstractContextManager
from pathlib import Path, PurePath
from typing import List, Optional, Callable

from ftpc.filedescriptor import FileDescriptor


class Client(AbstractContextManager, metaclass=ABCMeta):
    @abstractmethod
    def name(self) -> str:
        """
        Name of the resource represented by the client.

        :return:
            A string representing a human-readable name.
        """

    @abstractmethod
    def ls(self, remote: PurePath) -> List[FileDescriptor]:
        """
        List files and directories at the specified remote path.

        Args:
            remote: The remote path to list

        Returns:
            A list of FileDescriptor objects representing files and directories
        """

    @abstractmethod
    def get(self, remote: PurePath, local: Path, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Download a file from the remote path to the local path.

        Args:
            remote: The remote path to the file to download
            local: The local path where the file will be saved
            progress_callback: Optional callback function that receives the number of bytes downloaded so far
        """

    @abstractmethod
    def put(self, local: Path, remote: PurePath, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Upload a file from the local path to the remote path.

        Args:
            local: The local path to the file to upload
            remote: The remote path where the file will be saved
            progress_callback: Optional callback function that receives the number of bytes uploaded so far
        """

    @abstractmethod
    def unlink(self, remote: PurePath) -> bool:
        """
        Delete a file at the specified remote path.

        Args:
            remote: The remote path to the file to delete

        Returns:
            True if the file was successfully deleted, False otherwise
        """