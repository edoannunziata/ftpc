from ftplib import FTP, FTP_TLS, error_perm, error_temp, error_reply
from pathlib import Path, PurePosixPath, PurePath
from datetime import datetime
from typing import List, Optional, TYPE_CHECKING
import re
import socket

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType

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
        **kwargs,
    ):
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self.proxy_username = proxy_username
        self.proxy_password = proxy_password
        super().__init__(host, **kwargs)

    def connect(
        self, host: str = "", port: int = 0, timeout: float = -999, source_address=None
    ):
        """Connect to FTP server through SOCKS5 proxy."""
        if not host:
            host = self.host
        if not port:
            port = self.port
        if timeout == -999:
            timeout = self.timeout

        self.host = host
        self.port = port

        # Create SOCKS5 socket
        self.sock = socks.socksocket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.set_proxy(
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

    def ntransfercmd(self, cmd, rest=None):
        """Override to route data connections through SOCKS5 proxy."""
        size = None
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
        **kwargs,
    ):
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self.proxy_username = proxy_username
        self.proxy_password = proxy_password
        FTP_TLS.__init__(self, host, **kwargs)

    def ntransfercmd(self, cmd, rest=None):
        """Override to route data connections through SOCKS5 proxy and wrap with TLS."""
        conn, size = Socks5FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(
                conn, server_hostname=self.host, session=self.sock.session
            )
        return conn, size


class FtpClient(Client):
    def __init__(
        self,
        url,
        *,
        tls=True,
        username="",
        password="",
        name="",
        proxy_config: Optional["ProxyConfig"] = None,
    ):
        self.url = url
        self.tls = tls
        self.username = username
        self.password = password
        self.ftp_client = None
        self._name = name if name else url
        self.proxy_config = proxy_config

    def __enter__(self):
        if self.proxy_config:
            if not SOCKS_AVAILABLE:
                raise RuntimeError(
                    "PySocks is required for SOCKS5 proxy support. "
                    "Install with: pip install pysocks"
                )
            if self.tls:
                self.ftp_client = Socks5FTP_TLS(
                    self.url,
                    proxy_host=self.proxy_config.host,
                    proxy_port=self.proxy_config.port,
                    proxy_username=self.proxy_config.username,
                    proxy_password=self.proxy_config.password,
                )
                self.ftp_client.auth()
                self.ftp_client.login(user=self.username, passwd=self.password)
                self.ftp_client.prot_p()
            else:
                self.ftp_client = Socks5FTP(
                    self.url,
                    proxy_host=self.proxy_config.host,
                    proxy_port=self.proxy_config.port,
                    proxy_username=self.proxy_config.username,
                    proxy_password=self.proxy_config.password,
                )
                self.ftp_client.login(user=self.username, passwd=self.password)
        else:
            if self.tls:
                self.ftp_client = FTP_TLS(self.url)
                self.ftp_client.auth()
                self.ftp_client.login(user=self.username, passwd=self.password)
                self.ftp_client.prot_p()
            else:
                self.ftp_client = FTP(self.url)
                self.ftp_client.login(user=self.username, passwd=self.password)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.ftp_client:
            try:
                self.ftp_client.quit()
            except (error_perm, error_temp, error_reply, OSError, EOFError):
                # If quit fails (e.g., connection already closed), force close
                self.ftp_client.close()

    def name(self) -> str:
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        result = []

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

        except (error_perm, error_temp, error_reply, OSError, EOFError):
            # FTP errors: permission denied, temporary failure, protocol error
            # OSError: network issues, EOFError: connection closed
            pass

        return result

    def _is_directory(self, path_str: str) -> bool:
        """
        Check if a path on the FTP server is a directory.

        Args:
            path_str: The path string to check

        Returns:
            True if the path is a directory, False otherwise
        """
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

    def _parse_list_line(self, line: str) -> FileDescriptor | None:
        # Unix-style listing (most common)
        unix_pattern = r"^([\-ld])([rwxs\-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{1,2}|\d{4}))\s+(.+)$"

        # Windows-style listing
        windows_pattern = (
            r"^(\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}[AP]M)\s+(<DIR>|\d+)\s+(.+)$"
        )

        # Try Unix style first
        unix_match = re.match(unix_pattern, line)
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
                    modified_time = datetime.strptime(date_str, "%b %d %H:%M")
                    # Add current year since it's not in the string
                    current_year = datetime.now().year
                    modified_time = modified_time.replace(year=current_year)
                except ValueError:
                    modified_time = None

            file_name = unix_match.group(8)
            path = PurePosixPath(file_name)

            return FileDescriptor(
                path=path, filetype=file_type, size=size, modified_time=modified_time
            )

        # Try Windows style
        windows_match = re.match(windows_pattern, line)
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

    def get(self, remote: PurePath, local: Path, progress_callback=None):
        with open(local, "wb+") as fp:
            if progress_callback:
                bytes_so_far = 0

                def callback(data):
                    nonlocal bytes_so_far
                    bytes_so_far += len(data)
                    fp.write(data)
                    return progress_callback(bytes_so_far)

            else:
                callback = fp.write

            self.ftp_client.retrbinary(f"RETR {remote.as_posix()}", callback)

    def put(self, local: Path, remote: PurePath, progress_callback=None):
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
        try:
            self.ftp_client.delete(remote.as_posix())
            return True
        except (error_perm, error_temp, error_reply, OSError, EOFError):
            # Permission denied, file not found, or connection issues
            return False

    def mkdir(self, remote: PurePath) -> bool:
        try:
            self.ftp_client.mkd(remote.as_posix())
            return True
        except (error_perm, error_temp, error_reply, OSError, EOFError):
            # Permission denied, directory exists, or connection issues
            return False
