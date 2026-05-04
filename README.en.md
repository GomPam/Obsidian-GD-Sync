# GD Sync (Google Drive Sync for Obsidian)

Sync your Obsidian vault with Google Drive across desktop and mobile devices.

![License](https://img.shields.io/github/license/GomPam/Obsidian-GD-Sync)
![Version](https://img.shields.io/github/v/release/GomPam/Obsidian-GD-Sync?label=version)

[English](README.en.md) | [한국어](README.md)

## ✨ Features

- **Bidirectional Sync**: Keep your notes in sync between your local vault and Google Drive.
- **Auto-Sync**: Automatically upload changes after a configurable delay.
- **Background Sync**: Periodically scan for remote changes in the background.
- **Conflict Resolution**: Choose how to handle conflicts (Keep Local, Keep Remote, Keep Both, or Merge).
- **Mobile Friendly**: Designed to work on both Desktop and Mobile (iOS/Android) versions of Obsidian.
- **Secure**: Uses OAuth 2.0 with PKCE for secure authentication without exposing your credentials.
- **Selective Sync**: Choose a specific folder in Google Drive to sync with your vault.
- **Custom Extension Filter**: Sync default formats (md, images, pdf, etc.) and define your own custom extensions to sync.
- **Empty Folder Sync**: Maintains perfect 1:1 folder structure between local and remote, even for empty directories.
- **History**: View recent synchronization logs.
- **Clean Disconnect**: Safely clear all sync cache, history, and settings when disconnecting the account.

## 🚀 Getting Started

### 1. Installation

#### Via BRAT (Recommended for Beta)
1. Install the [Obsidian42 - BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Open **Settings** -> **BRAT** -> **Add Beta plugin**.
3. Enter the repository URL: `https://github.com/GomPam/Obsidian-GD-Sync`
4. Click **Add Plugin**.

### 2. Configuration

1. Go to **Settings** -> **GD Sync**.
2. Click **Connect** to authenticate with your Google account.
3. Once connected, click **Select Folder** to choose or create a folder in your Google Drive where your vault will be synced.
4. (Optional) Adjust **Auto-Upload Delay** and **Background Sync Interval** in the settings.

## ⚠️ Important Notes & Best Practices

- **Backup Your Vault**: While GD Sync is designed to be reliable, it's always a good idea to have a separate backup of your notes before starting with any sync tool.
- **Avoid Concurrent Edits**: Try not to edit the same file on two devices at the exact same time to minimize conflicts.
- **First Sync**: The first synchronization (Full Sync) might take some time depending on the size of your vault.

## 🛠 Troubleshooting

- **Auth Expired**: If you see an authentication error, click **Reconnect** in the settings.
- **Manual Sync**: You can trigger a full sync manually using the ribbon icon (cloud icon) or the command palette.
- **Check History**: Use the **View Sync History** command to see what was synced recently and look for any errors.

## 🛡️ Privacy & Disclaimer

### Privacy Policy
- **No Data Collection:** This plugin does not collect, store, or transmit any of your personal data, notes, or vault metadata to any third-party servers. 
- **Direct Communication:** All synchronization occurs directly between your local device and Google Drive APIs. 
- **Authentication:** OAuth 2.0 authentication is used purely to obtain an access token to interact with your Google Drive. We do not have access to your Google account credentials.

### Disclaimer
- **Data Safety:** This plugin is provided "as is" without any warranties. While every effort has been made to ensure safe synchronization, the developer is **not responsible for any data loss, corruption, or unintentional modifications**.
- **Always Backup:** Please ensure you have a robust, independent backup system for your Obsidian vault before using this plugin.

## 📄 License

This plugin is licensed under the MIT License. See [LICENSE](LICENSE) for details.
