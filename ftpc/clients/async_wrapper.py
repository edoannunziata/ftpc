"""Wrapper to adapt synchronous Client implementations to the async interface."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePath
from types import TracebackType
from typing import Callable, List, Optional
from typing_extensions import Self

from ftpc.clients.client import Client
from ftpc.clients.async_client import AsyncClient
from ftpc.filedescriptor import FileDescriptor


class AsyncClientWrapper(AsyncClient):
    """Wraps a synchronous Client to provide an async interface via thread pool.

    This is a transitional adapter that allows using existing sync clients
    with the async TUI infrastructure. For better performance, use native
    async client implementations where available.

    Example:
        async with AsyncClientWrapper(FtpClient(...)) as client:
            files = await client.ls(PurePath("/"))
    """

    def __init__(
        self,
        sync_client: Client,
        executor: Optional[ThreadPoolExecutor] = None,
    ) -> None:
        """
        Initialize the async wrapper.

        Args:
            sync_client: The synchronous client to wrap
            executor: Optional thread pool executor. If not provided,
                     a default executor with 4 workers will be created.
        """
        self._sync_client = sync_client
        self._executor = executor
        self._owns_executor = executor is None
        self._entered = False

    def name(self) -> str:
        """Return the name of the wrapped client."""
        return self._sync_client.name()

    async def __aenter__(self) -> Self:
        """Enter async context - initializes executor and enters sync client."""
        if self._owns_executor:
            self._executor = ThreadPoolExecutor(max_workers=4)

        # Enter the sync client's context in a thread
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            self._executor,
            self._sync_client.__enter__,
        )
        self._entered = True
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Exit async context - exits sync client and cleans up executor."""
        if self._entered:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                self._executor,
                lambda: self._sync_client.__exit__(exc_type, exc_val, exc_tb),
            )
            self._entered = False

        if self._owns_executor and self._executor is not None:
            self._executor.shutdown(wait=True)
            self._executor = None

    async def ls(self, remote: PurePath) -> List[FileDescriptor]:
        """List directory contents asynchronously."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_client.ls,
            remote,
        )

    async def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Download a file asynchronously."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            self._executor,
            lambda: self._sync_client.get(remote, local, progress_callback),
        )

    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None,
    ) -> None:
        """Upload a file asynchronously."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            self._executor,
            lambda: self._sync_client.put(local, remote, progress_callback),
        )

    async def unlink(self, remote: PurePath) -> bool:
        """Delete a file asynchronously."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_client.unlink,
            remote,
        )

    async def mkdir(self, remote: PurePath) -> bool:
        """Create a directory asynchronously."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_client.mkdir,
            remote,
        )
