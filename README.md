# MediaCraft

A high-performance, offline-first desktop application for local media management. Built with Electron + React, it gives you fast scanning, duplicate cleanup, re-encoding, and organized file output — entirely on your machine, with no cloud dependency.

## What It Does

MediaCraft is organized around four core workflows:

| Workflow | What it does |
|---|---|
| **Curate** | Recursively scan a folder, extract metadata for every image and video, and browse the collection in a virtualized grid with smart filters. |
| **Clean Up** | Detect perceptually duplicate images and videos, flag invalid files (corrupt, too small, bad ratio), and review groups before bulk deletion. |
| **Transform** | Resize images (long-edge scale or exact crop) and re-encode videos (H.264/H.265, configurable CRF, height, audio) via FFmpeg. |
| **Organize** | Auto-rename files with sequential numbering and export a clean, flat copy to an output folder. |

## Tech Stack

- **Framework:** Electron + Vite (`electron-vite`)
- **Frontend:** React 18, TypeScript, Tailwind CSS, `shadcn/ui`, `lucide-react`
- **State:** Zustand
- **Media processing:** `fluent-ffmpeg` (main process)
- **Storage:** `better-sqlite3` — local SQLite for metadata and tag caching
- **Security:** Strict context isolation — the renderer never touches `fs` directly; all I/O goes through a typed `contextBridge` API

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  Top Bar: Dataset root selector · Progress · Ctrl+K     │
├────────────────┬────────────────────────┬───────────────┤
│  Left Sidebar  │      Main Area         │ Right Sidebar │
│  · Folder tree │  · Virtualized grid    │ · Inspector   │
│  · Smart       │  · Duplicate review    │ · Properties  │
│    Filters     │    groups              │ · Actions     │
└────────────────┴────────────────────────┴───────────────┘
```

## Getting Started

> Setup instructions will be added once the project scaffold is in place.

## Project Status

Active development. See `project_goal.md` for the full architecture spec and folder structure.
