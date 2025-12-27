"""Async SFTP client implementation using asyncssh."""

import stat
from datetime import datetime
from pathlib import Path, PurePath, PurePosixPath
from types import TracebackType
from typing import Callable, List, Optional, TYPE_CHECKING, Any
from typing_extensions import Self

from ftpc.clients.async_client import AsyncClient
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig

try:
    import asyncssh
    ASYNCSSH_AVAILABLE = True
except ImportError:
    ASYNCSSH_AVAILABLE = False

try:
    import aiofiles
    AIOFILES_AVAILABLE = True
except ImportError:
    AIOFILES_AVAILABLE = False


class AsyncSftpClient(AsyncClient):
    """Async SFTP client using asyncssh library.

    Provides non-blocking SFTP operations with progress callbacks
    and cancellation support.
    """

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
        Initialize the async SFTP client.

        Args:
            host: The hostname or IP address of the SFTP server
            port: The port number (default: 22)
            username: Username for authentication
            password: Password for authentication
            key_filename: Path to the private key file for authentication
            name: Human-readable name for this client
            proxy_config: Optional proxy configuration (not yet supported for asyncssh)
        """
        if not ASYNCSSH_AVAILABLE:
            raise ImportError(
                "asyncssh is required for async SFTP support. "
                "Install with: pip install asyncssh"
            )

        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.key_filename = key_filename
        self._name = name if name else f"SFTP:{host}"
        self.proxy_config = proxy_config

        self._conn: Any = None  # asyncssh.SSHClientConnection
        self._sftp: Any = None  # asyncssh.SFTPClient

    def name(self) -> str:
        """Return the client name."""
        return self._name

    async def __aenter__(self) -> Self:
        """Connect to the SFTP server."""
        try:
            connect_kwargs: dict[str, Any] = {
                "host": self.host,
                "port": self.port,
                "known_hosts": None,  # Accept any host key (like paramiko's AutoAddPolicy)
            }

            if self.username:
                connect_kwargs["username"] = self.username

            if self.password:
                connect_kwargs["password"] = self.password

            if self.key_filename:
                connect_kwargs["client_keys"] = [self.key_filename]

            self._conn = await asyncssh.connect(**connect_kwargs)
            self._sftp = await self._conn.start_sftp_client()

        except asyncssh.Error as e:
            raise RuntimeError(f"Failed to connect to SFTP server: {e}")
        except Exception as e:
            raise RuntimeError(f"Failed to connect to SFTP server: {e}")

        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Disconnect from the SFTP server."""
        if self._sftp:
            self._sftp.exit()
            self._sftp = None

        if self._conn:
            self._conn.close()
            await self._conn.wait_closed()
            self._conn = None

    async def ls(self, remote: PurePath) -> List[FileDescriptor]:
        """List directory contents asynchronously."""
        assert self._sftp is not None, "Client not connected"
        result: List[FileDescriptor] = []

        try:
            path_str = remote.as_posix()
            entries = await self._sftp.readdir(path_str)

            for entry in entries:
                # Skip . and ..
                if entry.filename in (".", ".."):
                    continue

                # Determine file type
                attrs = entry.attrs
                if attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY:
                    file_type = FileType.DIRECTORY
                else:
                    file_type = FileType.FILE

                # Get size
                size = attrs.size if file_type == FileType.FILE and attrs.size else None

                # Get modification time
                modified_time = None
                if attrs.mtime:
                    modified_time = datetime.fromtimestamp(attrs.mtime)

                fd = FileDescriptor(
                    path=PurePosixPath(entry.filename),
                    filetype=file_type,
                    size=size,
                    modified_time=modified_time,
                )
                result.append(fd)

        except asyncssh.SFTPError as e:
            raise ListingError(f"Failed to list directory '{remote}': {e}")
        except Exception as e:
            raise ListingError(f"Failed to list directory '{remote}': {e}")

        return result

    async def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Download a file asynchronously with progress tracking."""
        assert self._sftp is not None, "Client not connected"

        remote_path = remote.as_posix()
        bytes_downloaded = 0
        chunk_size = 65536  # asyncssh default block size

        try:
            # Get file size for progress tracking
            attrs = await self._sftp.stat(remote_path)
            total_size = attrs.size or 0

            # Open remote file for reading
            async with self._sftp.open(remote_path, "rb") as remote_file:
                if AIOFILES_AVAILABLE:
                    import aiofiles
                    async with aiofiles.open(local, "wb") as local_file:
                        while True:
                            chunk = await remote_file.read(chunk_size)
                            if not chunk:
                                break
                            await local_file.write(chunk)
                            bytes_downloaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_downloaded):
                                    return
                else:
                    with open(local, "wb") as local_file:
                        while True:
                            chunk = await remote_file.read(chunk_size)
                            if not chunk:
                                break
                            local_file.write(chunk)
                            bytes_downloaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_downloaded):
                                    return

        except asyncssh.SFTPError:
            pass

    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Upload a file asynchronously with progress tracking."""
        assert self._sftp is not None, "Client not connected"

        remote_path = remote.as_posix()
        bytes_uploaded = 0
        chunk_size = 65536

        try:
            # Open remote file for writing
            async with self._sftp.open(remote_path, "wb") as remote_file:
                if AIOFILES_AVAILABLE:
                    import aiofiles
                    async with aiofiles.open(local, "rb") as local_file:
                        while True:
                            chunk = await local_file.read(chunk_size)
                            if not chunk:
                                break
                            await remote_file.write(chunk)
                            bytes_uploaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_uploaded):
                                    raise Exception("Transfer cancelled by user.")
                else:
                    with open(local, "rb") as local_file:
                        while True:
                            chunk = local_file.read(chunk_size)
                            if not chunk:
                                break
                            await remote_file.write(chunk)
                            bytes_uploaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_uploaded):
                                    raise Exception("Transfer cancelled by user.")

        except asyncssh.SFTPError:
            pass

    async def unlink(self, remote: PurePath) -> bool:
        """Delete a file asynchronously."""
        assert self._sftp is not None, "Client not connected"

        try:
            await self._sftp.remove(remote.as_posix())
            return True
        except Exception:
            return False

    async def mkdir(self, remote: PurePath) -> bool:
        """Create a directory asynchronously."""
        assert self._sftp is not None, "Client not connected"

        try:
            await self._sftp.mkdir(remote.as_posix())
            return True
        except Exception:
            return False
