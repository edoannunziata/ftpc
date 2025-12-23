"""Tests for FtpClient class."""

import unittest
from ftplib import error_perm
from unittest.mock import Mock, patch, MagicMock
from pathlib import Path, PurePath
from datetime import datetime

from ftpc.clients.ftpclient import FtpClient
from ftpc.filedescriptor import FileDescriptor, FileType


class TestFtpClient(unittest.TestCase):
    """Test cases for FtpClient class."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.client = FtpClient(
            url="ftp://example.com",
            username="testuser",
            password="testpass",
            tls=False,
            name="test_ftp"
        )
    
    @patch('ftpc.clients.ftpclient.FTP')
    def test_context_manager_plain_ftp(self, mock_ftp_class):
        """Test FtpClient as context manager with plain FTP."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        client = FtpClient(
            url="ftp://example.com",
            username="testuser", 
            password="testpass",
            tls=False,
            name="test"
        )
        
        with client as c:
            self.assertIsInstance(c, FtpClient)
            mock_ftp_class.assert_called_once()
            mock_ftp.login.assert_called_once_with(user="testuser", passwd="testpass")
        
        mock_ftp.quit.assert_called_once()
    
    @patch('ftpc.clients.ftpclient.FTP_TLS')
    def test_context_manager_tls_ftp(self, mock_ftp_tls_class):
        """Test FtpClient as context manager with TLS."""
        mock_ftp = Mock()
        mock_ftp_tls_class.return_value = mock_ftp
        
        client = FtpClient(
            url="ftp://example.com",
            username="testuser",
            password="testpass", 
            tls=True,
            name="test"
        )
        
        with client as c:
            self.assertIsInstance(c, FtpClient)
            mock_ftp_tls_class.assert_called_once()
            mock_ftp.login.assert_called_once_with(user="testuser", passwd="testpass")
            mock_ftp.prot_p.assert_called_once()
        
        mock_ftp.quit.assert_called_once()
    
    def test_client_name(self):
        """Test client name method."""
        self.assertEqual(self.client.name(), "test_ftp")
    
    @patch('ftpc.clients.ftpclient.FTP')
    def test_ls_operation(self, mock_ftp_class):
        """Test listing directory contents."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        # Mock FTP DIR response (detailed listing)
        def mock_dir(callback):
            lines = [
                "-rw-r--r--    1 user  group        1024 Jan 15 10:30 file1.txt",
                "-rw-r--r--    1 user  group        2048 Jan 16 14:00 file2.txt", 
                "drwxr-xr-x    2 user  group           0 Jan 14 09:15 directory1"
            ]
            for line in lines:
                callback(line)
        
        mock_ftp.dir.side_effect = mock_dir
        
        with self.client as client:
            result = client.ls(PurePath("/test/path"))
        
        self.assertEqual(len(result), 3)
        
        # Check file1.txt
        file1 = next((f for f in result if f.name == "file1.txt"), None)
        self.assertIsNotNone(file1)
        self.assertEqual(file1.filetype, FileType.FILE)
        self.assertEqual(file1.size, 1024)
        
        # Check directory1
        dir1 = next((f for f in result if f.name == "directory1"), None)
        self.assertIsNotNone(dir1)
        self.assertEqual(dir1.filetype, FileType.DIRECTORY)
        self.assertEqual(dir1.size, 0)
    
    @patch('ftpc.clients.ftpclient.FTP')
    def test_ls_fallback_to_nlst(self, mock_ftp_class):
        """Test ls falling back to NLST when DIR fails."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        # Mock DIR to return no results (empty detailed listing)
        def mock_dir(callback):
            pass  # No lines returned
        
        mock_ftp.dir.side_effect = mock_dir
        
        # Mock NLST response
        mock_ftp.nlst.return_value = ["file1.txt", "file2.txt"]
        
        # Mock _is_directory to return False for files
        def mock_is_directory(name):
            return False
        
        with self.client as client:
            client._is_directory = mock_is_directory
            result = client.ls(PurePath("/test/path"))
        
        self.assertEqual(len(result), 2)
        
        # When falling back to NLST, we use _is_directory to determine type
        for item in result:
            self.assertEqual(item.filetype, FileType.FILE)
            self.assertIsNone(item.size)
            self.assertIsNone(item.modified_time)
    
    @patch('ftpc.clients.ftpclient.FTP')
    @patch('builtins.open', new_callable=unittest.mock.mock_open)
    def test_get_operation(self, mock_open, mock_ftp_class):
        """Test downloading a file."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        # Mock progress callback
        progress_callback = Mock()
        
        with self.client as client:
            client.get(
                PurePath("/remote/file.txt"),
                Path("/local/file.txt"),
                progress_callback
            )
        
        # Verify FTP operations
        mock_ftp.retrbinary.assert_called_once()
        
        # Verify file was opened for writing
        mock_open.assert_called_once_with(Path("/local/file.txt"), "wb+")
        
        # The progress callback is called inside the retrbinary callback
        # We can't easily test the exact call without mocking the callback mechanism
    
    @patch('ftpc.clients.ftpclient.FTP')
    @patch('builtins.open', new_callable=unittest.mock.mock_open)
    def test_put_operation(self, mock_open, mock_ftp_class):
        """Test uploading a file."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        # Mock transfercmd to return a mock connection
        mock_conn = Mock()
        mock_ftp.transfercmd.return_value.__enter__ = Mock(return_value=mock_conn)
        mock_ftp.transfercmd.return_value.__exit__ = Mock(return_value=None)
        
        # Mock file read to return empty (simulating end of file)
        mock_file_handle = mock_open.return_value.__enter__.return_value
        mock_file_handle.read.return_value = b""  # Empty read (EOF)
        
        # Mock progress callback
        progress_callback = Mock()
        
        with self.client as client:
            client.put(
                Path("/local/file.txt"),
                PurePath("/remote/file.txt"),
                progress_callback
            )
        
        # Verify FTP operations
        mock_ftp.voidcmd.assert_called_with("TYPE I")
        mock_ftp.transfercmd.assert_called_once_with("STOR /remote/file.txt", None)
        mock_ftp.voidresp.assert_called_once()
        
        # Verify file was opened for reading
        mock_open.assert_called_once_with(Path("/local/file.txt"), "rb+")
    
    @patch('ftpc.clients.ftpclient.FTP')
    def test_unlink_operation(self, mock_ftp_class):
        """Test deleting a file."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        with self.client as client:
            result = client.unlink(PurePath("/remote/file.txt"))
        
        self.assertTrue(result)
        mock_ftp.delete.assert_called_once_with("/remote/file.txt")
    
    @patch('ftpc.clients.ftpclient.FTP')
    def test_unlink_failure(self, mock_ftp_class):
        """Test unlink operation failure."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        # Mock delete to raise an FTP error
        mock_ftp.delete.side_effect = error_perm("550 Delete failed")
        
        with self.client as client:
            result = client.unlink(PurePath("/remote/file.txt"))
        
        self.assertFalse(result)
    
    @patch('ftpc.clients.ftpclient.FTP')
    def test_connection_error_handling(self, mock_ftp_class):
        """Test handling of connection errors."""
        mock_ftp_class.side_effect = Exception("Connection failed")
        
        with self.assertRaises(Exception):
            with self.client:
                pass
    
    @patch('ftpc.clients.ftpclient.FTP')
    def test_login_error_handling(self, mock_ftp_class):
        """Test handling of login errors."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp
        
        # Mock login to raise an exception
        mock_ftp.login.side_effect = Exception("Login failed")
        
        with self.assertRaises(Exception):
            with self.client:
                pass
    
    def test_url_parsing(self):
        """Test URL parsing for different formats."""
        # Test with port
        client_with_port = FtpClient(
            url="ftp://example.com:2121",
            username="user",
            password="pass",
            name="test"
        )
        self.assertEqual(client_with_port.url, "ftp://example.com:2121")
        
        # Test without port
        client_without_port = FtpClient(
            url="ftp://example.com",
            username="user", 
            password="pass",
            name="test"
        )
        self.assertEqual(client_without_port.url, "ftp://example.com")
    
    def test_default_values(self):
        """Test default parameter values."""
        client = FtpClient(
            url="ftp://example.com",
            name="test"
        )
        
        self.assertEqual(client.username, "")
        self.assertEqual(client.password, "")
        self.assertTrue(client.tls)
    
    def test_tls_configuration(self):
        """Test TLS configuration."""
        client_tls = FtpClient(
            url="ftp://example.com",
            username="user",
            password="pass",
            tls=True,
            name="test"
        )

        self.assertTrue(client_tls.tls)

    @patch('ftpc.clients.ftpclient.FTP')
    def test_mkdir_operation(self, mock_ftp_class):
        """Test creating a directory."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp

        with self.client as client:
            result = client.mkdir(PurePath("/remote/new_directory"))

        self.assertTrue(result)
        mock_ftp.mkd.assert_called_once_with("/remote/new_directory")

    @patch('ftpc.clients.ftpclient.FTP')
    def test_mkdir_failure(self, mock_ftp_class):
        """Test mkdir operation failure."""
        mock_ftp = Mock()
        mock_ftp_class.return_value = mock_ftp

        # Mock mkd to raise an FTP error
        mock_ftp.mkd.side_effect = error_perm("550 Directory creation failed")

        with self.client as client:
            result = client.mkdir(PurePath("/remote/new_directory"))

        self.assertFalse(result)


if __name__ == "__main__":
    unittest.main()