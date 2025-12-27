"""Async S3 client implementation using aioboto3."""

from pathlib import Path, PurePath, PurePosixPath
from types import TracebackType
from typing import Any, Callable, List, Optional, TYPE_CHECKING
from typing_extensions import Self

from ftpc.clients.async_client import AsyncClient
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError

if TYPE_CHECKING:
    from ftpc.config import ProxyConfig

try:
    import aioboto3
    from botocore import UNSIGNED
    from botocore.client import Config
    AIOBOTO3_AVAILABLE = True
except ImportError:
    AIOBOTO3_AVAILABLE = False

try:
    import aiofiles
    AIOFILES_AVAILABLE = True
except ImportError:
    AIOFILES_AVAILABLE = False


class AsyncS3Client(AsyncClient):
    """Async S3-compatible storage client using aioboto3.

    Provides non-blocking S3 operations with progress callbacks
    and cancellation support.
    """

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
        Initialize the async S3 client.

        Args:
            bucket_name: Name of the S3 bucket to use
            endpoint_url: URL to the S3-compatible service endpoint
            aws_access_key_id: Optional access key ID for authentication
            aws_secret_access_key: Optional secret access key for authentication
            region_name: Optional AWS region name
            name: Human-readable name for this client
            proxy_config: Optional SOCKS5 proxy configuration
        """
        if not AIOBOTO3_AVAILABLE:
            raise ImportError(
                "aioboto3 is required for async S3 support. "
                "Install with: pip install aioboto3"
            )

        self.bucket_name = bucket_name
        self.endpoint_url = endpoint_url
        self.aws_access_key_id = aws_access_key_id
        self.aws_secret_access_key = aws_secret_access_key
        self.region_name = region_name
        self._name = name if name else f"S3:{bucket_name}"
        self.proxy_config = proxy_config

        self._session: Any = None
        self._s3_client: Any = None
        self._s3_client_ctx: Any = None

    def name(self) -> str:
        """Return the client name."""
        return self._name

    def _build_proxy_url(self) -> str:
        """Build SOCKS5 proxy URL for boto3."""
        assert self.proxy_config is not None, "Proxy config not set"
        if self.proxy_config.username and self.proxy_config.password:
            return (
                f"socks5://{self.proxy_config.username}:{self.proxy_config.password}"
                f"@{self.proxy_config.host}:{self.proxy_config.port}"
            )
        return f"socks5://{self.proxy_config.host}:{self.proxy_config.port}"

    async def __aenter__(self) -> Self:
        """Initialize the S3 client."""
        self._session = aioboto3.Session(
            aws_access_key_id=self.aws_access_key_id,
            aws_secret_access_key=self.aws_secret_access_key,
            region_name=self.region_name,
        )

        # Build config with optional proxy and signature settings
        config_kwargs: dict[str, Any] = {}

        if self.proxy_config:
            proxy_url = self._build_proxy_url()
            config_kwargs["proxies"] = {"http": proxy_url, "https": proxy_url}

        # If no credentials are provided, use unsigned requests
        if not self.aws_access_key_id and not self.aws_secret_access_key:
            config_kwargs["signature_version"] = UNSIGNED

        config = Config(**config_kwargs) if config_kwargs else None

        # Create the async client context
        self._s3_client_ctx = self._session.client(
            "s3",
            endpoint_url=self.endpoint_url,
            config=config,
        )
        self._s3_client = await self._s3_client_ctx.__aenter__()

        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Clean up the S3 client."""
        if self._s3_client_ctx:
            await self._s3_client_ctx.__aexit__(exc_type, exc_val, exc_tb)
            self._s3_client = None
            self._s3_client_ctx = None

    def _format_path(self, path: PurePath) -> str:
        """Format path for S3 (remove leading slash)."""
        path_str = path.as_posix()
        if path_str == "/":
            return ""
        if path_str.startswith("/"):
            return path_str[1:]
        return path_str

    async def ls(self, path: PurePath) -> List[FileDescriptor]:
        """List directory contents asynchronously."""
        assert self._s3_client is not None, "Client not connected"
        result: List[FileDescriptor] = []

        s3_path = self._format_path(path)
        prefix = s3_path + "/" if s3_path else ""

        try:
            response = await self._s3_client.list_objects_v2(
                Bucket=self.bucket_name,
                Prefix=prefix,
                Delimiter="/",
            )

            # Handle common prefixes (directories)
            if "CommonPrefixes" in response:
                for common_prefix in response["CommonPrefixes"]:
                    dir_name = common_prefix["Prefix"].rstrip("/")
                    dir_name = PurePosixPath(dir_name).name

                    fd = FileDescriptor(
                        path=PurePosixPath(dir_name),
                        filetype=FileType.DIRECTORY,
                        size=0,
                        modified_time=None,
                    )
                    result.append(fd)

            # Handle objects (files)
            if "Contents" in response:
                for content in response["Contents"]:
                    # Skip the directory placeholder itself
                    if content["Key"] == prefix:
                        continue

                    file_key = content["Key"]
                    if prefix:
                        file_key = file_key[len(prefix):]

                    # Skip nested paths
                    if "/" in file_key:
                        continue

                    fd = FileDescriptor(
                        path=PurePosixPath(file_key),
                        filetype=FileType.FILE,
                        size=content["Size"],
                        modified_time=content["LastModified"],
                    )
                    result.append(fd)

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
        assert self._s3_client is not None, "Client not connected"

        s3_path = self._format_path(remote)
        bytes_downloaded = 0

        try:
            response = await self._s3_client.get_object(
                Bucket=self.bucket_name,
                Key=s3_path,
            )

            body = response["Body"]

            if AIOFILES_AVAILABLE:
                import aiofiles
                async with aiofiles.open(local, "wb") as local_file:
                    async for chunk in body.iter_chunks():
                        await local_file.write(chunk)
                        bytes_downloaded += len(chunk)
                        if progress_callback:
                            if not progress_callback(bytes_downloaded):
                                return
            else:
                with open(local, "wb") as local_file:
                    async for chunk in body.iter_chunks():
                        local_file.write(chunk)
                        bytes_downloaded += len(chunk)
                        if progress_callback:
                            if not progress_callback(bytes_downloaded):
                                return

        except Exception:
            pass

    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Upload a file asynchronously with progress tracking."""
        assert self._s3_client is not None, "Client not connected"

        s3_path = self._format_path(remote)

        try:
            # Get file size
            total_size = local.stat().st_size

            if AIOFILES_AVAILABLE:
                import aiofiles
                async with aiofiles.open(local, "rb") as local_file:
                    content = await local_file.read()
                    await self._s3_client.put_object(
                        Bucket=self.bucket_name,
                        Key=s3_path,
                        Body=content,
                    )
            else:
                with open(local, "rb") as local_file:
                    content = local_file.read()
                    await self._s3_client.put_object(
                        Bucket=self.bucket_name,
                        Key=s3_path,
                        Body=content,
                    )

            if progress_callback:
                progress_callback(total_size)

        except Exception:
            pass

    async def unlink(self, remote: PurePath) -> bool:
        """Delete a file asynchronously."""
        assert self._s3_client is not None, "Client not connected"

        try:
            s3_path = self._format_path(remote)
            await self._s3_client.delete_object(
                Bucket=self.bucket_name,
                Key=s3_path,
            )
            return True
        except Exception:
            return False

    async def mkdir(self, remote: PurePath) -> bool:
        """Create a directory asynchronously (creates a placeholder object)."""
        assert self._s3_client is not None, "Client not connected"

        try:
            s3_path = self._format_path(remote)
            if not s3_path.endswith("/"):
                s3_path += "/"
            await self._s3_client.put_object(
                Bucket=self.bucket_name,
                Key=s3_path,
                Body=b"",
            )
            return True
        except Exception:
            return False
