# MediaCraft

MediaCraft is an offline-first Electron desktop application for browsing and managing large local image, video, and PDF collections. It keeps media on the local machine and exposes filesystem, SQLite, and media-processing capabilities only through the main process and a typed preload bridge.

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
- PDF first-page thumbnails and a full-screen brush editor with color, size, opacity, eyedropper, eraser, undo/redo, page navigation, zoom, and pan. Save PDF copies without changing the source.

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
- PDF.js for document rendering, PDF-lib for painted copies, and a dedicated PDF worker with native canvas thumbnails

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

During development, FFmpeg and FFprobe must be available on `PATH` for video metadata, thumbnails, and transforms. Packaged Windows builds bundle both tools. Native `better-sqlite3` must be rebuilt after changing the Electron version or native dependencies.

## Build a Windows app

The Windows package bundles FFmpeg/FFprobe and does not require `npm run dev` on the target machine. On Windows, run:

```powershell
npm run rebuild:native
npm run package:win
```

The installer and portable executable are written to `release/`:

- `MediaCraft-0.1.0-x64.exe` — normal installer with Desktop and Start Menu shortcuts.
- `MediaCraft-0.1.0-portable.exe` — runs without installation.

`npm run package:win:dir` creates an unpacked `release/win-unpacked/MediaCraft.exe` for a quick local smoke test. The packaging command copies `ffmpeg.exe` and `ffprobe.exe` from `PATH`; set `FFMPEG_PATH` and `FFPROBE_PATH` if they are installed elsewhere.

## Paint a PDF

Select a dataset folder or reload the current one. PDF files appear in **All Media**; double-click a PDF card or use **Paint PDF** in the Inspector. Paint with the brush, adjust color/size/opacity, and use the eraser to remove added paint. Edits remain available while switching pages or zooming. **Save PDF copy** opens the native save dialog and preserves the original document's text and vector content.

Use the zoom buttons or **Ctrl/Cmd + mouse wheel** over the page to zoom from 25% to 800%. Wheel zoom keeps the point under the cursor in place; use **Pan** to move around or **Fit page** to reset the view. Click **Pick color**, then click the PDF or an existing painted area to copy its visible color into the brush. The current HEX color is shown beside the color picker. At high zoom, the displayed page grows while the rendering resolution stays bounded to limit memory use.

Paint is embedded as a transparent raster overlay in the saved copy; brush history is available only while the editor is open. Password-protected PDFs are not supported, and editing a digitally signed PDF invalidates its signature. The editor accepts PDFs up to 256 MB, and safe saving requires a filesystem supporting hard links (for example NTFS, APFS, or ext4).

Saving pads the invisible RGB around painted pixels with nearby brush colors to prevent dark fringes in PDF readers that interpolate color and transparency separately. Visible colors, opacity, and erased areas stay unchanged. Restart a running app before saving new paint layers with this correction.

## Architecture Map

```text
src/
|- main/
|  |- db/              # SQLite lifecycle and prepared queries
|  |- ipc/             # Feature-specific main-process controllers
|  |- lib/             # Scanner, scheduler, media, duplicate, and export logic
|  `- workers/         # Catalog, CPU hash, and PDF workers
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

- Focused PDF tests cover catalog migration/scanning, normalized state, painting geometry, transparent-color padding, validation, save authorization/collisions, and worker output. Run `node --test tests/pdfPaint.test.cjs tests/pdfPaintImage.test.cjs tests/mediaStorePdf.test.cjs tests/pdfSave.test.cjs tests/pdfValidation.test.cjs`; after building, run the catalog/worker fixtures with Electron in `ELECTRON_RUN_AS_NODE=1` mode.
- PDF checks passed: 23 focused tests, 3 Electron catalog/worker integration tests, and native Electron UI checks for scanning, thumbnails, brush/eraser, undo/redo, pages, zoom, save-copy, and graceful corrupt-file errors. Packaged startup/runtime-file checks passed; installer interaction and arbitrary user PDFs remain unverified.
- Zoom/eyedropper checks passed: five paint tests plus production Electron checks for 800% display zoom, Ctrl/Cmd-wheel input, scroll anchoring, rapid zoom during rendering, and PDF/paint color sampling on normal and rotated pages without adding strokes.
- Real-world FFmpeg support still depends on the installed binary and the codecs/containers present in the user's files.
