import curses
from typing import Dict, Optional

from ftpc.config.base import BaseRemoteConfig
from ftpc.displaydescriptor import RemoteDisplayDescriptor
from ftpc.tui.lswindow import LsWindow
from ftpc.tui.dialog import show_dialog, show_input_dialog


class RemoteSelector:
    """Interactive remote selection menu using curses."""

    def __init__(self, remotes: Dict[str, BaseRemoteConfig]):
        self.remotes = remotes
        self.remote_descriptors = [
            RemoteDisplayDescriptor(
                remote_name=name,
                remote_type=config.type,
                config=config
            )
            for name, config in sorted(remotes.items())
        ]
        self.selected_path = "/"
        self.lswindow: Optional[LsWindow] = None
        self.stdscr = None

    def start(self) -> Optional[tuple[str, str]]:
        """Run the selector.

        Returns:
            Tuple of (remote_name, path) if a remote was selected,
            None if the user quit.
        """
        return curses.wrapper(self._main_loop)

    def _tui_init(self):
        curses.curs_set(0)  # Hide cursor

        # Clear screen
        self.stdscr.clear()
        self.stdscr.refresh()

        # Setup colors
        curses.start_color()
        curses.use_default_colors()

        curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLUE)  # Normal bar
        curses.init_pair(2, curses.COLOR_RED, -1)  # Icon color
        curses.init_pair(3, curses.COLOR_CYAN, -1)  # Directory color
        curses.init_pair(4, curses.COLOR_GREEN, -1)  # File color
        curses.init_pair(6, curses.COLOR_WHITE, curses.COLOR_GREEN)  # Selector bar
        curses.init_pair(7, -1, -1)  # Neutral color (default fg/bg)

        self.selector_bar_color = curses.color_pair(6) | curses.A_BOLD

        # Create lswindow
        self.lswindow = LsWindow(
            bar_color=self.selector_bar_color,
            icon_color=curses.color_pair(2) | curses.A_BOLD,
            dir_color=curses.color_pair(3),
            file_color=curses.color_pair(4),
            neutral_color=curses.color_pair(7),
            top_text="Select Remote",
            bottom_text="Press ? for help, i for details, o to set path"
        )

        self.lswindow.elements = self.remote_descriptors

    def _redraw(self):
        """Redraw the screen after dialogs."""
        self.stdscr.clear()
        self.stdscr.refresh()
        self.lswindow.draw_window()

    def _show_help(self):
        """Show help dialog for remote selector."""
        msg = [
            "Navigation:",
            "  j, DOWN    - Move selection down",
            "  k, UP      - Move selection up",
            "  g          - Go to first item",
            "  G          - Go to last item",
            "  /          - Search by prefix",
            "",
            "Actions:",
            "  ENTER, l   - Connect to selected remote",
            "  i          - Show remote details",
            "  o          - Set custom starting path",
            "",
            "Other:",
            "  ?          - Show this help",
            "  q          - Quit",
        ]
        show_dialog(self.stdscr, title="Remote Selector Help", content=msg)
        self._redraw()

    def _show_details(self, remote_desc: RemoteDisplayDescriptor):
        """Show details dialog for a remote."""
        config = remote_desc.config
        lines = [
            f"Name: {remote_desc.remote_name}",
            f"Type: {remote_desc.remote_type}",
        ]

        # Add type-specific details
        if hasattr(config, 'url') and config.url:
            lines.append(f"URL: {config.url}")
        if hasattr(config, 'endpoint_url') and config.endpoint_url:
            lines.append(f"Endpoint: {config.endpoint_url}")
        if hasattr(config, 'bucket_name') and config.bucket_name:
            lines.append(f"Bucket: {config.bucket_name}")
        if hasattr(config, 'filesystem') and config.filesystem:
            lines.append(f"Filesystem: {config.filesystem}")
        if hasattr(config, 'container') and config.container:
            lines.append(f"Container: {config.container}")
        if hasattr(config, 'username') and config.username:
            lines.append(f"Username: {config.username}")
        if hasattr(config, 'port') and config.port:
            lines.append(f"Port: {config.port}")
        if hasattr(config, 'region_name') and config.region_name:
            lines.append(f"Region: {config.region_name}")
        if hasattr(config, 'proxy') and config.proxy:
            lines.append(f"Proxy: {config.proxy.host}:{config.proxy.port}")

        show_dialog(
            self.stdscr,
            title=f"Remote: {remote_desc.remote_name}",
            content=lines
        )
        self._redraw()

    def _set_path(self):
        """Show dialog to set custom starting path."""
        path = show_input_dialog(
            self.stdscr,
            title="Starting Path",
            prompt=f"Current: {self.selected_path}"
        )
        if path:
            self.selected_path = path
            self.lswindow.bottom_text = f"Path: {self.selected_path} | ? help, i details"
        self._redraw()

    def _search(self):
        """Search for a remote by name prefix."""
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

    def _main_loop(self, stdscr) -> Optional[tuple[str, str]]:
        self.stdscr = stdscr
        self._tui_init()

        while True:
            match stdscr.getkey():
                case "q":
                    return None
                case "k" | "KEY_UP":
                    self.lswindow.select_previous()
                case "j" | "KEY_DOWN":
                    self.lswindow.select_next()
                case "G":
                    self.lswindow.select_last()
                case "g":
                    self.lswindow.select_first()
                case "l" | "\n":
                    if (selected := self.lswindow.get_selected()) and isinstance(
                        selected, RemoteDisplayDescriptor
                    ):
                        return (selected.remote_name, self.selected_path)
                case "i":
                    if (selected := self.lswindow.get_selected()) and isinstance(
                        selected, RemoteDisplayDescriptor
                    ):
                        self._show_details(selected)
                case "o":
                    self._set_path()
                case "/":
                    self._search()
                case "?":
                    self._show_help()
                case "KEY_RESIZE":
                    self._handle_resize()

    def _handle_resize(self):
        """Handle terminal resize."""
        if self.stdscr and self.lswindow:
            try:
                curses.update_lines_cols()
                self._tui_init()
            except curses.error:
                # Terminal resize failed - continue with current dimensions
                pass
