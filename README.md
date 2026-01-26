# Deaddrop

<p align="center">
  <img src="deaddrop/src/assets/icon.svg" alt="Deaddrop Logo" width="128" height="128">
</p>

<p align="center">
  A modern, cross-platform SFTP file transfer client built with Tauri.
</p>

## Overview

Deaddrop is a dual-pane file transfer application that allows you to securely transfer files between your local machine and remote servers via SFTP. Built with Rust and TypeScript, it provides a fast, native experience across Windows, macOS, and Linux.

## Features

### File Transfer
- Upload files and folders to remote servers via SFTP
- Download files from remote servers to your local machine
- Concurrent upload queue with progress tracking
- Recursive folder uploads with directory structure preservation
- Overwrite confirmation for existing files

### File Management
- Dual-pane interface showing local and remote file systems
- Navigate directories on both local and remote systems
- Create new folders locally and remotely
- Delete files and folders (with recursive deletion support)
- Search/filter files in both panels

### Connection Management
- SSH/SFTP connection with password authentication
- Save up to 3 connection profiles for quick access
- Secure password storage using OS keyring (Windows Credential Manager, macOS Keychain, Linux Secret Service)
- Connection pooling for improved performance

### User Interface
- Drag and drop files from your OS file manager
- Drag and drop within the app to queue uploads
- Multi-select files with Ctrl+Click and Shift+Click
- Zoom controls (Ctrl+Scroll or buttons)
- Theme support (Tokyo Night and Blackout themes)
- Real-time upload progress with percentage indicators

## Technology Stack

- **Frontend**: TypeScript, Vite
- **Backend**: Rust, Tauri 2
- **SFTP**: ssh2 crate
- **Secure Storage**: keyring crate (platform-native credential storage)

## Requirements

### Build Requirements
- Node.js 18+
- Rust 1.70+
- Platform-specific Tauri dependencies (see [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites))

### Runtime Requirements
- Windows 10+, macOS 10.15+, or Linux with GTK 3

## Installation

### From Source

1. Clone the repository:
```bash
git clone https://github.com/yourusername/deaddrop.git
cd deaddrop/deaddrop
```

2. Install dependencies:
```bash
npm install
```

3. Run in development mode:
```bash
npm run tauri dev
```

4. Build for production:
```bash
npm run tauri build
```

The built application will be available in `src-tauri/target/release/bundle/`.

## Usage

### Connecting to a Server

1. Click the **Connect** button in the toolbar
2. Enter the server details:
   - Host: The server hostname or IP address
   - Port: SSH port (default: 22)
   - Username: Your SSH username
   - Password: Your SSH password
3. Optionally save the connection as a profile for future use
4. Click **Connect**

### Transferring Files

**Upload via Selection:**
1. Navigate to the desired directory in the local panel (left)
2. Select files using click, Ctrl+Click, or Shift+Click
3. Click **Upload Selected** or drag files to the remote panel

**Upload via Drag and Drop:**
- Drag files from your OS file manager directly into the application
- Drag selected files from the local panel to the remote panel or drop zone

**Download:**
- Click the download button next to any file in the remote panel
- Choose the save location on your local machine

### Managing Profiles

- Enter connection details and a profile name, then click **Save Profile**
- Click a saved profile to auto-fill connection details
- Enable **Remember password** to store passwords securely in your OS keyring
- Maximum of 3 profiles can be saved

## Configuration

Application configuration is stored in:
- **Windows**: `%APPDATA%\deaddrop\`
- **macOS**: `~/Library/Application Support/deaddrop/`
- **Linux**: `~/.config/deaddrop/`

Passwords are stored separately in the OS credential manager for security.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Scroll | Zoom in/out |
| Ctrl+Click | Add to selection |
| Shift+Click | Range select |
| Enter | Navigate to directory / Confirm input |

## Security

- Passwords are stored in platform-native secure storage (not in plain text files)
- SSH connections use industry-standard encryption
- No telemetry or data collection

## License

This project is provided as-is for personal use.

## Contributing

Contributions are welcome. Please open an issue to discuss proposed changes before submitting a pull request.
