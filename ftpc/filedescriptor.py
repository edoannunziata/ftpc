from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePath
from enum import Enum, auto
from typing import Optional


class FileType(Enum):
    FILE = auto()
    DIRECTORY = auto()


@dataclass
class FileDescriptor:
    path: PurePath
    filetype: FileType
    size: Optional[int] = None
    modified_time: Optional[datetime] = None

    @property
    def name(self) -> str:
        return self.path.name
    
    @property
    def is_directory(self) -> bool:
        return self.filetype == FileType.DIRECTORY
    
    @property
    def is_file(self) -> bool:
        return self.filetype == FileType.FILE
    
    def __str__(self) -> str:
        return f"{str(self.filetype)} {self.path.as_posix()}"
