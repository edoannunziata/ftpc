"""
SFTP client for ftpc.

This module requires the following dependencies:
    - paramiko

If these dependencies are not installed, the client will not be available,
but the rest of the application will continue to work with other storage types.
"""
from pathlib import Path, PurePath, PurePosixPath
from typing import List, Optional, Callable
import importlib.util
import stat
from datetime import datetime
import os.path

# Check for SFTP dependencies
SFTP_DEPS_MISSING = []
if importlib.util.find_spec("paramiko") is None:
    SFTP_DEPS_MISSING.append("paramiko")

if not SFTP_DEPS_MISSING:
    # Only import paramiko if dependencies are available
    import paramiko
    from paramiko.ssh_exception import SSHException
else:
    # Define dummy exception classes to prevent syntax errors
    class SSHException(Exception): pass

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType


class SftpClient(Client):
    """Client to interact with SFTP servers.

    This client requires the following dependencies to be installed:
    - paramiko

    If these dependencies are not installed, the application will display
    an appropriate error message when attempting to use this client.
    """

    # Check if dependencies are missing when class is defined
    if SFTP_DEPS_MISSING:
        missing_deps = ", ".join(SFTP_DEPS_MISSING)
        raise ImportError(
            f"SFTP client requires additional dependencies: {missing_deps}. "
            f"Install with: pip install {' '.join(SFTP_DEPS_MISSING)}"
        )

    def __init__(
            self,
            host,
            *,
            port=22,
            username=None,
            password=None,
            key_filename=None,
            name=None
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
        """Establish SSH connection and create SFTP client when entering the context."""
        try:
            # Create SSH client and connect
            self.ssh_client = paramiko.SSHClient()
            self.ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            # Connect with the appropriate authentication method
            connect_kwargs = {
                'hostname': self.host,
                'port': self.port,
                'timeout': 10,
            }
            
            if self.username:
                connect_kwargs['username'] = self.username
            
            if self.password:
                connect_kwargs['password'] = self.password
            
            if self.key_filename:
                connect_kwargs['key_filename'] = self.key_filename
            else:
                connect_kwargs['look_for_keys'] = False
            
            self.ssh_client.connect(**connect_kwargs)

            # Create SFTP client
            self.sftp_client = self.ssh_client.open_sftp()
            
            return self
        except Exception as e:
            # Clean up if connection fails
            if self.ssh_client:
                self.ssh_client.close()
                self.ssh_client = None
            raise RuntimeError(f"Failed to connect to SFTP server: {str(e)}")

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Close SFTP and SSH connections when exiting the context."""
        if self.sftp_client:
            self.sftp_client.close()
            self.sftp_client = None
        
        if self.ssh_client:
            self.ssh_client.close()
            self.ssh_client = None

    def name(self) -> str:
        """Return a human-readable name for this client."""
        return self._name

    def ls(self, remote: PurePath) -> List[FileDescriptor]:
        """
        List files and directories in the specified remote path.

        Args:
            remote: The remote path to list

        Returns:
            A list of FileDescriptor objects representing the files and directories
        """
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
            # Handle errors (path not found, permission denied, etc.)
            pass
        
        return result

    def get(self, remote: PurePath, local: Path, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Download a file from the remote path to the local path.

        Args:
            remote: The remote path to the file to download
            local: The local path where the file will be saved
            progress_callback: Optional callback function that receives the number of bytes downloaded so far
        """
        try:
            # Convert paths
            remote_path = self._format_path(remote)
            local_path = str(local)
            
            if progress_callback:
                # Get file size for progress reporting
                try:
                    remote_stat = self.sftp_client.stat(remote_path)
                    total_size = remote_stat.st_size
                except:
                    total_size = 0  # Unknown size
                
                # Custom callback for progress tracking
                class ProgressTracker:
                    def __init__(self, callback, total):
                        self.bytes_processed = 0
                        self.callback = callback
                        self.total = total
                    
                    def __call__(self, bytes_transferred, total_transferred):
                        self.bytes_processed = total_transferred
                        return self.callback(self.bytes_processed)
                
                progress = ProgressTracker(progress_callback, total_size)
                
                # Download with progress callback
                self.sftp_client.get(remote_path, local_path, callback=progress)
            else:
                # Simple download without progress
                self.sftp_client.get(remote_path, local_path)
        
        except (SSHException, IOError):
            # Handle errors
            pass

    def put(self, local: Path, remote: PurePath, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Upload a file from the local path to the remote path.

        Args:
            local: The local path to the file to upload
            remote: The remote path where the file will be saved
            progress_callback: Optional callback function that receives the number of bytes uploaded so far
        """
        try:
            # Convert paths
            remote_path = self._format_path(remote)
            local_path = str(local)
            
            if progress_callback:
                # Get file size for progress reporting
                total_size = os.path.getsize(local_path)
                
                # Custom callback for progress tracking
                class ProgressTracker:
                    def __init__(self, callback, total):
                        self.bytes_processed = 0
                        self.callback = callback
                        self.total = total
                    
                    def __call__(self, bytes_transferred, total_transferred):
                        self.bytes_processed = total_transferred
                        return self.callback(self.bytes_processed)
                
                progress = ProgressTracker(progress_callback, total_size)
                
                # Upload with progress callback
                self.sftp_client.put(local_path, remote_path, callback=progress)
            else:
                # Simple upload without progress
                self.sftp_client.put(local_path, remote_path)
        
        except (SSHException, IOError):
            # Handle errors
            pass

    def unlink(self, remote: PurePath) -> bool:
        """
        Delete a file at the specified remote path.

        Args:
            remote: The remote path to the file to delete

        Returns:
            True if the file was successfully deleted, False otherwise
        """
        try:
            remote_path = self._format_path(remote)
            self.sftp_client.remove(remote_path)
            return True
        except (SSHException, IOError):
            return False

    def _format_path(self, path: PurePath) -> str:
        """
        Format a path object to a string path suitable for SFTP.

        Args:
            path: The path to format

        Returns:
            A string in the format expected by SFTP
        """
        return path.as_posix()

    def _stat_to_file_descriptor(self, attr, path: PurePath) -> FileDescriptor:
        """
        Convert an SFTP attribute to a FileDescriptor object.

        Args:
            attr: The SFTP file attributes
            path: The path for the FileDescriptor

        Returns:
            A FileDescriptor object representing the file or directory
        """
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
            modified_time=datetime.fromtimestamp(attr.st_mtime) if hasattr(attr, 'st_mtime') else None
        )
