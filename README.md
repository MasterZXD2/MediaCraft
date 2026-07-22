# MediaCraft

MediaCraft is an offline-first Electron desktop application for browsing and managing local image and video collections. It currently provides a secure three-pane media browser with recursive folder scanning, SQLite-backed scan caching, and asynchronous thumbnail generation.

All media stays on the local machine. The renderer does not access Node.js or the filesystem directly.

## Current Features

- Modern dark desktop UI built with React, Tailwind CSS, and shadcn-style components.
- Native folder picker and recursive media scanning.
- Supported images: `.jpg`, `.jpeg`, `.png`, and `.webp`.
- Supported videos: `.mp4`, `.mkv`, `.mov`, and `.webm`.
- Cache-first SQLite catalog for instant repeat loads.
- Background filesystem reconciliation that adds new files and removes missing files.
- Image thumbnails generated with Sharp.
- Video frames extracted with FFmpeg through `fluent-ffmpeg`.
- Two-worker asynchronous thumbnail queue to keep scanning responsive.
- Modification-aware thumbnail and failure caching.
- Secure `mediacraft-media://` protocol with per-scan file allowlisting.
- Strict Electron context isolation and a typed preload bridge.

## Planned Workflows

The full product direction is documented in [project_goal.md](project_goal.md).

| Workflow | Status | Scope |
|---|---|---|
| Curate | In progress | Scan, cache, browse, filter, and inspect local media. |
| Clean Up | Planned | Validation, duplicate detection, review groups, and trash management. |
| Transform | Planned | Image resizing and FFmpeg video re-encoding. |
| Organize | Planned | Sequential renaming and structured export. |

Duplicate detection, file transformation, deletion, export, virtualized grids, and complete media metadata extraction are not implemented yet.

## Tech Stack

- Electron 33 with `electron-vite`
- React 18 and TypeScript
- Tailwind CSS and Radix/shadcn-style UI primitives
- Zustand renderer state
- `better-sqlite3` local catalog
- Sharp image processing
- `fluent-ffmpeg` video frame extraction
- Lucide icons

## Requirements

- Node.js 22 or newer is recommended.
- npm.
- FFmpeg and FFprobe available on `PATH` for video thumbnails.

Verify FFmpeg with:

```powershell
ffmpeg -version
ffprobe -version
```

Image scanning and image thumbnails still work if FFmpeg is unavailable, but video thumbnails will remain placeholders.

## Getting Started

Install dependencies:

```powershell
npm install
```

The post-install script rebuilds `better-sqlite3` for Electron's native ABI. If the Electron version or native dependencies change, rebuild it manually:

```powershell
npm run rebuild:native
```

Start the desktop application:

```powershell
npm run dev
```

Select a folder from the top bar. Cached database results appear immediately on later visits while MediaCraft validates the folder in the background.

## Available Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start Electron with renderer hot reload. |
| `npm run typecheck` | Type-check the main, preload, shared, and renderer code. |
| `npm run build` | Type-check and build production bundles. |
| `npm run preview` | Preview the production Electron build. |
| `npm run rebuild:native` | Rebuild `better-sqlite3` for the installed Electron version. |

## Local Data

MediaCraft stores generated application data under Electron's platform-specific `userData` directory:

```text
<userData>/
|- mediacraft.db
|- mediacraft.db-wal
|- mediacraft.db-shm
`- MediaCraft_Thumbnails/
```

Thumbnail filenames are SHA-256 hashes of the source path, size, and modification time. Corrupt videos receive a matching `.failed` marker so FFmpeg is not repeatedly invoked. Changing the source file produces a new cache key and triggers another attempt.

## Architecture

```text
src/
|- main/
|  |- db/
|  |  |- index.ts          # SQLite lifecycle and schema
|  |  `- queries.ts        # Prepared catalog queries and transactions
|  |- ipc/
|  |  `- scanner.ts        # Cache-first recursive scanner and reconciliation
|  |- lib/
|  |  `- thumbnail.ts      # Sharp/FFmpeg thumbnail generation
|  `- index.ts             # Electron window, IPC, protocol, and queues
|- preload/
|  `- index.ts             # Typed contextBridge API
|- renderer/
|  |- index.html
|  `- src/
|     |- components/       # Three-pane layout and UI primitives
|     |- store/            # Zustand media state
|     `- App.tsx
`- shared/
   `- media.ts             # Shared serializable IPC contracts
```

The main process owns filesystem access, SQLite, Sharp, FFmpeg, cache paths, and protocol authorization. The preload exposes a narrow allowlisted API. The renderer receives serializable media records and event updates only.

## Database Schema

The `media_files` table stores:

- Dataset root and unique file path.
- Filename, media type, byte size, and modification timestamp.
- Nullable width, height, duration, and FPS fields reserved for background metadata extraction.

Folder lookups are indexed. Scan writes use prepared statements and transactions, and missing-file cleanup uses a temporary table so large datasets do not exceed SQLite parameter limits.

## Troubleshooting

### Video thumbnail remains a placeholder

Confirm FFmpeg is installed and the file contains a decodable video frame. Incomplete recordings may contain MP4 stream headers but no video packets. MediaCraft records these failures and keeps the placeholder instead of retrying on every scan.

### `better-sqlite3` reports a module ABI error

Rebuild the native dependency for Electron:

```powershell
npm run rebuild:native
```

### A file was added or removed outside MediaCraft

Select the dataset again. Cached records render first, followed by a background synchronization that updates the gallery and database.

## Security

- `contextIsolation` and the Electron sandbox are enabled.
- The renderer never imports `fs`, `path`, SQLite, Sharp, or FFmpeg.
- IPC channels are explicitly exposed through the preload bridge.
- Folder scans must originate from the native folder picker.
- Local media URLs are served through an allowlisted custom protocol.
- Directory symlinks are not followed during scans.

## Project Status

MediaCraft is under active development. The current milestone covers the UI shell and the foundational Curate workflow: local scanning, SQLite caching, synchronization, and thumbnails.
