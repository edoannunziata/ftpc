import curses
from enum import IntEnum, auto
from pathlib import PurePath, Path
from typing import Optional

from ftpc.clients.client import Client
from ftpc.clients.localclient import LocalClient
from ftpc.filedescriptor import FileDescriptor
from ftpc.tui.lswindow import LsWindow
from ftpc.tui.dialog import show_help_dialog, show_confirmation_dialog, ProgressDialog


class TuiMode(IntEnum):
    NORMAL = auto()
    UPLOAD = auto()


class Tui:
    def __init__(self, client: Client, *, cwd: PurePath):
        self.client = client
        self.cwd = cwd
        self.lswindow = None
        self.stdscr = None
        self.mode = TuiMode.NORMAL
        self.history: list[PurePath] = []  # Navigation history
        self.status_message: Optional[str] = None # Status message for downloads

    def start(self):
        curses.wrapper(self._main_loop)

    def _handle_resize(self, _signum, _frame):
        """Handle terminal resize event with complete terminal reset"""
        if self.stdscr and self.lswindow:
            try:
                # Force terminal reset and get new dimensions
                curses.update_lines_cols()

                self._tui_init()

                # Reset the window with the current elements
                file_descriptors = self.client.ls(self.cwd)
                self.lswindow.elements = file_descriptors
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

    def refresh_directory_listing(self):
        """Refresh the directory listing with current client and path"""
        file_descriptors = self.client.ls(self.cwd)
        self.lswindow.elements = sorted(file_descriptors, key=lambda u: u.path)

        if self.mode == TuiMode.NORMAL:
            self.lswindow.top_text = self.client.name()
        elif self.mode == TuiMode.UPLOAD:
            self.lswindow.top_text = 'Select a file to upload.'

        # Show status message if exists, otherwise show current path
        if self.status_message:
            self.lswindow.bottom_text = self.status_message
        else:
            self.lswindow.bottom_text = self.cwd.as_posix()

    def navigate_to_directory(self, dir_path: PurePath):
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

    def navigate_back(self):
        """Navigate to the previous directory in history"""
        if self.history:
            self.cwd = self.history.pop()
            self.refresh_directory_listing()

    def navigate_to_parent(self):
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

    def download_file(self, file_desc: FileDescriptor):
        """Download a file to the local current working directory"""
        # Show confirmation dialog
        if not show_confirmation_dialog(self.stdscr, "Download {file_desc.name} to local directory?"):
            self.status_message = "Download cancelled"
            return False

        try:
            # Get the local current working directory
            local_cwd = Path.cwd()

            # Create a local path in the current working directory using the file name
            local_path = local_cwd / file_desc.name

            # Create the remote path by combining the current working directory with the file name
            remote_path = self.cwd / file_desc.path

            with ProgressDialog(self.stdscr, "Downloading", file_desc.name, file_desc.size) as progress:
                try:
                    # Use the progress.update method as the callback
                    self.client.get(remote_path, local_path, progress.update)
                    if progress.is_canceled:
                        self.status_message = f"Download of {file_desc.name} was canceled"
                        return False
                    else:
                        self.status_message = f"Downloaded: {file_desc.name} to {local_cwd}"
                except Exception as e:
                    self.status_message = f"Error downloading {file_desc.name}: {str(e)}"
                    return False

            # Set status message and timeout
            self.status_message = f"Downloaded: {file_desc.name} to {local_cwd}"

            return True
        except Exception as e:
            self.status_message = f"Error downloading {file_desc.name}: {str(e)}"
            return False

    def search_file(self):
        """Search for a file/directory by name prefix"""
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
                if key in ('\x1b', '\n'):
                    break

                # Handle backspace/delete
                elif key in ('KEY_BACKSPACE', '\b', '\x7f'):
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

    def delete_file(self, file_desc):
        """Delete a file from the remote location."""
        # Don't allow deletion of directories
        if file_desc.is_directory:
            self.status_message = "Cannot delete directories"
            return False

        # Show confirmation dialog
        if not show_confirmation_dialog(self.stdscr, f"Delete {file_desc.name}? This cannot be undone."):
            self.status_message = "Deletion cancelled"
            return False

        try:
            # Create the full path
            remote_path = self.cwd / file_desc.path

            # Try to delete the file
            if self.client.unlink(remote_path):
                self.status_message = f"Deleted: {file_desc.name}"

                # Refresh the directory listing to show the change
                self.refresh_directory_listing()
                return True
            else:
                self.status_message = f"Failed to delete {file_desc.name}"
                return False

        except Exception as e:
            self.status_message = f"Error deleting {file_desc.name}: {str(e)}"
            return False

    def enter_upload_mode(self):
        """Enter upload file selection mode to browse local files"""
        # Store current state before switching
        self.remote_client = self.client
        self.remote_cwd = self.cwd

        # Switch to upload mode
        self.mode = TuiMode.UPLOAD
        self.client = self.upload_client

        # Use the local current working directory
        self.cwd = PurePath(Path.cwd().as_posix())

        # Update UI with red bars to indicate upload mode
        self.lswindow.bar_color = self.upload_bar_color
        self.lswindow.top_text = "Select a file to upload"
        self.status_message = "In upload mode - Press U to exit"

        # Reset history for the local client
        self.history = []

        # Refresh the display
        self.refresh_directory_listing()

    def exit_upload_mode(self):
        """Exit upload mode and return to normal mode"""
        # Switch back to normal mode
        self.mode = TuiMode.NORMAL
        self.client = self.remote_client
        self.cwd = self.remote_cwd

        # Reset UI with normal blue bars
        self.lswindow.bar_color = self.normal_bar_color
        self.lswindow.top_text = self.client.name()
        self.status_message = "Exited upload mode"

        # Reset history for the remote client
        self.history = []

        # Refresh the display
        self.refresh_directory_listing()

    def handle_upload_file_selection(self, file_desc: FileDescriptor):
        """Handle a file selection in upload mode"""
        # Get the local file path - convert to Path for local file system
        local_path = Path(self.cwd) / file_desc.path

        # Show a confirmation dialog
        if not show_confirmation_dialog(self.stdscr, "Upload {file_desc.name} to remote directory?"):
            self.status_message = "Upload cancelled"
            return False

        try:
            # Create the remote path
            remote_path = self.remote_cwd / file_desc.name

            with ProgressDialog(self.stdscr, "Uploading", file_desc.name, file_desc.size) as progress:
                try:
                    # Use the progress.update method as the callback
                    self.remote_client.put(local_path, remote_path, progress.update)
                    if progress.is_canceled:
                        self.status_message = f"Upload of {file_desc.name} was canceled"
                        return False
                    else:
                        # Set status message but don't exit upload mode yet
                        # We'll exit after the progress dialog is closed
                        self.status_message = f"Uploaded: {file_desc.name} to {self.cwd}"
                except Exception as e:
                    self.status_message = f"Error uploading {file_desc.name}: {str(e)}"
                    return False

            # Exit upload mode
            self.exit_upload_mode()

            # Set status message
            self.status_message = f"Uploaded: {file_desc.name} to {self.remote_cwd}"

            return True
        except Exception as e:
            self.status_message = f"Error uploading {file_desc.name}: {str(e)}"
            return False

    def _tui_init(self):
        curses.curs_set(0)  # Hide cursor

        # Clear screen
        self.stdscr.clear()
        self.stdscr.refresh()

        # Setup colors
        curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLUE)    # Normal mode bar color
        curses.init_pair(2, curses.COLOR_RED, curses.COLOR_BLACK)     # Icon color
        curses.init_pair(3, curses.COLOR_CYAN, curses.COLOR_BLACK)    # Directory color
        curses.init_pair(4, curses.COLOR_GREEN, curses.COLOR_BLACK)   # File color
        curses.init_pair(5, curses.COLOR_WHITE, curses.COLOR_RED)     # Upload mode bar color

        # Store color pairs for easy mode switching
        self.normal_bar_color = curses.color_pair(1) | curses.A_BOLD
        self.upload_bar_color = curses.color_pair(5) | curses.A_BOLD

        # Create lswindow with more color options
        self.lswindow = LsWindow(
            bar_color=self.normal_bar_color,
            icon_color=curses.color_pair(2) | curses.A_BOLD,
            dir_color=curses.color_pair(3),
            file_color=curses.color_pair(4)
        )

        # Initialize content
        self.refresh_directory_listing()

    def _main_loop(self, stdscr):
        with self.client:
            self.stdscr = stdscr

            self._tui_init()

            # Main input loop
            while True:
                self.status_message = None
                match stdscr.getkey():
                    case 'q':
                        break
                    case 'k' | 'KEY_UP':
                        self.lswindow.select_previous()
                    case 'j' | 'KEY_DOWN':
                        self.lswindow.select_next()
                    case 'G':
                        self.lswindow.select_last()
                    case 'g':
                        self.lswindow.select_first()
                    case 'l' | 'KEY_RIGHT' | '\n':  # Enter key handling
                        if selected := self.lswindow.get_selected():
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
                    case 'h' | 'KEY_LEFT':  # Go back
                        self.navigate_back()
                    case 'r':  # Refresh current directory
                        self.refresh_directory_listing()
                    case '?':  # Show help dialog
                        show_help_dialog(self.stdscr)
                        # Redraw everything after the dialog is closed
                        self.stdscr.clear()
                        self.stdscr.refresh()
                        self.lswindow.draw_window()
                        self.refresh_directory_listing()
                    case '/':
                        self.search_file()
                    case 'u':
                        self.upload_client = LocalClient()
                        if self.mode == TuiMode.NORMAL:
                            self.enter_upload_mode()
                        elif self.mode == TuiMode.UPLOAD:
                            self.exit_upload_mode()
                    case 'p':
                        self.navigate_to_parent()
                    case 'd':
                        if self.mode == TuiMode.NORMAL:  # Only allow deletion in normal mode
                            if selected := self.lswindow.get_selected():
                                self.delete_file(selected)
                                # Redraw everything after the operation
                                self.stdscr.clear()
                                self.stdscr.refresh()
                                self.lswindow.draw_window()
                                self.refresh_directory_listing()
                    case 'KEY_RESIZE':
                        # Additional resize handling if curses catches it directly
                        self._handle_resize(None, None)
