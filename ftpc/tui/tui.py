"""Async-aware TUI implementation for FTPC.

This module provides the main TUI that uses the AsyncRunner to execute
async client operations without blocking the UI thread.
"""

import curses
import time
from concurrent.futures import Future
from enum import IntEnum, auto
from pathlib import PurePath, Path
from typing import Any, Optional

from ftpc.async_runner import AsyncRunner, CancellationToken
from ftpc.clients.async_client import AsyncClient
from ftpc.clients.async_wrapper import AsyncClientWrapper
from ftpc.clients.localclient import LocalClient
from ftpc.displaydescriptor import DisplayDescriptor
from ftpc.filedescriptor import FileDescriptor
from ftpc.tui.lswindow import LsWindow
from ftpc.tui.dialog import (
    show_help_dialog,
    show_confirmation_dialog,
    show_input_dialog,
    ProgressDialog,
)
from ftpc.exceptions import (
    ConnectionError,
    AuthenticationError,
    ListingError,
    ClientError,
)


class TuiMode(IntEnum):
    NORMAL = auto()
    UPLOAD = auto()


class Tui:
    """Async-aware TUI for file transfer operations.

    This TUI uses the AsyncRunner to execute async client operations
    in a background thread, keeping the UI responsive during network
    operations.
    """

    def __init__(self, client: AsyncClient, *, cwd: PurePath) -> None:
        """Initialize the TUI.

        Args:
            client: The async client to use for file operations
            cwd: The initial working directory
        """
        self.client: AsyncClient = client
        self.cwd = cwd
        self.lswindow: Optional[LsWindow] = None
        self.stdscr: Any = None
        self.mode = TuiMode.NORMAL
        self.history: list[PurePath] = []
        self.status_message: Optional[str] = None

        # Upload mode state
        self.remote_client: Optional[AsyncClient] = None
        self.remote_cwd: Optional[PurePath] = None
        self.upload_client: Optional[AsyncClient] = None

        # Colors
        self.normal_bar_color: int = 0
        self.upload_bar_color: int = 0

        # Async runner for background operations
        self.async_runner: Optional[AsyncRunner] = None

    def start(self) -> None:
        """Start the TUI."""
        curses.wrapper(self._main_loop)

    def _wait_for_future(
        self,
        future: "Future[Any]",
        message: str = "Working...",
        cancellable: bool = True,
    ) -> Any:
        """Wait for a future to complete while keeping UI responsive.

        Args:
            future: The future to wait for
            message: Status message to display
            cancellable: Whether to allow cancellation with Escape

        Returns:
            The result of the future, or None if cancelled/failed
        """
        assert self.stdscr is not None
        assert self.lswindow is not None

        # Enable non-blocking input
        self.stdscr.nodelay(True)

        try:
            while not future.done():
                # Check for cancellation
                if cancellable:
                    try:
                        key = self.stdscr.getkey()
                        if key == "\x1b":  # Escape
                            future.cancel()
                            self.status_message = "Operation cancelled"
                            return None
                    except curses.error:
                        pass

                # Brief sleep to avoid busy-waiting
                time.sleep(0.02)

            # Get the result
            if future.cancelled():
                return None

            try:
                return future.result()
            except Exception as e:
                self.status_message = f"Error: {e}"
                return None
        finally:
            self.stdscr.nodelay(False)

    def _run_async(
        self,
        coro: Any,
        message: str = "Working...",
        cancellable: bool = True,
    ) -> Any:
        """Run an async coroutine and wait for the result.

        Args:
            coro: The coroutine to run
            message: Status message to display
            cancellable: Whether to allow cancellation

        Returns:
            The result of the coroutine
        """
        assert self.async_runner is not None
        future = self.async_runner.run(coro)
        return self._wait_for_future(future, message, cancellable)

    def _handle_resize(self, _signum: Any, _frame: Any) -> None:
        """Handle terminal resize event."""
        if self.stdscr and self.lswindow:
            try:
                curses.update_lines_cols()
                self._tui_init()

                # Refresh directory listing
                self.refresh_directory_listing()
                self.lswindow.top_text = self.client.name()

                if self.status_message:
                    self.lswindow.bottom_text = self.status_message
                else:
                    self.lswindow.bottom_text = self.cwd.as_posix()

                self.lswindow.draw_window()

            except Exception:
                try:
                    curses.endwin()
                    curses.initscr()
                    self.stdscr.clear()
                    self.stdscr.refresh()
                except Exception:
                    pass

    def refresh_directory_listing(self) -> None:
        """Refresh the directory listing with current client and path."""
        assert self.lswindow is not None
        assert self.async_runner is not None

        try:
            file_descriptors = self._run_async(
                self.client.ls(self.cwd),
                message="Loading directory...",
                cancellable=False,
            )
            if file_descriptors is not None:
                self.lswindow.elements = sorted(file_descriptors, key=lambda u: u.path)
            else:
                self.lswindow.elements = []
        except ListingError as e:
            self.lswindow.elements = []
            self.status_message = str(e)

        if self.mode == TuiMode.NORMAL:
            self.lswindow.top_text = self.client.name()
        elif self.mode == TuiMode.UPLOAD:
            self.lswindow.top_text = "Select a file to upload."

        if self.status_message:
            self.lswindow.bottom_text = self.status_message
        else:
            self.lswindow.bottom_text = self.cwd.as_posix()

    def navigate_to_directory(self, dir_path: PurePath) -> None:
        """Navigate to a directory, updating history."""
        self.history.append(self.cwd)

        if dir_path.is_absolute():
            self.cwd = dir_path
        else:
            self.cwd = PurePath(self.cwd) / dir_path

        self.refresh_directory_listing()

    def navigate_back(self) -> None:
        """Navigate to the previous directory in history."""
        if self.history:
            self.cwd = self.history.pop()
            self.refresh_directory_listing()

    def navigate_to_parent(self) -> None:
        """Navigate to the parent directory."""
        parent = self.cwd.parent

        if parent != self.cwd:
            self.history.append(self.cwd)
            self.cwd = parent
            self.refresh_directory_listing()

    def download_file(self, file_desc: FileDescriptor) -> bool:
        """Download a file to the local current working directory."""
        if not show_confirmation_dialog(
            self.stdscr, f"Download {file_desc.name} to local directory?"
        ):
            self.status_message = "Download cancelled"
            return False

        try:
            local_cwd = Path.cwd()
            local_path = local_cwd / file_desc.name
            remote_path = self.cwd / file_desc.path

            # Create cancellation token for progress callback
            cancel_token = CancellationToken()

            with ProgressDialog(
                self.stdscr, "Downloading", file_desc.name, file_desc.size
            ) as progress:
                try:
                    def progress_callback(bytes_done: int) -> bool:
                        if cancel_token.is_cancelled:
                            return False
                        progress.update(bytes_done)
                        # Check for Escape key
                        self.stdscr.nodelay(True)
                        try:
                            key = self.stdscr.getkey()
                            if key == "\x1b":
                                cancel_token.cancel()
                                return False
                        except curses.error:
                            pass
                        finally:
                            self.stdscr.nodelay(False)
                        return True

                    # Run the download asynchronously
                    assert self.async_runner is not None
                    future = self.async_runner.run(
                        self.client.get(remote_path, local_path, progress_callback)
                    )

                    # Wait for completion
                    while not future.done():
                        time.sleep(0.02)

                    if cancel_token.is_cancelled or progress.is_canceled:
                        self.status_message = f"Download of {file_desc.name} was canceled"
                        return False
                    else:
                        self.status_message = f"Downloaded: {file_desc.name} to {local_cwd}"

                except Exception as e:
                    self.status_message = f"Error downloading {file_desc.name}: {str(e)}"
                    return False

            return True

        except Exception as e:
            self.status_message = f"Error downloading {file_desc.name}: {str(e)}"
            return False

    def search_file(self) -> None:
        """Search for a file/directory by name prefix."""
        assert self.lswindow is not None

        original_bottom_text = self.lswindow.bottom_text
        self.lswindow.bottom_text = "Search: "
        search_string = ""

        curses.flushinp()
        curses.curs_set(1)

        bottom_start_pos = len("Search: ")

        while True:
            try:
                self.lswindow.botbar.move(0, bottom_start_pos + len(search_string) + 1)
                self.lswindow.botbar.refresh()

                key = self.stdscr.getkey()

                if key in ("\x1b", "\n"):
                    break
                elif key in ("KEY_BACKSPACE", "\b", "\x7f"):
                    if search_string:
                        search_string = search_string[:-1]
                        self.lswindow.bottom_text = f"Search: {search_string}"
                        self.lswindow.select_by_prefix(search_string)
                elif len(key) == 1 and ord(key) >= 32:
                    search_string += key
                    self.lswindow.bottom_text = f"Search: {search_string}"
                    self.lswindow.select_by_prefix(search_string)

            except curses.error:
                pass

        curses.curs_set(0)
        self.lswindow.bottom_text = original_bottom_text

    def delete_file(self, file_desc: FileDescriptor) -> bool:
        """Delete a file."""
        if file_desc.is_directory:
            self.status_message = "Cannot delete directories"
            return False

        if not show_confirmation_dialog(
            self.stdscr, f"Delete {file_desc.name}? This cannot be undone."
        ):
            self.status_message = "Deletion cancelled"
            return False

        try:
            remote_path = self.cwd / file_desc.path

            result = self._run_async(
                self.client.unlink(remote_path),
                message="Deleting...",
                cancellable=False,
            )

            if result:
                self.status_message = f"Deleted: {file_desc.name}"
                self.refresh_directory_listing()
                return True
            else:
                self.status_message = f"Failed to delete {file_desc.name}"
                return False

        except Exception as e:
            self.status_message = f"Error deleting {file_desc.name}: {str(e)}"
            return False

    def make_directory(self) -> bool:
        """Create a new directory in the current location."""
        dir_name = show_input_dialog(
            self.stdscr, "Create Directory", "Enter directory name:"
        )

        if not dir_name:
            self.status_message = "Directory creation cancelled"
            return False

        try:
            remote_path = self.cwd / dir_name

            result = self._run_async(
                self.client.mkdir(remote_path),
                message="Creating directory...",
                cancellable=False,
            )

            if result:
                self.status_message = f"Created directory: {dir_name}"
                self.refresh_directory_listing()
                return True
            else:
                self.status_message = f"Failed to create directory: {dir_name}"
                return False

        except Exception as e:
            self.status_message = f"Error creating directory: {str(e)}"
            return False

    def enter_upload_mode(self) -> None:
        """Enter upload mode to select a local file for upload."""
        assert self.lswindow is not None
        assert self.upload_client is not None

        self.remote_client = self.client
        self.remote_cwd = self.cwd

        self.mode = TuiMode.UPLOAD
        self.client = self.upload_client

        self.cwd = PurePath(Path.cwd().as_posix())

        self.lswindow.bar_color = self.upload_bar_color
        self.lswindow.top_text = "Select a file to upload"
        self.status_message = "In upload mode - Press U to exit"

        self.history = []

        self.refresh_directory_listing()

    def exit_upload_mode(self) -> None:
        """Exit upload mode and return to normal mode."""
        assert self.lswindow is not None
        assert self.remote_client is not None
        assert self.remote_cwd is not None

        self.mode = TuiMode.NORMAL
        self.client = self.remote_client
        self.cwd = self.remote_cwd

        self.lswindow.bar_color = self.normal_bar_color
        self.lswindow.top_text = self.client.name()
        self.status_message = "Exited upload mode"

        self.history = []

        self.refresh_directory_listing()

    def handle_upload_file_selection(self, file_desc: FileDescriptor) -> bool:
        """Handle file selection in upload mode."""
        assert self.remote_client is not None
        assert self.remote_cwd is not None

        local_path = Path(self.cwd) / file_desc.path

        if not show_confirmation_dialog(
            self.stdscr, f"Upload {file_desc.name} to remote directory?"
        ):
            self.status_message = "Upload cancelled"
            return False

        try:
            remote_path = self.remote_cwd / file_desc.name

            cancel_token = CancellationToken()

            with ProgressDialog(
                self.stdscr, "Uploading", file_desc.name, file_desc.size
            ) as progress:
                try:
                    def progress_callback(bytes_done: int) -> bool:
                        if cancel_token.is_cancelled:
                            return False
                        progress.update(bytes_done)
                        self.stdscr.nodelay(True)
                        try:
                            key = self.stdscr.getkey()
                            if key == "\x1b":
                                cancel_token.cancel()
                                return False
                        except curses.error:
                            pass
                        finally:
                            self.stdscr.nodelay(False)
                        return True

                    assert self.async_runner is not None
                    future = self.async_runner.run(
                        self.remote_client.put(local_path, remote_path, progress_callback)
                    )

                    while not future.done():
                        time.sleep(0.02)

                    if cancel_token.is_cancelled or progress.is_canceled:
                        self.status_message = f"Upload of {file_desc.name} was canceled"
                        return False

                except Exception as e:
                    self.status_message = f"Error uploading {file_desc.name}: {str(e)}"
                    return False

            self.exit_upload_mode()
            self.status_message = f"Uploaded: {file_desc.name} to {self.remote_cwd}"

            return True

        except Exception as e:
            self.status_message = f"Error uploading {file_desc.name}: {str(e)}"
            return False

    def _show_connection_error(self, stdscr: Any, error_message: str) -> None:
        """Display a connection error screen and wait for user to quit."""
        curses.curs_set(0)
        stdscr.clear()

        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(5, curses.COLOR_WHITE, curses.COLOR_RED)

        height, width = stdscr.getmaxyx()

        max_msg_width = width - 4
        truncated_msg = error_message[:max_msg_width] if len(error_message) > max_msg_width else error_message

        error_lines = [
            "Connection Error",
            "",
            truncated_msg,
            "",
            "Press 'q' to quit",
        ]

        for i, line in enumerate(error_lines):
            y = height // 2 - len(error_lines) // 2 + i
            x = max(0, (width - len(line)) // 2)
            try:
                if i == 0:
                    stdscr.addstr(y, x, line[:width - 1], curses.color_pair(5) | curses.A_BOLD)
                else:
                    stdscr.addstr(y, x, line[:width - 1])
            except curses.error:
                pass

        stdscr.refresh()

        while True:
            try:
                key = stdscr.getkey()
                if key == "q":
                    break
            except curses.error:
                pass

    def _tui_init(self) -> None:
        """Initialize TUI colors and window."""
        curses.curs_set(0)

        self.stdscr.clear()
        self.stdscr.refresh()

        curses.start_color()
        curses.use_default_colors()

        curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLUE)
        curses.init_pair(2, curses.COLOR_RED, -1)
        curses.init_pair(3, curses.COLOR_CYAN, -1)
        curses.init_pair(4, curses.COLOR_GREEN, -1)
        curses.init_pair(5, curses.COLOR_WHITE, curses.COLOR_RED)
        curses.init_pair(6, -1, -1)

        self.normal_bar_color = curses.color_pair(1) | curses.A_BOLD
        self.upload_bar_color = curses.color_pair(5) | curses.A_BOLD

        self.lswindow = LsWindow(
            bar_color=self.normal_bar_color,
            icon_color=curses.color_pair(2) | curses.A_BOLD,
            dir_color=curses.color_pair(3),
            file_color=curses.color_pair(4),
            neutral_color=curses.color_pair(6),
        )

        self.refresh_directory_listing()

    def _main_loop(self, stdscr: Any) -> None:
        """Main TUI event loop."""
        self.stdscr = stdscr

        try:
            # Start async runner
            with AsyncRunner() as runner:
                self.async_runner = runner

                # Enter async client context
                future = runner.run(self.client.__aenter__())
                try:
                    future.result(timeout=30)
                except Exception as e:
                    self._show_connection_error(stdscr, str(e))
                    return

                try:
                    self._tui_init()
                    assert self.lswindow is not None

                    # Main input loop
                    while True:
                        self.status_message = None
                        match stdscr.getkey():
                            case "q":
                                break
                            case "k" | "KEY_UP":
                                self.lswindow.select_previous()
                            case "j" | "KEY_DOWN":
                                self.lswindow.select_next()
                            case "G":
                                self.lswindow.select_last()
                            case "g":
                                self.lswindow.select_first()
                            case "l" | "KEY_RIGHT" | "\n":
                                if (selected := self.lswindow.get_selected()) and isinstance(
                                    selected, FileDescriptor
                                ):
                                    if selected.is_directory:
                                        self.navigate_to_directory(selected.path)
                                    elif self.mode == TuiMode.NORMAL:
                                        self.download_file(selected)
                                    elif self.mode == TuiMode.UPLOAD:
                                        self.handle_upload_file_selection(selected)
                                self.stdscr.clear()
                                self.stdscr.refresh()
                                self.lswindow.draw_window()
                                self.refresh_directory_listing()
                            case "h" | "KEY_LEFT":
                                self.navigate_back()
                            case "r":
                                self.refresh_directory_listing()
                            case "?":
                                show_help_dialog(self.stdscr)
                                self.stdscr.clear()
                                self.stdscr.refresh()
                                self.lswindow.draw_window()
                                self.refresh_directory_listing()
                            case "/":
                                self.search_file()
                            case "u":
                                self.upload_client = AsyncClientWrapper(LocalClient())
                                if self.mode == TuiMode.NORMAL:
                                    self.enter_upload_mode()
                                elif self.mode == TuiMode.UPLOAD:
                                    self.exit_upload_mode()
                            case "p":
                                self.navigate_to_parent()
                            case "d":
                                if self.mode == TuiMode.NORMAL:
                                    if (
                                        selected := self.lswindow.get_selected()
                                    ) and isinstance(selected, FileDescriptor):
                                        self.delete_file(selected)
                                        self.stdscr.clear()
                                        self.stdscr.refresh()
                                        self.lswindow.draw_window()
                                        self.refresh_directory_listing()
                            case "m":
                                if self.mode == TuiMode.NORMAL:
                                    self.make_directory()
                                    self.stdscr.clear()
                                    self.stdscr.refresh()
                                    self.lswindow.draw_window()
                                    self.refresh_directory_listing()
                            case "KEY_RESIZE":
                                self._handle_resize(None, None)

                finally:
                    # Exit async client context
                    exit_future = runner.run(self.client.__aexit__(None, None, None))
                    try:
                        exit_future.result(timeout=10)
                    except Exception:
                        pass

        except (ConnectionError, AuthenticationError, ClientError) as e:
            self._show_connection_error(stdscr, str(e))
