from dataclasses import dataclass
from typing import Dict, Any, Optional

from .base import BaseRemoteConfig, ValidationError


@dataclass
class LocalConfig(BaseRemoteConfig):
    @classmethod
    def from_dict(cls, name: str, data: Dict[str, Any]) -> "LocalConfig":
        return cls(name=name, type="local")

    def validate(self) -> None:
        if self.type != "local":
            raise ValidationError(f"Expected type 'local', got '{self.type}'")


@dataclass
class FtpConfig(BaseRemoteConfig):
    url: str
    username: str = "anonymous"
    password: str = "anonymous@"
    tls: bool = False

    @classmethod
    def from_dict(cls, name: str, data: Dict[str, Any]) -> "FtpConfig":
        if "url" not in data:
            raise ValidationError("FTP configuration requires 'url' field")

        return cls(
            name=name,
            type="ftp",
            url=data["url"],
            username=data.get("username", "anonymous"),
            password=data.get("password", "anonymous@"),
            tls=data.get("tls", False),
        )

    def validate(self) -> None:
        if self.type != "ftp":
            raise ValidationError(f"Expected type 'ftp', got '{self.type}'")

        if not self.url:
            raise ValidationError("FTP URL cannot be empty")

        if not isinstance(self.tls, bool):
            raise ValidationError("TLS setting must be a boolean")


@dataclass
class S3Config(BaseRemoteConfig):
    bucket_name: Optional[str] = None
    url: Optional[str] = None
    region_name: Optional[str] = None
    endpoint_url: Optional[str] = None
    aws_access_key_id: Optional[str] = None
    aws_secret_access_key: Optional[str] = None

    @classmethod
    def from_dict(cls, name: str, data: Dict[str, Any]) -> "S3Config":
        bucket_name = data.get("bucket_name")
        url = data.get("url")

        if url and url.startswith("s3://"):
            bucket_name = url[5:]  # Remove 's3://' prefix

        return cls(
            name=name,
            type="s3",
            bucket_name=bucket_name,
            url=url,
            region_name=data.get("region_name"),
            endpoint_url=data.get("endpoint_url"),
            aws_access_key_id=data.get("aws_access_key_id"),
            aws_secret_access_key=data.get("aws_secret_access_key"),
        )

    def validate(self) -> None:
        if self.type != "s3":
            raise ValidationError(f"Expected type 's3', got '{self.type}'")

        if not self.bucket_name and not self.url:
            raise ValidationError(
                "S3 configuration requires either 'url' or 'bucket_name'"
            )

    def get_bucket_name(self) -> str:
        if self.bucket_name:
            return self.bucket_name
        elif self.url and self.url.startswith("s3://"):
            return self.url[5:]
        else:
            raise ValidationError("No bucket name available")


@dataclass
class AzureConfig(BaseRemoteConfig):
    url: str
    filesystem: str
    connection_string: Optional[str] = None
    account_key: Optional[str] = None

    @classmethod
    def from_dict(cls, name: str, data: Dict[str, Any]) -> "AzureConfig":
        if "url" not in data:
            raise ValidationError("Azure configuration requires 'url' field")
        if "filesystem" not in data:
            raise ValidationError("Azure configuration requires 'filesystem' field")

        return cls(
            name=name,
            type="azure",
            url=data["url"],
            filesystem=data["filesystem"],
            connection_string=data.get("connection_string"),
            account_key=data.get("account_key"),
        )

    def validate(self) -> None:
        if self.type != "azure":
            raise ValidationError(f"Expected type 'azure', got '{self.type}'")

        if not self.url:
            raise ValidationError("Azure URL cannot be empty")

        if not self.filesystem:
            raise ValidationError("Azure filesystem cannot be empty")


@dataclass
class SftpConfig(BaseRemoteConfig):
    url: str
    port: int = 22
    username: Optional[str] = None
    password: Optional[str] = None
    key_filename: Optional[str] = None

    @classmethod
    def from_dict(cls, name: str, data: Dict[str, Any]) -> "SftpConfig":
        if "url" not in data:
            raise ValidationError("SFTP configuration requires 'url' field")

        return cls(
            name=name,
            type="sftp",
            url=data["url"],
            port=data.get("port", 22),
            username=data.get("username"),
            password=data.get("password"),
            key_filename=data.get("key_filename"),
        )

    def validate(self) -> None:
        if self.type != "sftp":
            raise ValidationError(f"Expected type 'sftp', got '{self.type}'")

        if not self.url:
            raise ValidationError("SFTP URL cannot be empty")

        if not isinstance(self.port, int) or self.port < 1 or self.port > 65535:
            raise ValidationError("SFTP port must be an integer between 1 and 65535")

        if not self.password and not self.key_filename:
            raise ValidationError(
                "SFTP configuration requires either 'password' or 'key_filename'"
            )
