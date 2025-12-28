import os
import shutil
from datetime import datetime
from pathlib import Path, PurePath
from types import TracebackType
from typing import Callable, List, Optional
from typing_extensions import Self

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType
from ftpc.exceptions import ListingError


class LocalClient(Client):
    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        pass

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        result = []

        try:
            entries = os.listdir(path)
        except (PermissionError, FileNotFoundError) as e:
            raise ListingError(f"Failed to list directory '{path}': {e}")

        for entry_name in entries:
            entry_path = Path(path) / entry_name
            pure_path = PurePath(entry_name)

            try:
                # Get file stats - use lstat to handle broken symlinks
                stat_info = entry_path.lstat()

                # Determine file type
                if entry_path.is_symlink():
                    # Check if symlink target exists
                    try:
                        entry_path.stat()
                        file_type = FileType.DIRECTORY if entry_path.is_dir() else FileType.FILE
                    except (FileNotFoundError, OSError):
                        # Broken symlink - treat as file
                        file_type = FileType.FILE
                else:
                    file_type = FileType.DIRECTORY if entry_path.is_dir() else FileType.FILE

                # Create FileDescriptor with available metadata
                fd = FileDescriptor(
                    path=pure_path,
                    filetype=file_type,
                    size=stat_info.st_size,
                    modified_time=datetime.fromtimestamp(stat_info.st_mtime),
                )

                result.append(fd)
            except (PermissionError, FileNotFoundError, OSError):
                # Skip files that disappear or are inaccessible
                continue

        return result

    def get(self, remote: PurePath, local: Path, progress_callback: Optional[Callable[[int], bool]] = None) -> None:
        shutil.copy2(remote, local)
        if progress_callback:
            progress_callback(os.stat(remote).st_size)

    def put(self, local: Path, remote: PurePath, progress_callback: Optional[Callable[[int], bool]] = None) -> None:
        shutil.copy2(local, remote)
        if progress_callback:
            progress_callback(os.stat(remote).st_size)

    def unlink(self, remote: PurePath) -> bool:
        try:
            file_path = Path(remote)
            if file_path.is_file():
                file_path.unlink()
                return True
            return False
        except (FileNotFoundError, PermissionError, IsADirectoryError):
            return False

    def mkdir(self, remote: PurePath) -> bool:
        try:
            dir_path = Path(remote)
            dir_path.mkdir()
            return True
        except (FileExistsError, PermissionError, OSError):
            return False

    def name(self) -> str:
        return "Local Storage"
