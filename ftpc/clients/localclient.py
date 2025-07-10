import os
import shutil
from datetime import datetime
from pathlib import Path, PurePath
from typing import List

from ftpc.clients.client import Client
from ftpc.filedescriptor import FileDescriptor, FileType


class LocalClient(Client):
    def __enter__(self):
        return super().__enter__()

    def __exit__(self, exc_type, exc_val, exc_tb):
        return super().__exit__(exc_type, exc_val, exc_tb)

    def ls(self, path: PurePath) -> List[FileDescriptor]:
        result = []

        try:
            for entry_name in os.listdir(path):
                entry_path = Path(path) / entry_name
                pure_path = PurePath(entry_name)

                # Determine file type
                file_type = FileType.DIRECTORY if entry_path.is_dir() else FileType.FILE

                # Get file stats
                stat_info = entry_path.stat()

                # Create FileDescriptor with available metadata
                fd = FileDescriptor(
                    path=pure_path,
                    filetype=file_type,
                    size=stat_info.st_size,
                    modified_time=datetime.fromtimestamp(stat_info.st_mtime),
                )

                result.append(fd)

        except (PermissionError, FileNotFoundError):
            pass

        return result

    def get(self, remote: PurePath, local: Path, progress_callback=None):
        shutil.copy2(remote, local)
        if progress_callback:
            progress_callback(os.stat(remote).st_size)

    def put(self, local: Path, remote: PurePath, progress_callback=None):
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

    def name(self):
        return "Local Storage"
