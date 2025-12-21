from pathlib import Path, PurePath, PurePosixPath
from types import TracebackType
from typing import Any, List, Optional, Callable, TYPE_CHECKING
from typing_extensions import Self

import boto3
from botocore.exceptions import ClientError
from botocore import UNSIGNED
from botocore.client import Config


from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig


class S3Client(Client):
    def __init__(
        self,
        bucket_name: str,
        *,
        endpoint_url: Optional[str] = None,
        aws_access_key_id: Optional[str] = None,
        aws_secret_access_key: Optional[str] = None,
        region_name: Optional[str] = None,
        name: Optional[str] = None,
        proxy_config: Optional["ProxyConfig"] = None,
    ) -> None:
        """
        Initialize the S3-compatible storage client.

        Args:
            bucket_name: Name of the S3 bucket to use (can be provided directly or via url)
            endpoint_url: URL to the S3-compatible service endpoint
            aws_access_key_id: Optional access key ID for authentication
            aws_secret_access_key: Optional secret access key for authentication
            region_name: Optional AWS region name
            name: Optional human-readable name for this client
            proxy_config: Optional SOCKS5 proxy configuration
        """
        self.bucket_name = bucket_name
        self.endpoint_url = endpoint_url
        self.aws_access_key_id = aws_access_key_id
        self.aws_secret_access_key = aws_secret_access_key
        self.region_name = region_name
        self._name = name if name else f"S3:{bucket_name}"
        self.proxy_config = proxy_config

        # These will be initialized in __enter__
        self.s3_client: Any = None  # boto3 client doesn't have good type stubs
        self.s3_resource: Any = None

    def __enter__(self) -> Self:
        # Create session with provided credentials if any
        session = boto3.session.Session(
            aws_access_key_id=self.aws_access_key_id,
            aws_secret_access_key=self.aws_secret_access_key,
            region_name=self.region_name,
        )

        # Build config with optional proxy and signature settings
        config_kwargs = {}

        if self.proxy_config:
            proxy_url = self._build_proxy_url()
            config_kwargs["proxies"] = {"http": proxy_url, "https": proxy_url}

        # If no credentials are provided, use unsigned requests (anonymous access)
        if not self.aws_access_key_id and not self.aws_secret_access_key:
            config_kwargs["signature_version"] = UNSIGNED

        config = Config(**config_kwargs) if config_kwargs else None

        self.s3_client = session.client(
            "s3", endpoint_url=self.endpoint_url, config=config
        )
        self.s3_resource = session.resource(
            "s3", endpoint_url=self.endpoint_url, config=config
        )

        return self

    def _build_proxy_url(self) -> str:
        """Build SOCKS5 proxy URL for boto3."""
        assert self.proxy_config is not None, "Proxy config not set"
        if self.proxy_config.username and self.proxy_config.password:
            return (
                f"socks5://{self.proxy_config.username}:{self.proxy_config.password}"
                f"@{self.proxy_config.host}:{self.proxy_config.port}"
            )
        return f"socks5://{self.proxy_config.host}:{self.proxy_config.port}"

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        self.s3_client = None
        self.s3_resource = None

    def name(self) -> str:
        return self._name

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        result = []

        # Convert path to string format that S3 expects
        s3_path = self._format_path(path)

        # For the root directory, we need an empty prefix
        prefix = s3_path + "/" if s3_path else ""

        # Simulate directories by using delimiter
        try:
            response = self.s3_client.list_objects_v2(
                Bucket=self.bucket_name, Prefix=prefix, Delimiter="/"
            )

            # Handle common prefixes (directories)
            if "CommonPrefixes" in response:
                for common_prefix in response["CommonPrefixes"]:
                    # Extract just the name component (not the full path)
                    dir_name = common_prefix["Prefix"].rstrip("/")
                    dir_name = PurePosixPath(dir_name).name

                    fd = FileDescriptor(
                        path=PurePosixPath(dir_name),
                        filetype=FileType.DIRECTORY,
                        size=0,  # Directories don't have a size in S3
                        modified_time=None,  # Directories don't have modified time in S3
                    )
                    result.append(fd)

            # Handle objects (files)
            if "Contents" in response:
                for content in response["Contents"]:
                    # Skip the directory placeholder itself if present
                    if content["Key"] == prefix:
                        continue

                    # Extract just the name component (not the full path)
                    file_key = content["Key"]
                    if prefix:
                        # Remove the prefix to get just the filename
                        file_key = file_key[len(prefix) :]

                    # Skip if this is a nested "directory"
                    if "/" in file_key:
                        continue

                    fd = FileDescriptor(
                        path=PurePosixPath(file_key),
                        filetype=FileType.FILE,
                        size=content["Size"],
                        modified_time=content["LastModified"],
                    )
                    result.append(fd)

        except ClientError as e:
            raise ListingError(f"Failed to list directory '{path}': {e}")

        return result

    def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        # Format path for S3
        s3_path = self._format_path(remote)

        # Create a custom callback for download progress
        class ProgressTracker:
            def __init__(self, callback: Optional[Callable[[int], bool]]) -> None:
                self.bytes_downloaded = 0
                self.callback = callback

            def __call__(self, bytes_amount: int) -> bool:
                self.bytes_downloaded += bytes_amount
                if self.callback:
                    return self.callback(self.bytes_downloaded)
                return True

        try:
            # Set up progress callback if provided
            if progress_callback:
                progress = ProgressTracker(progress_callback)
                self.s3_client.download_file(
                    self.bucket_name, s3_path, str(local), Callback=progress
                )
            else:
                self.s3_client.download_file(self.bucket_name, s3_path, str(local))
        except ClientError:
            # Handle not found or permission errors
            pass

    def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        s3_path = self._format_path(remote)

        class ProgressTracker:
            def __init__(self, callback: Optional[Callable[[int], bool]]) -> None:
                self.bytes_uploaded = 0
                self.callback = callback

            def __call__(self, bytes_amount: int) -> bool:
                self.bytes_uploaded += bytes_amount
                if self.callback:
                    return self.callback(self.bytes_uploaded)
                return True

        try:
            if progress_callback:
                progress = ProgressTracker(progress_callback)
                self.s3_client.upload_file(
                    str(local), self.bucket_name, s3_path, Callback=progress
                )
            else:
                self.s3_client.upload_file(str(local), self.bucket_name, s3_path)
        except ClientError:
            pass

    def unlink(self, remote: PurePath) -> bool:
        try:
            s3_path = self._format_path(remote)
            self.s3_client.delete_object(Bucket=self.bucket_name, Key=s3_path)
            return True
        except ClientError:
            return False

    def mkdir(self, remote: PurePath) -> bool:
        try:
            # S3 doesn't have real directories, but we can create a placeholder
            # object with a trailing slash to simulate a directory
            s3_path = self._format_path(remote)
            if not s3_path.endswith("/"):
                s3_path += "/"
            self.s3_client.put_object(Bucket=self.bucket_name, Key=s3_path, Body=b"")
            return True
        except ClientError:
            return False

    def _format_path(self, path: PurePath) -> str:
        path_str = path.as_posix()
        if path_str == "/":
            return ""
        if path_str.startswith("/"):
            return path_str[1:]
        return path_str
