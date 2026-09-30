# MediaCraft

MediaCraft is an offline-first Electron desktop application for browsing and managing large local image and video collections. It keeps media on the local machine and exposes filesystem, SQLite, and media-processing capabilities only through the main process and a typed preload bridge.

`project_goal.md` is the product source of truth. This README is the short operational context; [AGENTS.md](AGENTS.md) contains project-specific engineering boundaries and [Agent-Handoff.md](Agent-Handoff.md) contains the current implementation status and open work.

## Current State

The current tree contains the implemented foundation and the major workflows requested so far:

- Three-pane dark UI built with React, Tailwind CSS, shadcn-style Radix primitives, and Lucide icons.
- Recursive folder scanning with a cache-first SQLite catalog in a dedicated catalog worker.
- Bounded filesystem traversal, scan generations, paged catalog events, folder-tree navigation, search, sort, grid/list modes, and normalized Zustand state.
- Sharp/FFmpeg thumbnail generation with priority scheduling, secure `mediacraft-media://` serving, and atomic cache publication.
- Duplicate detection with a hash worker pool, scoped scans, progress/debug events, and duplicate grouping.
- Validation flags, soft trash, restore, and empty-trash support.
- Transform jobs for image resizing/cropping/adjustments and video encode, remux, MP3 extraction, snapshots, mute, and visual trimming.
- Sequential export planning with collision checks and bounded asynchronous copying.
- Global tags with add/remove/rename/delete operations and tag filtering.
- Full-screen keyboard-navigable media viewer with paused video playback, snapshots, visual trimming, and image crop/adjustment controls.

These features are supported by the current source tree and the reported checks in [Agent-Handoff.md](Agent-Handoff.md). The application is still under active development; a passing build does not replace manual testing with representative media.

## Stack

- Electron 43 with `electron-vite`
- React 18 and TypeScript
- Tailwind CSS and Radix/shadcn-style UI primitives
- Zustand
- `better-sqlite3` in the catalog worker
- Sharp for image processing
- Direct `ffmpeg`/`ffprobe` child-process wrapper for video work
- `@tanstack/react-virtual` for the gallery
- Lucide icons

## Start

```powershell
npm install
npm run dev
```

Useful checks:

```powershell
npm run typecheck
npm run build
npm run rebuild:native
```

FFmpeg and FFprobe must be available on `PATH` for video metadata, thumbnails, and transforms. Native `better-sqlite3` must be rebuilt after changing the Electron version or native dependencies.

## Architecture Map

```text
src/
|- main/
|  |- db/              # SQLite lifecycle and prepared queries
|  |- ipc/             # Feature-specific main-process controllers
|  |- lib/             # Scanner, scheduler, media, duplicate, and export logic
|  `- workers/         # Catalog and CPU hash workers
|- preload/            # Typed contextBridge API
|- renderer/src/
|  |- components/      # Layout, curate, cleanup, transform, organize, UI
|  |- hooks/            # Renderer-only hooks
|  `- store/            # Normalized catalog and UI state
`- shared/             # Serializable IPC contracts
```

The renderer must not import Node APIs or touch SQLite. Main-process handlers validate paths and input before forwarding work to workers or media libraries. The custom media protocol serves only files authorized by the active scan.

## Data Locations

Electron stores the catalog and thumbnail cache under the platform-specific `userData` directory:

```text
<userData>/
|- mediacraft.db
|- mediacraft.db-wal
|- mediacraft.db-shm
`- MediaCraft_Thumbnails/
```

## Known Limits

- The repository has no automated media-fixture test suite yet.
- Native Electron visual QA was not completed in the last pass because the browser runtime could not write its kernel assets.
- Real-world FFmpeg support still depends on the installed binary and the codecs/containers present in the user's files.
