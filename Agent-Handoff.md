# Agent Handoff

## Current state

The repository is a dirty working tree containing the MediaCraft implementation through the visual media-viewer trim workflow. The user requested the current project context to be documented; no new application behavior is being implemented in this handoff.

The source tree currently includes:

- Electron main/preload/renderer separation with context isolation and a typed `window.api` bridge.
- A catalog worker with SQLite schema migrations, WAL mode, generation-safe scans, bounded filesystem traversal, paged events, metadata/validation updates, tags, folder-tree queries, and trash operations.
- A priority media scheduler, direct FFmpeg/FFprobe wrapper, Sharp processing, worker-thread perceptual hashing, secure media protocol, and atomic thumbnail cache writes.
- Duplicate detection, scoped duplicate scans, progress events, debug-terminal logs, validation flags, soft trash/restore/empty-trash, tags, transforms, export planning/execution, and a virtualized normalized renderer catalog.
- A full-screen `MediaViewer` with keyboard navigation, paused native video playback, snapshot, visual trim range controls, image crop/rotate/flip, and related transform actions.

## Evidence and validation

Reported checks from the current work session:

- `npm run typecheck` passed.
- `npm run build` passed, including main, preload, and renderer bundles.
- `git diff --check` passed.
- `npm run dev` reached the renderer dev server and built the Electron main/preload/renderer bundles.

The in-app browser visual check was not completed because the browser runtime could not write its kernel assets. No automated media-fixture tests currently exist.

## Open work

1. Manually test the native Electron viewer with a real video: confirm metadata duration, both trim handles, frame seeking while dragging, snapshot output, and trim output extension.
2. Confirm the installed FFmpeg build can remux the user's MKV files with subtitles dropped and can extract MP3 audio.
3. Add focused fixture tests for scanner generation cleanup, duplicate grouping, transform argument construction, validator flags, and export collision handling when those workflows stabilize.
4. Review the empty generated `@/components` directory and the timestamped `electron.vite.config.*.mjs` files before committing; keep or remove them only after confirming whether they are needed by the local toolchain.

## Open decisions

- Whether viewer snapshot/trim feedback should remain a queued status or subscribe to final transform completion for the single-file action.
- Which FFmpeg binary distribution strategy should be used for packaged releases; development currently assumes `ffmpeg` and `ffprobe` are on `PATH`.
- Whether to add automated native-media fixtures before the next workflow phase.

## Working rule

Do not discard unrelated local changes. Continue to use the existing IPC contracts, worker boundaries, normalized store, and virtualized gallery patterns documented in [AGENTS.md](AGENTS.md).
