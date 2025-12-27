"""AsyncRunner for running asyncio coroutines from synchronous curses code.

This module provides a bridge between the synchronous curses TUI and the
async client implementations. It runs an asyncio event loop in a background
thread and provides methods to submit coroutines for execution.
"""

import asyncio
import threading
from concurrent.futures import Future
from typing import Any, Coroutine, Optional, TypeVar

T = TypeVar("T")


class AsyncRunner:
    """Runs asyncio coroutines from synchronous code.

    This class manages a background thread running an asyncio event loop,
    allowing the main curses thread to submit async operations without blocking.

    Example:
        runner = AsyncRunner()
        runner.start()

        # Submit an async operation
        future = runner.run(client.ls(path))

        # Poll for completion while keeping UI responsive
        while not future.done():
            # Update UI, check for cancellation, etc.
            time.sleep(0.05)

        result = future.result()

        runner.stop()
    """

    def __init__(self) -> None:
        """Initialize the async runner (does not start the event loop)."""
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._started = False

    @property
    def is_running(self) -> bool:
        """Check if the async runner is currently running."""
        return self._started and self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        """Start the background event loop.

        Creates a new thread running an asyncio event loop. The loop
        will run until stop() is called.

        Raises:
            RuntimeError: If the runner is already started.
        """
        if self._started:
            raise RuntimeError("AsyncRunner is already started")

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self._started = True

    def _run_loop(self) -> None:
        """Run the event loop in the background thread."""
        assert self._loop is not None
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def run(self, coro: Coroutine[Any, Any, T]) -> "Future[T]":
        """Submit a coroutine for execution and return a Future.

        The coroutine will be scheduled to run in the background event loop.
        The returned Future can be used to poll for completion or get the result.

        Args:
            coro: The coroutine to execute.

        Returns:
            A concurrent.futures.Future that will contain the result.

        Raises:
            RuntimeError: If the runner is not started.
        """
        if self._loop is None:
            raise RuntimeError("AsyncRunner not started - call start() first")
        if not self._started:
            raise RuntimeError("AsyncRunner not started - call start() first")

        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def run_sync(self, coro: Coroutine[Any, Any, T], timeout: Optional[float] = None) -> T:
        """Submit a coroutine and wait for the result synchronously.

        This is a convenience method that combines run() with result().
        Use this when you want to block until the operation completes.

        Args:
            coro: The coroutine to execute.
            timeout: Optional timeout in seconds.

        Returns:
            The result of the coroutine.

        Raises:
            RuntimeError: If the runner is not started.
            TimeoutError: If the operation times out.
            Exception: Any exception raised by the coroutine.
        """
        future = self.run(coro)
        return future.result(timeout=timeout)

    def stop(self, timeout: float = 5.0) -> None:
        """Stop the background event loop.

        This will stop the event loop and wait for the thread to finish.

        Args:
            timeout: Maximum time to wait for the thread to finish (default: 5s).
        """
        if self._loop is not None and self._started:
            # Schedule the loop to stop
            self._loop.call_soon_threadsafe(self._loop.stop)

        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

        if self._loop is not None:
            self._loop.close()
            self._loop = None

        self._started = False

    def __enter__(self) -> "AsyncRunner":
        """Context manager entry - starts the runner."""
        self.start()
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[object],
    ) -> None:
        """Context manager exit - stops the runner."""
        self.stop()


class CancellationToken:
    """Token for cooperative cancellation of async operations.

    This class provides a thread-safe way to signal cancellation to
    async operations that support it.

    Example:
        token = CancellationToken()

        def progress_callback(bytes_done: int) -> bool:
            if token.is_cancelled:
                return False  # Signal to stop
            update_ui(bytes_done)
            return True

        # In another thread (e.g., on Escape key press)
        token.cancel()
    """

    def __init__(self) -> None:
        """Initialize the cancellation token."""
        self._cancelled = False
        self._lock = threading.Lock()

    @property
    def is_cancelled(self) -> bool:
        """Check if cancellation has been requested."""
        with self._lock:
            return self._cancelled

    def cancel(self) -> None:
        """Request cancellation."""
        with self._lock:
            self._cancelled = True

    def reset(self) -> None:
        """Reset the cancellation state (for reuse)."""
        with self._lock:
            self._cancelled = False
