"""Tests for the Storage facade."""

import asyncio
import tempfile
import unittest
from pathlib import Path, PurePath

from ftpc import (
    Storage,
    StorageBuilder,
    SyncStorageSession,
    AsyncStorageSession,
    UnsupportedProtocolError,
)
from ftpc.storage import _parse_storage_url, ParsedURL


class TestURLParsing(unittest.TestCase):
    """Tests for URL parsing functionality."""

    def test_parse_local_path(self):
        """Test parsing a local filesystem path."""
        result = _parse_storage_url("/home/user/data")
        self.assertEqual(result.protocol, "file")
        self.assertEqual(result.path, "/home/user/data")

    def test_parse_file_url(self):
        """Test parsing a file:// URL."""
        result = _parse_storage_url("file:///home/user/data")
        self.assertEqual(result.protocol, "file")
        self.assertEqual(result.path, "/home/user/data")

    def test_parse_ftp_url_simple(self):
        """Test parsing a simple FTP URL."""
        result = _parse_storage_url("ftp://ftp.example.com/pub")
        self.assertEqual(result.protocol, "ftp")
        self.assertEqual(result.host, "ftp.example.com")
        self.assertEqual(result.path, "/pub")
        self.assertIsNone(result.username)
        self.assertIsNone(result.password)
        self.assertIsNone(result.port)

    def test_parse_ftp_url_with_credentials(self):
        """Test parsing an FTP URL with username and password."""
        result = _parse_storage_url("ftp://user:pass@ftp.example.com/pub")
        self.assertEqual(result.protocol, "ftp")
        self.assertEqual(result.host, "ftp.example.com")
        self.assertEqual(result.username, "user")
        self.assertEqual(result.password, "pass")
        self.assertEqual(result.path, "/pub")

    def test_parse_ftp_url_with_port(self):
        """Test parsing an FTP URL with custom port."""
        result = _parse_storage_url("ftp://ftp.example.com:2121/pub")
        self.assertEqual(result.protocol, "ftp")
        self.assertEqual(result.host, "ftp.example.com")
        self.assertEqual(result.port, 2121)

    def test_parse_ftps_url(self):
        """Test parsing an FTPS URL."""
        result = _parse_storage_url("ftps://ftp.example.com/secure")
        self.assertEqual(result.protocol, "ftps")
        self.assertEqual(result.host, "ftp.example.com")

    def test_parse_sftp_url(self):
        """Test parsing an SFTP URL."""
        result = _parse_storage_url("sftp://user@host.example.com/home/user")
        self.assertEqual(result.protocol, "sftp")
        self.assertEqual(result.host, "host.example.com")
        self.assertEqual(result.username, "user")

    def test_parse_s3_url(self):
        """Test parsing an S3 URL."""
        result = _parse_storage_url("s3://my-bucket/path/to/files")
        self.assertEqual(result.protocol, "s3")
        self.assertEqual(result.host, "my-bucket")
        self.assertEqual(result.path, "/path/to/files")

    def test_parse_azure_url(self):
        """Test parsing an Azure Data Lake URL."""
        result = _parse_storage_url("azure://account.dfs.core.windows.net/filesystem/path")
        self.assertEqual(result.protocol, "azure")
        self.assertEqual(result.host, "account.dfs.core.windows.net")
        self.assertEqual(result.path, "/filesystem/path")

    def test_parse_blob_url(self):
        """Test parsing an Azure Blob URL."""
        result = _parse_storage_url("blob://account.blob.core.windows.net/container/path")
        self.assertEqual(result.protocol, "blob")
        self.assertEqual(result.host, "account.blob.core.windows.net")
        self.assertEqual(result.path, "/container/path")

    def test_parse_url_with_encoded_credentials(self):
        """Test parsing URL with URL-encoded special characters in credentials."""
        result = _parse_storage_url("ftp://user%40domain:p%40ss%3Aword@host.com/path")
        self.assertEqual(result.username, "user@domain")
        self.assertEqual(result.password, "p@ss:word")


class TestStorageLocal(unittest.TestCase):
    """Tests for Storage with local filesystem."""

    def test_connect_sync_local_path(self):
        """Test sync connection to local filesystem via path."""
        with Storage.connect_sync("/tmp") as store:
            self.assertIsInstance(store, SyncStorageSession)
            self.assertEqual(store.name, "Local Storage")
            files = store.list("/")
            self.assertIsInstance(files, list)

    def test_connect_sync_file_url(self):
        """Test sync connection to local filesystem via file:// URL."""
        with Storage.connect_sync("file:///tmp") as store:
            self.assertEqual(store.name, "Local Storage")

    def test_local_named_constructor_sync(self):
        """Test local storage via named constructor (sync)."""
        builder = Storage.local("/tmp")
        self.assertIsInstance(builder, StorageBuilder)
        with builder.sync() as store:
            self.assertIsInstance(store, SyncStorageSession)
            files = store.list()
            self.assertIsInstance(files, list)

    def test_upload_download_delete(self):
        """Test file upload, download, and delete operations."""
        with tempfile.TemporaryDirectory() as tmpdir:
            local_file = Path(tmpdir) / "test.txt"
            local_file.write_text("Hello, Storage!")

            with Storage.connect_sync(tmpdir) as store:
                # Upload
                store.upload(local_file, "uploaded.txt")

                # Verify uploaded file exists
                files = store.list()
                file_names = [f.path.name for f in files]
                self.assertIn("uploaded.txt", file_names)

                # Download
                download_path = Path(tmpdir) / "downloaded.txt"
                store.download("uploaded.txt", download_path)
                self.assertEqual(download_path.read_text(), "Hello, Storage!")

                # Delete
                result = store.delete("uploaded.txt")
                self.assertTrue(result)

                # Verify deleted
                files = store.list()
                file_names = [f.path.name for f in files]
                self.assertNotIn("uploaded.txt", file_names)

    def test_mkdir(self):
        """Test directory creation."""
        with tempfile.TemporaryDirectory() as tmpdir:
            with Storage.connect_sync(tmpdir) as store:
                result = store.mkdir("new_directory")
                self.assertTrue(result)

                # Verify directory exists
                self.assertTrue((Path(tmpdir) / "new_directory").is_dir())


class TestStorageLocalAsync(unittest.TestCase):
    """Tests for async Storage with local filesystem."""

    def test_connect_async_local_path(self):
        """Test async connection to local filesystem."""
        async def run_test():
            async with Storage.connect("/tmp") as store:
                self.assertIsInstance(store, AsyncStorageSession)
                self.assertEqual(store.name, "Local Storage")
                files = await store.list("/")
                self.assertIsInstance(files, list)

        asyncio.run(run_test())

    def test_local_named_constructor_async(self):
        """Test local storage via named constructor (async)."""
        async def run_test():
            async with Storage.local("/tmp") as store:
                self.assertIsInstance(store, AsyncStorageSession)
                files = await store.list()
                self.assertIsInstance(files, list)

        asyncio.run(run_test())

    def test_async_upload_download(self):
        """Test async file upload and download."""
        async def run_test():
            with tempfile.TemporaryDirectory() as tmpdir:
                local_file = Path(tmpdir) / "test.txt"
                local_file.write_text("Hello, Async Storage!")

                async with Storage.connect(tmpdir) as store:
                    # Upload
                    await store.upload(local_file, "uploaded.txt")

                    # Verify
                    files = await store.list()
                    file_names = [f.path.name for f in files]
                    self.assertIn("uploaded.txt", file_names)

                    # Download
                    download_path = Path(tmpdir) / "downloaded.txt"
                    await store.download("uploaded.txt", download_path)
                    self.assertEqual(download_path.read_text(), "Hello, Async Storage!")

        asyncio.run(run_test())


class TestStorageErrors(unittest.TestCase):
    """Tests for error handling."""

    def test_unsupported_protocol(self):
        """Test that unsupported protocols raise UnsupportedProtocolError."""
        with self.assertRaises(UnsupportedProtocolError):
            with Storage.connect_sync("unknown://host/path") as store:
                pass


class TestNamedConstructors(unittest.TestCase):
    """Tests for named constructor availability."""

    def test_ftp_constructor_returns_builder(self):
        """Test that ftp() returns a StorageBuilder."""
        builder = Storage.ftp(host="ftp.example.com")
        self.assertIsInstance(builder, StorageBuilder)

    def test_local_constructor_returns_builder(self):
        """Test that local() returns a StorageBuilder."""
        builder = Storage.local()
        self.assertIsInstance(builder, StorageBuilder)


if __name__ == "__main__":
    unittest.main()
