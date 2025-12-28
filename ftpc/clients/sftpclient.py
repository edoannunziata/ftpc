from pathlib import Path, PurePath, PurePosixPath
from types import TracebackType
from typing import Any, List, Optional, Callable, TYPE_CHECKING
from typing_extensions import Self
import socket
import stat
from datetime import datetime
import os.path

import paramiko
from paramiko.sftp_attr import SFTPAttributes
from paramiko.ssh_exception import SSHException

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig

try:
    import socks

    SOCKS_AVAILABLE = True
except ImportError:
    SOCKS_AVAILABLE = False


class SftpClient(Client):
    def __init__(
        self,
        host: str,
        *,
        port: int = 22,
        username: Optional[str] = None,
        password: Optional[str] = None,
        key_filename: Optional[str] = None,
        name: Optional[str] = None,
        proxy_config: Optional["ProxyConfig"] = None,
    ) -> None:
        """
        Initialize the SFTP client.

        Args:
            host: The hostname or IP address of the SFTP server
            port: The port number for the SFTP server (default: 22)
            username: The username for authentication
            password: The password for authentication
            key_filename: Path to the private key file for authentication
            name: Optional human-readable name for this client
            proxy_config: Optional SOCKS5 proxy configuration
        """
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.key_filename = key_filename
        self._name = name if name else f"SFTP:{host}"
        self.proxy_config = proxy_config

        # These will be initialized in __enter__
        self.ssh_client: Optional[paramiko.SSHClient] = None
        self.sftp_client: Optional[paramiko.SFTPClient] = None
        self._proxy_socket: Optional[socket.socket] = None

    def __enter__(self) -> Self:
        try:
            self.ssh_client = paramiko.SSHClient()
            self.ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            connect_kwargs = {
                "hostname": self.host,
                "port": self.port,
                "timeout": 10,
            }

            # Create SOCKS5 proxy socket if configured
            if self.proxy_config:
                if not SOCKS_AVAILABLE:
                    raise RuntimeError(
                        "PySocks is required for SOCKS5 proxy support. "
                        "Install with: pip install pysocks"
                    )
                self._proxy_socket = socks.socksocket()
                self._proxy_socket.set_proxy(  # type: ignore[union-attr]
                    socks.SOCKS5,
                    self.proxy_config.host,
                    self.proxy_config.port,
                    username=self.proxy_config.username,
                    password=self.proxy_config.password,
                )
                self._proxy_socket.connect((self.host, self.port))
                connect_kwargs["sock"] = self._proxy_socket

            if self.username:
                connect_kwargs["username"] = self.username

            if self.password:
                connect_kwargs["password"] = self.password

            if self.key_filename:
                connect_kwargs["key_filename"] = self.key_filename
            else:
                connect_kwargs["look_for_keys"] = False
                connect_kwargs["allow_agent"] = False

            self.ssh_client.connect(**connect_kwargs)

            # Create SFTP client
            self.sftp_client = self.ssh_client.open_sftp()

            return self
        except Exception as e:
            if self._proxy_socket:
                self._proxy_socket.close()
                self._proxy_socket = None
            if self.ssh_client:
                self.ssh_client.close()
                self.ssh_client = None
            raise RuntimeError(f"Failed to connect to SFTP server: {str(e)}")

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        if self.sftp_client:
            self.sftp_client.close()
            self.sftp_client = None

        if self.ssh_client:
            self.ssh_client.close()
            self.ssh_client = None

        if self._proxy_socket:
            self._proxy_socket.close()
            self._proxy_socket = None

    def name(self) -> str:
        return self._name

    def ls(self, remote: PurePath) -> List[FileDescriptor]:
        assert self.sftp_client is not None, "Client not connected"
        result = []

        try:
            # Convert PurePath to string path
            path_str = self._format_path(remote)

            # List files in the directory
            for attr in self.sftp_client.listdir_attr(path_str):
                # Create a FileDescriptor for each item
                fd = self._stat_to_file_descriptor(attr, PurePosixPath(attr.filename))
                result.append(fd)

        except (SSHException, IOError) as e:
            raise ListingError(f"Failed to list directory '{remote}': {e}")

        return result

    def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        assert self.sftp_client is not None, "Client not connected"
        try:
            remote_path = self._format_path(remote)
            local_path = str(local)

            if progress_callback:
                try:
                    remote_stat = self.sftp_client.stat(remote_path)
                    total_size = remote_stat.st_size if remote_stat.st_size else 0
                except (SSHException, IOError):
                    total_size = 0  # Unknown size

                class ProgressTracker:
                    def __init__(self, callback: Callable[[int], bool], total: int) -> None:
                        self.bytes_processed = 0
                        self.callback = callback
                        self.total = total

                    def __call__(self, bytes_transferred: int, total_transferred: int) -> bool:
                        self.bytes_processed = total_transferred
                        return self.callback(self.bytes_processed)

                progress = ProgressTracker(progress_callback, total_size)

                self.sftp_client.get(remote_path, local_path, callback=progress)
            else:
                self.sftp_client.get(remote_path, local_path)

        except (SSHException, IOError):
            pass

    def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        assert self.sftp_client is not None, "Client not connected"
        try:
            remote_path = self._format_path(remote)
            local_path = str(local)

            if progress_callback:
                total_size = os.path.getsize(local_path)

                class ProgressTracker:
                    def __init__(self, callback: Callable[[int], bool], total: int) -> None:
                        self.bytes_processed = 0
                        self.callback = callback
                        self.total = total

                    def __call__(self, bytes_transferred: int, total_transferred: int) -> bool:
                        self.bytes_processed = total_transferred
                        return self.callback(self.bytes_processed)

                progress = ProgressTracker(progress_callback, total_size)

                self.sftp_client.put(local_path, remote_path, callback=progress)
            else:
                self.sftp_client.put(local_path, remote_path)

        except (SSHException, IOError):
            pass

    def unlink(self, remote: PurePath) -> bool:
        assert self.sftp_client is not None, "Client not connected"
        try:
            remote_path = self._format_path(remote)
            self.sftp_client.remove(remote_path)
            return True
        except (SSHException, IOError):
            return False

    def mkdir(self, remote: PurePath) -> bool:
        assert self.sftp_client is not None, "Client not connected"
        try:
            remote_path = self._format_path(remote)
            self.sftp_client.mkdir(remote_path)
            return True
        except (SSHException, IOError):
            return False

    def _format_path(self, path: PurePath) -> str:
        return path.as_posix()

    def _stat_to_file_descriptor(self, attr: SFTPAttributes, path: PurePath) -> FileDescriptor:
        # Determine if it's a file or directory
        if attr.st_mode is not None and stat.S_ISDIR(attr.st_mode):
            filetype = FileType.DIRECTORY
        else:
            filetype = FileType.FILE

        # Create file descriptor with available metadata
        return FileDescriptor(
            path=path,
            filetype=filetype,
            size=attr.st_size if filetype == FileType.FILE else None,
            modified_time=(
                datetime.fromtimestamp(attr.st_mtime)
                if attr.st_mtime is not None
                else None
            ),
        )
