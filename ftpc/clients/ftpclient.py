from ftplib import FTP, FTP_TLS
from pathlib import Path, PurePosixPath, PurePath
from datetime import datetime
from typing import List
import re

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType


class FtpClient(Client):
    def __init__(
        self,
        url,
        *,
        tls=True,
        username='',
        password='',
        name=''
    ):
        self.url = url
        self.tls = tls
        self.username = username
        self.password = password
        self.ftp_client = None
        self._name = name if name else url

    def __enter__(self):
        if self.tls:
            self.ftp_client = FTP_TLS(self.url)
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
            except Exception:
                self.ftp_client.close()

    def name(self) -> str:
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        """
        List files and directories in the specified FTP path.

        Args:
            path: The remote FTP path to list

        Returns:
            A list of FileDescriptor objects representing the files and directories
        """
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
                        filetype=FileType.DIRECTORY if is_dir else FileType.FILE
                    )
                    result.append(fd)

        except Exception:
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
        except Exception:
            return False
        finally:
            try:
                self.ftp_client.cwd(original_dir)
            except Exception:
                pass

    def _parse_list_line(self, line: str) -> FileDescriptor | None:
        """
        Parse a line from the FTP LIST command output.

        Args:
            line: The line from LIST output
            parent_path: The parent path for constructing full paths

        Returns:
            A FileDescriptor object, or None if parsing failed
        """
        # Unix-style listing (most common)
        unix_pattern = r'^([\-ld])([rwxs\-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{1,2}|\d{4}))\s+(.+)$'

        # Windows-style listing
        windows_pattern = r'^(\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}[AP]M)\s+(<DIR>|\d+)\s+(.+)$'

        # Try Unix style first
        unix_match = re.match(unix_pattern, line)
        if unix_match:
            file_type = FileType.DIRECTORY if unix_match.group(1) == 'd' else FileType.FILE
            size = int(unix_match.group(6))

            # Parse the date (this is simplified and might need adjustment)
            try:
                date_str = unix_match.group(7)
                # This is a simplification - proper parsing would need more context
                modified_time = datetime.strptime(date_str, '%b %d %Y')
            except ValueError:
                try:
                    modified_time = datetime.strptime(date_str, '%b %d %H:%M')
                    # Add current year since it's not in the string
                    current_year = datetime.now().year
                    modified_time = modified_time.replace(year=current_year)
                except ValueError:
                    modified_time = None

            file_name = unix_match.group(8)
            path = PurePosixPath(file_name)

            return FileDescriptor(
                path=path,
                filetype=file_type,
                size=size,
                modified_time=modified_time
            )

        # Try Windows style
        windows_match = re.match(windows_pattern, line)
        if windows_match:
            # Parse the date
            try:
                date_str = windows_match.group(1)
                modified_time = datetime.strptime(date_str, '%m-%d-%y %I:%M%p')
            except ValueError:
                modified_time = None

            dir_or_size = windows_match.group(2)
            file_name = windows_match.group(3)

            # Determine if it's a directory
            is_dir = dir_or_size == '<DIR>'
            size = 0 if is_dir else int(dir_or_size)

            path = PurePosixPath(file_name)

            return FileDescriptor(
                path=path,
                filetype=FileType.DIRECTORY if is_dir else FileType.FILE,
                size=size,
                modified_time=modified_time
            )

        # If we couldn't parse the line format, return None
        return None

    def get(self, remote: PurePath, local: Path, progress_callback = None):
        with open(local, 'wb+') as fp:
            if progress_callback:
                bytes_so_far = 0

                def callback(data):
                    nonlocal bytes_so_far
                    bytes_so_far += len(data)
                    fp.write(data)
                    return progress_callback(bytes_so_far)
            else:
                callback = fp.write

            self.ftp_client.retrbinary(f'RETR {remote.as_posix()}', callback)

    def put(self, local: Path, remote: PurePath, progress_callback = None):
        cmd = f'STOR {remote.as_posix()}'
        with open(local, 'rb+') as fp:
            self.ftp_client.voidcmd('TYPE I')
            if progress_callback:
                bytes_so_far = 0
                with self.ftp_client.transfercmd(cmd, None) as conn:
                    while buf := fp.read(8192):
                        conn.sendall(buf)
                        bytes_so_far += len(buf)
                        if not progress_callback(bytes_so_far):
                            conn.close()
                            self.ftp_client.voidresp()
                            raise Exception('Transfer cancelled by user.')
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
        except Exception:
            return False
