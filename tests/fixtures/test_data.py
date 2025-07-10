"""Test data and fixtures for ftpc tests."""

import tempfile
import os
from pathlib import Path, PurePath
from datetime import datetime
from typing import List

from ftpc.filedescriptor import FileDescriptor, FileType


class TestDataFixtures:
    """Common test data and fixtures for ftpc tests."""
    
    @staticmethod
    def create_sample_file_descriptors() -> List[FileDescriptor]:
        """Create sample FileDescriptor objects for testing."""
        return [
            FileDescriptor(
                path=PurePath("test_file.txt"),
                filetype=FileType.FILE,
                size=1024,
                modified_time=datetime(2023, 1, 15, 10, 30, 0)
            ),
            FileDescriptor(
                path=PurePath("test_directory"),
                filetype=FileType.DIRECTORY,
                size=None,
                modified_time=datetime(2023, 1, 14, 9, 15, 0)
            ),
            FileDescriptor(
                path=PurePath("large_file.bin"),
                filetype=FileType.FILE,
                size=1024 * 1024 * 5,  # 5MB
                modified_time=datetime(2023, 1, 16, 14, 45, 0)
            )
        ]
    
    @staticmethod
    def create_temp_directory_with_files():
        """Create a temporary directory with test files."""
        temp_dir = tempfile.mkdtemp()
        
        # Create test files
        test_files = [
            ("test_file.txt", "This is a test file content."),
            ("empty_file.txt", ""),
            ("binary_file.bin", b"\x00\x01\x02\x03\x04\x05")
        ]
        
        for filename, content in test_files:
            file_path = Path(temp_dir) / filename
            if isinstance(content, str):
                file_path.write_text(content)
            else:
                file_path.write_bytes(content)
        
        # Create a subdirectory
        subdir = Path(temp_dir) / "subdir"
        subdir.mkdir()
        (subdir / "nested_file.txt").write_text("Nested file content")
        
        return temp_dir
    
    @staticmethod
    def create_mock_toml_config():
        """Create a mock TOML configuration for testing."""
        return {
            "local": {
                "type": "local"
            },
            "ftp": {
                "type": "ftp",
                "url": "ftp://example.com",
                "username": "testuser",
                "password": "testpass",
                "tls": False
            },
            "s3": {
                "type": "s3",
                "url": "s3://test-bucket",
                "region_name": "us-east-1"
            }
        }