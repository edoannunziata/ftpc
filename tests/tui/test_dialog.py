"""Tests for dialog system."""

import unittest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime

from ftpc.tui.dialog import (
    init_dialog_box, 
    show_dialog, 
    show_confirmation_dialog, 
    show_help_dialog,
    ProgressDialog
)


class TestDialogSystem(unittest.TestCase):
    """Test cases for dialog system."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.mock_stdscr = Mock()
        self.mock_stdscr.getmaxyx.return_value = (24, 80)  # Standard terminal size
    
    @patch('curses.newwin')
    def test_init_dialog_box_basic(self, mock_newwin):
        """Test basic dialog box initialization."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        # Mock user input
        self.mock_stdscr.getkey.return_value = 'q'
        
        result = init_dialog_box(
            self.mock_stdscr,
            "Test Title",
            ["Line 1", "Line 2"],
            "Press q to continue"
        )
        
        # Verify dialog was created
        mock_newwin.assert_called_once()
        mock_dialog.box.assert_called_once()
        mock_dialog.refresh.assert_called_once()
        
        # Verify title and content were added
        self.assertTrue(mock_dialog.addstr.called)
        
        # Verify return value
        self.assertEqual(result, 'q')
    
    @patch('curses.newwin')
    def test_init_dialog_box_with_input_filter(self, mock_newwin):
        """Test dialog box with input filtering."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        # Mock user input sequence - first invalid, then valid
        self.mock_stdscr.getkey.side_effect = ['x', 'y']
        
        result = init_dialog_box(
            self.mock_stdscr,
            "Confirm",
            ["Are you sure?"],
            "Press y/n",
            lambda key: key.lower() in 'yn'
        )
        
        # Should return 'y' after rejecting 'x'
        self.assertEqual(result, 'y')
        
        # Should have called getkey twice
        self.assertEqual(self.mock_stdscr.getkey.call_count, 2)
    
    @patch('curses.newwin')
    def test_show_dialog(self, mock_newwin):
        """Test show_dialog function."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        self.mock_stdscr.getkey.return_value = 'enter'
        
        show_dialog(
            self.mock_stdscr,
            "Information",
            ["This is info", "Second line"],
            "Press any key"
        )
        
        # Verify dialog was created and shown
        mock_newwin.assert_called_once()
        mock_dialog.box.assert_called_once()
        mock_dialog.refresh.assert_called_once()
    
    @patch('curses.newwin')
    def test_show_confirmation_dialog_yes(self, mock_newwin):
        """Test confirmation dialog with yes response."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        self.mock_stdscr.getkey.return_value = 'y'
        
        result = show_confirmation_dialog(
            self.mock_stdscr,
            "Delete file?",
            "Confirm? (y/n)"
        )
        
        self.assertTrue(result)
    
    @patch('curses.newwin')
    def test_show_confirmation_dialog_no(self, mock_newwin):
        """Test confirmation dialog with no response."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        self.mock_stdscr.getkey.return_value = 'n'
        
        result = show_confirmation_dialog(
            self.mock_stdscr,
            "Delete file?",
            "Confirm? (y/n)"
        )
        
        self.assertFalse(result)
    
    @patch('curses.newwin')
    def test_show_confirmation_dialog_case_insensitive(self, mock_newwin):
        """Test confirmation dialog is case insensitive."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        # Test uppercase Y
        self.mock_stdscr.getkey.return_value = 'Y'
        
        result = show_confirmation_dialog(
            self.mock_stdscr,
            "Delete file?",
            "Confirm? (y/n)"
        )
        
        self.assertTrue(result)
    
    @patch('curses.newwin')
    def test_show_help_dialog(self, mock_newwin):
        """Test help dialog display."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        self.mock_stdscr.getkey.return_value = 'q'
        
        show_help_dialog(self.mock_stdscr)
        
        # Verify dialog was created
        mock_newwin.assert_called_once()
        mock_dialog.box.assert_called_once()
        mock_dialog.refresh.assert_called_once()
        
        # Verify help content was added (multiple addstr calls)
        self.assertTrue(mock_dialog.addstr.called)
        self.assertGreater(mock_dialog.addstr.call_count, 5)  # Should have many help lines
    
    def test_progress_dialog_creation(self):
        """Test ProgressDialog creation."""
        progress = ProgressDialog(
            self.mock_stdscr,
            "Downloading",
            "test_file.txt",
            1024
        )
        
        self.assertEqual(progress.title, "Downloading")
        self.assertEqual(progress.file_name, "test_file.txt")
        self.assertEqual(progress.total_size, 1024)
        self.assertEqual(progress.current, 0)
        self.assertFalse(progress.canceled)
    
    @patch('curses.newwin')
    def test_progress_dialog_context_manager(self, mock_newwin):
        """Test ProgressDialog as context manager."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        progress = ProgressDialog(
            self.mock_stdscr,
            "Uploading",
            "test.txt",
            512
        )
        
        with progress as p:
            self.assertIs(p, progress)
            # Dialog should be created
            mock_newwin.assert_called_once()
            mock_dialog.box.assert_called_once()
        
        # After context exit, dialog should be cleaned up
        self.assertIsNone(progress.dialog)
    
    @patch('curses.newwin')
    def test_progress_dialog_update(self, mock_newwin):
        """Test ProgressDialog update method."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        progress = ProgressDialog(
            self.mock_stdscr,
            "Transfer",
            "file.txt",
            1000
        )
        
        # Mock nodelay to avoid blocking
        self.mock_stdscr.nodelay = Mock()
        self.mock_stdscr.getkey.side_effect = Exception("No key")  # No key pressed
        
        with progress:
            # Update progress
            result = progress.update(500)
            
            self.assertTrue(result)  # Should return True (not canceled)
            self.assertEqual(progress.current, 500)
            
            # Verify dialog was updated
            self.assertTrue(mock_dialog.addstr.called)
            self.assertTrue(mock_dialog.refresh.called)
    
    @patch('curses.newwin')
    def test_progress_dialog_cancel(self, mock_newwin):
        """Test ProgressDialog cancellation."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        progress = ProgressDialog(
            self.mock_stdscr,
            "Transfer",
            "file.txt",
            1000
        )
        
        # Mock nodelay and getkey to simulate 'q' press
        self.mock_stdscr.nodelay = Mock()
        self.mock_stdscr.getkey.return_value = 'q'
        
        with progress:
            # Update progress and simulate cancel
            result = progress.update(300)
            
            self.assertFalse(result)  # Should return False (canceled)
            self.assertTrue(progress.is_canceled)
    
    def test_progress_dialog_format_size(self):
        """Test ProgressDialog size formatting."""
        progress = ProgressDialog(
            self.mock_stdscr,
            "Test",
            "file.txt",
            1024
        )
        
        # Test different size formats
        self.assertEqual(progress._format_size(512), "512 B")
        self.assertEqual(progress._format_size(1024), "1.0 KB")
        self.assertEqual(progress._format_size(1024 * 1024), "1.0 MB")
        self.assertEqual(progress._format_size(1024 * 1024 * 1024), "1.0 GB")
    
    @patch('curses.newwin')
    def test_progress_dialog_percentage_calculation(self, mock_newwin):
        """Test ProgressDialog percentage calculation."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        progress = ProgressDialog(
            self.mock_stdscr,
            "Test",
            "file.txt",
            1000
        )
        
        # Mock nodelay to avoid blocking
        self.mock_stdscr.nodelay = Mock()
        self.mock_stdscr.getkey.side_effect = Exception("No key")
        
        with progress:
            # Test 0%
            progress.update(0)
            # Test 50%
            progress.update(500)
            # Test 100%
            progress.update(1000)
            # Test over 100% (should cap at 100%)
            progress.update(1200)
            
            # Verify dialog was updated multiple times
            self.assertGreater(mock_dialog.addstr.call_count, 4)
    
    @patch('curses.newwin')
    def test_dialog_size_calculation(self, mock_newwin):
        """Test dialog size calculation for different screen sizes."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        # Test with small screen
        self.mock_stdscr.getmaxyx.return_value = (10, 40)
        self.mock_stdscr.getkey.return_value = 'q'
        
        init_dialog_box(
            self.mock_stdscr,
            "Title",
            ["Short line"],
            "Press q"
        )
        
        # Dialog should be created with appropriate size
        args, kwargs = mock_newwin.call_args
        dialog_height, dialog_width, dialog_y, dialog_x = args
        
        # Verify dialog fits within screen
        self.assertLess(dialog_height, 10)
        self.assertLess(dialog_width, 40)
        self.assertGreaterEqual(dialog_y, 0)
        self.assertGreaterEqual(dialog_x, 0)
    
    @patch('curses.newwin')
    def test_dialog_content_truncation(self, mock_newwin):
        """Test dialog content truncation for long text."""
        mock_dialog = Mock()
        mock_newwin.return_value = mock_dialog
        
        # Create dialog with very long content
        long_title = "A" * 100
        long_content = ["B" * 200, "C" * 150]
        
        self.mock_stdscr.getkey.return_value = 'q'
        
        init_dialog_box(
            self.mock_stdscr,
            long_title,
            long_content,
            "Press q"
        )
        
        # Verify dialog was created (content should be truncated internally)
        mock_newwin.assert_called_once()
        mock_dialog.addstr.assert_called()


if __name__ == "__main__":
    unittest.main()