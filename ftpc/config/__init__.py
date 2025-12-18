"""Configuration management for ftpc."""

from .base import Config, BaseRemoteConfig, ConfigError, RemoteNotFoundError, ValidationError
from .remotes import (
    LocalConfig,
    FtpConfig,
    S3Config,
    AzureConfig,
    SftpConfig,
    ProxyConfig,
)

__all__ = [
    "Config",
    "BaseRemoteConfig",
    "ConfigError",
    "RemoteNotFoundError",
    "ValidationError",
    "LocalConfig",
    "FtpConfig",
    "S3Config",
    "AzureConfig",
    "SftpConfig",
    "ProxyConfig",
]