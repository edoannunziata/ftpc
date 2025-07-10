"""Tests for FileDescriptor class."""

import unittest
from datetime import datetime
from pathlib import PurePath

from ftpc.filedescriptor import FileDescriptor, FileType


class TestFileDescriptor(unittest.TestCase):
    """Test cases for FileDescriptor class."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.test_file = FileDescriptor(
            path=PurePath("test_file.txt"),
            filetype=FileType.FILE,
            size=1024,
            modified_time=datetime(2023, 1, 15, 10, 30, 0)
        )
        
        self.test_directory = FileDescriptor(
            path=PurePath("test_directory"),
            filetype=FileType.DIRECTORY,
            size=None,
            modified_time=datetime(2023, 1, 14, 9, 15, 0)
        )
    
    def test_file_descriptor_creation(self):
        """Test FileDescriptor creation with all parameters."""
        fd = FileDescriptor(
            path=PurePath("example.txt"),
            filetype=FileType.FILE,
            size=512,
            modified_time=datetime(2023, 1, 1, 12, 0, 0)
        )
        
        self.assertEqual(fd.path, PurePath("example.txt"))
        self.assertEqual(fd.filetype, FileType.FILE)
        self.assertEqual(fd.size, 512)
        self.assertEqual(fd.modified_time, datetime(2023, 1, 1, 12, 0, 0))
    
    def test_file_descriptor_minimal_creation(self):
        """Test FileDescriptor creation with minimal parameters."""
        fd = FileDescriptor(
            path=PurePath("minimal.txt"),
            filetype=FileType.FILE
        )
        
        self.assertEqual(fd.path, PurePath("minimal.txt"))
        self.assertEqual(fd.filetype, FileType.FILE)
        self.assertIsNone(fd.size)
        self.assertIsNone(fd.modified_time)
    
    def test_name_property(self):
        """Test the name property returns the filename."""
        self.assertEqual(self.test_file.name, "test_file.txt")
        self.assertEqual(self.test_directory.name, "test_directory")
        
        # Test with nested path
        nested_fd = FileDescriptor(
            path=PurePath("dir/subdir/file.txt"),
            filetype=FileType.FILE
        )
        self.assertEqual(nested_fd.name, "file.txt")
    
    def test_is_directory_property(self):
        """Test the is_directory property."""
        self.assertFalse(self.test_file.is_directory)
        self.assertTrue(self.test_directory.is_directory)
    
    def test_is_file_property(self):
        """Test the is_file property."""
        self.assertTrue(self.test_file.is_file)
        self.assertFalse(self.test_directory.is_file)
    
    def test_str_representation(self):
        """Test string representation of FileDescriptor."""
        file_str = str(self.test_file)
        dir_str = str(self.test_directory)
        
        self.assertIn("FileType.FILE", file_str)
        self.assertIn("test_file.txt", file_str)
        self.assertIn("FileType.DIRECTORY", dir_str)
        self.assertIn("test_directory", dir_str)
    
    def test_file_type_enum(self):
        """Test FileType enum values."""
        self.assertNotEqual(FileType.FILE, FileType.DIRECTORY)
        self.assertEqual(FileType.FILE, FileType.FILE)
        self.assertEqual(FileType.DIRECTORY, FileType.DIRECTORY)
    
    def test_equality_and_comparison(self):
        """Test FileDescriptor equality (based on dataclass)."""
        fd1 = FileDescriptor(
            path=PurePath("test.txt"),
            filetype=FileType.FILE,
            size=100
        )
        fd2 = FileDescriptor(
            path=PurePath("test.txt"),
            filetype=FileType.FILE,
            size=100
        )
        fd3 = FileDescriptor(
            path=PurePath("test.txt"),
            filetype=FileType.FILE,
            size=200
        )
        
        self.assertEqual(fd1, fd2)
        self.assertNotEqual(fd1, fd3)
    
    def test_path_handling(self):
        """Test various path formats."""
        # Test with absolute path
        abs_fd = FileDescriptor(
            path=PurePath("/absolute/path/file.txt"),
            filetype=FileType.FILE
        )
        self.assertEqual(abs_fd.name, "file.txt")
        
        # Test with relative path
        rel_fd = FileDescriptor(
            path=PurePath("relative/path/file.txt"),
            filetype=FileType.FILE
        )
        self.assertEqual(rel_fd.name, "file.txt")
        
        # Test with just filename
        name_fd = FileDescriptor(
            path=PurePath("filename.txt"),
            filetype=FileType.FILE
        )
        self.assertEqual(name_fd.name, "filename.txt")
    
    def test_size_handling(self):
        """Test size parameter handling."""
        # Test with zero size
        zero_fd = FileDescriptor(
            path=PurePath("zero.txt"),
            filetype=FileType.FILE,
            size=0
        )
        self.assertEqual(zero_fd.size, 0)
        
        # Test with large size
        large_fd = FileDescriptor(
            path=PurePath("large.txt"),
            filetype=FileType.FILE,
            size=1024 * 1024 * 1024  # 1GB
        )
        self.assertEqual(large_fd.size, 1024 * 1024 * 1024)
    
    def test_modified_time_handling(self):
        """Test modified_time parameter handling."""
        # Test with specific datetime
        dt = datetime(2023, 6, 15, 14, 30, 45)
        fd = FileDescriptor(
            path=PurePath("timed.txt"),
            filetype=FileType.FILE,
            modified_time=dt
        )
        self.assertEqual(fd.modified_time, dt)
        
        # Test with None (default)
        fd_none = FileDescriptor(
            path=PurePath("no_time.txt"),
            filetype=FileType.FILE
        )
        self.assertIsNone(fd_none.modified_time)


if __name__ == "__main__":
    unittest.main()