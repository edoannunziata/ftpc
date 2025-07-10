"""Tests for LocalClient class."""

import unittest
import tempfile
import shutil
import os
from pathlib import Path, PurePath
from datetime import datetime

from ftpc.clients.localclient import LocalClient
from ftpc.filedescriptor import FileDescriptor, FileType
from tests.fixtures.test_data import TestDataFixtures


class TestLocalClient(unittest.TestCase):
    """Test cases for LocalClient class."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = TestDataFixtures.create_temp_directory_with_files()
        self.client = LocalClient()
    
    def tearDown(self):
        """Clean up test fixtures."""
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)
    
    def test_client_context_manager(self):
        """Test LocalClient as context manager."""
        with LocalClient() as client:
            self.assertIsInstance(client, LocalClient)
            self.assertEqual(client.name(), "Local Storage")
    
    def test_client_name(self):
        """Test client name method."""
        self.assertEqual(self.client.name(), "Local Storage")
    
    def test_ls_existing_directory(self):
        """Test listing contents of existing directory."""
        result = self.client.ls(PurePath(self.temp_dir))
        
        # Should return FileDescriptor objects
        self.assertIsInstance(result, list)
        self.assertTrue(len(result) > 0)
        
        # Check that all results are FileDescriptor objects
        for item in result:
            self.assertIsInstance(item, FileDescriptor)
            self.assertIsInstance(item.path, PurePath)
            self.assertIn(item.filetype, [FileType.FILE, FileType.DIRECTORY])
        
        # Check for expected files
        names = [item.name for item in result]
        self.assertIn("test_file.txt", names)
        self.assertIn("empty_file.txt", names)
        self.assertIn("binary_file.bin", names)
        self.assertIn("subdir", names)
    
    def test_ls_file_properties(self):
        """Test that ls returns correct file properties."""
        result = self.client.ls(PurePath(self.temp_dir))
        
        # Find the test file
        test_file = next((f for f in result if f.name == "test_file.txt"), None)
        self.assertIsNotNone(test_file)
        
        # Check properties
        self.assertEqual(test_file.filetype, FileType.FILE)
        self.assertIsInstance(test_file.size, int)
        self.assertGreater(test_file.size, 0)
        self.assertIsInstance(test_file.modified_time, datetime)
        
        # Find the subdirectory
        subdir = next((f for f in result if f.name == "subdir"), None)
        self.assertIsNotNone(subdir)
        self.assertEqual(subdir.filetype, FileType.DIRECTORY)
    
    def test_ls_nonexistent_directory(self):
        """Test listing contents of non-existent directory."""
        result = self.client.ls(PurePath("/nonexistent/directory"))
        self.assertEqual(result, [])
    
    def test_ls_permission_denied(self):
        """Test listing directory with permission denied."""
        # This test might not work on all systems, but should not crash
        result = self.client.ls(PurePath("/root"))
        self.assertIsInstance(result, list)  # Should return empty list, not crash
    
    def test_get_file_operation(self):
        """Test downloading/copying a file."""
        # Create source file
        source_file = Path(self.temp_dir) / "source.txt"
        source_content = "Test content for get operation"
        source_file.write_text(source_content)
        
        # Create destination path
        dest_dir = tempfile.mkdtemp()
        dest_file = Path(dest_dir) / "destination.txt"
        
        try:
            # Test the get operation
            self.client.get(PurePath(source_file), dest_file)
            
            # Verify file was copied
            self.assertTrue(dest_file.exists())
            self.assertEqual(dest_file.read_text(), source_content)
            
            # Verify file stats are preserved
            source_stat = source_file.stat()
            dest_stat = dest_file.stat()
            self.assertEqual(source_stat.st_size, dest_stat.st_size)
            
        finally:
            shutil.rmtree(dest_dir)
    
    def test_get_with_progress_callback(self):
        """Test get operation with progress callback."""
        # Create source file
        source_file = Path(self.temp_dir) / "progress_test.txt"
        source_content = "A" * 1000  # 1000 bytes
        source_file.write_text(source_content)
        
        # Create destination path
        dest_dir = tempfile.mkdtemp()
        dest_file = Path(dest_dir) / "progress_dest.txt"
        
        # Track progress callbacks
        progress_calls = []
        
        def progress_callback(bytes_transferred):
            progress_calls.append(bytes_transferred)
        
        try:
            self.client.get(PurePath(source_file), dest_file, progress_callback)
            
            # Verify callback was called
            self.assertTrue(len(progress_calls) > 0)
            self.assertEqual(progress_calls[-1], 1000)  # Final call should be file size
            
        finally:
            shutil.rmtree(dest_dir)
    
    def test_put_file_operation(self):
        """Test uploading/copying a file."""
        # Create source file
        source_dir = tempfile.mkdtemp()
        source_file = Path(source_dir) / "upload_source.txt"
        source_content = "Test content for put operation"
        source_file.write_text(source_content)
        
        # Create destination path
        dest_file = Path(self.temp_dir) / "upload_dest.txt"
        
        try:
            # Test the put operation
            self.client.put(source_file, PurePath(dest_file))
            
            # Verify file was copied
            self.assertTrue(dest_file.exists())
            self.assertEqual(dest_file.read_text(), source_content)
            
        finally:
            shutil.rmtree(source_dir)
    
    def test_put_with_progress_callback(self):
        """Test put operation with progress callback."""
        # Create source file
        source_dir = tempfile.mkdtemp()
        source_file = Path(source_dir) / "put_progress.txt"
        source_content = "B" * 2000  # 2000 bytes
        source_file.write_text(source_content)
        
        # Create destination path
        dest_file = Path(self.temp_dir) / "put_progress_dest.txt"
        
        # Track progress callbacks
        progress_calls = []
        
        def progress_callback(bytes_transferred):
            progress_calls.append(bytes_transferred)
        
        try:
            self.client.put(source_file, PurePath(dest_file), progress_callback)
            
            # Verify callback was called
            self.assertTrue(len(progress_calls) > 0)
            self.assertEqual(progress_calls[-1], 2000)  # Final call should be file size
            
        finally:
            shutil.rmtree(source_dir)
    
    def test_unlink_file(self):
        """Test deleting a file."""
        # Create test file
        test_file = Path(self.temp_dir) / "to_delete.txt"
        test_file.write_text("This file will be deleted")
        
        # Verify file exists
        self.assertTrue(test_file.exists())
        
        # Delete file
        result = self.client.unlink(PurePath(test_file))
        
        # Verify deletion
        self.assertTrue(result)
        self.assertFalse(test_file.exists())
    
    def test_unlink_nonexistent_file(self):
        """Test deleting a non-existent file."""
        nonexistent_file = Path(self.temp_dir) / "nonexistent.txt"
        result = self.client.unlink(PurePath(nonexistent_file))
        self.assertFalse(result)
    
    def test_unlink_directory(self):
        """Test attempting to delete a directory (should fail)."""
        # Create test directory
        test_dir = Path(self.temp_dir) / "test_directory"
        test_dir.mkdir()
        
        # Attempt to delete directory
        result = self.client.unlink(PurePath(test_dir))
        
        # Should fail and return False
        self.assertFalse(result)
        self.assertTrue(test_dir.exists())  # Directory should still exist
    
    def test_unlink_permission_denied(self):
        """Test deleting a file with permission denied."""
        # Create test file
        test_file = Path(self.temp_dir) / "readonly.txt"
        test_file.write_text("Read-only file")
        
        # Make file read-only (this might not work on all systems)
        try:
            test_file.chmod(0o444)  # Read-only
            
            # Attempt to delete (might succeed or fail depending on system)
            result = self.client.unlink(PurePath(test_file))
            
            # Result should be boolean
            self.assertIsInstance(result, bool)
            
        except (OSError, PermissionError):
            # If we can't set permissions, skip this test
            pass
        finally:
            # Clean up - restore write permissions
            try:
                test_file.chmod(0o644)
                test_file.unlink()
            except (OSError, PermissionError):
                pass
    
    def test_error_handling(self):
        """Test error handling in various operations."""
        # Test get with non-existent source
        with self.assertRaises(FileNotFoundError):
            self.client.get(PurePath("/nonexistent/file.txt"), Path("/tmp/dest.txt"))
        
        # Test put with non-existent source
        with self.assertRaises(FileNotFoundError):
            self.client.put(Path("/nonexistent/file.txt"), PurePath("/tmp/dest.txt"))
    
    def test_binary_file_operations(self):
        """Test operations with binary files."""
        # Create binary file
        binary_data = bytes(range(256))  # 256 bytes of binary data
        source_file = Path(self.temp_dir) / "binary_source.bin"
        source_file.write_bytes(binary_data)
        
        # Test get operation
        dest_dir = tempfile.mkdtemp()
        dest_file = Path(dest_dir) / "binary_dest.bin"
        
        try:
            self.client.get(PurePath(source_file), dest_file)
            
            # Verify binary data integrity
            self.assertEqual(dest_file.read_bytes(), binary_data)
            
        finally:
            shutil.rmtree(dest_dir)


if __name__ == "__main__":
    unittest.main()