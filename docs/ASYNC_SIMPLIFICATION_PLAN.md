# Async Architecture Simplification Plan

## Goal

Simplify the async architecture by:
1. **Single client interface** - Only `AsyncClient`, remove sync `Client` usage
2. **Minimize dependencies** - Use ThreadPool to wrap existing sync libraries instead of adding new async libraries
3. **Reduce code duplication** - No parallel sync/async implementations

## Current State (To Be Simplified)

```
ftpc/clients/
├── client.py              # Sync ABC (6 methods)
├── async_client.py        # Async ABC (6 methods) - KEEP
├── async_wrapper.py       # Wraps sync → async - KEEP & ENHANCE
├── localclient.py         # Sync local
├── async_local_client.py  # Async local (redundant)
├── ftpclient.py           # Sync FTP (ftplib)
├── async_ftp_client.py    # Async FTP (aioftp) - REMOVE
├── sftpclient.py          # Sync SFTP (paramiko)
├── async_sftp_client.py   # Async SFTP (asyncssh) - REMOVE
├── s3client.py            # Sync S3 (boto3)
├── async_s3_client.py     # Async S3 (aioboto3) - REMOVE
├── azureclient.py         # Sync Azure ADLS
├── async_azure_client.py  # Async Azure ADLS - REMOVE
├── azureblobclient.py     # Sync Azure Blob
├── async_azure_blob_client.py  # Async Azure Blob - REMOVE
```

## Target State

```
ftpc/clients/
├── client.py              # Sync ABC - KEEP (internal use only)
├── async_client.py        # Async ABC - PRIMARY INTERFACE
├── async_wrapper.py       # Wraps any sync client → async via ThreadPool
├── localclient.py         # Sync implementation
├── ftpclient.py           # Sync implementation (ftplib)
├── sftpclient.py          # Sync implementation (paramiko)
├── s3client.py            # Sync implementation (boto3)
├── azureclient.py         # Sync implementation
├── azureblobclient.py     # Sync implementation
```

## Changes Required

### 1. Remove Native Async Client Implementations

Delete the following files (they add dependencies without significant benefit):
- `ftpc/clients/async_local_client.py`
- `ftpc/clients/async_ftp_client.py`
- `ftpc/clients/async_sftp_client.py`
- `ftpc/clients/async_s3_client.py`
- `ftpc/clients/async_azure_client.py`
- `ftpc/clients/async_azure_blob_client.py`

### 2. Enhance AsyncClientWrapper

The `AsyncClientWrapper` becomes the **only** way to get an async client. It wraps any sync `Client` implementation using a ThreadPool.

Current wrapper is already well-designed - no changes needed to the core logic.

### 3. Add Factory Function

Create a simple factory to construct async clients from config:

```python
# ftpc/clients/__init__.py or new factory.py

def create_async_client(config: RemoteConfig) -> AsyncClient:
    """Create an async client from configuration.

    Automatically wraps the appropriate sync client with AsyncClientWrapper.
    """
    sync_client = create_sync_client(config)  # existing logic
    return AsyncClientWrapper(sync_client)
```

### 4. Update TUI to Use AsyncClient Only

Modify `AsyncTui` to be the primary TUI class:
- Rename `AsyncTui` → `Tui` (replace the old sync version)
- Remove old sync `Tui` class
- Update `__main__.py` to use the new async-based `Tui`

### 5. Update `__init__.py` Exports

Simplify exports:
```python
# Primary interface
from ftpc.clients.async_client import AsyncClient
from ftpc.clients.async_wrapper import AsyncClientWrapper

# Internal sync implementations (still needed, just not primary API)
from ftpc.clients.client import Client  # for type hints
```

### 6. Update pyproject.toml Dependencies

Remove async-specific libraries from dependencies:

**Remove from `[project.optional-dependencies]`:**
```toml
# DELETE this entire section:
async = [
    "aiofiles>=23.2.1",
    "aioftp>=0.21.4",
    "asyncssh>=2.14.2",
    "aioboto3>=12.3.0",
]
```

**Remove from `all`:**
```toml
all = [
    # Keep existing...
    # REMOVE: "aiofiles>=23.2.1",
    # REMOVE: "aioftp>=0.21.4",
    # REMOVE: "asyncssh>=2.14.2",
    # REMOVE: "aioboto3>=12.3.0",
]
```

**Remove from mypy overrides:**
```toml
# REMOVE these from module list:
# "aioftp.*",
# "asyncssh.*",
# "aioboto3.*",
# "aiofiles.*",
```

### 7. Update Tests

- Remove tests for deleted async clients
- Keep tests for `AsyncClientWrapper` and `AsyncRunner`
- Update test imports

## File Changes Summary

| Action | File |
|--------|------|
| DELETE | `ftpc/clients/async_local_client.py` |
| DELETE | `ftpc/clients/async_ftp_client.py` |
| DELETE | `ftpc/clients/async_sftp_client.py` |
| DELETE | `ftpc/clients/async_s3_client.py` |
| DELETE | `ftpc/clients/async_azure_client.py` |
| DELETE | `ftpc/clients/async_azure_blob_client.py` |
| MODIFY | `ftpc/clients/__init__.py` - simplify exports |
| MODIFY | `ftpc/tui/tui.py` - replace with async version |
| DELETE | `ftpc/tui/async_tui.py` - merged into tui.py |
| MODIFY | `ftpc/__main__.py` - use async TUI |
| MODIFY | `pyproject.toml` - remove async deps |
| MODIFY | `tests/clients/test_async_clients.py` - remove native async client tests |

## Benefits

1. **Fewer dependencies** - No aioftp, asyncssh, aioboto3, aiofiles
2. **Less code** - ~1500 lines removed
3. **Single code path** - No sync/async duplication
4. **Battle-tested libraries** - Keep using ftplib, paramiko, boto3
5. **ThreadPool performance** - Good enough for file transfers (I/O bound)
6. **Simpler maintenance** - One implementation per backend

## ThreadPool Performance Note

Using ThreadPool for async wrapping is appropriate here because:
- File transfers are I/O-bound, not CPU-bound
- Network latency dominates, not thread overhead
- ThreadPoolExecutor efficiently manages thread reuse
- The main benefit (responsive UI) is still achieved

For most users, the difference between native async and ThreadPool-wrapped async will be imperceptible. The sync libraries are also more mature and battle-tested.
