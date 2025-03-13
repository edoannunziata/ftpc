"""
S3-compatible storage client for ftpc.

This module requires the following dependencies:
    - boto3

If these dependencies are not installed, the client will not be available,
but the rest of the application will continue to work with other storage types.
"""
from pathlib import Path, PurePath, PurePosixPath
from typing import List, Optional, Callable
import importlib.util
from datetime import datetime

# Check for S3 dependencies
S3_DEPS_MISSING = []
if importlib.util.find_spec("boto3") is None:
    S3_DEPS_MISSING.append("boto3")

if not S3_DEPS_MISSING:
    # Only import boto3 if dependencies are available
    import boto3
    from botocore.exceptions import ClientError
    from botocore import UNSIGNED
    from botocore.client import Config
else:
    # Define dummy exception classes to prevent syntax errors
    class ClientError(Exception): pass

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType


class S3Client(Client):
    """Client to interact with S3-compatible storage.

    This client requires the following dependencies to be installed:
    - boto3

    If these dependencies are not installed, the application will display
    an appropriate error message when attempting to use this client.
    """

    # Check if dependencies are missing when class is defined
    if S3_DEPS_MISSING:
        missing_deps = ", ".join(S3_DEPS_MISSING)
        raise ImportError(
            f"S3 client requires additional dependencies: {missing_deps}. "
            f"Install with: pip install {' '.join(S3_DEPS_MISSING)}"
        )

    def __init__(
            self,
            bucket_name,
            *,
            endpoint_url=None,
            aws_access_key_id=None,
            aws_secret_access_key=None,
            region_name=None,
            name=None
    ):
        """
        Initialize the S3-compatible storage client.

        Args:
            bucket_name: Name of the S3 bucket to use (can be provided directly or via url)
            endpoint_url: URL to the S3-compatible service endpoint
            aws_access_key_id: Optional access key ID for authentication
            aws_secret_access_key: Optional secret access key for authentication
            region_name: Optional AWS region name
            name: Optional human-readable name for this client
        """
        self.bucket_name = bucket_name
        self.endpoint_url = endpoint_url
        self.aws_access_key_id = aws_access_key_id
        self.aws_secret_access_key = aws_secret_access_key
        self.region_name = region_name
        self._name = name if name else f"S3:{bucket_name}"

        # These will be initialized in __enter__
        self.s3_client = None
        self.s3_resource = None

    def __enter__(self):
        """Connect to S3 when entering the context."""
        # Create session with provided credentials if any
        session = boto3.session.Session(
            aws_access_key_id=self.aws_access_key_id,
            aws_secret_access_key=self.aws_secret_access_key,
            region_name=self.region_name
        )

        # Create S3 client and resource
        # If no credentials are provided, use unsigned requests (anonymous access)
        if not self.aws_access_key_id and not self.aws_secret_access_key:
            config = Config(signature_version=UNSIGNED)
            self.s3_client = session.client(
                's3', 
                endpoint_url=self.endpoint_url,
                config=config
            )
            self.s3_resource = session.resource(
                's3', 
                endpoint_url=self.endpoint_url,
                config=config
            )
        else:
            self.s3_client = session.client('s3', endpoint_url=self.endpoint_url)
            self.s3_resource = session.resource('s3', endpoint_url=self.endpoint_url)
        
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Clean up resources when exiting the context."""
        self.s3_client = None
        self.s3_resource = None

    def name(self) -> str:
        """Return a human-readable name for this client."""
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        """
        List files and directories in the specified S3 path.

        Args:
            path: The remote S3 path to list

        Returns:
            A list of FileDescriptor objects representing the files and directories
        """
        result = []

        # Convert path to string format that S3 expects
        s3_path = self._format_path(path)
        
        # For the root directory, we need an empty prefix
        prefix = s3_path + '/' if s3_path else ''
        
        # Simulate directories by using delimiter
        try:
            response = self.s3_client.list_objects_v2(
                Bucket=self.bucket_name,
                Prefix=prefix,
                Delimiter='/'
            )
            
            # Handle common prefixes (directories)
            if 'CommonPrefixes' in response:
                for common_prefix in response['CommonPrefixes']:
                    # Extract just the name component (not the full path)
                    dir_name = common_prefix['Prefix'].rstrip('/')
                    dir_name = PurePosixPath(dir_name).name
                    
                    fd = FileDescriptor(
                        path=PurePosixPath(dir_name),
                        filetype=FileType.DIRECTORY,
                        size=0,  # Directories don't have a size in S3
                        modified_time=None  # Directories don't have modified time in S3
                    )
                    result.append(fd)
            
            # Handle objects (files)
            if 'Contents' in response:
                for content in response['Contents']:
                    # Skip the directory placeholder itself if present
                    if content['Key'] == prefix:
                        continue
                    
                    # Extract just the name component (not the full path)
                    file_key = content['Key']
                    if prefix:
                        # Remove the prefix to get just the filename
                        file_key = file_key[len(prefix):]
                    
                    # Skip if this is a nested "directory"
                    if '/' in file_key:
                        continue
                    
                    fd = FileDescriptor(
                        path=PurePosixPath(file_key),
                        filetype=FileType.FILE,
                        size=content['Size'],
                        modified_time=content['LastModified']
                    )
                    result.append(fd)
                    
        except ClientError:
            # Handle not found or permission errors
            pass

        return result

    def get(self, remote: PurePath, local: Path, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Download a file from S3 to the local path.

        Args:
            remote: The remote path to the file to download
            local: The local path where the file will be saved
            progress_callback: Optional callback function that receives bytes downloaded so far
        """
        # Format path for S3
        s3_path = self._format_path(remote)
        
        # Create a custom callback for download progress
        class ProgressTracker:
            def __init__(self, callback):
                self.bytes_downloaded = 0
                self.callback = callback
                
            def __call__(self, bytes_amount):
                self.bytes_downloaded += bytes_amount
                if self.callback:
                    return self.callback(self.bytes_downloaded)
                return True
        
        try:
            # Set up progress callback if provided
            if progress_callback:
                progress = ProgressTracker(progress_callback)
                self.s3_client.download_file(
                    self.bucket_name, 
                    s3_path, 
                    str(local), 
                    Callback=progress
                )
            else:
                self.s3_client.download_file(
                    self.bucket_name, 
                    s3_path, 
                    str(local)
                )
        except ClientError:
            # Handle not found or permission errors
            pass

    def put(self, local: Path, remote: PurePath, progress_callback: Optional[Callable[[int], bool]] = None):
        """
        Upload a file from the local path to S3.

        Args:
            local: The local path to the file to upload
            remote: The remote path where the file will be saved
            progress_callback: Optional callback function that receives bytes uploaded so far
        """
        # Format path for S3
        s3_path = self._format_path(remote)
        
        # Create a custom callback for upload progress
        class ProgressTracker:
            def __init__(self, callback):
                self.bytes_uploaded = 0
                self.callback = callback
                
            def __call__(self, bytes_amount):
                self.bytes_uploaded += bytes_amount
                if self.callback:
                    return self.callback(self.bytes_uploaded)
                return True
        
        try:
            # Set up progress callback if provided
            if progress_callback:
                progress = ProgressTracker(progress_callback)
                self.s3_client.upload_file(
                    str(local), 
                    self.bucket_name, 
                    s3_path, 
                    Callback=progress
                )
            else:
                self.s3_client.upload_file(
                    str(local), 
                    self.bucket_name, 
                    s3_path
                )
        except ClientError:
            # Handle permission errors
            pass

    def unlink(self, remote: PurePath) -> bool:
        """
        Delete a file at the specified remote S3 path.

        Args:
            remote: The remote path to the file to delete

        Returns:
            True if the file was successfully deleted, False otherwise
        """
        try:
            # Format path for S3
            s3_path = self._format_path(remote)
            
            # Delete the object
            self.s3_client.delete_object(
                Bucket=self.bucket_name,
                Key=s3_path
            )
            
            return True
        except ClientError:
            return False

    def _format_path(self, path: PurePath) -> str:
        """
        Format a path object to the format expected by S3.

        Args:
            path: The path to format

        Returns:
            A string in the format expected by S3
        """
        # Remove leading slash if present
        path_str = path.as_posix()
        if path_str == '/':
            return ''
        if path_str.startswith('/'):
            return path_str[1:]
        return path_str
