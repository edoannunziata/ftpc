# Asyncio Migration Plan for FTPC

## Executive Summary

This document outlines a phased approach to migrate FTPC from synchronous blocking I/O to an asyncio-based architecture. The migration aims to improve UI responsiveness, enable operation cancellation, and lay groundwork for future parallel operations.

**Current State**: All 6 storage backends use synchronous blocking I/O, causing UI freezes during network operations.

**Target State**: Async-native client layer with responsive TUI that supports cancellation and progress updates.

---

## Phase 1: Async Client Layer Foundation

### Objective
Create an async version of the `Client` abstract base class and implement async adapters that wrap existing synchronous clients.

### 1.1 New Async Client Interface

Create `ftpc/clients/async_client.py`:

```python
from abc import abstractmethod, ABCMeta
from contextlib import AbstractAsyncContextManager
from pathlib import Path, PurePath
from typing import List, Optional, Callable, AsyncIterator
from typing_extensions import Self

from ftpc.filedescriptor import FileDescriptor


class AsyncClient(AbstractAsyncContextManager["AsyncClient"], metaclass=ABCMeta):
    @abstractmethod
    def name(self) -> str:
        """Name of the resource represented by the client."""

    @abstractmethod
    async def ls(self, remote: PurePath) -> List[FileDescriptor]:
        """List files and directories at the specified remote path."""

    @abstractmethod
    async def get(
        self,
        remote: PurePath,
        local: Path,
        progress_callback: Optional[Callable[[int], bool]] = None
    ) -> None:
        """Download a file from the remote path to the local path."""

    @abstractmethod
    async def put(
        self,
        local: Path,
        remote: PurePath,
        progress_callback: Optional[Callable[[int], bool]] = None
    ) -> None:
        """Upload a file from the local path to the remote path."""

    @abstractmethod
    async def unlink(self, remote: PurePath) -> bool:
        """Delete a file at the specified remote path."""

    @abstractmethod
    async def mkdir(self, remote: PurePath) -> bool:
        """Create a directory at the specified remote path."""

    async def __aenter__(self) -> Self:
        return self

    @abstractmethod
    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        pass
```

### 1.2 Sync-to-Async Wrapper (Transitional)

Create `ftpc/clients/async_wrapper.py` to wrap existing sync clients:

```python
import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Callable
from pathlib import Path, PurePath

from ftpc.clients.client import Client
from ftpc.clients.async_client import AsyncClient


class AsyncClientWrapper(AsyncClient):
    """Wraps a synchronous Client to provide async interface via thread pool."""

    def __init__(self, sync_client: Client, executor: Optional[ThreadPoolExecutor] = None):
        self._sync_client = sync_client
        self._executor = executor or ThreadPoolExecutor(max_workers=4)

    def name(self) -> str:
        return self._sync_client.name()

    async def ls(self, remote: PurePath):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_client.ls,
            remote
        )

    async def get(self, remote: PurePath, local: Path,
                  progress_callback: Optional[Callable[[int], bool]] = None):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync_client.get,
            remote, local, progress_callback
        )

    # ... similar for put, unlink, mkdir
```

### 1.3 Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `ftpc/clients/async_client.py` | Create | New async ABC |
| `ftpc/clients/async_wrapper.py` | Create | Sync-to-async adapter |
| `ftpc/clients/__init__.py` | Modify | Export new classes |

### 1.4 Acceptance Criteria
- [ ] `AsyncClient` ABC defined with all methods from `Client`
- [ ] `AsyncClientWrapper` successfully wraps any sync client
- [ ] Unit tests pass for wrapper functionality
- [ ] Type checking passes with mypy --strict

---

## Phase 2: Native Async Client Implementations

### Objective
Replace thread-pool wrappers with native async implementations for each backend.

### 2.1 Library Selection

| Backend | Current Library | Async Library | Notes |
|---------|-----------------|---------------|-------|
| FTP/FTPS | `ftplib` | `aioftp` | Full async FTP/FTPS support |
| SFTP | `paramiko` | `asyncssh` | Async SSH with SFTP subsystem |
| S3 | `boto3` | `aioboto3` | Thin async wrapper around boto3 |
| Azure ADLS | `azure-storage-file-datalake` | Same (async API) | SDK has native async support |
| Azure Blob | `azure-storage-blob` | Same (async API) | SDK has native async support |
| Local | `shutil`, `os` | `aiofiles` | Async file operations |

### 2.2 Implementation Order (by complexity)

#### 2.2.1 Local Client (Simplest)
```python
# ftpc/clients/async_local_client.py
import aiofiles
import aiofiles.os

class AsyncLocalClient(AsyncClient):
    async def get(self, remote: PurePath, local: Path, ...):
        async with aiofiles.open(remote, 'rb') as src:
            async with aiofiles.open(local, 'wb') as dst:
                while chunk := await src.read(8192):
                    await dst.write(chunk)
                    if progress_callback:
                        progress_callback(len(chunk))
```

#### 2.2.2 Azure Clients (SDK has async)
```python
# ftpc/clients/async_azure_client.py
from azure.storage.filedatalake.aio import DataLakeServiceClient

class AsyncAzureClient(AsyncClient):
    async def __aenter__(self):
        self._service_client = DataLakeServiceClient(...)
        return self

    async def ls(self, remote: PurePath):
        file_system = self._service_client.get_file_system_client(...)
        paths = []
        async for path in file_system.get_paths(path=str(remote)):
            paths.append(self._to_file_descriptor(path))
        return paths
```

#### 2.2.3 S3 Client
```python
# ftpc/clients/async_s3_client.py
import aioboto3

class AsyncS3Client(AsyncClient):
    async def __aenter__(self):
        session = aioboto3.Session()
        self._s3 = await session.client('s3').__aenter__()
        return self

    async def get(self, remote: PurePath, local: Path, ...):
        await self._s3.download_file(
            self._bucket,
            str(remote),
            str(local),
            Callback=progress_callback
        )
```

#### 2.2.4 FTP/FTPS Client (New library)
```python
# ftpc/clients/async_ftp_client.py
import aioftp

class AsyncFTPClient(AsyncClient):
    async def __aenter__(self):
        self._client = aioftp.Client()
        await self._client.connect(self._host, self._port)
        await self._client.login(self._user, self._password)
        return self

    async def ls(self, remote: PurePath):
        result = []
        async for path, info in self._client.list(str(remote)):
            result.append(self._to_file_descriptor(path, info))
        return result

    async def get(self, remote: PurePath, local: Path, ...):
        async with self._client.download_stream(str(remote)) as stream:
            async with aiofiles.open(local, 'wb') as f:
                async for chunk in stream.iter_by_block():
                    await f.write(chunk)
                    if progress_callback:
                        progress_callback(len(chunk))
```

#### 2.2.5 SFTP Client (New library)
```python
# ftpc/clients/async_sftp_client.py
import asyncssh

class AsyncSFTPClient(AsyncClient):
    async def __aenter__(self):
        self._conn = await asyncssh.connect(
            self._host,
            port=self._port,
            username=self._user,
            password=self._password
        )
        self._sftp = await self._conn.start_sftp_client()
        return self

    async def get(self, remote: PurePath, local: Path, ...):
        await self._sftp.get(str(remote), str(local),
                            progress_handler=progress_callback)
```

### 2.3 New Dependencies

Add to `pyproject.toml`:
```toml
[project.optional-dependencies]
async = [
    "aioftp>=0.21.0",
    "asyncssh>=2.14.0",
    "aioboto3>=12.0.0",
    "aiofiles>=23.0.0",
]
```

### 2.4 Files to Create

| File | Backend | Estimated Lines |
|------|---------|-----------------|
| `ftpc/clients/async_local_client.py` | Local | ~80 |
| `ftpc/clients/async_ftp_client.py` | FTP/FTPS | ~350 |
| `ftpc/clients/async_sftp_client.py` | SFTP | ~250 |
| `ftpc/clients/async_s3_client.py` | S3 | ~220 |
| `ftpc/clients/async_azure_client.py` | Azure ADLS | ~200 |
| `ftpc/clients/async_azure_blob_client.py` | Azure Blob | ~220 |

### 2.5 Acceptance Criteria
- [ ] All 6 async clients implemented
- [ ] Feature parity with sync versions
- [ ] Progress callbacks work correctly
- [ ] Proper resource cleanup in `__aexit__`
- [ ] Integration tests pass against real services
- [ ] SOCKS5 proxy support maintained (where applicable)

---

## Phase 3: TUI Async Integration

### Objective
Integrate async clients with the curses TUI while maintaining UI responsiveness.

### 3.1 The Curses-Asyncio Challenge

**Problem**: Curses uses blocking `stdscr.getkey()` which conflicts with asyncio's event loop.

**Solution Options**:

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | Run asyncio in background thread | Minimal TUI changes | Thread sync complexity |
| B | Non-blocking curses + asyncio | Clean single-threaded | Significant TUI rewrite |
| C | Migrate to Textual | Modern, async-native | Major rewrite, new dependency |

**Recommended: Option A** (lowest risk, incremental migration)

### 3.2 Implementation: Background Asyncio Thread

```python
# ftpc/async_runner.py
import asyncio
import threading
from typing import Coroutine, Any, Optional
from concurrent.futures import Future


class AsyncRunner:
    """Runs asyncio coroutines from synchronous curses code."""

    def __init__(self):
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None

    def start(self):
        """Start the background event loop."""
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def run(self, coro: Coroutine[Any, Any, Any]) -> Future:
        """Submit a coroutine and return a Future."""
        if self._loop is None:
            raise RuntimeError("AsyncRunner not started")
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def stop(self):
        """Stop the background event loop."""
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=5.0)
```

### 3.3 Modified TUI Integration

```python
# In ftpc/tui/tui.py

class Tui:
    def __init__(self, client: AsyncClient):
        self.client = client
        self.async_runner = AsyncRunner()

    def __enter__(self):
        self.async_runner.start()
        return self

    def __exit__(self, *args):
        self.async_runner.stop()

    def _do_download(self, remote_path: PurePath, local_path: Path):
        """Non-blocking download with progress updates."""
        future = self.async_runner.run(
            self.client.get(remote_path, local_path, self._progress_callback)
        )

        # Poll for completion while keeping UI responsive
        with ProgressDialog(self.stdscr, "Downloading...") as progress:
            while not future.done():
                # Check for user cancel (non-blocking)
                self.stdscr.nodelay(True)
                try:
                    key = self.stdscr.getkey()
                    if key == '\x1b':  # Escape
                        future.cancel()
                        break
                except curses.error:
                    pass
                finally:
                    self.stdscr.nodelay(False)

                # Update progress display
                progress.refresh()
                time.sleep(0.05)  # 50ms polling interval

        if future.cancelled():
            self._show_message("Download cancelled")
        elif future.exception():
            self._show_error(str(future.exception()))
        else:
            self._show_message("Download complete")
```

### 3.4 Cancellation Support

```python
# ftpc/clients/async_client.py - Enhanced with cancellation

class CancellableTransfer:
    """Wraps an async transfer with cancellation support."""

    def __init__(self):
        self._cancelled = False
        self._task: Optional[asyncio.Task] = None

    def cancel(self):
        self._cancelled = True
        if self._task:
            self._task.cancel()

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled


# Usage in client:
async def get(self, remote, local, progress_callback=None,
              cancellation_token: Optional[CancellableTransfer] = None):
    async with aiofiles.open(local, 'wb') as f:
        async for chunk in self._stream_file(remote):
            if cancellation_token and cancellation_token.is_cancelled:
                raise asyncio.CancelledError("Transfer cancelled by user")
            await f.write(chunk)
```

### 3.5 Files to Modify

| File | Changes |
|------|---------|
| `ftpc/tui/tui.py` | Add AsyncRunner integration, modify operation methods |
| `ftpc/tui/dialog.py` | Update ProgressDialog for async polling |
| `ftpc/__main__.py` | Initialize async client instead of sync |
| `ftpc/async_runner.py` | New file for background event loop |

### 3.6 Acceptance Criteria
- [ ] UI remains responsive during file transfers
- [ ] Escape key cancels in-flight operations
- [ ] Progress updates display in real-time
- [ ] No race conditions or deadlocks
- [ ] Clean shutdown of async resources

---

## Phase 4: Testing and Validation

### 4.1 Unit Tests

```python
# tests/test_async_clients.py
import pytest
import asyncio

@pytest.mark.asyncio
async def test_async_ftp_ls():
    async with AsyncFTPClient(config) as client:
        files = await client.ls(PurePath("/"))
        assert len(files) > 0

@pytest.mark.asyncio
async def test_async_download_with_progress():
    progress_values = []

    async with AsyncS3Client(config) as client:
        await client.get(
            PurePath("test.txt"),
            Path("/tmp/test.txt"),
            progress_callback=lambda n: progress_values.append(n)
        )

    assert len(progress_values) > 0
    assert progress_values[-1] > 0

@pytest.mark.asyncio
async def test_cancellation():
    async with AsyncFTPClient(config) as client:
        token = CancellableTransfer()

        async def cancel_after_delay():
            await asyncio.sleep(0.1)
            token.cancel()

        asyncio.create_task(cancel_after_delay())

        with pytest.raises(asyncio.CancelledError):
            await client.get(large_file, local_path, cancellation_token=token)
```

### 4.2 Integration Tests

- Test against real FTP/SFTP servers (containerized)
- Test against LocalStack for S3
- Test against Azurite for Azure
- Test proxy configurations

### 4.3 Performance Benchmarks

Compare sync vs async for:
- Single large file transfer
- Multiple small file transfers
- Directory listing of 1000+ files
- UI responsiveness during transfers

---

## Phase 5: Future Enhancements (Optional)

### 5.1 Parallel Operations
```python
async def download_multiple(self, files: List[PurePath], dest: Path):
    """Download multiple files concurrently."""
    tasks = [
        self.client.get(f, dest / f.name)
        for f in files
    ]
    await asyncio.gather(*tasks, return_exceptions=True)
```

### 5.2 Connection Pooling
```python
class ConnectionPool:
    """Maintain a pool of reusable connections."""
    def __init__(self, factory, max_size=5):
        self._pool = asyncio.Queue(maxsize=max_size)
        self._factory = factory
```

### 5.3 Textual Migration (Long-term)

Consider migrating from curses to [Textual](https://textual.textualize.io/) for:
- Native async support
- Rich widgets and styling
- Better cross-platform support
- Modern development experience

---

## Migration Checklist

### Phase 1: Foundation
- [ ] Create `AsyncClient` ABC
- [ ] Create `AsyncClientWrapper`
- [ ] Add unit tests
- [ ] Update type hints

### Phase 2: Native Clients
- [ ] Implement `AsyncLocalClient`
- [ ] Implement `AsyncAzureClient`
- [ ] Implement `AsyncAzureBlobClient`
- [ ] Implement `AsyncS3Client`
- [ ] Implement `AsyncFTPClient`
- [ ] Implement `AsyncSFTPClient`
- [ ] Add async dependencies to pyproject.toml
- [ ] Integration tests for all clients

### Phase 3: TUI Integration
- [ ] Create `AsyncRunner`
- [ ] Modify `Tui` class for async
- [ ] Implement cancellation
- [ ] Update progress dialogs
- [ ] Update `__main__.py`

### Phase 4: Testing
- [ ] Unit test coverage > 80%
- [ ] Integration tests passing
- [ ] Performance benchmarks documented
- [ ] Manual testing complete

### Phase 5: Cleanup
- [ ] Remove sync client wrappers (if fully migrated)
- [ ] Update documentation
- [ ] Update README.md

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| aioftp/asyncssh API differences | Medium | Medium | Thorough testing, fallback to wrapper |
| Thread synchronization bugs | Low | High | Careful design, code review |
| Performance regression | Low | Medium | Benchmarking before/after |
| Proxy support gaps in async libs | Medium | Medium | Test early, document limitations |
| Curses compatibility issues | Low | Medium | Extensive cross-platform testing |

---

## Appendix: Dependency Versions

```toml
# Recommended versions for pyproject.toml
[project.optional-dependencies]
async = [
    "aioftp>=0.21.4",
    "asyncssh>=2.14.2",
    "aioboto3>=12.3.0",
    "aiofiles>=23.2.1",
]
```

All Azure SDK packages already support async via their `.aio` submodules.
