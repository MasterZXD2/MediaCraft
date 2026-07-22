# MediaCraft Architecture and Performance Optimization Proposals

**Review date:** 2026-07-22  
**Scope:** Current Electron main process, preload bridge, React renderer, filesystem scanner, SQLite catalog, thumbnail pipeline, and planned duplicate/transformation workflows.  
**Purpose:** Architectural analysis only. This document does not implement any changes.

## Executive Summary

MediaCraft has a sound prototype foundation: context isolation is enabled, filesystem and native modules are confined to the main process, SQLite uses WAL mode, scan data is cached, thumbnails are content-versioned, and background work has basic concurrency limits and cancellation tokens. Those decisions are worth preserving.

The current architecture will nevertheless degrade sharply as a dataset grows from hundreds of files to tens or hundreds of thousands. The primary constraints are not Electron or React themselves. They are the current data movement and execution model:

1. **Filesystem metadata is collected serially.** Every media file incurs an awaited `stat` before the next file begins.
2. **Synchronous SQLite work runs on Electron's main thread.** `better-sqlite3` is fast, but a large query, sort, transaction, or deletion pass still blocks window and IPC orchestration while it runs.
3. **The entire catalog crosses IPC and lives in one renderer array.** A warm load and a background sync both serialize every `MediaFile` object.
4. **Thumbnail completion is effectively O(N squared).** Every thumbnail event maps and replaces the complete `mediaFiles` array, and it can also cause the complete grid to reconcile.
5. **The gallery is not virtualized.** Every media record becomes a React component and DOM subtree, even when it is far outside the viewport.
6. **Thumbnail work has a fixed, mixed four-worker policy.** Four Sharp operations and four FFmpeg processes have very different resource costs; canceled scans do not terminate already-running work immediately.
7. **The catalog and thumbnail cache lack lifecycle controls.** The cache can grow indefinitely, final files are not written atomically, schema migrations are absent, and partial scans have no generation boundary.

The best near-term architecture is **not a framework rewrite**. Keep Electron, React, Sharp, FFmpeg, and SQLite, but turn the Electron main process into a thin coordinator. Move catalog/scanning work to a dedicated worker or Electron utility process, page catalog data across IPC, virtualize the gallery, batch renderer updates, and introduce one resource-aware job scheduler.

Rust, C++, WebGL, and Tauri can be valuable later, but none addresses the most immediate O(N), O(N squared), and main-thread blocking behavior as cheaply as the changes above.

### Current Critical Path

```text
Folder picker
    |
    v
Electron main process
    |- serial readdir/stat walk
    |- synchronous SQLite transactions and full sorted SELECT
    |- full MediaFile[] structured clone over IPC
    `- four mixed thumbnail workers
          |- Sharp/libvips
          `- one FFmpeg process per video attempt
                         |
                         v
                 one IPC event per item
                         |
                         v
Zustand: map the full array for each thumbnail
                         |
                         v
React: render every card in a non-virtualized grid
```

### Performance Targets

The repository does not yet contain reproducible benchmark results, so numbers in this report are engineering targets or typical ranges, not guarantees.

| Metric | Recommended target |
|---|---:|
| Warm catalog time to first visible page | under 200 ms for 100,000 records |
| Main-process event-loop delay during background work | p95 under 25 ms |
| Initial renderer catalog payload | under 1-2 MB |
| Mounted gallery cards | approximately 50-200, independent of catalog size |
| Progress IPC frequency | at most 10 updates/second |
| Thumbnail state commits | at most one commit per animation frame or 50-200 results |
| Scanner throughput improvement over current serial walk | 3-10x on SSD is a reasonable benchmark target |
| Cache disk budget | configurable, with deterministic LRU/orphan cleanup |
| Crash consistency | previous complete catalog remains visible after interrupted scan |

## Measurement and Performance Governance

### Proposal 1: Establish Reproducible Performance Baselines

**The Concept:** Create fixed benchmark datasets at 10,000, 100,000, and, where practical, 1,000,000 records. Test cold and warm scans on SSD, HDD, network shares, and removable media. Record time to first grid, full scan duration, files/second, thumbnails/second by type, IPC bytes, renderer DOM count, process memory, and event-loop delay. Use Node `perf_hooks`, Electron process metrics, Chromium Performance traces, and SQLite query plans. Keep the benchmark local and offline.

**Expected Impact:** This does not directly accelerate the app, but it prevents optimization by intuition. It makes 10-30% regressions visible, identifies whether filesystem, database, decoder, IPC, or rendering dominates on each machine, and supplies decision gates for Rust or framework migration.

**Implementation Effort:** **Low to Medium.** The harness is straightforward; representative media fixtures and stable CI timing require more care.

**Trade-offs:** Benchmarks consume engineering time and disk space. CI machines are noisy, so absolute thresholds should be used only on controlled hardware; shared CI should primarily compare relative changes.

## Database and Catalog

### Proposal 2: Move SQLite Ownership Off the Electron Main Thread

**The Concept:** Give one dedicated catalog worker exclusive ownership of the `better-sqlite3` connection. An Electron `utilityProcess` offers stronger crash isolation; a Node `worker_thread` is simpler and has lower messaging overhead. The main process should send typed commands such as scan, page query, update metadata, and cancel. The worker should return bounded batches or diffs through a `MessagePort`.

**Expected Impact:** Long synchronous SQLite operations no longer freeze Electron window management or IPC. Main-process p95 event-loop delay can remain below roughly 25 ms even when a transaction or query takes hundreds of milliseconds. A single owner also eliminates accidental concurrent connection policy and simplifies transaction ordering.

**Implementation Effort:** **Medium.** Query APIs become asynchronous at the process boundary, error propagation and worker startup must be designed, and native module packaging must be validated in the worker environment.

**Trade-offs:** Adds message serialization, lifecycle management, and another failure domain. `better-sqlite3` objects cannot cross the boundary. Utility processes use more memory than a worker thread but isolate native crashes better.

### Proposal 3: Replace Temporary-Path Cleanup with Scan Generations

**The Concept:** Add a dataset table and a monotonically increasing `scan_generation`. Every discovered membership row is marked with the active generation. On successful completion, delete memberships from older generations and atomically mark the new generation complete. Keep the last completed generation visible until the replacement scan commits. Model datasets and files separately so the same file may belong to overlapping selected roots.

**Expected Impact:** Removes the in-memory `allFilePaths` array and the second pass that inserts every path into a temporary table. Memory becomes bounded by the current batch rather than total catalog size. An interrupted scan cannot make a half-updated catalog authoritative. Overlapping parent/child datasets stop moving a unique file row between roots.

**Implementation Effort:** **Medium.** Requires a schema migration and changes to upsert and cleanup queries.

**Trade-offs:** The schema is more relational and queries require a membership join. Old failed generations need periodic cleanup.

### Proposal 4: Page, Filter, and Aggregate in SQLite

**The Concept:** Stop returning all rows for a root. Add keyset pagination, preferably by a stable ordered tuple such as normalized path plus ID. Push media type, validation status, duplicate-group, and filename search filters into SQL. Return aggregate counts and total bytes separately. Use FTS5 only when substring/token search requirements justify it.

**Expected Impact:** A warm 100,000-file dataset can render from a page of 100-500 lightweight records instead of cloning tens of megabytes. Query and IPC latency becomes proportional to page size. Renderer memory no longer scales linearly with the complete catalog.

**Implementation Effort:** **Medium to High.** Requires renderer pagination/virtualization integration and a versioned query contract.

**Trade-offs:** Sorting and selection across unloaded pages become more complex. Offset pagination should be avoided for deep pages because its cost grows with the offset; keyset pagination constrains arbitrary page jumps.

### Proposal 5: Add Covering Indexes and Conservative SQLite Tuning

**The Concept:** Retain WAL, `synchronous=NORMAL`, foreign keys, and a busy timeout. Add a covering index aligned with the hot query, for example dataset/root plus case-normalized path and ID, so SQLite does not sort an entire root after using only `folder_path`. Benchmark a negative `cache_size` around 64-256 MB, `temp_store=MEMORY`, `mmap_size` around 128-512 MB on 64-bit systems, `journal_size_limit`, and an explicit WAL checkpoint policy. Run `PRAGMA optimize` periodically and on a clean close. Set page-size or auto-vacuum choices only during database creation or migration.

**Expected Impact:** The covering index can reduce large ordered-folder queries by 2-10x when sorting currently dominates. Cache and mmap tuning commonly provide a smaller 10-30% improvement for repeated reads. WAL checkpoint limits prevent unbounded WAL growth.

**Implementation Effort:** **Low to Medium.** Most changes are small, but each PRAGMA must be benchmarked on target filesystems.

**Trade-offs:** Larger cache and mmap settings increase memory use. `temp_store=MEMORY` can be harmful for unexpectedly large sorts. Aggressive checkpoints create write stalls. Network filesystems may not support WAL semantics reliably and may require a local catalog regardless of source location.

### Proposal 6: Separate Regenerable Catalog Data from Durable User Data

**The Concept:** Treat scan metadata and derived hashes as a rebuildable cache, while tags, exclusions, review decisions, and transform presets are durable user state. They can be separate databases or clearly separated tables with different backup and recovery policies.

**Expected Impact:** Corrupt or stale catalog data can be rebuilt without risking user decisions. Catalog writes may use performance-oriented durability, while important user state can use stronger durability and backups. Recovery paths become predictable.

**Implementation Effort:** **Medium.** Easier now than after feature tables proliferate.

**Trade-offs:** Cross-database transactions are harder. Two files require coordinated migrations and diagnostic tooling.

### Proposal 7: Introduce Versioned Migrations, Integrity Checks, and Recovery

**The Concept:** Use `PRAGMA user_version` with ordered transactional migrations. On startup, detect incompatible or failed migrations, make a bounded backup, and expose a recovery path. Run quick integrity checks after an unclean shutdown and full checks only on demand. Store the application/catalog schema version independently from Electron package version.

**Expected Impact:** Prevents startup crashes and silent schema drift as duplicate, validation, and transform tables arrive. Recovery from power loss or native-module failures becomes deterministic.

**Implementation Effort:** **Medium.** The migration runner is modest; reliable rollback and recovery UX require testing.

**Trade-offs:** Backups consume disk, and large database copies can delay startup unless performed incrementally or only before risky migrations.

## Filesystem Scanning

### Proposal 8: Use a Bounded-Concurrency Filesystem Walker

**The Concept:** Separate directory enumeration from metadata collection. Feed discovered media paths into an asynchronous stat queue with an adaptive concurrency limit. Start around 32 operations for local SSDs, lower it for HDD/network paths, and tune from measurements. Emit records to the catalog worker in batches of approximately 500-2,000 rather than transactions of 100. Preserve cancellation through an `AbortSignal` or scan generation token.

**Expected Impact:** Serial `stat` is the most obvious scan throughput bottleneck. A bounded queue can target 3-10x higher throughput on SSD and high-latency shares. Larger transactional batches reduce transaction overhead and IPC chatter. The bound prevents descriptor exhaustion and random-I/O collapse.

**Implementation Effort:** **Medium.** Requires a queue, backpressure, cancellation, and device-sensitive tuning.

**Trade-offs:** Excess concurrency hurts HDDs, antivirus-heavy systems, and network shares. Results arrive out of order and must be sorted by SQL or a stable key later.

### Proposal 9: Reuse Scanner Fingerprints Throughout the Pipeline

**The Concept:** The scanner already knows path, size, type, and modification time. Pass that fingerprint to thumbnail and metadata jobs instead of calling `stat` again inside `generateThumbnail`. Compute one normalized cache key once and persist it with the media record.

**Expected Impact:** Eliminates one filesystem syscall per thumbnail candidate. At 100,000 files this removes 100,000 redundant metadata reads, which is material on network, removable, or sleeping disks. It also guarantees the scanner, database, and cache agree on source version.

**Implementation Effort:** **Low.** Extend job data and cache helpers.

**Trade-offs:** The pipeline must detect a file changing between scan and decode. Failed jobs should compare the current fingerprint and enqueue a new version rather than publishing stale output.

### Proposal 10: Add Incremental Native File Watching with Periodic Reconciliation

**The Concept:** After a complete scan, watch active roots with a native watcher such as `@parcel/watcher`. Debounce and coalesce create/change/delete/rename events into catalog jobs. Keep periodic or user-triggered reconciliation because operating-system watcher buffers can overflow and network shares are inconsistent.

**Expected Impact:** Small external changes appear in milliseconds without repeatedly walking an entire large tree. Warm operation becomes proportional to changes rather than total files.

**Implementation Effort:** **Medium to High.** Rename pairing, overflow handling, exclusions, removable drives, and platform behavior require careful testing.

**Trade-offs:** Recursive watchers consume OS resources and are not a source of truth. Very large or network-mounted trees may need watching disabled. A full reconciliation remains necessary.

### Proposal 11: Introduce Stable File Identity and Canonical Paths

**The Concept:** Store both display path and a canonical comparison path. On Windows, normalize case and separators and consider volume serial plus file ID for rename detection. On POSIX, use device/inode carefully. Do not use only a case-sensitive unique text path for identity.

**Expected Impact:** Avoids duplicate rows caused by path casing, recognizes renames without regenerating every derived artifact, and makes overlapping datasets reliable. Rename-heavy organization workflows become much cheaper.

**Implementation Effort:** **Medium to High.** Native file identifiers and network filesystems differ by platform.

**Trade-offs:** File IDs can be recycled, are not always stable across copies or network shares, and require a path fallback. Canonicalization rules must not collapse distinct POSIX filenames.

### Proposal 12: Consider a Rust Scanner Only After the Bounded Node Walker Is Benchmarked

**The Concept:** If filesystem traversal remains dominant, implement a small Rust N-API module using `ignore`, `walkdir`, or platform APIs. Return compact batches through N-API rather than one JS object per file. Keep filtering and path normalization in the native layer.

**Expected Impact:** Depending on platform and object-allocation overhead, a native walker may add another 2-5x over a tuned Node walker and substantially reduce JavaScript garbage collection at million-file scale.

**Implementation Effort:** **High.** Cross-compilation, code signing, Electron ABI distribution, long-path behavior, and CI packaging all become more complex.

**Trade-offs:** Native maintenance cost is permanent. Filesystem speed may still be limited by storage and antivirus, producing little benefit. Rust should have a benchmark gate, not be adopted preemptively.

## Thumbnail and Media Pipeline

### Proposal 13: Build a Resource-Aware, Priority Job Scheduler

**The Concept:** Replace the mixed fixed four-worker loop with one central scheduler. Use separate budgets for image jobs, video decode jobs, hashing, validation, and transforms. Prioritize currently visible cards, then near-viewport cards, then background catalog work. Adapt limits to logical cores, memory pressure, storage type, foreground/background state, and battery status. Carry cancellation into running tasks and terminate superseded FFmpeg processes.

**Expected Impact:** Prevents four FFmpeg decoders plus libvips threads from oversubscribing CPU and saturating one disk. Visible thumbnails arrive sooner even on huge datasets. Cancellation releases resources immediately instead of waiting up to the current 30-second timeout.

**Implementation Effort:** **High.** Requires a job model, priorities, deduplication, cancellation, fairness, and lifecycle ownership.

**Trade-offs:** Scheduler bugs can starve background work or underuse hardware. Adaptive policies must remain observable and user-configurable for unusual machines.

### Proposal 14: Replace Deprecated `fluent-ffmpeg` with a Maintained Direct Process Wrapper

**The Concept:** Invoke a known FFmpeg/FFprobe binary directly with argument arrays through a maintained process library or a small internal wrapper. Never use a shell. Centralize binary discovery, capability probing, timeout/cancellation, stderr parsing, exit classification, and Windows process-tree termination. Bundle or install a tested FFmpeg build rather than relying solely on `PATH`.

**Expected Impact:** The main gain is stability, not raw decode speed. It removes dependence on deprecated `fluent-ffmpeg`, makes failures deterministic, improves cancellation, and prevents machine-specific PATH drift. It also creates one foundation for thumbnails, metadata, validation, and transforms.

**Implementation Effort:** **Medium.** The current thumbnail command is small; cross-platform packaging and licensing review are the larger tasks.

**Trade-offs:** Bundled binaries increase installer size, require security updates, and trigger codec/license considerations. An internal wrapper must track relevant FFmpeg CLI changes.

### Proposal 15: Make Thumbnail Cache Writes Atomic and Add Lifecycle Management

**The Concept:** Write thumbnails to a unique temporary file in the cache directory, validate dimensions/format, then atomically rename to the hash path. Track cache entries, source fingerprints, byte size, last access, failure class, and generator version in SQLite. Enforce a configurable size limit with LRU eviction and remove orphaned versions in idle time.

**Expected Impact:** A crash can no longer leave a partial JPEG that `access()` treats as valid. Disk use stays bounded. Generator-version keys allow format/quality changes without ambiguous stale files. Negative failure markers can expire selectively for transient failures.

**Implementation Effort:** **Medium.** Atomic write helpers are low effort; correct indexing, eviction, and cleanup scheduling add complexity.

**Trade-offs:** LRU writes can become noisy if every image view updates SQLite. Approximate access buckets or batched updates are preferable. Renames are atomic only within the same filesystem.

### Proposal 16: Extract Metadata During Existing Native Work

**The Concept:** Capture image dimensions and orientation while Sharp reads the header. Run FFprobe once per changed video and persist duration, stream dimensions, frame-rate rational, codec, and rotation before or alongside thumbnail extraction. Reuse this metadata for validation and duplicate candidate filtering.

**Expected Impact:** Avoids future duplicate reads and probes. The inspector becomes useful without delaying the initial directory list. Multi-stage video duplicate detection can reject most pairs from cached duration/resolution before decoding frames.

**Implementation Effort:** **Low to Medium.** Native tools already exist; database update batching is required.

**Trade-offs:** Metadata semantics are messy: variable frame rate, rotation, malformed containers, and multiple video streams need explicit policy. Do not represent rational FPS only as an imprecise float if exact comparisons matter.

### Proposal 17: Use One Video Decode Session for Multiple Sample Frames

**The Concept:** For validation or duplicate detection, request first, last, and intermediate sample frames from a single FFmpeg invocation per video. Decode in timestamp order or use a filter graph that emits multiple frames. Compute and persist hashes as results arrive.

**Expected Impact:** Process startup and container probing are often a large part of short thumbnail jobs. One process for six samples can be 2-5x faster than six independent invocations and creates far less process churn.

**Implementation Effort:** **Medium.** Sampling accuracy, variable frame rate, and corrupt-file fallback need careful command design.

**Trade-offs:** One failed long-running process can lose all samples. Seeking in timestamp order may decode more frames than independent fast seeks for long-GOP content; benchmark both strategies.

### Proposal 18: Add Hardware Encoding with Capability Detection, Not as a Default Shortcut

**The Concept:** For the future Transform workflow, probe NVENC, Intel Quick Sync, AMD AMF, and VideoToolbox at startup or on demand. Offer hardware profiles with software fallback. Keep software x264/x265 for quality-sensitive output. Record encoder, driver, and chosen settings in job diagnostics.

**Expected Impact:** Compatible hardware commonly provides 2-8x faster video transcoding and much lower CPU use. The UI remains responsive and batch transforms complete sooner.

**Implementation Effort:** **High.** Platform-specific filters, pixel formats, driver failures, quality controls, and fallback testing are substantial.

**Trade-offs:** Hardware output often needs more bitrate for equivalent quality, capabilities differ by generation, and driver behavior is less deterministic. GPU acceleration usually offers little value for one-frame thumbnails because process/probe overhead dominates.

## Duplicate Detection and Native Processing

### Proposal 19: Put CPU-Bound Hashing and Index Construction in Worker Threads

**The Concept:** Use a persistent worker pool for JavaScript CPU work such as dHash bit packing, Hamming comparisons, BK-tree construction, and union-find grouping. Sharp can produce tiny grayscale buffers; transfer their `ArrayBuffer`s rather than cloning large images. Size the pool independently from FFmpeg jobs.

**Expected Impact:** Keeps both Electron main and renderer responsive. On a multi-core CPU, embarrassingly parallel hash generation can approach 3-7x speedup on 4-8 effective workers, subject to image decode and disk limits.

**Implementation Effort:** **Medium.** Requires worker protocol, transferable buffers, cancellation, and deterministic result assembly.

**Trade-offs:** Too many workers compete with libvips and FFmpeg. Worker startup is expensive unless workers are persistent. Debugging and stack traces are less direct.

### Proposal 20: Use a Multi-Stage Duplicate Pipeline Before Considering Native BK-Trees

**The Concept:** Persist cheap features first: exact size/hash, dimensions, duration buckets, and 64-bit perceptual hashes. Narrow candidates in SQLite, then apply Hamming/BK-tree grouping only to plausible buckets, and decode expensive video samples last. Store algorithm and version with every derived hash.

**Expected Impact:** The expensive stage operates on a small fraction of the library. Exact duplicates can be resolved without image decode, and most videos are rejected by duration/resolution. This can reduce total comparisons and frame extraction by orders of magnitude compared with all-pairs processing.

**Implementation Effort:** **Medium to High.** The algorithms are known; persistent, resumable stages and review semantics require design.

**Trade-offs:** Aggressive prefilters can create false negatives. Algorithm-version migrations and threshold changes require selective recomputation.

### Proposal 21: Use Rust N-API for Hash Search Only if Profiling Shows JavaScript Is the Hotspot

**The Concept:** A focused Rust module can provide SIMD grayscale hashing, 64-bit popcount, BK-tree search, union-find, or locality-sensitive buckets. Keep SQLite and UI contracts in TypeScript. Expose batch APIs to amortize N-API crossings.

**Expected Impact:** SIMD and compact native structures can improve hash/search stages by approximately 3-20x when JavaScript comparison and allocation are genuinely dominant. Memory per hash/group can also fall significantly.

**Implementation Effort:** **High.** Requires native release artifacts for every OS/architecture, deterministic tests, and crash-safe boundaries.

**Trade-offs:** N-API calls per item can erase the benefit; only batch APIs make sense. Native crashes are more severe, and the optimization does nothing for disk or decode-bound workloads.

## IPC and Process Boundaries

### Proposal 22: Replace Full Snapshots and Per-Item Events with Pages and Batches

**The Concept:** Define versioned IPC messages for catalog pages, aggregate summaries, and batched changes. Coalesce thumbnail-ready results for 16-100 ms or until 50-200 items accumulate. Throttle progress to at most 10 Hz. Background synchronization should send `{added, updated, removedIds}` batches or only advance a dataset version that causes visible pages to refresh.

**Expected Impact:** For 100,000 thumbnails, batching 100 at a time reduces 100,000 IPC messages to roughly 1,000. Renderer commits and structured clones fall by similar orders of magnitude. The main process avoids sending a second complete catalog after every reconciliation.

**Implementation Effort:** **Medium.** Contracts, buffering, ordering, and scan-version checks are required.

**Trade-offs:** Results appear in small bursts rather than individually. Batches need sequence numbers or dataset versions so late messages cannot corrupt a newer view.

### Proposal 23: Replace Path Allowlist Sets with Capability-Based Media URLs

**The Concept:** Thumbnail URLs should contain an opaque thumbnail/cache ID or validated hash, not an encoded absolute path. The protocol handler can validate a strict filename pattern and enforce containment under the cache root. Original-media access should use an opaque media ID resolved through the catalog worker and current dataset authorization. Add immutable caching headers and ETags for content-versioned thumbnails.

**Expected Impact:** Removes two in-memory path sets that scale with total files, potentially saving tens or hundreds of megabytes at very large scale. Browser caching becomes more effective, and local paths no longer travel in every thumbnail URL.

**Implementation Effort:** **Medium.** Requires protocol and shared-contract changes.

**Trade-offs:** Resolving original media IDs may add a database lookup unless capabilities are cached. Authorization must be invalidated when the active dataset changes.

### Proposal 24: Make Preload Event Subscriptions Disposable

**The Concept:** Every `on...` preload API should return an unsubscribe function that removes the exact `ipcRenderer` listener. The renderer store should initialize subscriptions once and dispose them during hot-module replacement or teardown.

**Expected Impact:** Prevents duplicate progress and thumbnail handlers during Vite HMR, tests, or future window recreation. This improves stability and eliminates hard-to-diagnose duplicate state work.

**Implementation Effort:** **Low.** It is a narrow API adjustment.

**Trade-offs:** Callers must own cleanup. Shared callback identity must be handled correctly.

## React Rendering and Renderer State

### Proposal 25: Virtualize the Media Grid Immediately

**The Concept:** Use `@tanstack/react-virtual`, `react-window`, or a purpose-built virtualized grid. Compute stable column count and card dimensions, render only visible rows plus a small overscan, and prioritize thumbnail jobs from the visible range. Preserve scroll anchor by stable media ID when pages or sync diffs change.

**Expected Impact:** Mounted cards fall from O(total files) to roughly 50-200. At 10,000-100,000 items this can reduce DOM and component memory by more than 90-99% and is the most important step toward sustained 60 FPS scrolling. It also makes lazy thumbnail decoding predictable.

**Implementation Effort:** **Medium.** Responsive columns, scroll restoration, selection, keyboard navigation, and dynamic sidebar width need integration testing.

**Trade-offs:** Accessibility and focus management require deliberate work. Variable-height cards are harder; fixed card aspect and row height are strongly preferred.

### Proposal 26: Normalize Zustand State and Subscribe Per Card

**The Concept:** Store records as `byId` plus ordered IDs/pages instead of one large mutable array. Keep thumbnail status in a keyed map or record. A `MediaCard` should subscribe only to its own record and be memoized. Apply thumbnail batches in one state commit. Store aggregate count/bytes instead of reducing the complete array during every parent render.

**Expected Impact:** A thumbnail update becomes O(1) state work instead of an O(N) array map. Across N thumbnail completions, the current O(N squared) pattern becomes approximately O(N). Only affected visible cards render.

**Implementation Effort:** **Medium.** Store selectors, page ordering, and sync diff reducers need redesign.

**Trade-offs:** Normalized stores are more verbose. Careless selector object creation can still trigger renders; selector equality must be explicit.

### Proposal 27: Move Search, Sort, and Smart Filters to the Catalog Query Layer

**The Concept:** Debounce input, send a typed query specification to the catalog worker, and virtualize/paginate results. Cache recent query pages by dataset version and query key. Return smart-filter counts from indexed aggregate queries rather than scanning renderer arrays.

**Expected Impact:** Search and filtering remain responsive at 100,000+ records, and renderer memory stays bounded. SQL indexes do the work once rather than JavaScript repeatedly filtering large object arrays.

**Implementation Effort:** **Medium.** Requires query definitions and UI loading/stale-result behavior.

**Trade-offs:** Every query has an asynchronous boundary. FTS indexing increases database size and write cost. Complex arbitrary sort combinations may require additional indexes.

### Proposal 28: Use Browser Image Decoding First; Reserve Canvas/WebGL for Specialized Views

**The Concept:** Continue using `<img>` for virtualized thumbnail cards, add immutable cache headers, and optionally call `HTMLImageElement.decode()` before reveal to avoid paint jank. Use `createImageBitmap`, OffscreenCanvas, or WebGL only for dense contact sheets, image comparison, histogramming, or custom zoom where profiling shows DOM/image decoding is inadequate.

**Expected Impact:** Virtualized native image elements are usually the fastest and most maintainable gallery path. Avoiding an unnecessary WebGL renderer saves significant complexity. Canvas/WebGL can later improve specialized high-density views or GPU compositing.

**Implementation Effort:** **Low** for decode scheduling; **High** for a WebGL gallery.

**Trade-offs:** Browser decode caches are less controllable than a custom renderer. WebGL introduces context loss, texture budgeting, accessibility gaps, and device-specific failures, so it should not be the default optimization.

## Main-Process Stability and Operations

### Proposal 29: Add a Central Job Manager and Graceful Shutdown Protocol

**The Concept:** Represent every scan, thumbnail, metadata, duplicate, and transform operation as a tracked job with ID, dataset version, state, progress, cancellation token, resource class, and child processes. On dataset switch or app quit, stop accepting work, cancel queued jobs, terminate active FFmpeg processes, wait for safe database checkpoints, then close workers and SQLite.

**Expected Impact:** Prevents orphan FFmpeg processes, writes after database shutdown, stale IPC events, and resources lingering for up to timeout. Crash and cancellation behavior become testable rather than incidental.

**Implementation Effort:** **Medium to High.** It overlaps product-wide workflow orchestration and is best introduced before Transform.

**Trade-offs:** Adds state-machine complexity. Shutdown must have a hard deadline so one stuck native process cannot prevent exit.

### Proposal 30: Add Structured Local Diagnostics and Health Signals

**The Concept:** Use rotating local logs with structured fields for job ID, media ID, stage, duration, exit class, and dataset version. Track event-loop delay, worker queue depth, SQLite busy time, thumbnail hit rate, and FFmpeg failure categories. Provide a user-controlled diagnostic export with paths redacted if desired; do not add cloud telemetry.

**Expected Impact:** Makes machine-specific native failures and performance regressions actionable. Cache hit rate and queue telemetry directly guide concurrency and eviction tuning.

**Implementation Effort:** **Low to Medium.** Logging is simple; useful classification and privacy-conscious export need discipline.

**Trade-offs:** Logs consume disk and may contain sensitive local paths. Rotation, redaction, and opt-in export are mandatory.

### Proposal 31: Build Fault-Injection and Scale Tests

**The Concept:** Add tests for truncated media, zero-frame videos, permission failures, removed files during scan, Unicode and very long paths, symlinks, overlapping roots, disconnected drives, SQLite corruption, disk-full cache writes, FFmpeg hangs, cancellation, HMR listener duplication, and 100,000 synthetic catalog rows. Use Playwright/Electron tests for visible-grid and memory assertions.

**Expected Impact:** Stability improves more than from isolated micro-optimizations. The known corrupt-video negative-cache behavior becomes a regression test, and future native/worker changes gain a safety net.

**Implementation Effort:** **Medium to High.** Synthetic catalog tests are easy; cross-platform filesystem and native-process tests take time.

**Trade-offs:** Native tests can be slow and flaky without controlled fixtures. Separate fast unit tests from scheduled platform integration suites.

### Proposal 32: Upgrade Runtime and Deprecated Dependencies Deliberately

**The Concept:** Electron 33, Vite 5, and the deprecated `fluent-ffmpeg` wrapper should not remain indefinitely. Establish a quarterly supported-runtime upgrade cadence, pin native artifacts, run smoke tests on each target OS, and publish a software bill of materials. Upgrade Electron one supported major at a time when possible.

**Expected Impact:** Gains Chromium/Node performance and security fixes, avoids unsupported native ABI combinations, and reduces surprise upgrade cliffs.

**Implementation Effort:** **Medium.** Routine once automated, but the first dependency modernization may expose breaking changes.

**Trade-offs:** New Electron versions can change GPU, protocol, sandbox, or native-module behavior. Upgrades must be benchmarked rather than assumed faster.

### Proposal 33: Tighten External Navigation and Startup Failure Handling

**The Concept:** Allow external navigation only for explicitly approved `https:` and, if required, `http:` URLs. Treat database/native initialization failures as controlled startup states with recovery guidance instead of unhandled promise rejection. Keep production CSP separate from development HMR allowances.

**Expected Impact:** Improves security and startup reliability. A broken native ABI or unavailable database produces an actionable UI rather than a partially initialized app.

**Implementation Effort:** **Low.** The behavior is localized.

**Trade-offs:** A strict URL allowlist may block future legitimate protocols until explicitly added. Recovery UI adds a small startup branch.

## Framework-Level Options

### Proposal 34: Retain Electron for the Next Optimization Cycle

**The Concept:** Keep Electron as the application shell while moving heavy work out of its main process. Electron already supplies the required Node/native ecosystem, mature protocol APIs, devtools, process isolation, and predictable Chromium rendering.

**Expected Impact:** Captures the major performance gains without a rewrite. Renderer virtualization, paged IPC, worker-owned SQLite, and a tuned scanner address the actual bottlenecks while preserving delivery speed.

**Implementation Effort:** **Low** as an architectural decision; the optimizations themselves have the effort listed above.

**Trade-offs:** Electron retains higher idle memory and installer size than native webview shells. Chromium must be kept current.

### Proposal 35: Evaluate Tauri Only Against Explicit Product Constraints

**The Concept:** Build a short proof of concept only if installer size, idle memory, or startup time becomes a hard requirement. The Tauri core would likely move scanning, SQLite, and media orchestration to Rust while retaining the React UI in the system webview.

**Expected Impact:** A Tauri build can reduce installer and idle shell memory substantially, often by tens to more than 100 MB, depending on platform. It does not automatically fix full-array IPC, O(N squared) state updates, or a non-virtualized React grid.

**Implementation Effort:** **Very High.** Main/preload/protocol/native packaging and process orchestration would be rewritten, and webview differences would need cross-platform validation.

**Trade-offs:** Windows WebView2 availability/version, platform rendering differences, a smaller Node-native ecosystem, and migration risk. Tauri is not currently justified by the observed code bottlenecks.

## Recommended Target Architecture

```text
Electron main process (thin coordinator)
|- window/security/protocol lifecycle
|- typed IPC gateway with paging, batching, and version checks
`- central job manager
      |
      +--> Catalog utility process or worker
      |    |- bounded concurrent filesystem walk
      |    |- exclusive better-sqlite3 connection
      |    |- scan generations and incremental watcher
      |    `- paged/filter/aggregate queries
      |
      +--> Media scheduler
      |    |- Sharp image budget
      |    |- direct FFmpeg/FFprobe process budget
      |    |- visible-item priority
      |    `- atomic bounded thumbnail cache
      |
      `--> CPU worker pool
           |- perceptual hash computation
           |- BK-tree/bucket search
           `- union-find grouping

React renderer
|- virtualized grid
|- normalized Zustand state
|- page and diff subscriptions
`- O(1) per-item thumbnail updates
```

## Prioritization Matrix

| Priority | Proposal group | ROI | Primary outcome |
|---:|---|---|---|
| 0 | Baseline benchmarks and local diagnostics | Very high | Makes every later decision measurable |
| 1 | Virtualized grid plus normalized/batched renderer state | Exceptional | Removes DOM explosion and O(N squared) updates |
| 2 | Catalog worker plus paged IPC | Exceptional | Keeps Electron responsive and bounds memory/payloads |
| 3 | Bounded scanner plus scan-generation schema | Very high | Faster scans with crash-safe reconciliation |
| 4 | Resource-aware media scheduler plus direct FFmpeg wrapper | High | Stable throughput, priority, and real cancellation |
| 5 | Atomic cache, cache budget, metadata reuse | High | Less I/O, bounded disk, fewer corrupt artifacts |
| 6 | Watcher, migrations, tests, lifecycle manager | High | Long-running stability and incremental updates |
| 7 | SQLite PRAGMA/index tuning | Medium | Useful gains after query/data-flow fixes |
| 8 | Hardware video encoding | High for Transform only | Faster future transcodes |
| 9 | Rust N-API hotspots | Conditional | Large gains only after profiling proves CPU/GC limits |
| 10 | Tauri migration | Low at present | Footprint improvement, not core scaling correction |

## Conclusion and Roadmap

### Top 3 Highest-ROI Actions

1. **Virtualize the grid and eliminate O(N squared) renderer updates.** Normalize Zustand records, subscribe per visible card, batch thumbnail events, throttle progress, and stop sending full sync snapshots. This is the fastest route from a prototype gallery to reliable 100,000-item behavior.
2. **Move the catalog/scanner off Electron's main thread and page all catalog reads.** Give one worker or utility process ownership of `better-sqlite3`, use bounded filesystem concurrency, and keep IPC payloads page-sized. This protects UI responsiveness and process stability even when native work is slow.
3. **Adopt scan generations and a resource-aware media scheduler.** Make scans atomic and resumable, remove the O(N) missing-path side structure, reuse file fingerprints, prioritize visible thumbnails, and cancel active FFmpeg work. This improves throughput, correctness, and operational control together.

### Suggested Delivery Order

- **Phase 0:** Add benchmark fixtures, event-loop/IPC measurements, and scale assertions.
- **Phase 1:** Virtualized grid, normalized store, batched thumbnail/progress events.
- **Phase 2:** Catalog worker, paged SQL queries, covering indexes, aggregate APIs.
- **Phase 3:** Bounded scanner, scan-generation schema, incremental diff events.
- **Phase 4:** Central media scheduler, direct FFmpeg wrapper, metadata co-extraction, atomic cache and eviction.
- **Phase 5:** Duplicate worker pipeline, then benchmark whether Rust N-API is justified.
- **Phase 6:** Hardware encode profiles for Transform. Reconsider Tauri only if product-level footprint targets remain unmet after these changes.

The governing principle should be: **fix asymptotic behavior and process isolation before introducing lower-level languages or changing frameworks**. MediaCraft can reach large-dataset performance with its current stack if it stops moving and rendering the entire catalog for every incremental event and stops executing catalog work on Electron's coordination thread.
