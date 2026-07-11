# MediaCraft — Project Goal & Source of Truth

## Primary Objective

MediaCraft is a high-performance, offline-first desktop application for local media management. It replaces a legacy C++/Python hybrid (THT) with a modern Electron + React stack, preserving all core media workflows while dropping all AI/ML features. The target user manages large local collections of images and videos and needs fast scanning, duplicate cleanup, re-encoding, and organized file output — with no cloud dependency and no model inference.

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Desktop framework | Electron (via `electron-vite`) | Chromium renderer + Node.js main process |
| Frontend framework | React 18 + TypeScript | Renderer process only |
| Build tool | Vite (via `electron-vite`) | Fast HMR, separate configs per process |
| Styling | Tailwind CSS + `shadcn/ui` | Component library built on Radix UI primitives |
| Icons | `lucide-react` | Tree-shakeable icon set |
| State management | Zustand | Lightweight, no boilerplate |
| Media processing | `fluent-ffmpeg` | Node.js wrapper for FFmpeg binary |
| Database | `better-sqlite3` | Synchronous SQLite for metadata and tag storage |
| IPC bridge | `contextBridge` (Electron preload) | Strict context isolation enforced |

### Security Guidelines

- **Context Isolation is mandatory.** The renderer process must never import or use Node.js APIs (`fs`, `path`, `child_process`, etc.) directly.
- All filesystem and media operations run **exclusively in the main process**.
- The preload script exposes a typed `window.api` object via `contextBridge.exposeInMainWorld`. Every renderer-to-main call goes through this bridge.
- IPC channels are explicitly allowlisted in the preload — no wildcard forwarding.
- User-supplied paths are validated and normalized in the main process before any `fs` operation.

---

## Core Features

### 1. Curate

Scan a root folder and build a catalog of all media files.

- Recursive directory traversal for images (`.jpg`, `.jpeg`, `.png`, `.webp`) and videos (`.mp4`, `.avi`, `.mov`, `.mkv`, `.webm`, `.flv`, `.wmv`, `.m4v`)
- Extract per-file metadata: path, dimensions, file size, duration (video), fps (video)
- Results cached in SQLite for instant re-load
- Smart Filters in the left sidebar: filter by status (valid/flagged/duplicate), media type (image/video), or presence in duplicate groups
- Virtualized grid view in the main area for large collections (thousands of files)

### 2. Clean Up

Identify and remove duplicate or invalid files.

**Duplicate detection:**
- Images: perceptual hash (dHash, 8×8) with BK-tree + union-find for transitive grouping. Configurable Hamming distance threshold (default 6/64).
- Videos: multi-stage — duration within ±0.5 s, first-frame hash match, last-frame hash match, random-sample frame match (≥70% of 5 samples).
- Results shown as review groups in the main area; user marks which copy to keep.

**Validation:**
- Images: flag files that are too small (< 512 px either dimension), bad aspect ratio (outside 1:3–3:1), or suspiciously small on disk (< 30 KB).
- Videos: decode-sample check via FFmpeg — confirms file opens, has valid frame count, fps, and resolution; samples first/last/evenly-spaced frames for decode errors.

**Trash:**
- Files marked for removal are moved to a session trash list; bulk delete is a separate, confirmed action.

### 3. Transform

Re-encode media files with configurable output settings.

**Images:**
- Resize modes: `long_edge` (scale longest edge, preserve aspect ratio) or `exact` (scale + center-crop to exact WxH).
- Resampling: high-quality Lanczos via Sharp (Node.js native).
- Output mirrors source subfolder structure.

**Videos:**
- Re-encode via FFmpeg: codec (`libx264` CRF 23 default, or `libx265` CRF 28), target height, audio bitrate (default 160 kbps AAC), encoding preset.
- Height-anchor scaling (`scale=-2:H`) preserves aspect ratio with H.264-compatible width alignment.
- Skip-upscale option: skips re-encoding if source height ≤ target.
- Output always `.mp4` with `+faststart` for streaming compatibility.
- Real-time progress fed back to the renderer via IPC events.

### 4. Organize

Rename and move files into a clean output structure.

**Auto-rename:**
- Sequential numbering: `<prefix>_001.ext`, `<prefix>_002.ext`, …
- Deterministic sort order (normalized, case-insensitive paths).
- Dry-run mode shows the planned mapping before applying.
- Collision detection prevents overwriting.

**Export:**
- Copy selected files to an output folder with a flat or mirrored structure.
- `shutil`-equivalent copy preserves file timestamps.
- Exclusion list (stored in SQLite) filters files the user has marked to skip.

---

## Folder Structure

```
MediaCraft/
├── src/
│   ├── main/                        # Electron main process (Node.js)
│   │   ├── index.ts                 # App entry point, BrowserWindow setup
│   │   ├── ipc/                     # IPC channel handlers (one file per feature)
│   │   │   ├── scanner.ts           # Curate: scan + metadata extraction
│   │   │   ├── duplicates.ts        # Clean Up: duplicate detection + validation
│   │   │   ├── transform.ts         # Transform: image resize + video re-encode
│   │   │   └── organize.ts          # Organize: rename + export
│   │   ├── lib/                     # Core business logic (no IPC coupling)
│   │   │   ├── scanner.ts
│   │   │   ├── duplicateDetector.ts
│   │   │   ├── validator.ts
│   │   │   ├── ffmpeg.ts
│   │   │   └── organizer.ts
│   │   └── db/                      # SQLite via better-sqlite3
│   │       ├── index.ts             # DB connection + migrations
│   │       └── queries.ts           # Typed query helpers
│   │
│   ├── preload/
│   │   └── index.ts                 # contextBridge — exposes window.api
│   │
│   └── renderer/                    # React application
│       ├── index.html
│       └── src/
│           ├── main.tsx             # React root
│           ├── App.tsx              # Root layout shell
│           ├── components/
│           │   ├── layout/
│           │   │   ├── TopBar.tsx           # Progress, root selector, Ctrl+K palette
│           │   │   ├── LeftSidebar.tsx      # Folder tree + Smart Filters
│           │   │   ├── MainArea.tsx         # Grid + Duplicate Review
│           │   │   └── RightSidebar.tsx     # Inspector + File Properties + Actions
│           │   ├── curate/
│           │   │   ├── MediaGrid.tsx        # Virtualized thumbnail grid
│           │   │   └── MediaCard.tsx
│           │   ├── cleanup/
│           │   │   ├── DuplicateGroup.tsx
│           │   │   └── ValidationFlag.tsx
│           │   ├── transform/
│           │   │   ├── TransformPanel.tsx
│           │   │   └── ProgressBar.tsx
│           │   ├── organize/
│           │   │   ├── RenamePanel.tsx
│           │   │   └── ExportPanel.tsx
│           │   └── shared/
│           │       ├── CommandPalette.tsx   # Ctrl+K
│           │       └── ConfirmDialog.tsx
│           ├── store/               # Zustand stores
│           │   ├── mediaStore.ts    # Catalog, selection, filters
│           │   ├── uiStore.ts       # Sidebar state, active view, palette open
│           │   └── settingsStore.ts # Root path, preferences
│           ├── hooks/               # Custom React hooks
│           └── lib/                 # Renderer-side helpers (no Node.js)
│
├── resources/                       # App icons, bundled FFmpeg binary path config
├── electron.vite.config.ts
├── package.json
├── tailwind.config.js
├── tsconfig.json
├── tsconfig.node.json
├── project_goal.md                  # ← this file
└── README.md
```

---

## What This Project Is Not

- No AI, machine learning, or model inference of any kind.
- No cloud sync, remote APIs, or telemetry.
- No caption generation, tagging models, or training dataset export tooling.
