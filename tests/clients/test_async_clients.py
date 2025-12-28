"""Tests for async client implementations."""

import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path, PurePath
from datetime import datetime

from ftpc.clients.async_client import AsyncClient
from ftpc.clients.async_wrapper import AsyncClientWrapper
from ftpc.clients.localclient import LocalClient
from ftpc.async_runner import AsyncRunner, CancellationToken
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError
from tests.fixtures.test_data import TestDataFixtures


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
