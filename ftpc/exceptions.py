"""Centralized exception definitions for FTPC."""

from ftplib import error_perm, error_temp, error_reply


class FtpcError(Exception):
    """Base exception for all FTPC errors."""


# Configuration Exceptions


class ConfigError(FtpcError):
    """Base exception for configuration errors."""


class RemoteNotFoundError(ConfigError):
    """Exception raised when a remote configuration is not found."""


class ValidationError(ConfigError):
    """Exception raised when configuration validation fails."""


# Client/Connection Exceptions


class ClientError(FtpcError):
    """Base exception for client operation errors."""


class ConnectionError(ClientError):
    """Failed to connect to remote server."""


class AuthenticationError(ClientError):
    """Authentication failed."""


class ListingError(ClientError):
    """Directory listing failed."""


class TransferError(ClientError):
    """File transfer (get/put) failed."""


class PermissionDeniedError(ClientError):
    """Permission denied on remote operation."""


class NotFoundError(ClientError):
    """Remote file or directory not found."""


# FTP-Specific Exceptions

FtpPermError = error_perm
FtpTempError = error_temp
FtpReplyError = error_reply


# TUI Exceptions


class TuiError(FtpcError):
    """Base exception for TUI errors."""


class ResizeError(TuiError):
    """Terminal resize operation failed."""
