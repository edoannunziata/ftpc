"""Tests for configuration system."""

import unittest
from io import BytesIO

from ftpc.config import Config, ConfigError, RemoteNotFoundError, ValidationError
from ftpc.config.remotes import (
    LocalConfig,
    FtpConfig,
    S3Config,
    AzureConfig,
    SftpConfig,
)


class TestConfigSystem(unittest.TestCase):
    """Test cases for the configuration system."""

    def setUp(self):
        """Set up test fixtures."""
        self.sample_config_data = {
            "local": {"type": "local"},
            "ftp": {
                "type": "ftp",
                "url": "ftp://example.com",
                "username": "testuser",
                "password": "testpass",
                "tls": False,
            },
            "s3": {"type": "s3", "url": "s3://test-bucket", "region_name": "us-east-1"},
            "azure": {
                "type": "azure",
                "url": "mystorageaccount.dfs.core.windows.net",
                "filesystem": "myfilesystem",
            },
            "sftp": {
                "type": "sftp",
                "url": "sftp.example.com",
                "port": 22,
                "username": "user",
                "password": "pass",
            },
        }

    def create_config_file(self, data):
        """Create a temporary TOML configuration file."""
        import tomllib

        # Create TOML content
        toml_content = ""
        for section, values in data.items():
            toml_content += f"[{section}]\n"
            for key, value in values.items():
                if isinstance(value, bool):
                    toml_content += f"{key} = {str(value).lower()}\n"
                elif isinstance(value, int):
                    toml_content += f"{key} = {value}\n"
                else:
                    toml_content += f'{key} = "{value}"\n'
            toml_content += "\n"

        return BytesIO(toml_content.encode())

    def test_config_from_file_success(self):
        """Test successful configuration loading from file."""
        config_file = self.create_config_file(self.sample_config_data)

        config = Config.from_file(config_file)

        self.assertIsInstance(config, Config)
        self.assertEqual(len(config.remotes), 5)

        # Check all remotes are present
        expected_remotes = ["local", "ftp", "s3", "azure", "sftp"]
        for remote_name in expected_remotes:
            self.assertIn(remote_name, config.remotes)

    def test_config_from_file_none(self):
        """Test configuration loading with None file."""
        with self.assertRaises(ConfigError):
            Config.from_file(None)

    def test_config_from_file_invalid_toml(self):
        """Test configuration loading with invalid TOML."""
        invalid_toml = BytesIO(b"invalid toml content [[[")

        with self.assertRaises(ConfigError):
            Config.from_file(invalid_toml)

    def test_config_missing_type(self):
        """Test configuration with missing type field."""
        config_data = {
            "test": {
                "url": "example.com"
                # Missing 'type' field
            },
            "valid": {"type": "local"}  # Add a valid remote so config doesn't fail entirely
        }
        config_file = self.create_config_file(config_data)

        config = Config.from_file(config_file)
        warnings = config.get_warnings()
        
        self.assertEqual(len(warnings), 1)
        self.assertIn("missing required 'type' field", warnings[0])
        self.assertIn("valid", config.remotes)  # Valid remote should be loaded
        self.assertNotIn("test", config.remotes)  # Invalid remote should be skipped

    def test_config_unknown_type(self):
        """Test configuration with unknown type."""
        config_data = {
            "test": {"type": "unknown_type"},
            "valid": {"type": "local"}  # Add a valid remote so config doesn't fail entirely
        }
        config_file = self.create_config_file(config_data)

        config = Config.from_file(config_file)
        warnings = config.get_warnings()
        
        self.assertEqual(len(warnings), 1)
        self.assertIn("Unknown remote type 'unknown_type'", warnings[0])
        self.assertIn("valid", config.remotes)  # Valid remote should be loaded
        self.assertNotIn("test", config.remotes)  # Invalid remote should be skipped

    def test_get_remote_success(self):
        """Test successful remote retrieval."""
        config_file = self.create_config_file(self.sample_config_data)
        config = Config.from_file(config_file)

        ftp_remote = config.get_remote("ftp")
        self.assertIsInstance(ftp_remote, FtpConfig)
        self.assertEqual(ftp_remote.name, "ftp")
        self.assertEqual(ftp_remote.type, "ftp")

    def test_get_remote_not_found(self):
        """Test remote retrieval with non-existent remote."""
        config_file = self.create_config_file(self.sample_config_data)
        config = Config.from_file(config_file)

        with self.assertRaises(RemoteNotFoundError) as context:
            config.get_remote("nonexistent")

        self.assertIn("Remote 'nonexistent' not found", str(context.exception))
        self.assertIn("Available remotes:", str(context.exception))

    def test_list_remotes(self):
        """Test listing all remotes."""
        config_file = self.create_config_file(self.sample_config_data)
        config = Config.from_file(config_file)

        remotes = config.list_remotes()

        expected = {
            "local": "local",
            "ftp": "ftp",
            "s3": "s3",
            "azure": "azure",
            "sftp": "sftp",
        }

        self.assertEqual(remotes, expected)

    def test_empty_config(self):
        """Test configuration with no remotes."""
        config_file = self.create_config_file({})

        with self.assertRaises(ValidationError) as context:
            Config.from_file(config_file)

        self.assertIn("must contain at least one remote", str(context.exception))


class TestRemoteConfigs(unittest.TestCase):
    """Test cases for remote-specific configurations."""

    def test_local_config(self):
        """Test LocalConfig creation and validation."""
        config = LocalConfig.from_dict("test", {"type": "local"})

        self.assertEqual(config.name, "test")
        self.assertEqual(config.type, "local")

        # Validation should pass
        config.validate()

    def test_local_config_wrong_type(self):
        """Test LocalConfig with wrong type."""
        config = LocalConfig(name="test", type="wrong")

        with self.assertRaises(ValidationError):
            config.validate()

    def test_ftp_config_basic(self):
        """Test FtpConfig creation and validation."""
        data = {
            "type": "ftp",
            "url": "ftp://example.com",
            "username": "user",
            "password": "pass",
            "tls": True,
        }

        config = FtpConfig.from_dict("test", data)

        self.assertEqual(config.name, "test")
        self.assertEqual(config.type, "ftp")
        self.assertEqual(config.url, "ftp://example.com")
        self.assertEqual(config.username, "user")
        self.assertEqual(config.password, "pass")
        self.assertTrue(config.tls)

        # Validation should pass
        config.validate()

    def test_ftp_config_defaults(self):
        """Test FtpConfig with default values."""
        data = {"type": "ftp", "url": "ftp://example.com"}

        config = FtpConfig.from_dict("test", data)

        self.assertEqual(config.username, "anonymous")
        self.assertEqual(config.password, "anonymous@")
        self.assertFalse(config.tls)

    def test_ftp_config_missing_url(self):
        """Test FtpConfig with missing URL."""
        data = {"type": "ftp"}

        with self.assertRaises(ValidationError) as context:
            FtpConfig.from_dict("test", data)

        self.assertIn("requires 'url' field", str(context.exception))

    def test_s3_config_with_url(self):
        """Test S3Config with URL."""
        data = {"type": "s3", "url": "s3://test-bucket", "region_name": "us-east-1"}

        config = S3Config.from_dict("test", data)

        self.assertEqual(config.bucket_name, "test-bucket")
        self.assertEqual(config.url, "s3://test-bucket")
        self.assertEqual(config.region_name, "us-east-1")

        # Validation should pass
        config.validate()

    def test_s3_config_with_bucket_name(self):
        """Test S3Config with bucket_name."""
        data = {"type": "s3", "bucket_name": "my-bucket", "region_name": "us-west-2"}

        config = S3Config.from_dict("test", data)

        self.assertEqual(config.bucket_name, "my-bucket")
        self.assertIsNone(config.url)

        # Validation should pass
        config.validate()

    def test_s3_config_no_bucket_info(self):
        """Test S3Config without bucket information."""
        data = {"type": "s3"}

        config = S3Config.from_dict("test", data)

        with self.assertRaises(ValidationError) as context:
            config.validate()

        self.assertIn("requires either 'url' or 'bucket_name'", str(context.exception))

    def test_s3_config_get_bucket_name(self):
        """Test S3Config get_bucket_name method."""
        # Test with bucket_name
        config = S3Config(name="test", type="s3", bucket_name="my-bucket")
        self.assertEqual(config.get_bucket_name(), "my-bucket")

        # Test with URL
        config = S3Config(name="test", type="s3", url="s3://url-bucket")
        self.assertEqual(config.get_bucket_name(), "url-bucket")

        # Test with neither
        config = S3Config(name="test", type="s3")
        with self.assertRaises(ValidationError):
            config.get_bucket_name()

    def test_azure_config_basic(self):
        """Test AzureConfig creation and validation."""
        data = {
            "type": "azure",
            "url": "mystorageaccount.dfs.core.windows.net",
            "filesystem": "myfilesystem",
            "account_key": "key123",
        }

        config = AzureConfig.from_dict("test", data)

        self.assertEqual(config.name, "test")
        self.assertEqual(config.type, "azure")
        self.assertEqual(config.url, "mystorageaccount.dfs.core.windows.net")
        self.assertEqual(config.filesystem, "myfilesystem")
        self.assertEqual(config.account_key, "key123")

        # Validation should pass
        config.validate()

    def test_azure_config_missing_fields(self):
        """Test AzureConfig with missing required fields."""
        # Missing URL
        with self.assertRaises(ValidationError) as context:
            AzureConfig.from_dict("test", {"type": "azure", "filesystem": "fs"})
        self.assertIn("requires 'url' field", str(context.exception))

        # Missing filesystem
        with self.assertRaises(ValidationError) as context:
            AzureConfig.from_dict("test", {"type": "azure", "url": "example.com"})
        self.assertIn("requires 'filesystem' field", str(context.exception))

    def test_sftp_config_basic(self):
        """Test SftpConfig creation and validation."""
        data = {
            "type": "sftp",
            "url": "sftp.example.com",
            "port": 22,
            "username": "user",
            "password": "pass",
        }

        config = SftpConfig.from_dict("test", data)

        self.assertEqual(config.name, "test")
        self.assertEqual(config.type, "sftp")
        self.assertEqual(config.url, "sftp.example.com")
        self.assertEqual(config.port, 22)
        self.assertEqual(config.username, "user")
        self.assertEqual(config.password, "pass")

        # Validation should pass
        config.validate()

    def test_sftp_config_with_key_file(self):
        """Test SftpConfig with key file authentication."""
        data = {
            "type": "sftp",
            "url": "sftp.example.com",
            "username": "user",
            "key_filename": "/path/to/key",
        }

        config = SftpConfig.from_dict("test", data)

        self.assertEqual(config.key_filename, "/path/to/key")
        self.assertIsNone(config.password)

        # Validation should pass
        config.validate()

    def test_sftp_config_missing_url(self):
        """Test SftpConfig with missing URL."""
        data = {"type": "sftp"}

        with self.assertRaises(ValidationError) as context:
            SftpConfig.from_dict("test", data)

        self.assertIn("requires 'url' field", str(context.exception))

    def test_sftp_config_invalid_port(self):
        """Test SftpConfig with invalid port."""
        data = {
            "type": "sftp",
            "url": "sftp.example.com",
            "port": 70000,  # Invalid port
            "password": "pass",
        }

        config = SftpConfig.from_dict("test", data)

        with self.assertRaises(ValidationError) as context:
            config.validate()

        self.assertIn(
            "port must be an integer between 1 and 65535", str(context.exception)
        )

    def test_sftp_config_no_auth(self):
        """Test SftpConfig without authentication."""
        data = {
            "type": "sftp",
            "url": "sftp.example.com",
            "username": "user",
            # No password or key_filename
        }

        config = SftpConfig.from_dict("test", data)

        with self.assertRaises(ValidationError) as context:
            config.validate()

        self.assertIn(
            "requires either 'password' or 'key_filename'", str(context.exception)
        )


if __name__ == "__main__":
    unittest.main()
