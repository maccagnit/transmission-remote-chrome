# Transmission Remote — Chrome Extension

A fast, modern Chrome extension to control your **Transmission** torrent daemon directly from the browser. Dark theme, keyboard shortcuts, magnet link interception, and full daemon control — all in a compact popup.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue) ![Chrome](https://img.shields.io/badge/Chrome-Extension-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

### Torrent Management
- View all torrents with real-time status, progress, speeds, ETA, and peer info
- Start, stop, verify, reannounce, and remove torrents
- Bulk selection (click, Ctrl+click, Shift+click) with floating action bar
- Right-click context menu on torrents for quick actions
- Sort by name, date added, size, progress, speed, ratio, or queue position
- Filter by status: All, Downloading, Seeding, Stopped, Queued, Checking, Error
- Search torrents by name

### Magnet Link Interception
- **Automatically intercepts magnet link clicks** on any webpage
- Opens a clean dialog to configure download options before adding
- Also works with `.torrent` file links via right-click context menu
- Paste magnet URIs directly into the popup's quick-add bar

### Turtle Mode (Alt Speed)
- One-click toggle from the popup header
- Configure download/upload limits in KB/s
- Schedule turtle mode for specific days and time ranges

### Speed Limits
- Configure global download and upload speed limits
- Enable/disable independently

### Server Stats
- Live global download/upload speeds in the stats bar
- Active torrent count
- Free disk space on the download directory

## Architecture

This extension communicates directly with Transmission's **JSON-RPC API** over HTTP — no Python, no `transmission_rpc`, no external dependencies. Pure browser-native `fetch()` calls.

```
┌─────────────┐     HTTP/JSON-RPC      ┌──────────────────────┐
│  Extension   │ ◄──────────────────►   │  Transmission Daemon │
│  (popup/bg)  │   X-Transmission-      │  (port 9091)         │
│              │   Session-Id (CSRF)    │                      │
└─────────────┘                         └──────────────────────┘
```

- **Background Service Worker** — Handles all RPC communication, magnet link interception, context menus, and badge updates
- **Content Script** — Intercepts magnet link clicks on web pages
- **Popup** — Main torrent management UI
- **Magnet Dialog** — Popup window for configuring torrent options before adding
- **Options Page** — Server configuration, turtle mode settings, speed limits

## Installation

### From Source (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/maccagnit/transmission-remote-chrome.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in top-right)

4. Click **Load unpacked** and select the cloned folder

5. Click the extension icon → Settings → Configure your Transmission server

### Transmission Daemon Setup

Make sure your Transmission daemon has RPC enabled. In `settings.json`:

```json
{
  "rpc-enabled": true,
  "rpc-port": 9091,
  "rpc-authentication-required": false,
  "rpc-whitelist-enabled": false,
  "rpc-host-whitelist-enabled": false
}
```

If accessing remotely (e.g., Raspberry Pi), you may need to:
- Set `rpc-whitelist-enabled` to `false` or add your IP
- Set `rpc-host-whitelist-enabled` to `false` or add the hostname
- Optionally enable authentication with `rpc-username` and `rpc-password`

## Configuration

Open the extension options page (right-click extension icon → Options) to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Host | `localhost` | Transmission daemon hostname or IP |
| Port | `9091` | RPC port |
| Path | `/transmission/rpc` | RPC endpoint path |
| HTTPS | Off | Use HTTPS for the connection |
| Username | — | RPC authentication username |
| Password | — | RPC authentication password |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+A` | Select all torrents |
| `Escape` | Deselect all / close menus |
| `Delete` | Remove selected torrents |
| `Click` | Select single torrent |
| `Ctrl+Click` | Toggle torrent selection |
| `Shift+Click` | Range select |

## Tech Stack

- **Manifest V3** Chrome Extension
- Pure **JavaScript** (no framework, no build step)
- **Transmission RPC** protocol (direct HTTP/JSON)
- CSS custom properties for theming

## Why Not `transmission_rpc` (Python)?

Browser extensions run in a sandboxed JavaScript environment — they can't execute Python. However, Transmission exposes a clean JSON-RPC API over HTTP, which is exactly what `fetch()` was made for. This extension talks directly to that API, handling CSRF tokens (`X-Transmission-Session-Id`) and authentication natively.

## License

MIT
