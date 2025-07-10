import curses
from typing import List, Callable, Any


def init_dialog_box(
    stdscr: Any,
    title: str,
    content: List[str],
    prompt: str = "Press Any key to continue",
    allowed_input: Callable[[str], bool] = lambda _: True,
):
    # Get screen dimensions
    height, width = stdscr.getmaxyx()

    # Calculate dialog dimensions and position
    content_width = max(len(title) + 4, max(len(line) for line in content) + 4)
    dialog_width = min(content_width, width - 4)
    dialog_height = min(len(content) + 4, height - 2)
    dialog_y = (height - dialog_height) // 2
    dialog_x = (width - dialog_width) // 2

    # Create dialog window
    dialog = curses.newwin(dialog_height, dialog_width, dialog_y, dialog_x)
    dialog.box()

    # Add title
    title = title[: dialog_width - 4]  # Truncate if too long
    title_x = (dialog_width - len(title)) // 2
    dialog.addstr(0, title_x, title)

    # Add content
    for i, line in enumerate(content):
        if i >= dialog_height - 2:  # Reserve bottom line for prompt
            break
        line = line[: dialog_width - 4]  # Truncate if too long
        dialog.addstr(i + 1, 2, line)

    # Add prompt
    dialog.addstr(dialog_height - 2, 2, prompt)

    dialog.refresh()

    while True:
        if allowed_input(key := stdscr.getkey()):
            return key


def show_dialog(
    stdscr: Any, title: str, content: List[str], prompt: str = "Press Any key to close"
):
    init_dialog_box(stdscr, title, content, prompt, lambda _: True)


def show_confirmation_dialog(
    stdscr: Any, content: str, prompt: str = "Confirm? (y/n)"
) -> bool:
    key = init_dialog_box(
        stdscr, "Confirm?", [content], prompt, lambda u: u.lower() in "yn"
    )
    return key.lower() == "y"


def show_help_dialog(stdscr: Any):
    msg = [
        "Navigation Controls:",
        "  j, DOWN    - Move selection down",
        "  k, UP      - Move selection up",
        "  g          - Go to first item",
        "  Shift-G    - Go to last item",
        "  l, RIGHT   - Enter directory",
        "  h, LEFT    - Go back to previous directory",
        "  p          - Go to parent directory",
        "  /          - Search for files by prefix",
        "",
        "File Operations:",
        "  ENTER      - Enter directory or download file",
        "  d          - Delete selected file",
        "  u          - Enter/exit upload mode",
        "",
        "Other Commands:",
        "  r          - Refresh current directory",
        "  ?          - Show this help",
        "  q          - Quit program",
    ]
    show_dialog(stdscr, title="Key Commands", content=msg)


class ProgressDialog:
    """A dialog box that shows a progress bar for file transfers.

    This class can be used as a context manager:

    with ProgressDialog(stdscr, "Download", "file.txt", 1024) as progress:
        # Transfer operations here
        progress.update(512)  # Update with current bytes
    """

    def __init__(self, stdscr, title, file_name, total_size):
        """
        Initialize a progress dialog.

        Args:
            stdscr: The curses standard screen
            title: The title of the dialog
            file_name: The name of the file being transferred
            total_size: The total size of the file in bytes
        """
        self.stdscr = stdscr
        self.title = title
        self.file_name = file_name
        self.total_size = total_size
        self.current = 0
        self.dialog = None
        self.width = 0
        self.height = 0
        self.progress_width = 0
        self.canceled = False

    def _create_dialog(self):
        """Create the progress dialog window."""
        # Get screen dimensions
        height, width = self.stdscr.getmaxyx()

        # Calculate dialog dimensions and position
        dialog_width = min(60, width - 4)
        dialog_height = 7  # Fixed height for the progress dialog
        dialog_y = (height - dialog_height) // 2
        dialog_x = (width - dialog_width) // 2

        # Store dimensions for later use
        self.width = dialog_width
        self.height = dialog_height
        self.progress_width = dialog_width - 11  # Width of the progress bar

        # Create dialog window
        self.dialog = curses.newwin(dialog_height, dialog_width, dialog_y, dialog_x)
        self.dialog.box()

        # Add title
        title = self.title[: dialog_width - 4]  # Truncate if too long
        title_x = (dialog_width - len(title)) // 2
        self.dialog.addstr(0, title_x, title)

        # Add file name
        file_info = f"File: {self.file_name}"
        if len(file_info) > dialog_width - 4:
            file_info = file_info[: dialog_width - 7] + "..."
        self.dialog.addstr(1, 2, file_info)

        # Add size info
        size_info = f"Size: {self._format_size(self.total_size)}"
        self.dialog.addstr(2, 2, size_info)

        # Initialize progress bar (empty)
        self._draw_progress_bar(0)

        # Add cancel instruction
        self.dialog.addstr(5, 2, "Press 'q' to cancel")

        # Refresh the dialog
        self.dialog.refresh()

    def _format_size(self, size_bytes):
        """Format size in bytes to a human-readable string."""
        if size_bytes < 1024:
            return f"{size_bytes} B"
        elif size_bytes < 1024 * 1024:
            return f"{size_bytes / 1024:.1f} KB"
        elif size_bytes < 1024 * 1024 * 1024:
            return f"{size_bytes / (1024 * 1024):.1f} MB"
        else:
            return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"

    def _draw_progress_bar(self, percentage):
        """Draw the progress bar with the given percentage."""
        # Clear the line
        self.dialog.addstr(3, 2, " " * (self.width - 4))

        # Calculate the number of filled blocks
        filled_width = int(self.progress_width * percentage / 100)

        # Draw progress bar container
        self.dialog.addstr(3, 2, "[" + " " * self.progress_width + "]")

        # Fill in the progress
        for i in range(filled_width):
            self.dialog.addstr(3, 3 + i, "█")

        # Draw percentage
        percentage_str = f" {percentage:.0f}%"
        self.dialog.addstr(3, 4 + self.progress_width, percentage_str)

        # Draw transfer speed and ETA on line 4
        if percentage > 0:
            self.dialog.addstr(4, 2, f"Transferred: {self._format_size(self.current)}")

        # Refresh the dialog
        self.dialog.refresh()

    def update(self, current_bytes):
        """
        Update the progress bar.

        Args:
            current_bytes: The number of bytes transferred so far

        Returns:
            False if the user pressed 'q' to cancel, True otherwise
        """
        self.current = current_bytes

        # Calculate percentage
        percentage = (
            min(100.0, (current_bytes / self.total_size) * 100)
            if self.total_size > 0
            else 0
        )

        # Update the progress bar
        self._draw_progress_bar(percentage)

        # Check for user input (non-blocking)
        self.stdscr.nodelay(True)
        try:
            key = self.stdscr.getkey()
            if key.lower() == "q":
                self.canceled = True
                return False
        except Exception:
            pass
        finally:
            self.stdscr.nodelay(False)

        return True

    @property
    def is_canceled(self):
        """Return True if the transfer was canceled by the user."""
        return self.canceled

    def __enter__(self):
        """Enter the context manager."""
        # Create the dialog when entering the context
        self._create_dialog()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Exit the context manager."""
        # Close the dialog when exiting the context
        if self.dialog:
            self.dialog = None
        # Redraw the screen
        self.stdscr.touchwin()
        self.stdscr.refresh()
        # Return False to propagate exceptions
        return False
