import curses
from enum import IntEnum, auto
from pathlib import PurePath, Path
from typing import Any, Optional

from ftpc.clients.client import Client
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
    def __init__(self, client: Client, *, cwd: PurePath) -> None:
        self.client: Client = client
        self.cwd = cwd
        self.lswindow: Optional[LsWindow] = None
        self.stdscr: Any = None
        self.mode = TuiMode.NORMAL
        self.history: list[PurePath] = []  # Navigation history
        self.status_message: Optional[str] = None  # Status message for downloads
        # These are set in upload mode
        self.remote_client: Optional[Client] = None
        self.remote_cwd: Optional[PurePath] = None
        self.upload_client: Optional[LocalClient] = None
        self.normal_bar_color: int = 0
        self.upload_bar_color: int = 0

    def start(self) -> None:
        curses.wrapper(self._main_loop)

    def _handle_resize(self, _signum: Any, _frame: Any) -> None:
        """Handle terminal resize event with complete terminal reset"""
        if self.stdscr and self.lswindow:
            try:
                # Force terminal reset and get new dimensions
                curses.update_lines_cols()

                self._tui_init()

                # Reset the window with the current elements
                try:
                    file_descriptors = self.client.ls(self.cwd)
                    self.lswindow.elements = file_descriptors  # type: ignore[assignment]
                except ListingError as e:
                    self.lswindow.elements = []
                    self.status_message = str(e)

                self.lswindow.top_text = self.client.name()

                # Set bottom text
                if self.status_message:
                    self.lswindow.bottom_text = self.status_message
                else:
                    self.lswindow.bottom_text = self.cwd.as_posix()

                # Draw everything fresh
                self.lswindow.draw_window()

            except Exception:
                # If anything fails, we need to recover somehow
                try:
                    # Try to at least get a working terminal back
                    curses.endwin()
                    curses.initscr()
                    self.stdscr.clear()
                    self.stdscr.refresh()
                except Exception:
                    pass

    def refresh_directory_listing(self) -> None:
        """Refresh the directory listing with current client and path"""
        assert self.lswindow is not None, "LsWindow not initialized"
        try:
            file_descriptors = self.client.ls(self.cwd)
            self.lswindow.elements = sorted(file_descriptors, key=lambda u: u.path)  # type: ignore[attr-defined]
        except ListingError as e:
            self.lswindow.elements = []
            self.status_message = str(e)

        if self.mode == TuiMode.NORMAL:
            self.lswindow.top_text = self.client.name()
        elif self.mode == TuiMode.UPLOAD:
            self.lswindow.top_text = "Select a file to upload."

        # Show status message if exists, otherwise show current path
        if self.status_message:
            self.lswindow.bottom_text = self.status_message
        else:
            self.lswindow.bottom_text = self.cwd.as_posix()

    def navigate_to_directory(self, dir_path: PurePath) -> None:
        """Navigate to a directory, updating history"""
        # Save current location in history for "back" functionality
        self.history.append(self.cwd)

        # Update current directory
        if dir_path.is_absolute():
            self.cwd = dir_path
        else:
            self.cwd = PurePath(self.cwd) / dir_path

        # Refresh the display
        self.refresh_directory_listing()

    def navigate_back(self) -> None:
        """Navigate to the previous directory in history"""
        if self.history:
            self.cwd = self.history.pop()
            self.refresh_directory_listing()

    def navigate_to_parent(self) -> None:
        """Navigate to the parent directory"""
        # Get the parent path
        parent = self.cwd.parent

        # Only navigate if we're not already at the root
        if parent != self.cwd:
            # Save current location in history for "back" functionality
            self.history.append(self.cwd)

            # Update current directory to parent
            self.cwd = parent

            # Refresh the display
            self.refresh_directory_listing()

    def download_file(self, file_desc: FileDescriptor) -> bool:
        """Download a file to the local current working directory"""
        # Show confirmation dialog
        if not show_confirmation_dialog(
            self.stdscr, f"Download {file_desc.name} to local directory?"
        ):
            self.status_message = "Download cancelled"
            return False

        try:
            # Get the local current working directory
            local_cwd = Path.cwd()

            # Create a local path in the current working directory using the file name
            local_path = local_cwd / file_desc.name

            # Create the remote path by combining the current working directory with the file name
            remote_path = self.cwd / file_desc.path

            with ProgressDialog(
                self.stdscr, "Downloading", file_desc.name, file_desc.size
            ) as progress:
                try:
                    # Use the progress.update method as the callback
                    self.client.get(remote_path, local_path, progress.update)
                    if progress.is_canceled:
                        self.status_message = (
                            f"Download of {file_desc.name} was canceled"
                        )
                        return False
                    else:
                        self.status_message = (
                            f"Downloaded: {file_desc.name} to {local_cwd}"
                        )
                except Exception as e:
                    self.status_message = (
                        f"Error downloading {file_desc.name}: {str(e)}"
                    )
                    return False

            # Set status message and timeout
            self.status_message = f"Downloaded: {file_desc.name} to {local_cwd}"

            return True
        except Exception as e:
            self.status_message = f"Error downloading {file_desc.name}: {str(e)}"
            return False

    def search_file(self) -> None:
        """Search for a file/directory by name prefix"""
        assert self.lswindow is not None, "LsWindow not initialized"
        # Save current bottom text to restore it later
        original_bottom_text = self.lswindow.bottom_text

        # Show search prompt at the bottom
        self.lswindow.bottom_text = "Search: "
        search_string = ""

        # Clear input buffer
        curses.flushinp()

        # Show cursor for text input
        curses.curs_set(1)

        # Get cursor position for the search input
        bottom_start_pos = len("Search: ")

        while True:
            try:
                # Position cursor at end of search input
                self.lswindow.botbar.move(0, bottom_start_pos + len(search_string) + 1)
                self.lswindow.botbar.refresh()

                # Get user input
                key = self.stdscr.getkey()

                # Escape and Enter exit search mode
                if key in ("\x1b", "\n"):
                    break

                # Handle backspace/delete
                elif key in ("KEY_BACKSPACE", "\b", "\x7f"):
                    if search_string:
                        search_string = search_string[:-1]
                        # Update the bottom bar with new search string
                        self.lswindow.bottom_text = f"Search: {search_string}"

                        # Find and select as we type
                        self.lswindow.select_by_prefix(search_string)

                # Ignore control keys and other special keys
                elif len(key) == 1 and ord(key) >= 32:
                    # Add character to search string
                    search_string += key
                    # Update the bottom bar with new search string
                    self.lswindow.bottom_text = f"Search: {search_string}"

                    # Find and select as we type
                    self.lswindow.select_by_prefix(search_string)

            except curses.error:
                pass

        # Hide cursor when done
        curses.curs_set(0)

        # Restore bottom text
        self.lswindow.bottom_text = original_bottom_text

    def delete_file(self, file_desc: FileDescriptor) -> bool:
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

            if self.client.unlink(remote_path):
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
        # Show input dialog to get directory name
        dir_name = show_input_dialog(
            self.stdscr, "Create Directory", "Enter directory name:"
        )

        if not dir_name:
            self.status_message = "Directory creation cancelled"
            return False

        try:
            remote_path = self.cwd / dir_name

            if self.client.mkdir(remote_path):
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
        assert self.lswindow is not None, "LsWindow not initialized"
        assert self.upload_client is not None, "Upload client not initialized"
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
        assert self.lswindow is not None, "LsWindow not initialized"
        assert self.remote_client is not None, "Remote client not set"
        assert self.remote_cwd is not None, "Remote cwd not set"
        self.mode = TuiMode.NORMAL
        self.client = self.remote_client
        self.cwd = self.remote_cwd

        self.lswindow.bar_color = self.normal_bar_color
        self.lswindow.top_text = self.client.name()
        self.status_message = "Exited upload mode"

        self.history = []

        self.refresh_directory_listing()

    def handle_upload_file_selection(self, file_desc: FileDescriptor) -> bool:
        assert self.remote_client is not None, "Remote client not set"
        assert self.remote_cwd is not None, "Remote cwd not set"
        local_path = Path(self.cwd) / file_desc.path

        if not show_confirmation_dialog(
            self.stdscr, "Upload {file_desc.name} to remote directory?"
        ):
            self.status_message = "Upload cancelled"
            return False

        try:
            remote_path = self.remote_cwd / file_desc.name

            with ProgressDialog(
                self.stdscr, "Uploading", file_desc.name, file_desc.size
            ) as progress:
                try:
                    self.remote_client.put(local_path, remote_path, progress.update)
                    if progress.is_canceled:
                        self.status_message = f"Upload of {file_desc.name} was canceled"
                        return False
                    else:
                        self.status_message = (
                            f"Uploaded: {file_desc.name} to {self.cwd}"
                        )
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
        """Display a connection error screen and wait for user to quit"""
        curses.curs_set(0)
        stdscr.clear()

        # Setup colors
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(5, curses.COLOR_WHITE, curses.COLOR_RED)

        height, width = stdscr.getmaxyx()

        # Display error message - truncate if too long
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
                if i == 0:  # Title line in red
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
        curses.curs_set(0)  # Hide cursor

        # Clear screen
        self.stdscr.clear()
        self.stdscr.refresh()

        # Setup colors
        curses.start_color()
        curses.use_default_colors()

        curses.init_pair(
            1, curses.COLOR_WHITE, curses.COLOR_BLUE
        )  # Normal mode bar color
        curses.init_pair(2, curses.COLOR_RED, -1)  # Icon color
        curses.init_pair(3, curses.COLOR_CYAN, -1)  # Directory color
        curses.init_pair(4, curses.COLOR_GREEN, -1)  # File color
        curses.init_pair(
            5, curses.COLOR_WHITE, curses.COLOR_RED
        )  # Upload mode bar color
        curses.init_pair(6, -1, -1)  # Neutral color (default fg/bg)

        # Store color pairs for easy mode switching
        self.normal_bar_color = curses.color_pair(1) | curses.A_BOLD
        self.upload_bar_color = curses.color_pair(5) | curses.A_BOLD

        # Create lswindow with more color options
        self.lswindow = LsWindow(
            bar_color=self.normal_bar_color,
            icon_color=curses.color_pair(2) | curses.A_BOLD,
            dir_color=curses.color_pair(3),
            file_color=curses.color_pair(4),
            neutral_color=curses.color_pair(6),
        )

        # Initialize content
        self.refresh_directory_listing()

    def _main_loop(self, stdscr: Any) -> None:
        self.stdscr = stdscr

        try:
            with self.client:
                self._tui_init()
                assert self.lswindow is not None, "LsWindow not initialized"

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
                        case "l" | "KEY_RIGHT" | "\n":  # Enter key handling
                            if (selected := self.lswindow.get_selected()) and isinstance(
                                selected, FileDescriptor
                            ):
                                if selected.is_directory:
                                    # Navigate to directory
                                    self.navigate_to_directory(selected.path)
                                elif self.mode == TuiMode.NORMAL:
                                    # Download file if it's a regular file
                                    self.download_file(selected)
                                elif self.mode == TuiMode.UPLOAD:
                                    self.handle_upload_file_selection(selected)
                            # Redraw everything after the dialog is closed
                            self.stdscr.clear()
                            self.stdscr.refresh()
                            self.lswindow.draw_window()
                            self.refresh_directory_listing()
                        case "h" | "KEY_LEFT":  # Go back
                            self.navigate_back()
                        case "r":  # Refresh current directory
                            self.refresh_directory_listing()
                        case "?":  # Show help dialog
                            show_help_dialog(self.stdscr)
                            # Redraw everything after the dialog is closed
                            self.stdscr.clear()
                            self.stdscr.refresh()
                            self.lswindow.draw_window()
                            self.refresh_directory_listing()
                        case "/":
                            self.search_file()
                        case "u":
                            self.upload_client = LocalClient()
                            if self.mode == TuiMode.NORMAL:
                                self.enter_upload_mode()
                            elif self.mode == TuiMode.UPLOAD:
                                self.exit_upload_mode()
                        case "p":
                            self.navigate_to_parent()
                        case "d":
                            if (
                                self.mode == TuiMode.NORMAL
                            ):  # Only allow deletion in normal mode
                                if (
                                    selected := self.lswindow.get_selected()
                                ) and isinstance(selected, FileDescriptor):
                                    self.delete_file(selected)
                                    # Redraw everything after the operation
                                    self.stdscr.clear()
                                    self.stdscr.refresh()
                                    self.lswindow.draw_window()
                                    self.refresh_directory_listing()
                        case "m":
                            if (
                                self.mode == TuiMode.NORMAL
                            ):  # Only allow mkdir in normal mode
                                self.make_directory()
                                # Redraw everything after the operation
                                self.stdscr.clear()
                                self.stdscr.refresh()
                                self.lswindow.draw_window()
                                self.refresh_directory_listing()
                        case "KEY_RESIZE":
                            # Additional resize handling if curses catches it directly
                            self._handle_resize(None, None)
        except (ConnectionError, AuthenticationError, ClientError) as e:
            self._show_connection_error(stdscr, str(e))
