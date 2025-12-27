"""Tests for async client implementations."""

import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path, PurePath
from datetime import datetime

from ftpc.clients.async_client import AsyncClient
from ftpc.clients.async_local_client import AsyncLocalClient
from ftpc.clients.async_wrapper import AsyncClientWrapper
from ftpc.clients.localclient import LocalClient
from ftpc.async_runner import AsyncRunner, CancellationToken
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError
from tests.fixtures.test_data import TestDataFixtures


class TestAsyncLocalClient(unittest.TestCase):
    """Test cases for AsyncLocalClient class."""

    def setUp(self) -> None:
        """Set up test fixtures."""
        self.temp_dir = TestDataFixtures.create_temp_directory_with_files()
        self.client = AsyncLocalClient()

    def tearDown(self) -> None:
        """Clean up test fixtures."""
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    def test_client_name(self) -> None:
        """Test client name method."""
        self.assertEqual(self.client.name(), "Local Storage")

    def test_client_context_manager(self) -> None:
        """Test AsyncLocalClient as async context manager."""
        async def run_test() -> None:
            async with AsyncLocalClient() as client:
                self.assertIsInstance(client, AsyncLocalClient)
                self.assertEqual(client.name(), "Local Storage")

        asyncio.run(run_test())

    def test_ls_existing_directory(self) -> None:
        """Test listing contents of existing directory."""
        async def run_test() -> None:
            async with self.client:
                result = await self.client.ls(PurePath(self.temp_dir))

                # Should return FileDescriptor objects
                self.assertIsInstance(result, list)
                self.assertTrue(len(result) > 0)

                # Check that all results are FileDescriptor objects
                for item in result:
                    self.assertIsInstance(item, FileDescriptor)
                    self.assertIsInstance(item.path, PurePath)
                    self.assertIn(item.filetype, [FileType.FILE, FileType.DIRECTORY])

                # Check for expected files
                names = [item.name for item in result]
                self.assertIn("test_file.txt", names)
                self.assertIn("empty_file.txt", names)
                self.assertIn("binary_file.bin", names)
                self.assertIn("subdir", names)

        asyncio.run(run_test())

    def test_ls_file_properties(self) -> None:
        """Test that ls returns correct file properties."""
        async def run_test() -> None:
            async with self.client:
                result = await self.client.ls(PurePath(self.temp_dir))

                # Find the test file
                test_file = next((f for f in result if f.name == "test_file.txt"), None)
                self.assertIsNotNone(test_file)

                # Check properties
                assert test_file is not None
                self.assertEqual(test_file.filetype, FileType.FILE)
                self.assertIsInstance(test_file.size, int)
                self.assertGreater(test_file.size, 0)
                self.assertIsInstance(test_file.modified_time, datetime)

                # Find the subdirectory
                subdir = next((f for f in result if f.name == "subdir"), None)
                self.assertIsNotNone(subdir)
                assert subdir is not None
                self.assertEqual(subdir.filetype, FileType.DIRECTORY)

        asyncio.run(run_test())

    def test_ls_nonexistent_directory(self) -> None:
        """Test listing contents of non-existent directory raises ListingError."""
        async def run_test() -> None:
            async with self.client:
                with self.assertRaises(ListingError):
                    await self.client.ls(PurePath("/nonexistent/directory"))

        asyncio.run(run_test())

    def test_get_file_operation(self) -> None:
        """Test downloading/copying a file."""
        async def run_test() -> None:
            # Create source file
            source_file = Path(self.temp_dir) / "source.txt"
            source_content = "Test content for get operation"
            source_file.write_text(source_content)

            # Create destination path
            dest_dir = tempfile.mkdtemp()
            dest_file = Path(dest_dir) / "destination.txt"

            try:
                async with self.client:
                    await self.client.get(PurePath(source_file), dest_file)

                    # Verify file was copied
                    self.assertTrue(dest_file.exists())
                    self.assertEqual(dest_file.read_text(), source_content)
            finally:
                shutil.rmtree(dest_dir)

        asyncio.run(run_test())

    def test_get_with_progress_callback(self) -> None:
        """Test get operation with progress callback."""
        async def run_test() -> None:
            # Create source file
            source_file = Path(self.temp_dir) / "progress_test.txt"
            source_content = "A" * 1000
            source_file.write_text(source_content)

            # Create destination path
            dest_dir = tempfile.mkdtemp()
            dest_file = Path(dest_dir) / "progress_dest.txt"

            # Track progress callbacks
            progress_calls: list[int] = []

            def progress_callback(bytes_transferred: int) -> bool:
                progress_calls.append(bytes_transferred)
                return True

            try:
                async with self.client:
                    await self.client.get(
                        PurePath(source_file), dest_file, progress_callback
                    )

                    # Verify callback was called
                    self.assertTrue(len(progress_calls) > 0)
            finally:
                shutil.rmtree(dest_dir)

        asyncio.run(run_test())

    def test_put_file_operation(self) -> None:
        """Test uploading/copying a file."""
        async def run_test() -> None:
            # Create source file
            source_dir = tempfile.mkdtemp()
            source_file = Path(source_dir) / "upload_source.txt"
            source_content = "Test content for put operation"
            source_file.write_text(source_content)

            # Create destination path
            dest_file = Path(self.temp_dir) / "upload_dest.txt"

            try:
                async with self.client:
                    await self.client.put(source_file, PurePath(dest_file))

                    # Verify file was copied
                    self.assertTrue(dest_file.exists())
                    self.assertEqual(dest_file.read_text(), source_content)
            finally:
                shutil.rmtree(source_dir)

        asyncio.run(run_test())

    def test_unlink_file(self) -> None:
        """Test deleting a file."""
        async def run_test() -> None:
            # Create test file
            test_file = Path(self.temp_dir) / "to_delete.txt"
            test_file.write_text("This file will be deleted")

            # Verify file exists
            self.assertTrue(test_file.exists())

            async with self.client:
                # Delete file
                result = await self.client.unlink(PurePath(test_file))

                # Verify deletion
                self.assertTrue(result)
                self.assertFalse(test_file.exists())

        asyncio.run(run_test())

    def test_unlink_nonexistent_file(self) -> None:
        """Test deleting a non-existent file."""
        async def run_test() -> None:
            nonexistent_file = Path(self.temp_dir) / "nonexistent.txt"
            async with self.client:
                result = await self.client.unlink(PurePath(nonexistent_file))
                self.assertFalse(result)

        asyncio.run(run_test())

    def test_mkdir_creates_directory(self) -> None:
        """Test creating a new directory."""
        async def run_test() -> None:
            new_dir = Path(self.temp_dir) / "new_directory"

            # Verify directory doesn't exist yet
            self.assertFalse(new_dir.exists())

            async with self.client:
                # Create directory
                result = await self.client.mkdir(PurePath(new_dir))

                # Verify success
                self.assertTrue(result)
                self.assertTrue(new_dir.exists())
                self.assertTrue(new_dir.is_dir())

        asyncio.run(run_test())

    def test_mkdir_existing_directory(self) -> None:
        """Test creating a directory that already exists."""
        async def run_test() -> None:
            existing_dir = Path(self.temp_dir) / "existing_dir"
            existing_dir.mkdir()

            async with self.client:
                # Attempt to create directory that already exists
                result = await self.client.mkdir(PurePath(existing_dir))

                # Should fail and return False
                self.assertFalse(result)

        asyncio.run(run_test())


class TestAsyncClientWrapper(unittest.TestCase):
    """Test cases for AsyncClientWrapper class."""

    def setUp(self) -> None:
        """Set up test fixtures."""
        self.temp_dir = TestDataFixtures.create_temp_directory_with_files()
        self.sync_client = LocalClient()
        self.async_wrapper = AsyncClientWrapper(self.sync_client)

    def tearDown(self) -> None:
        """Clean up test fixtures."""
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    def test_wrapper_name(self) -> None:
        """Test that wrapper returns wrapped client's name."""
        self.assertEqual(self.async_wrapper.name(), "Local Storage")

    def test_wrapper_context_manager(self) -> None:
        """Test AsyncClientWrapper as async context manager."""
        async def run_test() -> None:
            async with AsyncClientWrapper(LocalClient()) as client:
                self.assertIsInstance(client, AsyncClientWrapper)
                self.assertEqual(client.name(), "Local Storage")

        asyncio.run(run_test())

    def test_wrapper_ls(self) -> None:
        """Test listing through wrapper."""
        async def run_test() -> None:
            async with self.async_wrapper:
                result = await self.async_wrapper.ls(PurePath(self.temp_dir))

                self.assertIsInstance(result, list)
                self.assertTrue(len(result) > 0)

                names = [item.name for item in result]
                self.assertIn("test_file.txt", names)

        asyncio.run(run_test())

    def test_wrapper_get(self) -> None:
        """Test get operation through wrapper."""
        async def run_test() -> None:
            source_file = Path(self.temp_dir) / "test_file.txt"
            dest_dir = tempfile.mkdtemp()
            dest_file = Path(dest_dir) / "wrapped_dest.txt"

            try:
                async with self.async_wrapper:
                    await self.async_wrapper.get(PurePath(source_file), dest_file)
                    self.assertTrue(dest_file.exists())
            finally:
                shutil.rmtree(dest_dir)

        asyncio.run(run_test())

    def test_wrapper_mkdir(self) -> None:
        """Test mkdir through wrapper."""
        async def run_test() -> None:
            new_dir = Path(self.temp_dir) / "wrapped_new_dir"

            async with self.async_wrapper:
                result = await self.async_wrapper.mkdir(PurePath(new_dir))
                self.assertTrue(result)
                self.assertTrue(new_dir.exists())

        asyncio.run(run_test())


class TestAsyncRunner(unittest.TestCase):
    """Test cases for AsyncRunner class."""

    def test_runner_start_stop(self) -> None:
        """Test starting and stopping the runner."""
        runner = AsyncRunner()
        self.assertFalse(runner.is_running)

        runner.start()
        self.assertTrue(runner.is_running)

        runner.stop()
        self.assertFalse(runner.is_running)

    def test_runner_context_manager(self) -> None:
        """Test runner as context manager."""
        with AsyncRunner() as runner:
            self.assertTrue(runner.is_running)
        # After exiting context, should be stopped
        self.assertFalse(runner.is_running)

    def test_runner_run_coroutine(self) -> None:
        """Test running a coroutine."""
        async def simple_coro() -> int:
            await asyncio.sleep(0.01)
            return 42

        with AsyncRunner() as runner:
            future = runner.run(simple_coro())
            result = future.result(timeout=5)
            self.assertEqual(result, 42)

    def test_runner_run_sync(self) -> None:
        """Test run_sync convenience method."""
        async def simple_coro() -> str:
            await asyncio.sleep(0.01)
            return "hello"

        with AsyncRunner() as runner:
            result = runner.run_sync(simple_coro())
            self.assertEqual(result, "hello")

    def test_runner_exception_propagation(self) -> None:
        """Test that exceptions from coroutines are propagated."""
        async def failing_coro() -> None:
            raise ValueError("Test error")

        with AsyncRunner() as runner:
            future = runner.run(failing_coro())
            with self.assertRaises(ValueError) as context:
                future.result(timeout=5)
            self.assertEqual(str(context.exception), "Test error")

    def test_runner_not_started_error(self) -> None:
        """Test that running without starting raises error."""
        runner = AsyncRunner()

        async def simple_coro() -> None:
            pass

        with self.assertRaises(RuntimeError):
            runner.run(simple_coro())

    def test_runner_double_start_error(self) -> None:
        """Test that starting twice raises error."""
        runner = AsyncRunner()
        runner.start()
        try:
            with self.assertRaises(RuntimeError):
                runner.start()
        finally:
            runner.stop()


class TestCancellationToken(unittest.TestCase):
    """Test cases for CancellationToken class."""

    def test_initial_state(self) -> None:
        """Test token starts not cancelled."""
        token = CancellationToken()
        self.assertFalse(token.is_cancelled)

    def test_cancel(self) -> None:
        """Test cancellation."""
        token = CancellationToken()
        token.cancel()
        self.assertTrue(token.is_cancelled)

    def test_reset(self) -> None:
        """Test reset after cancellation."""
        token = CancellationToken()
        token.cancel()
        self.assertTrue(token.is_cancelled)
        token.reset()
        self.assertFalse(token.is_cancelled)


if __name__ == "__main__":
    unittest.main()
