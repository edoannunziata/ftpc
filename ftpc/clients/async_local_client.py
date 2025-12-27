"""Async local filesystem client implementation."""

import asyncio
import os
from datetime import datetime
from pathlib import Path, PurePath
from types import TracebackType
from typing import Callable, List, Optional
from typing_extensions import Self

from ftpc.clients.async_client import AsyncClient
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError

# aiofiles is optional - fall back to thread pool if not available
try:
    import aiofiles
    import aiofiles.os
    AIOFILES_AVAILABLE = True
except ImportError:
    AIOFILES_AVAILABLE = False


class AsyncLocalClient(AsyncClient):
    """Async client for local filesystem operations.

    Uses aiofiles for true async I/O if available, otherwise falls back
    to running blocking operations in a thread pool.
    """

    def __init__(self) -> None:
        """Initialize the async local client."""
        self._name = "Local Storage"

    def name(self) -> str:
        """Return the client name."""
        return self._name

    async def __aenter__(self) -> Self:
        """Enter async context."""
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Exit async context - nothing to clean up for local client."""
        pass

    async def ls(self, path: PurePath) -> List[FileDescriptor]:
        """List directory contents asynchronously."""
        result: List[FileDescriptor] = []

        try:
            # Use aiofiles if available, otherwise run in thread
            if AIOFILES_AVAILABLE:
                entries = await aiofiles.os.listdir(path)
            else:
                loop = asyncio.get_running_loop()
                entries = await loop.run_in_executor(None, os.listdir, path)

            for entry_name in entries:
                entry_path = Path(path) / entry_name
                pure_path = PurePath(entry_name)

                # Get file info - run stat in executor if needed
                if AIOFILES_AVAILABLE:
                    stat_info = await aiofiles.os.stat(entry_path)
                    is_dir = await aiofiles.os.path.isdir(entry_path)
                else:
                    loop = asyncio.get_running_loop()
                    stat_info = await loop.run_in_executor(None, entry_path.stat)
                    is_dir = await loop.run_in_executor(None, entry_path.is_dir)

                file_type = FileType.DIRECTORY if is_dir else FileType.FILE

                fd = FileDescriptor(
                    path=pure_path,
                    filetype=file_type,
                    size=stat_info.st_size,
                    modified_time=datetime.fromtimestamp(stat_info.st_mtime),
                )
                result.append(fd)

        except (PermissionError, FileNotFoundError) as e:
            raise ListingError(f"Failed to list directory '{path}': {e}")

        return result

    async def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Copy a file from source to destination asynchronously."""
        chunk_size = 8192
        bytes_copied = 0

        if AIOFILES_AVAILABLE:
            async with aiofiles.open(remote, "rb") as src:
                async with aiofiles.open(local, "wb") as dst:
                    while True:
                        chunk = await src.read(chunk_size)
                        if not chunk:
                            break
                        await dst.write(chunk)
                        bytes_copied += len(chunk)
                        if progress_callback:
                            if not progress_callback(bytes_copied):
                                # User cancelled
                                return
        else:
            # Fall back to thread pool execution
            loop = asyncio.get_running_loop()

            def copy_with_progress() -> None:
                nonlocal bytes_copied
                with open(remote, "rb") as src:
                    with open(local, "wb") as dst:
                        while True:
                            chunk = src.read(chunk_size)
                            if not chunk:
                                break
                            dst.write(chunk)
                            bytes_copied += len(chunk)
                            if progress_callback:
                                progress_callback(bytes_copied)

            await loop.run_in_executor(None, copy_with_progress)

    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Copy a file from local to remote (both are local paths)."""
        # For local client, put is the same as get with paths swapped
        await self.get(PurePath(local), Path(remote), progress_callback)

    async def unlink(self, remote: PurePath) -> bool:
        """Delete a file asynchronously."""
        try:
            file_path = Path(remote)

            if AIOFILES_AVAILABLE:
                is_file = await aiofiles.os.path.isfile(file_path)
                if is_file:
                    await aiofiles.os.remove(file_path)
                    return True
                return False
            else:
                loop = asyncio.get_running_loop()
                is_file = await loop.run_in_executor(None, file_path.is_file)
                if is_file:
                    await loop.run_in_executor(None, file_path.unlink)
                    return True
                return False
        except (FileNotFoundError, PermissionError, IsADirectoryError):
            return False

    async def mkdir(self, remote: PurePath) -> bool:
        """Create a directory asynchronously."""
        try:
            dir_path = Path(remote)

            if AIOFILES_AVAILABLE:
                await aiofiles.os.mkdir(dir_path)
            else:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, dir_path.mkdir)
            return True
        except (FileExistsError, PermissionError, OSError):
            return False
