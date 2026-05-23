# Decision Notepad

Decision Notepad is a small local-first macOS scratchpad for reasoning through choices while you work.

It is built for quickly capturing rough thoughts, marking impressions, keeping short references, and exporting clean text when you are ready to move the work somewhere else.

## Features

- Keyboard-first capture for fast reasoning entries
- Four simple markers: Keep, Reject, Question, Verify
- Plain text notes with an optional Reference field for URLs, document numbers, citations, or source notes
- Scratch Pad for loose fragments before they become structured entries
- Clean Markdown export for sharing, handoff, documents, and AI/chat workflows outside the app
- Full-fidelity JSON notepad backup and restore
- Local app data with no account, cloud sync, or embedded AI calls
- Light, dark, and system theme modes
- Optional always-on-top window behavior for Mac workflows

## Privacy

Decision Notepad is local-first. It does not require an account, does not sync to a hosted service, and does not call an AI API.

Markdown export and JSON backups are user-owned local files. Markdown is the human-readable output format; JSON backup is the full-fidelity app-session format.

## Install

Download the latest `.dmg` from GitHub Releases, open it, and drag Decision Notepad to Applications.

The initial packaged build is for Apple Silicon Macs.

## Build From Source

Requirements:

- macOS
- Rust
- Tauri 2 CLI

For a local development run:

```sh
cd src-tauri
cargo tauri dev
```

For a release build:

```sh
./scripts/build-mac.sh
```

Signing and notarization require an Apple Developer ID certificate and local notarytool credentials.

## Data

The app stores the active notepad as local app data. Use Save notepad backup to create a portable JSON backup that preserves entries, markers, references, Scratch Pad text, preferences, and ordering.

Use Markdown export when you want clean readable output for documents, email, Obsidian, GitHub, chat, or another writing tool.

## Status

Decision Notepad is early release software. The core capture, marker, reference, backup, and Markdown export workflow is working, but the project is still intentionally small and evolving.

## License

MIT
