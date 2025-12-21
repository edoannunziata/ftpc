import curses
from types import TracebackType
from typing import List, Callable, Any, Optional
from typing_extensions import Self


def init_dialog_box(
    stdscr: Any,
    title: str,
    content: List[str],
    prompt: str = "Press Any key to continue",
    allowed_input: Callable[[str], bool] = lambda _: True,
) -> str:
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
        key: str = stdscr.getkey()
        if allowed_input(key):
            return key


def show_dialog(
    stdscr: Any, title: str, content: List[str], prompt: str = "Press Any key to close"
) -> None:
    init_dialog_box(stdscr, title, content, prompt, lambda _: True)


def show_confirmation_dialog(
    stdscr: Any, content: str, prompt: str = "Confirm? (y/n)"
) -> bool:
    key = init_dialog_box(
        stdscr, "Confirm?", [content], prompt, lambda u: u.lower() in "yn"
    )
    return key.lower() == "y"


def show_input_dialog(
    stdscr: Any, title: str, prompt: str = "Enter value:"
) -> str | None:
    """
    Show an input dialog that allows the user to type text.

    Args:
        stdscr: The curses standard screen
        title: The title of the dialog
        prompt: The prompt text shown above the input field

    Returns:
        The entered text, or None if the user cancelled (pressed Escape)
    """
    # Get screen dimensions
    height, width = stdscr.getmaxyx()

    # Calculate dialog dimensions and position
    dialog_width = min(60, width - 4)
    dialog_height = 6
    dialog_y = (height - dialog_height) // 2
    dialog_x = (width - dialog_width) // 2

    # Create dialog window
    dialog = curses.newwin(dialog_height, dialog_width, dialog_y, dialog_x)
    dialog.box()

    # Add title
    title = title[: dialog_width - 4]  # Truncate if too long
    title_x = (dialog_width - len(title)) // 2
    dialog.addstr(0, title_x, title)

    # Add prompt
    dialog.addstr(1, 2, prompt)

    # Add input field indicator
    input_y = 2
    input_x = 2
    input_width = dialog_width - 4
    dialog.addstr(input_y, input_x, ">" + " " * (input_width - 1))

    # Add instructions
    dialog.addstr(4, 2, "Enter to confirm, Esc to cancel")

    dialog.refresh()

    # Show cursor for text input
    curses.curs_set(1)

    # Clear input buffer
    curses.flushinp()

    input_text = ""
    while True:
        # Position cursor after the ">" and current text
        try:
            dialog.move(input_y, input_x + 1 + len(input_text))
        except curses.error:
            pass
        dialog.refresh()

        try:
            key = stdscr.getkey()

            # Escape cancels
            if key == "\x1b":
                curses.curs_set(0)
                return None

            # Enter confirms
            if key == "\n":
                curses.curs_set(0)
                return input_text if input_text else None

            # Handle backspace/delete
            if key in ("KEY_BACKSPACE", "\b", "\x7f"):
                if input_text:
                    input_text = input_text[:-1]
                    # Clear and redraw input field
                    dialog.addstr(input_y, input_x, ">" + " " * (input_width - 1))
                    dialog.addstr(input_y, input_x + 1, input_text[: input_width - 2])

            # Add printable characters
            elif len(key) == 1 and ord(key) >= 32:
                if len(input_text) < input_width - 3:  # Leave room for cursor
                    input_text += key
                    dialog.addstr(input_y, input_x + 1, input_text[: input_width - 2])

        except curses.error:
            pass


def show_help_dialog(stdscr: Any) -> None:
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
        "  m          - Create new directory",
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

    def __init__(
        self, stdscr: Any, title: str, file_name: str, total_size: Optional[int]
    ) -> None:
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
        self.total_size = total_size if total_size is not None else 0
        self.current = 0
        self.dialog: Any = None
        self.width = 0
        self.height = 0
        self.progress_width = 0
        self.canceled = False

    def _create_dialog(self) -> None:
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

    def _format_size(self, size_bytes: int) -> str:
        """Format size in bytes to a human-readable string."""
        if size_bytes < 1024:
            return f"{size_bytes} B"
        elif size_bytes < 1024 * 1024:
            return f"{size_bytes / 1024:.1f} KB"
        elif size_bytes < 1024 * 1024 * 1024:
            return f"{size_bytes / (1024 * 1024):.1f} MB"
        else:
            return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"

    def _draw_progress_bar(self, percentage: float) -> None:
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

    def update(self, current_bytes: int) -> bool:
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
        except (curses.error, Exception):
            # No input available (expected in nodelay mode)
            pass
        finally:
            self.stdscr.nodelay(False)

        return True

    @property
    def is_canceled(self) -> bool:
        """Return True if the transfer was canceled by the user."""
        return self.canceled

    def __enter__(self) -> Self:
        """Enter the context manager."""
        # Create the dialog when entering the context
        self._create_dialog()
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        """Exit the context manager."""
        # Close the dialog when exiting the context
        if self.dialog:
            self.dialog = None
        # Redraw the screen
        self.stdscr.touchwin()
        self.stdscr.refresh()
