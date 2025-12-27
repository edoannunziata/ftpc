"""Async FTP/FTPS client implementation using aioftp."""

from datetime import datetime
from pathlib import Path, PurePath, PurePosixPath
from types import TracebackType
from typing import Callable, List, Optional, TYPE_CHECKING
from typing_extensions import Self

from ftpc.clients.async_client import AsyncClient
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import (
    ConnectionError,
    AuthenticationError,
    ListingError,
)

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig

try:
    import aioftp
    AIOFTP_AVAILABLE = True
except ImportError:
    AIOFTP_AVAILABLE = False

try:
    import aiofiles
    AIOFILES_AVAILABLE = True
except ImportError:
    AIOFILES_AVAILABLE = False


class AsyncFtpClient(AsyncClient):
    """Async FTP/FTPS client using aioftp library.

    Provides non-blocking FTP operations with progress callbacks
    and cancellation support.
    """

    def __init__(
        self,
        url: str,
        *,
        port: int = 21,
        tls: bool = True,
        username: str = "",
        password: str = "",
        name: str = "",
        proxy_config: Optional["ProxyConfig"] = None,
    ) -> None:
        """
        Initialize the async FTP client.

        Args:
            url: The hostname or IP address of the FTP server
            port: The port number (default: 21)
            tls: Whether to use FTPS/TLS (default: True)
            username: Username for authentication
            password: Password for authentication
            name: Human-readable name for this client
            proxy_config: Optional SOCKS5 proxy configuration (not yet supported)
        """
        if not AIOFTP_AVAILABLE:
            raise ImportError(
                "aioftp is required for async FTP support. "
                "Install with: pip install aioftp"
            )

        self.url = url
        self.port = port
        self.tls = tls
        self.username = username or "anonymous"
        self.password = password or ""
        self._name = name if name else url
        self.proxy_config = proxy_config

        self._client: Optional["aioftp.Client"] = None

    def name(self) -> str:
        """Return the client name."""
        return self._name

    async def __aenter__(self) -> Self:
        """Connect to the FTP server."""
        try:
            # Create client with TLS if requested
            if self.tls:
                self._client = aioftp.Client.context(
                    ssl=True,
                    parse_list_line_custom_first=True,
                )
            else:
                self._client = aioftp.Client()

            await self._client.connect(self.url, self.port)
            await self._client.login(self.username, self.password)

        except aioftp.StatusCodeError as e:
            error_str = str(e)
            if "530" in error_str:
                raise AuthenticationError(f"Authentication failed: {error_str}")
            raise ConnectionError(f"FTP error: {error_str}")
        except OSError as e:
            raise ConnectionError(f"Failed to connect to {self.url}: {e}")
        except Exception as e:
            raise ConnectionError(f"FTP connection error: {e}")

        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Disconnect from the FTP server."""
        if self._client:
            try:
                await self._client.quit()
            except Exception:
                pass
            self._client = None

    async def ls(self, path: PurePath) -> List[FileDescriptor]:
        """List directory contents asynchronously."""
        assert self._client is not None, "Client not connected"
        result: List[FileDescriptor] = []

        try:
            path_str = path.as_posix()

            async for entry_path, entry_info in self._client.list(path_str):
                # Get just the filename from the full path
                name = PurePosixPath(entry_path).name

                # Determine file type
                file_type = FileType.DIRECTORY if entry_info.get("type") == "dir" else FileType.FILE

                # Get size
                size = int(entry_info.get("size", 0)) if file_type == FileType.FILE else 0

                # Get modification time if available
                modified_time = None
                if "modify" in entry_info:
                    try:
                        # aioftp provides modify as a datetime string
                        modify_str = entry_info["modify"]
                        if isinstance(modify_str, str):
                            modified_time = datetime.strptime(modify_str, "%Y%m%d%H%M%S")
                        elif isinstance(modify_str, datetime):
                            modified_time = modify_str
                    except (ValueError, TypeError):
                        pass

                fd = FileDescriptor(
                    path=PurePosixPath(name),
                    filetype=file_type,
                    size=size,
                    modified_time=modified_time,
                )
                result.append(fd)

        except aioftp.StatusCodeError as e:
            raise ListingError(f"Failed to list directory '{path}': {e}")
        except Exception as e:
            raise ListingError(f"Failed to list directory '{path}': {e}")

        return result

    async def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Download a file asynchronously with progress tracking."""
        assert self._client is not None, "Client not connected"

        remote_path = remote.as_posix()
        bytes_downloaded = 0

        try:
            if AIOFILES_AVAILABLE:
                import aiofiles
                async with aiofiles.open(local, "wb") as local_file:
                    async with self._client.download_stream(remote_path) as stream:
                        async for chunk in stream.iter_by_block():
                            await local_file.write(chunk)
                            bytes_downloaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_downloaded):
                                    # User cancelled
                                    return
            else:
                # Fall back to sync file write
                with open(local, "wb") as local_file:
                    async with self._client.download_stream(remote_path) as stream:
                        async for chunk in stream.iter_by_block():
                            local_file.write(chunk)
                            bytes_downloaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_downloaded):
                                    return

        except aioftp.StatusCodeError as e:
            raise Exception(f"Download failed: {e}")

    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Upload a file asynchronously with progress tracking."""
        assert self._client is not None, "Client not connected"

        remote_path = remote.as_posix()
        bytes_uploaded = 0
        chunk_size = 8192

        try:
            if AIOFILES_AVAILABLE:
                import aiofiles
                async with aiofiles.open(local, "rb") as local_file:
                    async with self._client.upload_stream(remote_path) as stream:
                        while True:
                            chunk = await local_file.read(chunk_size)
                            if not chunk:
                                break
                            await stream.write(chunk)
                            bytes_uploaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_uploaded):
                                    raise Exception("Transfer cancelled by user.")
            else:
                with open(local, "rb") as local_file:
                    async with self._client.upload_stream(remote_path) as stream:
                        while True:
                            chunk = local_file.read(chunk_size)
                            if not chunk:
                                break
                            await stream.write(chunk)
                            bytes_uploaded += len(chunk)
                            if progress_callback:
                                if not progress_callback(bytes_uploaded):
                                    raise Exception("Transfer cancelled by user.")

        except aioftp.StatusCodeError as e:
            raise Exception(f"Upload failed: {e}")

    async def unlink(self, remote: PurePath) -> bool:
        """Delete a file asynchronously."""
        assert self._client is not None, "Client not connected"

        try:
            await self._client.remove_file(remote.as_posix())
            return True
        except Exception:
            return False

    async def mkdir(self, remote: PurePath) -> bool:
        """Create a directory asynchronously."""
        assert self._client is not None, "Client not connected"

        try:
            await self._client.make_directory(remote.as_posix())
            return True
        except Exception:
            return False
