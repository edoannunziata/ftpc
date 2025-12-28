from ftplib import FTP, FTP_TLS, error_perm, error_temp, error_reply
from pathlib import Path, PurePosixPath, PurePath
from datetime import datetime
from types import TracebackType
from typing import Any, Callable, List, Optional, Tuple, TYPE_CHECKING, Union
from typing_extensions import Self
import re
import socket

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import (
    ClientConnectionError,
    AuthenticationError,
    ListingError,
)

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig

try:
    import socks

    SOCKS_AVAILABLE = True
except ImportError:
    SOCKS_AVAILABLE = False


class Socks5FTP(FTP):
    """FTP client that routes connections through a SOCKS5 proxy."""

    def __init__(
        self,
        host: str = "",
        proxy_host: str = "",
        proxy_port: int = 1080,
        proxy_username: Optional[str] = None,
        proxy_password: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self.proxy_username = proxy_username
        self.proxy_password = proxy_password
        super().__init__(host, **kwargs)

    def connect(
        self,
        host: str = "",
        port: int = 0,
        timeout: float = -999,
        source_address: Optional[Tuple[str, int]] = None,
    ) -> str:
        """Connect to FTP server through SOCKS5 proxy."""
        if not host:
            host = self.host
        if not port:
            port = self.port
        if timeout == -999:
            timeout = self.timeout  # type: ignore[assignment]

        self.host = host
        self.port = port

        # Create SOCKS5 socket
        self.sock = socks.socksocket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.set_proxy(  # type: ignore[union-attr]
            socks.SOCKS5,
            self.proxy_host,
            self.proxy_port,
            username=self.proxy_username,
            password=self.proxy_password,
        )
        if timeout is not None and timeout >= 0:
            self.sock.settimeout(timeout)
        self.sock.connect((host, port))
        self.af = self.sock.family
        self.file = self.sock.makefile("r", encoding=self.encoding)
        self.welcome = self.getresp()
        return self.welcome

    def ntransfercmd(self, cmd: str, rest: Optional[int] = None) -> Tuple[socket.socket, Optional[int]]:  # type: ignore[override]
        """Override to route data connections through SOCKS5 proxy."""
        size: Optional[int] = None
        if self.passiveserver:
            host, port = self.makepasv()
            # Create SOCKS5 socket for data connection
            conn = socks.socksocket(socket.AF_INET, socket.SOCK_STREAM)
            conn.set_proxy(
                socks.SOCKS5,
                self.proxy_host,
                self.proxy_port,
                username=self.proxy_username,
                password=self.proxy_password,
            )
            conn.settimeout(self.timeout)
            conn.connect((host, port))
            try:
                if rest is not None:
                    self.sendcmd("REST %s" % rest)
                resp = self.sendcmd(cmd)
                if resp[0] == "2":
                    resp = self.getresp()
                if resp[0] != "1":
                    raise Exception(resp)
            except Exception:
                conn.close()
                raise
            if resp[:3] == "150":
                match = re.search(r"\((\d+) bytes\)", resp)
                if match:
                    size = int(match.group(1))
        else:
            # Active mode not supported through SOCKS proxy
            raise RuntimeError("Active FTP mode is not supported through SOCKS5 proxy")
        return conn, size


class Socks5FTP_TLS(FTP_TLS, Socks5FTP):
    """FTPS client that routes connections through a SOCKS5 proxy."""

    def __init__(
        self,
        host: str = "",
        proxy_host: str = "",
        proxy_port: int = 1080,
        proxy_username: Optional[str] = None,
        proxy_password: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self.proxy_username = proxy_username
        self.proxy_password = proxy_password
        FTP_TLS.__init__(self, host, **kwargs)

    def ntransfercmd(self, cmd: str, rest: Optional[int] = None) -> Tuple[socket.socket, Optional[int]]:  # type: ignore[override]
        """Override to route data connections through SOCKS5 proxy and wrap with TLS."""
        conn, size = Socks5FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:  # type: ignore[attr-defined]
            conn = self.context.wrap_socket(
                conn, server_hostname=self.host, session=self.sock.session  # type: ignore[union-attr]
            )
        return conn, size


class FtpClient(Client):
    # Directory listing patterns
    _UNIX_PATTERN = re.compile(
        r"^([\-ld])([rwxs\-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+"
        r"(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{1,2}|\d{4}))\s+(.+)$"
    )
    _WINDOWS_PATTERN = re.compile(
        r"^(\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}[AP]M)\s+(<DIR>|\d+)\s+(.+)$"
    )

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
        self.url = url
        self.port = port
        self.tls = tls
        self.username = username
        self.password = password
        self.ftp_client: Optional[Union[FTP, FTP_TLS, Socks5FTP, Socks5FTP_TLS]] = None
        self._name = name if name else url
        self.proxy_config = proxy_config

    def __enter__(self) -> Self:
        if self.proxy_config and not SOCKS_AVAILABLE:
            raise RuntimeError(
                "PySocks is required for SOCKS5 proxy support. "
                "Install with: pip install pysocks"
            )

        try:
            self.ftp_client = self._create_client()
            self.ftp_client.connect(self.url, self.port, timeout=5)
            self._login()
        except error_perm as e:
            error_str = str(e)
            if "530" in error_str:
                raise AuthenticationError(f"Authentication failed: {error_str}")
            raise ClientConnectionError(f"FTP error: {error_str}")
        except (socket.gaierror, socket.timeout, OSError) as e:
            raise ClientConnectionError(f"Failed to connect to {self.url}: {e}")
        except (error_temp, error_reply) as e:
            raise ClientConnectionError(f"FTP error: {e}")
        return self

    def _create_client(self) -> Union[FTP, FTP_TLS, Socks5FTP, Socks5FTP_TLS]:
        """Create appropriate FTP client based on TLS and proxy settings.

        Note: Does not connect to the server. Call connect() separately.
        """
        if self.proxy_config:
            cls = Socks5FTP_TLS if self.tls else Socks5FTP
            return cls(
                proxy_host=self.proxy_config.host,
                proxy_port=self.proxy_config.port,
                proxy_username=self.proxy_config.username,
                proxy_password=self.proxy_config.password,
            )
        return FTP_TLS() if self.tls else FTP()

    def _login(self) -> None:
        """Authenticate and enable TLS protection if applicable."""
        assert self.ftp_client is not None, "Client not created"
        if self.tls:
            self.ftp_client.auth()  # type: ignore[union-attr]
        self.ftp_client.login(user=self.username, passwd=self.password)
        if self.tls:
            self.ftp_client.prot_p()  # type: ignore[union-attr]

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        if self.ftp_client:
            try:
                self.ftp_client.quit()
            except (error_perm, error_temp, error_reply, OSError, EOFError):
                # If quit fails (e.g., connection already closed), force close
                self.ftp_client.close()

    def name(self) -> str:
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        """List directory contents, trying MLSD first with LIST fallback."""
        assert self.ftp_client is not None, "Client not connected"

        try:
            # Try MLSD first (RFC 3659 standardized format)
            return self._ls_mlsd(path)
        except error_perm:
            # MLSD not supported, fall back to LIST parsing
            return self._ls_list(path)

    def _ls_list(self, path: PurePath) -> List[FileDescriptor]:
        """List directory contents using LIST command with regex parsing.

        This is a fallback for servers that don't support MLSD.
        """
        assert self.ftp_client is not None, "Client not connected"
        result: List[FileDescriptor] = []

        try:
            # Get detailed directory listing
            lines: list[str] = []
            self.ftp_client.cwd(path.as_posix())
            self.ftp_client.dir(lines.append)

            # Parse the detailed listing to extract file information
            for line in lines:
                if fd := self._parse_list_line(line):
                    result.append(fd)

            # If detailed listing doesn't work, fall back to simpler listing
            if not result:
                simple_list = self.ftp_client.nlst()
                for name in simple_list:
                    # In simple list mode, we can't determine if it's a file or directory
                    # We'll need to probe each item by trying to CWD to it
                    pure_path = PurePosixPath(name)

                    # Try to determine if it's a directory
                    is_dir = self._is_directory(name)

                    fd = FileDescriptor(
                        path=pure_path,
                        filetype=FileType.DIRECTORY if is_dir else FileType.FILE,
                    )
                    result.append(fd)

        except (error_perm, error_temp, error_reply, OSError, EOFError) as e:
            # FTP errors: permission denied, temporary failure, protocol error
            # OSError: network issues, EOFError: connection closed
            raise ListingError(f"Failed to list directory '{path}': {e}")

        return result

    def _is_directory(self, path_str: str) -> bool:
        """
        Check if a path on the FTP server is a directory.

        Args:
            path_str: The path string to check

        Returns:
            True if the path is a directory, False otherwise
        """
        assert self.ftp_client is not None, "Client not connected"
        original_dir = self.ftp_client.pwd()
        try:
            self.ftp_client.cwd(path_str)
            return True
        except (error_perm, error_temp, OSError, EOFError):
            # Cannot cwd into path - it's not a directory (or doesn't exist)
            return False
        finally:
            try:
                self.ftp_client.cwd(original_dir)
            except (error_perm, error_temp, OSError, EOFError):
                # Best effort to restore directory - if it fails, we can't do much
                pass

    def _ls_mlsd(self, path: PurePath) -> List[FileDescriptor]:
        """List directory contents using MLSD command (RFC 3659).

        MLSD provides a standardized, machine-readable format that is more
        reliable than parsing LIST output.

        Args:
            path: Directory path to list

        Returns:
            List of FileDescriptor objects

        Raises:
            error_perm: If MLSD is not supported by the server
        """
        assert self.ftp_client is not None, "Client not connected"
        result: List[FileDescriptor] = []

        for name, facts in self.ftp_client.mlsd(path.as_posix()):
            # Skip current and parent directory entries
            file_type_str = facts.get("type", "").lower()
            if file_type_str in ("cdir", "pdir"):
                continue

            # Determine file type
            if file_type_str == "dir":
                file_type = FileType.DIRECTORY
            else:
                file_type = FileType.FILE

            # Parse size
            size: Optional[int] = None
            if "size" in facts:
                try:
                    size = int(facts["size"])
                except ValueError:
                    pass

            # Parse modification time (YYYYMMDDHHMMSS format, UTC)
            modified_time: Optional[datetime] = None
            if "modify" in facts:
                try:
                    # MLSD modify format: YYYYMMDDHHMMSS or YYYYMMDDHHMMSS.sss
                    modify_str = facts["modify"].split(".")[0]
                    modified_time = datetime.strptime(modify_str, "%Y%m%d%H%M%S")
                except ValueError:
                    pass

            result.append(
                FileDescriptor(
                    path=PurePosixPath(name),
                    filetype=file_type,
                    size=size,
                    modified_time=modified_time,
                )
            )

        return result

    def _parse_list_line(self, line: str) -> FileDescriptor | None:
        # Try Unix style first
        unix_match = self._UNIX_PATTERN.match(line)
        if unix_match:
            file_type = (
                FileType.DIRECTORY if unix_match.group(1) == "d" else FileType.FILE
            )
            size = int(unix_match.group(6))

            # Parse the date (this is simplified and might need adjustment)
            try:
                date_str = unix_match.group(7)
                # This is a simplification - proper parsing would need more context
                modified_time = datetime.strptime(date_str, "%b %d %Y")
            except ValueError:
                try:
                    # Add current year to avoid Python 3.15 deprecation warning
                    current_year = datetime.now().year
                    modified_time = datetime.strptime(
                        f"{current_year} {date_str}", "%Y %b %d %H:%M"
                    )
                except ValueError:
                    modified_time = None

            file_name = unix_match.group(8)
            path = PurePosixPath(file_name)

            return FileDescriptor(
                path=path, filetype=file_type, size=size, modified_time=modified_time
            )

        # Try Windows style
        windows_match = self._WINDOWS_PATTERN.match(line)
        if windows_match:
            # Parse the date
            try:
                date_str = windows_match.group(1)
                modified_time = datetime.strptime(date_str, "%m-%d-%y %I:%M%p")
            except ValueError:
                modified_time = None

            dir_or_size = windows_match.group(2)
            file_name = windows_match.group(3)

            # Determine if it's a directory
            is_dir = dir_or_size == "<DIR>"
            size = 0 if is_dir else int(dir_or_size)

            path = PurePosixPath(file_name)

            return FileDescriptor(
                path=path,
                filetype=FileType.DIRECTORY if is_dir else FileType.FILE,
                size=size,
                modified_time=modified_time,
            )

        # If we couldn't parse the line format, return None
        return None

    def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        assert self.ftp_client is not None, "Client not connected"
        with open(local, "wb+") as fp:
            if progress_callback:
                bytes_so_far = 0

                def callback(data: bytes) -> None:
                    nonlocal bytes_so_far
                    bytes_so_far += len(data)
                    fp.write(data)
                    progress_callback(bytes_so_far)

                self.ftp_client.retrbinary(f"RETR {remote.as_posix()}", callback)
            else:
                self.ftp_client.retrbinary(f"RETR {remote.as_posix()}", fp.write)

    def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        assert self.ftp_client is not None, "Client not connected"
        cmd = f"STOR {remote.as_posix()}"
        with open(local, "rb+") as fp:
            self.ftp_client.voidcmd("TYPE I")
            if progress_callback:
                bytes_so_far = 0
                with self.ftp_client.transfercmd(cmd, None) as conn:
                    while buf := fp.read(8192):
                        conn.sendall(buf)
                        bytes_so_far += len(buf)
                        if not progress_callback(bytes_so_far):
                            conn.close()
                            self.ftp_client.voidresp()
                            raise Exception("Transfer cancelled by user.")
                self.ftp_client.voidresp()
            else:
                with self.ftp_client.transfercmd(cmd, None) as conn:
                    while buf := fp.read(8192):
                        conn.sendall(buf)
                self.ftp_client.voidresp()

    def unlink(self, remote: PurePath) -> bool:
        assert self.ftp_client is not None, "Client not connected"
        try:
            self.ftp_client.delete(remote.as_posix())
            return True
        except (error_perm, error_temp, error_reply, OSError, EOFError):
            return False

    def mkdir(self, remote: PurePath) -> bool:
        assert self.ftp_client is not None, "Client not connected"
        try:
            self.ftp_client.mkd(remote.as_posix())
            return True
        except (error_perm, error_temp, error_reply, OSError, EOFError):
            return False
