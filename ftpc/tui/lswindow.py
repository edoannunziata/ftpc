import curses
from typing import Any, Optional

from ftpc.displaydescriptor import DisplayDescriptor
from ftpc.filedescriptor import DescriptorType


class LsWindow:
    def __init__(
        self,
        *,
        bar_color: int = 0,
        icon_color: int = 0,
        dir_color: int = 0,
        file_color: int = 0,
        neutral_color: int = 0,
        top_text: str = "",
        bottom_text: str = "",
    ):
        self.height = max(1, curses.LINES - 2)
        self.width = max(10, curses.COLS - 2)

        self._elements: list[DisplayDescriptor] = []

        self.selected: int = 0
        self.first_visible_index = 0
        self.last_visible_index = min(self.height, len(self.elements))

        self._bar_color = bar_color
        self.icon_color = icon_color
        self.dir_color = dir_color
        self.file_color = file_color
        self.neutral_color = neutral_color
        self._top_text = top_text if top_text else " "  # Ensure non-empty string
        self._bottom_text = (
            bottom_text if bottom_text else " "
        )  # Ensure non-empty string

        self.topbar = curses.newwin(1, curses.COLS, 0, 0)
        self.topbar.bkgd(" ", self._bar_color)

        self.eldisplay = curses.newwin(max(1, curses.LINES - 2), curses.COLS, 1, 0)

        self.botbar = curses.newwin(1, curses.COLS, max(0, curses.LINES - 1), 0)
        self.botbar.bkgd(" ", self._bar_color)

        # Update visible range if needed
        self.last_visible_index = min(
            self.first_visible_index + self.height, len(self.elements)
        )

    def handle_resize(self) -> None:
        """Handle terminal resize event"""
        # Update height and width
        self.height = max(1, curses.LINES - 2)
        self.width = max(10, curses.COLS - 2)

        try:
            # Resize existing windows
            self.topbar.resize(1, curses.COLS)
            self.eldisplay.resize(max(1, curses.LINES - 2), curses.COLS)
            self.botbar.resize(1, curses.COLS)

            # Update window positions
            self.topbar.mvwin(0, 0)
            self.eldisplay.mvwin(1, 0)
            self.botbar.mvwin(max(0, curses.LINES - 1), 0)

            # Clear and refresh in correct sequence
            self.topbar.clear()
            self.eldisplay.clear()
            self.botbar.clear()

            # Reset background attributes
            self.topbar.bkgd(" ", self._bar_color)
            self.botbar.bkgd(" ", self._bar_color)

            # Update visible range if needed
            self.last_visible_index = min(
                self.first_visible_index + self.height, len(self.elements)
            )

            # Refresh all windows in proper order (bottom-up)
            self.botbar.noutrefresh()
            self.eldisplay.noutrefresh()
            self.topbar.noutrefresh()
            curses.doupdate()  # Update the physical screen once with all changes

            # Redraw everything
            self.draw_window()
        except curses.error:
            # Handle any curses errors during resize
            pass

    def safe_addstr(self, window: Any, y: int, x: int, text: str, attr: int = 0) -> None:
        """Safe wrapper for addstr that handles boundaries and empty strings"""
        if not text:
            return

        # Get window dimensions
        max_y, max_x = window.getmaxyx()

        # Check if we're trying to write outside the window
        if y < 0 or x < 0 or y >= max_y or x >= max_x:
            return

        # Calculate available space
        available_width = max_x - x - 1  # Leave 1 character of margin

        if available_width <= 0:
            return

        # Ensure we don't write too much
        display_text = text[:available_width]

        try:
            window.addstr(y, x, display_text, attr)
        except curses.error:
            # Fallback in case we hit curses error
            pass

    def draw_window(self) -> None:
        try:
            # Get the current terminal dimensions directly
            max_lines, max_cols = curses.LINES, curses.COLS

            # Update our internal dimensions
            self.height = max(1, max_lines - 2)
            self.width = max(10, max_cols - 2)

            # Clear all windows properly first
            self.topbar.erase()
            self.eldisplay.erase()
            self.botbar.erase()

            # Draw top bar
            self.safe_addstr(self.topbar, 0, 1, self.top_text[: max_cols - 2])

            # No need to continue if no height
            if self.height <= 0:
                return

            # Make sure our selected item is valid
            if self.elements and self.selected >= len(self.elements):
                self.selected = len(self.elements) - 1

            # Update visible range
            self.last_visible_index = min(
                self.first_visible_index + self.height, len(self.elements)
            )

            # Check if we have elements to draw
            if not self.elements:
                # Show a message when no files/directories are found
                self.safe_addstr(
                    self.eldisplay, 0, 1, "No files or directories found", curses.A_BOLD
                )
                self.safe_addstr(self.eldisplay, 1, 1, "(Press 'r' to refresh)")
            else:
                # Draw elements
                visible_elements = self.elements[
                    self.first_visible_index : self.last_visible_index
                ]
                for i, file_desc in enumerate(visible_elements):
                    if i >= self.height:  # Safety check
                        break

                    is_selected = i == self.selected - self.first_visible_index

                    # Select display color based on descriptor type
                    match file_desc.descriptor_type:
                        case DescriptorType.DIRECTORY:
                            display_color = self.dir_color
                        case DescriptorType.FILE:
                            display_color = self.file_color
                        case DescriptorType.NEUTRAL:
                            display_color = self.neutral_color

                    # Format entry with type indicator
                    match file_desc.descriptor_type:
                        case DescriptorType.DIRECTORY:
                            type_char = "D"
                        case DescriptorType.FILE:
                            type_char = "F"
                        case DescriptorType.NEUTRAL:
                            type_char = " "
                    name = file_desc.name

                    # Add file size for regular files
                    size_text = ""
                    if (
                        file_desc.descriptor_type == DescriptorType.FILE
                        and file_desc.size is not None
                    ):
                        # Format size nicely
                        if file_desc.size < 1024:
                            size_text = f"{file_desc.size}B"
                        elif file_desc.size < 1024 * 1024:
                            size_text = f"{file_desc.size / 1024:.1f}K"
                        else:
                            size_text = f"{file_desc.size / (1024 * 1024):.1f}M"

                    # Add modification time if available
                    time_text = ""
                    if file_desc.modified_time:
                        time_text = file_desc.modified_time.strftime("%Y-%m-%d %H:%M")

                    # Get window dimensions for layout calculation
                    _max_y, max_x = self.eldisplay.getmaxyx()

                    # Prepare base display text with file type and name
                    name_text = f"{type_char} {name}"

                    # Calculate available space and positioning
                    metadata_text = ""
                    metadata_pos = (
                        max_x - 2
                    )  # Start position from right edge with padding

                    # Add modification time if available (rightmost)
                    if time_text and max_x > 40:
                        metadata_text = time_text
                        metadata_pos = max_x - len(time_text) - 2

                    # Add size info if available (to the left of the time)
                    if size_text and max_x > 40:
                        if metadata_text:
                            # If we already have time text, put size before it with spacing
                            size_pos = metadata_pos - len(size_text) - 2
                            if (
                                size_pos > len(name_text) + 5
                            ):  # Only if we have enough space
                                metadata_pos = size_pos
                                metadata_text = f"{size_text}  {metadata_text}"
                        else:
                            # If no time text, just show the size
                            metadata_text = size_text
                            metadata_pos = max_x - len(size_text) - 2

                    # Truncate the name if needed to avoid overlap with metadata
                    display_text = name_text
                    available_width = metadata_pos - 5 if metadata_text else max_x - 5
                    if len(name_text) > available_width:
                        display_text = name_text[: available_width - 3] + "..."

                    # Draw selection indicator if this is the selected item
                    if is_selected:
                        self.safe_addstr(self.eldisplay, i, 1, ">", self.icon_color)
                        self.safe_addstr(
                            self.eldisplay,
                            i,
                            3,
                            display_text,
                            display_color | curses.A_BOLD,
                        )
                    else:
                        self.safe_addstr(
                            self.eldisplay, i, 3, display_text, display_color
                        )

                    # Draw metadata right-aligned if we have any
                    if metadata_text:
                        if is_selected:
                            self.safe_addstr(
                                self.eldisplay,
                                i,
                                metadata_pos,
                                metadata_text,
                                display_color | curses.A_BOLD,
                            )
                        else:
                            self.safe_addstr(
                                self.eldisplay,
                                i,
                                metadata_pos,
                                metadata_text,
                                display_color,
                            )

            # Draw bottom bar
            self.safe_addstr(self.botbar, 0, 1, self.bottom_text[: max_cols - 2])

            # Refresh windows with noutrefresh for efficiency
            self.topbar.noutrefresh()
            self.eldisplay.noutrefresh()
            self.botbar.noutrefresh()

            # Update the physical screen once with all changes
            curses.doupdate()

        except curses.error:
            # Safely handle any curses errors
            pass

    @property
    def elements(self) -> list[DisplayDescriptor]:
        return self._elements

    @elements.setter
    def elements(self, elements: list[DisplayDescriptor]) -> None:
        self._elements = elements or []  # Ensure we never have None
        self.selected = 0
        self.first_visible_index = 0
        self.last_visible_index = min(self.height, len(self.elements))
        self.draw_window()

    @property
    def top_text(self) -> str:
        return self._top_text

    @top_text.setter
    def top_text(self, top_text: str) -> None:
        self._top_text = top_text if top_text else " "  # Ensure non-empty string
        self.draw_window()

    @property
    def bottom_text(self) -> str:
        return self._bottom_text

    @bottom_text.setter
    def bottom_text(self, bottom_text: str) -> None:
        self._bottom_text = (
            bottom_text if bottom_text else " "
        )  # Ensure non-empty string
        self.draw_window()

    @property
    def bar_color(self) -> int:
        return self._bar_color

    @bar_color.setter
    def bar_color(self, color: int) -> None:
        self._bar_color = color
        self.topbar.bkgd(" ", color)
        self.botbar.bkgd(" ", color)
        self.draw_window()

    def select_first(self) -> None:
        if not self.elements:
            return
        self.selected = 0
        self.first_visible_index = 0
        self.last_visible_index = min(self.height, len(self.elements))
        self.draw_window()

    def select_last(self) -> None:
        if not self.elements:
            return
        self.selected = len(self.elements) - 1
        self.last_visible_index = len(self.elements)
        self.first_visible_index = max(0, self.last_visible_index - self.height)
        self.draw_window()

    def select_previous(self) -> None:
        if not self.elements or self.selected <= 0:
            return

        self.selected -= 1
        dy = self.selected - self.first_visible_index
        if dy < 2 and self.first_visible_index > 0:
            self.first_visible_index -= 1
            self.last_visible_index -= 1
        self.draw_window()

    def select_next(self) -> None:
        if not self.elements or self.selected >= len(self.elements) - 1:
            return

        self.selected += 1
        dy = self.selected - self.first_visible_index
        if dy > self.height - 3 and self.last_visible_index < len(self.elements):
            self.last_visible_index += 1
            self.first_visible_index += 1
        self.draw_window()

    def select_by_prefix(self, prefix: str) -> bool:
        """
        Select the first item that starts with the given prefix.

        Args:
            prefix: The prefix string to search for

        Returns:
            True if an item was found and selected, False otherwise
        """
        if not self.elements or not prefix:
            return False

        # Search for the first element that matches the prefix
        for i, file_desc in enumerate(self.elements):
            if file_desc.name.lower().startswith(prefix.lower()):
                # Found a match, select it
                self.selected = i

                # Adjust visible range if needed
                if i < self.first_visible_index:
                    # Item is above the visible range
                    self.first_visible_index = i
                    self.last_visible_index = min(
                        self.first_visible_index + self.height, len(self.elements)
                    )
                elif i >= self.last_visible_index:
                    # Item is below the visible range
                    self.last_visible_index = i + 1
                    self.first_visible_index = max(
                        0, self.last_visible_index - self.height
                    )

                self.draw_window()
                return True

        return False

    def get_selected(self) -> DisplayDescriptor | None:
        if not self.elements:
            return None
        return self.elements[self.selected]
