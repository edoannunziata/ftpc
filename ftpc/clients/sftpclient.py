from pathlib import Path, PurePath, PurePosixPath
from typing import List, Optional, Callable
import stat
from datetime import datetime
import os.path

import paramiko
from paramiko.ssh_exception import SSHException

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType


class SftpClient(Client):
    def __init__(
        self,
        host,
        *,
        port=22,
        username=None,
        password=None,
        key_filename=None,
        name=None,
    ):
        """
        Initialize the SFTP client.

        Args:
            host: The hostname or IP address of the SFTP server
            port: The port number for the SFTP server (default: 22)
            username: The username for authentication
            password: The password for authentication
            key_filename: Path to the private key file for authentication
            name: Optional human-readable name for this client
        """
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.key_filename = key_filename
        self._name = name if name else f"SFTP:{host}"

        # These will be initialized in __enter__
        self.ssh_client = None
        self.sftp_client = None

    def __enter__(self):
        try:
            self.ssh_client = paramiko.SSHClient()
            self.ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            connect_kwargs = {
                "hostname": self.host,
                "port": self.port,
                "timeout": 10,
            }

            if self.username:
                connect_kwargs["username"] = self.username

            if self.password:
                connect_kwargs["password"] = self.password

            if self.key_filename:
                connect_kwargs["key_filename"] = self.key_filename
            else:
                connect_kwargs["look_for_keys"] = False

            self.ssh_client.connect(**connect_kwargs)

            # Create SFTP client
            self.sftp_client = self.ssh_client.open_sftp()

            return self
        except Exception as e:
            if self.ssh_client:
                self.ssh_client.close()
                self.ssh_client = None
            raise RuntimeError(f"Failed to connect to SFTP server: {str(e)}")

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.sftp_client:
            self.sftp_client.close()
            self.sftp_client = None

        if self.ssh_client:
            self.ssh_client.close()
            self.ssh_client = None

    def name(self) -> str:
        return self._name

    def ls(self, remote: PurePath) -> List[FileDescriptor]:
        result = []

        try:
            # Convert PurePath to string path
            path_str = self._format_path(remote)

            # List files in the directory
            for attr in self.sftp_client.listdir_attr(path_str):
                # Create a FileDescriptor for each item
                fd = self._stat_to_file_descriptor(attr, PurePosixPath(attr.filename))
                result.append(fd)

        except (SSHException, IOError):
            pass

        return result

    def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ):
        try:
            remote_path = self._format_path(remote)
            local_path = str(local)

            if progress_callback:
                try:
                    remote_stat = self.sftp_client.stat(remote_path)
                    total_size = remote_stat.st_size
                except:
                    total_size = 0  # Unknown size

                class ProgressTracker:
                    def __init__(self, callback, total):
                        self.bytes_processed = 0
                        self.callback = callback
                        self.total = total

                    def __call__(self, bytes_transferred, total_transferred):
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
    ):
        try:
            remote_path = self._format_path(remote)
            local_path = str(local)

            if progress_callback:
                total_size = os.path.getsize(local_path)

                class ProgressTracker:
                    def __init__(self, callback, total):
                        self.bytes_processed = 0
                        self.callback = callback
                        self.total = total

                    def __call__(self, bytes_transferred, total_transferred):
                        self.bytes_processed = total_transferred
                        return self.callback(self.bytes_processed)

                progress = ProgressTracker(progress_callback, total_size)

                self.sftp_client.put(local_path, remote_path, callback=progress)
            else:
                self.sftp_client.put(local_path, remote_path)

        except (SSHException, IOError):
            pass

    def unlink(self, remote: PurePath) -> bool:
        try:
            remote_path = self._format_path(remote)
            self.sftp_client.remove(remote_path)
            return True
        except (SSHException, IOError):
            return False

    def _format_path(self, path: PurePath) -> str:
        return path.as_posix()

    def _stat_to_file_descriptor(self, attr, path: PurePath) -> FileDescriptor:
        # Determine if it's a file or directory
        if stat.S_ISDIR(attr.st_mode):
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
                if hasattr(attr, "st_mtime")
                else None
            ),
        )
