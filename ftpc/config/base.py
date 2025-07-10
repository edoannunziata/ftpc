import tomllib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, Any, Type, Optional, IO


class ConfigError(Exception):
    """Base exception for configuration errors."""


class RemoteNotFoundError(ConfigError):
    """Exception raised when a remote configuration is not found."""


class ValidationError(ConfigError):
    """Exception raised when configuration validation fails."""


@dataclass
class BaseRemoteConfig(ABC):
    name: str
    type: str

    @classmethod
    @abstractmethod
    def from_dict(cls, name: str, data: Dict[str, Any]) -> "BaseRemoteConfig":
        """Create a remote configuration from a dictionary.

        Args:
            name: The name of the remote configuration
            data: Dictionary containing configuration data

        Returns:
            Instance of the remote configuration class

        Raises:
            ValidationError: If configuration data is invalid
        """

    @abstractmethod
    def validate(self) -> None:
        """Validate the configuration.

        Raises:
            ValidationError: If configuration is invalid
        """


@dataclass
class Config:
    remotes: Dict[str, BaseRemoteConfig]

    @classmethod
    def from_file(cls, config_file: Optional[IO[bytes]]) -> "Config":
        """Load configuration from a TOML file.

        Args:
            config_file: Open file handle to TOML configuration file

        Returns:
            Config instance with all remote configurations loaded

        Raises:
            ConfigError: If configuration file cannot be loaded or parsed
            ValidationError: If configuration data is invalid
        """
        if config_file is None:
            raise ConfigError("Configuration file not provided")

        try:
            config_data = tomllib.load(config_file)
        except Exception as e:
            raise ConfigError(f"Failed to parse TOML configuration: {e}")

        remotes = {}

        for remote_name, remote_data in config_data.items():
            if not isinstance(remote_data, dict):
                raise ValidationError(
                    f"Remote '{remote_name}' configuration must be a dictionary"
                )

            if "type" not in remote_data:
                raise ValidationError(
                    f"Remote '{remote_name}' missing required 'type' field"
                )

            remote_type = remote_data["type"]
            config_class = cls._get_config_class(remote_type)

            if config_class is None:
                raise ValidationError(
                    f"Unknown remote type '{remote_type}' for remote '{remote_name}'"
                )

            try:
                remote_config = config_class.from_dict(remote_name, remote_data)
                remote_config.validate()
                remotes[remote_name] = remote_config
            except Exception as e:
                raise ValidationError(
                    f"Invalid configuration for remote '{remote_name}': {e}"
                )

        config = cls(remotes=remotes)
        config.validate()
        return config

    @staticmethod
    def _get_config_class(remote_type: str) -> Optional[Type[BaseRemoteConfig]]:
        """Get the configuration class for a given remote type.

        Args:
            remote_type: The type of remote (e.g., 'ftp', 's3', etc.)

        Returns:
            Configuration class for the remote type, or None if unknown
        """
        from .remotes import LocalConfig, FtpConfig, S3Config, AzureConfig, SftpConfig

        type_mapping = {
            "local": LocalConfig,
            "ftp": FtpConfig,
            "s3": S3Config,
            "azure": AzureConfig,
            "sftp": SftpConfig,
        }

        return type_mapping.get(remote_type)

    def get_remote(self, name: str) -> BaseRemoteConfig:
        """Get a remote configuration by name.

        Args:
            name: Name of the remote configuration

        Returns:
            Remote configuration instance

        Raises:
            RemoteNotFoundError: If remote configuration is not found
        """
        if name not in self.remotes:
            available = ", ".join(self.remotes.keys())
            raise RemoteNotFoundError(
                f"Remote '{name}' not found in configuration. "
                f"Available remotes: {available}"
            )

        return self.remotes[name]

    def validate(self) -> None:
        """Validate the entire configuration.

        Raises:
            ValidationError: If configuration is invalid
        """
        if not self.remotes:
            raise ValidationError("Configuration must contain at least one remote")

        for remote_name, remote_config in self.remotes.items():
            try:
                remote_config.validate()
            except ValidationError as e:
                raise ValidationError(f"Remote '{remote_name}': {e}")

    def list_remotes(self) -> Dict[str, str]:
        return {name: config.type for name, config in self.remotes.items()}
