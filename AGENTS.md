# MediaCraft Agent Guidance

## Before editing

- Read [project_goal.md](project_goal.md) for product scope and exclusions.
- Read [Agent-Handoff.md](Agent-Handoff.md) for the current state and known gaps.
- Preserve unrelated dirty-worktree changes. Do not reset or checkout files to discard them.

## Architecture boundaries

- Keep Node.js, `fs`, `path`, SQLite, Sharp, FFmpeg, and worker-thread code in the main process or its workers.
- Keep the renderer behind the typed API in [src/preload/index.ts](src/preload/index.ts); do not add direct Node imports to renderer code.
- Keep SQLite ownership in the catalog worker. Main-process IPC controllers should coordinate requests and authorization rather than open the database themselves.
- Add or update serializable contracts in `src/shared/` when an IPC payload changes.
- Preserve the virtualized gallery and normalized Zustand state; avoid copying the complete catalog for per-item updates.
- Reuse the existing Tailwind, shadcn-style primitives, Lucide icons, scheduler, worker, and protocol patterns before adding dependencies or abstractions.

## Feature ownership

- Scanning/catalog/folder tree: `src/main/workers/catalogWorker.ts`, `src/main/ipc/scanner.ts`, `src/main/db/`.
- Media processing: `src/main/lib/ffmpeg.ts`, `src/main/lib/transformer.ts`, `src/main/lib/thumbnail.ts`, and `src/main/lib/scheduler.ts`.
- Duplicate and validation workflows: `src/main/lib/duplicateDetector.ts`, `src/main/lib/validator.ts`, and `src/main/ipc/duplicates.ts`.
- Renderer state and filtering: `src/renderer/src/store/mediaStore.ts`.
- Layout and viewer UX: `src/renderer/src/components/`.

## Validation

Run the smallest relevant check first. For cross-process or shared-type changes, run:

```powershell
npm run typecheck
npm run build
```

Use `npm run rebuild:native` after native dependency or Electron version changes. Do not treat a successful build as proof that arbitrary user media decodes correctly; manual checks with representative images, videos, nested folders, duplicate groups, tags, transforms, and trash/export flows remain necessary.
