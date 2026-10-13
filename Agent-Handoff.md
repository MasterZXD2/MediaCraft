# Agent Handoff

## Current state

The current working tree includes the MediaCraft workflows plus PDF catalog support and a dedicated brush editor. The user authorized scanning PDFs in All Media and opening the editor by double-click.

The source tree currently includes:

- Electron main/preload/renderer separation with context isolation and a typed `window.api` bridge.
- A catalog worker with SQLite schema migrations, WAL mode, generation-safe scans, bounded filesystem traversal, paged events, metadata/validation updates, tags, folder-tree queries, and trash operations.
- A priority media scheduler, direct FFmpeg/FFprobe wrapper, Sharp processing, worker-thread perceptual hashing, secure media protocol, and atomic thumbnail cache writes.
- Duplicate detection, scoped duplicate scans, progress events, debug-terminal logs, validation flags, soft trash/restore/empty-trash, tags, transforms, export planning/execution, and a virtualized normalized renderer catalog.
- A full-screen `MediaViewer` with keyboard navigation, paused native video playback, snapshot, visual trim range controls, image crop/rotate/flip, and related transform actions.
- PDF schema migration preserving IDs/tags, recursive PDF discovery, first-page thumbnails, and a lazy PDF Paint Editor with brush/eraser, eyedropper, undo/redo, pages, Ctrl/Cmd-wheel zoom/pan, and save-copy IPC. PDF processing uses a dedicated bounded worker; original text/vector content and source bytes are preserved.

## Evidence and validation

Verified checks from the PDF work session:

- `npm run typecheck` passed.
- `npm run build` passed, including main, preload, and renderer bundles.
- `git diff --check` passed.
- `npm run rebuild:native` passed.
- `npm run package:win:dir` and `npm run package:win` passed. The unpacked app, NSIS installer, and portable executable include the workers, native modules, and bundled FFmpeg/FFprobe.
- `npm run dev` opened the PDF editor, loaded its offline worker/assets through the secure protocol, accepted brush input, and handled unsaved-close confirmation; the isolated instance exited cleanly.
- 23 focused PDF tests and 3 Electron catalog/worker integration tests passed.
- Native Electron production UI checks passed scanning/thumbnails, brush/eraser, undo/redo, pages, zoom, save-copy, corrupt-file handling, and image/video viewer regressions.
- Zoom/eyedropper refinement passed typecheck, build, and all five paint tests. Isolated production Electron checks confirmed actual display zoom through 800%, bounded backing raster (~4 million pixels), center/pointer anchoring within scroll bounds, rapid wheel input during rendering, color sampling after scroll and on rotated/CropBox pages, and unchanged paint history when picking colors. No renderer or console errors occurred; the test instance closed cleanly.
- PDF export now extends brush RGB into fully transparent pixels in the background PDF worker, preventing dark fringes from separate RGB/soft-mask interpolation. A real-file regression at 72/144/288 DPI passed in Poppler and PDF.js: no remaining darkening of originally white pixels, exact paint alpha and visible RGB preserved, original page content/searchable text/geometry preserved, and source file hashes unchanged. A corrected copy was published separately; direct PDF X verification remains outstanding.

Focused PDF fixtures cover migration/scanning, normalized state, paint geometry, corrupt-versus-unsupported validation, save authorization/collisions, worker cancellation, and saved output. Saved three-page fixture verification preserved searchable text, rotation/CropBox, untouched pages, and the source file's SHA256. Packaged startup/runtime-file checks passed; installer interaction and arbitrary user PDFs remain unverified.

## Open work

1. Manually test the native Electron viewer with a real video: confirm metadata duration, both trim handles, frame seeking while dragging, snapshot output, and trim output extension.
2. Confirm the installed FFmpeg build can remux the user's MKV files with subtitles dropped and can extract MP3 audio.
3. Add focused fixture tests for scanner generation cleanup, duplicate grouping, transform argument construction, validator flags, and export collision handling when those workflows stabilize.
4. Review the empty generated `@/components` directory and the timestamped `electron.vite.config.*.mjs` files before committing; keep or remove them only after confirming whether they are needed by the local toolchain.

## Open decisions

- Whether viewer snapshot/trim feedback should remain a queued status or subscribe to final transform completion for the single-file action.
- Packaged Windows builds use the staged FFmpeg/FFprobe binaries; development continues to resolve them from `PATH`.
- Whether to add automated native-media fixtures before the next workflow phase.

## PDF boundaries

- PDFs stay outside image/video duplicate hashing and conversion; All Media, tags, trash, export, and folder navigation include them.
- Editor source limit: 256 MB. Paint is a transparent raster overlay; stroke history lasts only while the editor is open. Save budgets bound painted pages, PNG bytes, and decoded pixels.
- Password-protected PDFs are unsupported. Editing invalidates digital signatures; signed PDFs have not been verified.
- Save uses a native dialog, rejects the original path/hard links, checks source versions, and publishes a complete copy atomically. New-copy publication requires a hard-link-capable filesystem such as NTFS; confirmed replacement retains a narrow stat-to-rename race.
- Node/SQLite remain outside the renderer. PDF.js assets are bundled offline, and originals load through the authorized custom protocol with web security enabled.

## Working rule

Do not discard unrelated local changes. Continue to use the existing IPC contracts, worker boundaries, normalized store, and virtualized gallery patterns documented in [AGENTS.md](AGENTS.md).
