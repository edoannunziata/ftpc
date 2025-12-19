from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Protocol, runtime_checkable, TYPE_CHECKING

from ftpc.filedescriptor import DescriptorType

if TYPE_CHECKING:
    from ftpc.config.base import BaseRemoteConfig


@runtime_checkable
class DisplayDescriptor(Protocol):
    """Protocol defining what LsWindow needs for display."""

    @property
    def name(self) -> str:
        """Display name for the item."""

    @property
    def descriptor_type(self) -> DescriptorType:
        """Type of item for color selection."""

    @property
    def size(self) -> Optional[int]:
        """Size in bytes (None if not applicable)."""
        ...

    @property
    def modified_time(self) -> Optional[datetime]:
        """Last modification time (None if not applicable)."""
        ...


@dataclass
class RemoteDisplayDescriptor:
    """Display descriptor for remote configurations in the selector."""

    remote_name: str
    remote_type: str
    config: "BaseRemoteConfig"

    @property
    def name(self) -> str:
        return self.remote_name

    @property
    def descriptor_type(self) -> DescriptorType:
        return DescriptorType.NEUTRAL

    @property
    def size(self) -> Optional[int]:
        return None

    @property
    def modified_time(self) -> Optional[datetime]:
        return None
