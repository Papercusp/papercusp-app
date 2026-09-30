/**
 * `system:gitnexus-reindex` — the refresh owner for the gitnexus code graph (WI-6454).
 *
 * WHY THIS EXISTS. `gitnexus.context` / `gitnexus.query` answer "where is this symbol
 * defined, and who calls it" from a knowledge graph built by `gitnexus analyze`. That
 * graph was built BY HAND once (2026-07-27) and nothing refreshed it, so it began
 * decaying immediately on a tree where git-sync commits every few minutes. A definition
 * lookup against a stale graph silently returns a symbol that has moved — or misses one
 * that is new — and the caller cannot tell which happened. That unowned decay is what
 * pins the `code-search.definition-lookup` substitution pair at `observe`
 * (`lib/bash-substitution/pairs/code-search.ts`).
 *
 * WHY A GATED HOURLY TICK RATHER THAN A PLAIN CRON. Every spawn is a FULL rebuild (see
 * `--force` below) that was measured on this box at **309s cold** on the 2026-08 graph,
 * ~14.5 min of non-embedding work on the 2026-09-05 graph under fleet load, and **2,343s for
 * the steady-state tick** (full rebuild + embedding-cache restore + re-embed of the changed
 * nodes, run #4, load/core 1.06). So the cadence
 * cannot be "run it every hour" — the routine fires hourly but the EXPENSIVE part is
 * conditional: each tick reads the registry + git + loadavg and the latest perf-signals
 * capture (all cheap) and only then decides to spawn. `decideReindex` is the whole policy,
 * kept pure so it is testable without a 15-minute subprocess.
 *
 * `--force` IS MANDATORY (D-002, plan gitnexus-embeddings-enablement-2026-09-05). gitnexus
 * 1.6.9 defaults to an INCREMENTAL path (changed files + a BFS of their importers, "skipping
 * wipe") and on this graph that path is the outage: MEASURED 2026-09-05, twice, on a
 * 296-changed / 91-added / +6,839-importer write set, the incremental writeback breached the
 * 16 GiB GITNEXUS_LBUG_MAX_DB_BYTES ceiling ~35–45 min in ("Maximum database size of
 * 17179869184 bytes has been reached" → "manual WAL checkpoint failed after retries" →
 * SIGSEGV), leaving the D-016 residue that wedges every reader (/tmp/wi39394/run2-embed-run.log,
 * /tmp/wi39394/bootstrap-live/run.log); the same path had timeout-killed the hourly tick ~10×
 * over the preceding 3 days. A FULL rebuild of the same graph completed in 3,133s INCLUDING a
 * cold 2,265s embedding phase, with the database file ending at 5.3 GiB
 * (/tmp/wi39394/run1-embed-run.log). Full-per-tick is therefore the cheaper AND the durable
 * design here; a bigger ceiling merely moves the cliff (the live root has ~70 GB free).
 *
 * EMBEDDINGS ARE ON (WI-39394). Every spawn passes `--embeddings 0`
 * (GITNEXUS_EMBEDDINGS_NODE_CAP) so the vector leg of `gitnexus.query` is populated instead
 * of the permanent 0-of-246k it sat at since WI-35557. The cold 217,120-embedding pass
 * (≈96/s on cuda) is NOT something this routine pays every tick: `--force --embeddings`
 * LOADS the embedding cache from the existing index BEFORE the wipe, RESTORES it into the
 * fresh database, and generates only for new/changed nodes (`core/run-analyze.js`
 * "We *always* load the embedding cache when one is requested"; `core/embedding-mode.js`).
 * The first population is a ONE-SHOT SUPERVISED BOOTSTRAP outside the routine (D-002).
 * ⚠ An analyze WITHOUT `--embeddings` merely PRESERVES the embeddings already present and
 * never embeds a new node, so dropping the flag does not "turn embeddings off" — it silently
 * freezes the vector leg at bootstrap time while every count still reads healthy. That is
 * why both flags live in `buildAnalyzeArgs` beside `--skip-agents-md` and are asserted by
 * tests, and why the canary treats `embeddings == 0` after an embeddings-enabled run as a
 * DEGRADATION.
 *
 * ⚠ `--skip-agents-md` IS MANDATORY AND IS HARDCODED HERE ON PURPOSE. Without it,
 * `analyze` REWRITES a gitnexus section into `CLAUDE.md` and `AGENTS.md`. In this repo
 * those are prompt SOURCES spliced into every agent's context, and CLAUDE.md
 * additionally carries the generated `gen:tool-routing` table — an unguarded analyze
 * corrupts both and reds the drift check. `buildAnalyzeArgs` is the single place the
 * argv is constructed and a test asserts the flag is present, so the trap cannot be
 * re-armed by editing a call site (enforcement: structural).
 *
 * Bounded + fail-soft, mirroring cargo-test-action / p2p-perf-actions: the child is its
 * own process-group leader so a timeout SIGTERM/SIGKILLs the whole tree (node →
 * tree-sitter workers), never just the wrapper, and a wedged analyze can therefore never
 * wedge the routines tick.
 *
 * RESOURCE-CAPPED (P-004): the child runs the PINNED gitnexus CLI under this process's
 * own node with an explicit heap/semi-space/stack budget — see GITNEXUS_ANALYZE_HEAP_MB
 * for the measured hazard (gitnexus self-grants 0.75x of a cgroup it does not own alone)
 * and analyzeEnv/analyzeNodeArgs for why the budget is split across env and argv.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readFileSync,
  existsSync,
  unlinkSync,
  statSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statfsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
} from 'node:fs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { managedSpawn } from '../../task-manager/managed-spawn';
import { dirSizeBytes } from '../../storage/disk';
import { criticalWriteHeadroomBytes, diskPolicyFromEnv } from '../../storage/disk-space-alarm';
import {
  DEFAULT_RESOURCE_BUDGET,
  classifyIndexDisk,
  type IndexDiskVerdict,
} from '../../code-intelligence/contracts';
import { SELECTIVE_ACCEPTANCE_CORPUS, SELECTIVE_SOURCE_BLOBS } from '../../code-intelligence/selective-corpus';

/** Registry alias this repo is indexed under (`analyze --name papercusp`). The alias
 *  disambiguates it from other checkouts on the box whose basename would collide. */
export const GITNEXUS_REPO_NAME = 'papercusp';

/** The exact-index failure fixture: this source was present in the indexed commit but
 * omitted by GitNexus's 512 KiB walker default. Keep the path tied to the corpus so a
 * source move updates both the acceptance case and the refresh guard. */
const EXACT_INDEX_CASE = SELECTIVE_ACCEPTANCE_CORPUS.find((entry) => entry.id === 'selective-exact-index-symbol');
if (!EXACT_INDEX_CASE?.expectedSites[0]) throw new Error('GitNexus exact-index acceptance case is missing');
export const GITNEXUS_KNOWN_SOURCE_PATH = EXACT_INDEX_CASE.expectedSites[0].path;

/** GitNexus 1.6.9/1.6.12 clamp the walker setting at tree-sitter's 32 MiB limit.
 * Derive the required setting from the live files named by the existing corpus,
 * instead of bumping a fixed limit whenever a source file grows. */
export function selectiveSourceLimitKb(root: string): number {
  let maxBytes = 512 * 1024;
  for (const relativePath of Object.keys(SELECTIVE_SOURCE_BLOBS)) {
    try {
      maxBytes = Math.max(maxBytes, statSync(path.join(root, relativePath)).size);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A synthetic/mock root may lack corpus files. The post-build canary
      // separately refuses a missing known source on the real repository.
    }
  }
  if (maxBytes > 32 * 1024 * 1024) {
    throw new Error(`GitNexus selective source exceeds tree-sitter's 32 MiB ceiling (${maxBytes} bytes)`);
  }
  return Math.ceil(maxBytes / 1024);
}

/**
 * Sized from the measured LIVE tick (D-004), not from an isolated measurement and not from the
 * 2026-08 cold build (309.2s — the figure the old 20-minute value was cut from, on a graph a
 * third this size and before embeddings).
 *
 * Measured 2026-09-05 (D-004): the first routine tick after the seeded resume — `analyze
 * --force --embeddings 0` over 248,736 nodes, restoring the 216k-embedding cache and
 * re-embedding the changed nodes — ran the way the routine actually runs it, under pc-heavy
 * (nice 10 / ionice idle) on a box carrying ~75 live agents, and took 6,446s (spawned
 * 18:32:12Z, indexedAt 20:19:38Z; 107:26 wall). The SAME pass in isolation took 2,343s
 * (run #4, D-002) — 2.75x faster — which is why D-002's 70-minute value, cut from the isolated
 * number, was exceeded by the very first live tick (rescued by hand from its scope deadline,
 * WI-39394 / WI-2146606). 165 min is ~1.54x the live tick: real headroom for load variance,
 * while still bounding a genuinely wedged indexer inside three cron intervals.
 *
 * It deliberately EXCEEDS the hourly cron: the routine row is `concurrency: 'skip'`
 * (seed-gitnexus-reindex-routine.ts), so a fire that lands while the previous tick is still
 * awaiting its analyze is skipped rather than double-spawned — IN-PROCESS only: an analyze
 * that outlives a bg-host restart is caught by `detectLiveAnalyzeWriter` instead (WI-2146606).
 * The cold one-shot bootstrap (3,139s isolated; >6,270s on the live root) is NOT run under this
 * timeout — see the module header.
 */
export const GITNEXUS_ANALYZE_TIMEOUT_MS = 165 * 60_000;

/**
 * The DBOS ceiling on ONE fire of this routine (`routineFireTimeoutMs` reads it off the
 * registration below). It must clear GITNEXUS_ANALYZE_TIMEOUT_MS plus the preflight, canary
 * and health bookkeeping around the spawn, because without an explicit value the fire runs
 * under the 2-hour `ROUTINE_FIRE_TIMEOUT_MS` default — BELOW the analyze's own 165-minute
 * budget. A fire cancelled at that default while its child is still inside budget releases
 * the routine's dedup id (so the next cron fire launches the action beside a live writer —
 * only WI-2146606's skip then stands between it and a double spawn) and never reaches the
 * health record for the tick that completes minutes later. Measured 2026-09-05: the first
 * routine-owned live tick took 107:26 against that 2h default — 12 minutes from a silent
 * cancellation on a busier box. Fifteen minutes of margin covers everything the action does
 * around the child (capacity telemetry, residue scan, canary, health write) with room.
 */
export const GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS = GITNEXUS_ANALYZE_TIMEOUT_MS + 15 * 60_000;

/**
 * FREE-DISK admission floor for a full rebuild (2026-09-05 ENOSPC incident).
 *
 * A `--force` rebuild writes a fresh `lbug.shadow` + `lbug.wal` BESIDE the live `lbug`
 * (5.28 GB on the 2026-09-05 graph) and only promotes at the end, so a tick needs roughly one
 * more database's worth of space than it holds, plus the WAL the embedding insert streams
 * through. Measured 2026-09-05: the 20:32:59Z routine tick ran its whole ~1h50 pass and then
 * died at 22:25:52Z inside `batchInsertEmbeddings` — `Cannot write to file … lbug.wal … No
 * space left on device` (exit 1 at run-analyze.js:1035) — because an unrelated build had
 * filled `/` to 100% at ~22:24Z. Postgres shares that filesystem and PANICked on `pg_wal` in
 * the same minute (WAL writer SIGABRT, recovery until 22:30:40Z). Two hours of GPU/CPU were
 * spent to produce nothing, and the incomplete marker then forced ANOTHER full rebuild.
 *
 * So the gate is a floor on what a rebuild can be admitted into, not a size ceiling: the
 * larger of this constant and 2x the current `lbug` size must be free on the index's
 * filesystem, or the tick defers with a `low disk` skip line and leaves the (complete) old
 * index serving. A measurement that cannot be taken is fail-soft (unknown ≠ low), matching
 * the memory-pressure gate.
 */
export const GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES = 16 * 1024 ** 3;

export interface DiskCapacityBytes {
  freeBytes: number;
  totalBytes: number;
}

/** Capacity available to this user on the filesystem holding `dir`; `null` when unmeasurable. */
export function measureDiskCapacityBytes(dir: string): DiskCapacityBytes | null {
  try {
    const s = statfsSync(dir);
    const blockSize = Number(s.bsize);
    const freeBytes = Number(s.bavail) * blockSize;
    const totalBytes = Number(s.blocks) * blockSize;
    return Number.isFinite(freeBytes) && freeBytes >= 0 && Number.isFinite(totalBytes) && totalBytes > 0
      ? { freeBytes, totalBytes }
      : null;
  } catch {
    return null;
  }
}

/** Compatibility scalar for callers/tests that only need the available byte count. */
export function measureFreeDiskBytes(dir: string): number | null {
  return measureDiskCapacityBytes(dir)?.freeBytes ?? null;
}

/**
 * PURE — the free space a full rebuild needs: its transient-write budget (the floor, or
 * twice the live database when that is larger) PLUS the protected shared-writer reserve.
 * The shadow is a second copy and the WAL/parse caches ride in the transient margin; the
 * reserve remains free for PostgreSQL and other correctness-critical writers. An unknown
 * database size falls back to the floor alone, and callers without a shared reserve retain
 * the original behavior.
 */
export function requiredFreeDiskBytes(
  dbBytes: number | null,
  minFreeBytes: number = GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES,
  protectedReserveBytes: number = 0,
): number {
  const floor = Number.isFinite(minFreeBytes) && minFreeBytes > 0 ? minFreeBytes : GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES;
  const transientDemand =
    dbBytes == null || !Number.isFinite(dbBytes) || dbBytes <= 0 ? floor : Math.max(floor, 2 * dbBytes);
  const reserve = Number.isFinite(protectedReserveBytes) && protectedReserveBytes > 0 ? protectedReserveBytes : 0;
  return transientDemand + reserve;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * The analyze child's OWN cgroup ceiling (managedSpawn `memoryMaxBytes`), so a regression
 * can never consume the background host's 40 GiB quota.
 *
 * Sized from measurement, twice: 10.59 GiB peak RSS on the 2026-08-21 graph (19,479 files,
 * no embeddings, 2 GiB LadybugDB pool) → 20 GiB; then 14.9 GiB (15,633,516 kB, /usr/bin/time
 * "Maximum resident set size") on 2026-09-05 over 246,622 nodes WITH embeddings and the 8 GiB
 * buffer-pool pin (GITNEXUS_LBUG_BUFFER_POOL_BYTES). That peak lands in the LadybugDB bulk-
 * load phase, BEFORE embedding starts — the embedding phase itself ran at 2.3–3.2 GiB with the
 * model on the GPU — so it is the pool + heap, not the embedder, that sets the envelope.
 * 24 GiB = the 16 GiB heap cap + the 8 GiB pool worst case; against the measured 14.9 GiB it is
 * ~1.6x headroom, and 24 + the ~11.6 GiB of observed co-tenants stays under the 40 GiB
 * bg-host cgroup. A cgroup OOM kill here is not a cheap failure: it leaves the D-016 residue.
 */
export const GITNEXUS_ANALYZE_MEMORY_MAX_BYTES = 24 * 1024 ** 3;

// ---------------------------------------------------------------------------
// P-004 — ANALYZE RESOURCE CAP (heap / semi-space / stack).
//
// THE HAZARD, measured live 2026-08-21 rather than assumed:
//
// gitnexus sizes its OWN V8 heap and re-execs itself with the result
// (`dist/cli/analyze.js`: `computeHeapCapMb` -> `ensureHeap`). The formula is
// `0.75 * effective`, where `effective` is `process.constrainedMemory()` when set --
// i.e. THIS PROCESS'S CGROUP LIMIT. We run inside `papercup-bg-host.service`, whose
// `memory.max` is 40 GiB, so it grants itself 0.75 * 40960 = 30720 MB. Observed on
// the live worker's own /proc environ, exactly: `--max-old-space-size=30720`. The
// prediction matching the observation to the megabyte is what confirms this
// derivation rather than a plausible story about it.
//
// That heuristic is sound for a dedicated container and WRONG here, for one reason:
// it assumes gitnexus is the SOLE TENANT of that cgroup. It is not. bg-host runs
// every operator routine, and held ~11.6 GiB of OTHER work while analyze ran. A
// gitnexus that actually used its self-granted 30 GiB would put the cgroup at
// ~41.6 GiB against a 40 GiB cap -- and the cgroup OOM killer does not kill "the
// process that asked for too much", it kills WITHIN THE WHOLE CGROUP. So a runaway
// analyze can take down the background host and every routine sharing it, which is
// a far larger blast radius than the failed index it started as.
//
// THE CAP IS SET FROM MEASUREMENT, NOT A GUESS. Sampled externally from /proc every
// 3s across a full run (an in-process beat cannot report on main-thread saturation --
// a saturated Node main thread stops its own timers exactly when you need them):
//   peak worker RSS (VmHWM) 10.42 GiB; peak whole-tree RSS 10.59 GiB
//   over 19,479 files / 191,008 nodes / 381,064 edges.
// RSS >= heap, so ~10.4 GiB bounds the heap the run actually used. 16 GiB therefore
// clears real usage by ~1.5x while bounding worst case (16 GiB heap + native
// tree-sitter/LadybugDB overhead, ~20 GiB) so that even a saturated analyze plus
// observed co-tenants stays under the 40 GiB cgroup cap.
export const GITNEXUS_ANALYZE_HEAP_MB = 16_384;

/** Young-gen sizing gitnexus applies for itself; preserved verbatim so capping the
 *  heap does not silently regress its GC tuning. Legal in NODE_OPTIONS. */
export const GITNEXUS_ANALYZE_SEMI_SPACE_MB = 128;

/** gitnexus raises the stack "to prevent stack overflow on deep class hierarchies".
 *  ILLEGAL in NODE_OPTIONS on Node 24+ (verified on node v25.9.0: the process exits 9
 *  with "--stack-size= is not allowed in NODE_OPTIONS"), so it MUST travel as a real
 *  argv flag. See analyzeNodeArgs. */
export const GITNEXUS_ANALYZE_STACK_KB = 4_096;

/**
 * P-004 — the LADYBUGDB size ceiling, PINNED rather than inherited.
 *
 * This is the `maxDBSize` handed to the native LadybugDB constructor. It is an mmap
 * VIRTUAL address-space reservation, not resident memory — measured on the live worker:
 * VmSize 230 GiB against VmHWM 10.42 GiB — so the number costs nothing until pages are
 * actually touched, and it is NOT the memory hazard. GITNEXUS_ANALYZE_HEAP_MB is.
 *
 * It is pinned here for a different reason: DRIFT. Upstream's default is 16 GiB, chosen
 * against an assumption its own comment states — "the GitNexus self-index uses < 50 MiB".
 * That assumption does not hold for this repo. Measured 2026-08-21: `.gitnexus/` is
 * 6.5 GB with the database file itself at 3.97 GiB over 19,479 files / 191,008 nodes,
 * i.e. ~25% of the ceiling already consumed and growing with the tree. A repo operating
 * that close to a number chosen for a 50 MiB workload should own that number explicitly
 * rather than inherit whatever a future gitnexus release happens to pick.
 *
 * Originally pinned at the SAME 16 GiB upstream uses (a pin, not a retune). RETUNED to
 * 64 GiB on 2026-09-05 (plan gitnexus-embeddings-enablement-2026-09-05, D-003) from a
 * measurement that falsified the "file size approaches the ceiling" model: the one-shot
 * live-root bootstrap (`--force --embeddings 0`, /tmp/wi39394/bootstrap-live2/run.log) hit
 * "Maximum database size of 17179869184 bytes has been reached" → "manual WAL checkpoint
 * failed after retries" → SIGSEGV three seconds into the embedding INSERT phase, while the
 * database FILE sat at 5.27 GB (31% of the ceiling) the whole run and the WAL at 0.8 MB.
 * The identical run on an isolated checkout (same env, same graph, /tmp/wi39394/run4-embed-
 * run.log) passed, the only difference being wall-clock: 74 min of embedding generation
 * under fleet load, with gitnexus's manual WAL-checkpoint driver firing every 5 s
 * throughout, versus 28 min. So the ceiling is a bound on the buffer manager's VIRTUAL
 * frame reservation — which the checkpoint cadence consumes and the file size does not
 * report — not on bytes on disk. 64 GiB is still VA only (VmSize already reads 230 GiB
 * against a 10 GiB VmHWM), keeps the 0.6 alert ratio meaningful (38 GiB against a 5.3 GB
 * file), and stays far under the 64-bit mmap ceiling. Per D-016 a mid-analyze failure
 * leaves orphan shadow/WAL residue gitnexus cannot itself recover from, which is why the
 * cliff is moved rather than watched.
 */
export const GITNEXUS_LBUG_MAX_DB_BYTES = 64 * 1024 * 1024 * 1024;

/** Alert before the LadybugDB mmap ceiling becomes an outage cliff. */
export const GITNEXUS_LBUG_DB_ALERT_RATIO = 0.6;

/**
 * The LadybugDB BUFFER POOL — a different resource from GITNEXUS_LBUG_MAX_DB_BYTES above,
 * and the distinction is the whole reason this constant exists. The max-DB-size pin is a
 * virtual-address reservation (cheap to raise). This is RESIDENT memory, so it is sized
 * deliberately rather than maximised.
 *
 * MEASURED 2026-09-02 (EI-22172147268902766): a full rebuild of this repo died ~20 minutes
 * in with "COPY failed for File: Buffer manager exception: Unable to allocate memory! The
 * buffer pool is full and no memory could be freed!" — gitnexus 1.6.10 defaults the pool to
 * `min(2 GiB, 80% RAM)`, i.e. 2 GiB here, and the bulk COPY of a 22,394-file / 238,521-node
 * graph exhausts it. Raising the NODE heap does nothing for this: the pool is LadybugDB
 * native memory, which is why the failing run had a 193 GB heap and still died.
 *
 * 8 GiB, not upstream's suggested 4 GiB: the on-disk database is already 5.1 GiB and grows
 * with the tree, and 4 GiB is the generic example from the error string rather than a number
 * measured against this repo. 8 GiB is ~3% of host RAM — real headroom, still bounded.
 *
 * NOT `0`. Zero is gitnexus's escape hatch restoring LadybugDB's native 80%-of-RAM default,
 * which on this 251 GB box means a ~200 GB RESIDENT pool on a machine shared by ~50 checkouts
 * and the agent fleet. The failure mode it trades into is worse than the one it fixes.
 */
export const GITNEXUS_LBUG_BUFFER_POOL_BYTES = 8 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// EMBEDDINGS — plan gitnexus-embeddings-enablement-2026-09-05 (WI-39394), D-002.
//
// gitnexus 1.6.9 semantics that these three constants pin (core/embedding-mode.js,
// core/embeddings/config.js, cli/analyze.js):
//   * `--embeddings [limit]` ENABLES generation; without it an analyze only PRESERVES
//     embeddings already in the index and never embeds a new node. `limit` overrides the
//     50,000-node safety cap (DEFAULT_EMBEDDING_NODE_LIMIT); `0` disables the cap. This
//     graph is 246,622 nodes, so the default cap would SKIP embedding wholesale with a
//     notice — measured 2026-09-04 ("--embeddings 50000" run → 0 embeddings).
//   * `GITNEXUS_EMBEDDING_DEVICE` is read by resolveEmbeddingConfig ahead of any CLI
//     override; `cuda` falls back to cpu INSIDE gitnexus when the CUDA provider cannot load
//     (embedder devicesToTry), so pinning cuda is never a hard dependency on the GPU.
//   * `GITNEXUS_EMBEDDING_THREADS` is the onnxruntime intra-op thread count (default 4).
// ---------------------------------------------------------------------------

/**
 * `--embeddings <cap>` — 0 = UNCAPPED. Anything else silently re-arms the node-count skip
 * on this graph (246,622 nodes vs the 50,000 default), which is exactly the failure that kept
 * the vector leg at 0 embeddings for a month. Measured 2026-09-05: the uncapped cold pass over
 * the full graph completes (217,120 embeddings, exit 0) — see the module header for cost.
 */
export const GITNEXUS_EMBEDDINGS_NODE_CAP = 0;

/** Embedding device pin. `cuda` on this box (RTX, ~1.3 GiB used at 47–79% util for the
 *  whole pass); gitnexus falls back to cpu internally if the CUDA provider is unavailable. */
export const GITNEXUS_EMBEDDING_DEVICE = 'cuda';

/** onnxruntime intra-op threads for the embedder. gitnexus's own default is 4; pinned so a
 *  future upstream default change cannot silently move the CPU envelope of the hourly tick. */
export const GITNEXUS_EMBEDDING_THREADS = 4;

/** P-012 (D-016) — glibc malloc arena cap for the analyze child. Uncapped, glibc grows up to
 *  8×cores arenas; measured 2026-09-27 the analyze's native heap reached ~7.9 GB of arenas
 *  against a 1.1 GB V8 heap, filled its own 24 GiB cgroup and was pushed 11 GB into swap. */
export const GITNEXUS_ANALYZE_MALLOC_ARENA_MAX = 2;

/** P-012 (D-017) — gitnexus's manual WAL checkpoint driver. It forces a CHECKPOINT every 5 s
 *  during analyze to dodge a Windows rename race (AV / Defender file locks) that Linux does
 *  not have; here it paced the whole LBUG phase — ~6 s cycles of ~10 MB rewrite + 9 fdatasync,
 *  25.5 GB written for a 5.4 GB db at ~2% CPU. '0' is gitnexus's documented opt-out; the
 *  engine's own auto-checkpoint (64 MiB WAL threshold) stays on, so durability is unchanged. */
export const GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX = '0';

/** Skip when the box is genuinely oversubscribed — load ABOVE 1.5x cores means real run-queue
 *  queueing, and a 4-minute CPU-heavy index is exactly the wrong thing to pile on. (This box
 *  is 128 cores and idles around 0.5/core, so this defers only during a real storm.) */
export const DEFAULT_MAX_LOAD_PER_CORE = 1.5;

/** Any real commit is worth refreshing for; the interval floor below is what actually
 *  bounds the cost. */
export const DEFAULT_MIN_COMMITS_BEHIND = 1;

/** Never re-index more often than this, whatever the tick says. At ~234s a run, a 45min
 *  floor caps the steady-state duty cycle at roughly 9% of one core-set. */
export const DEFAULT_MIN_INTERVAL_SEC = 45 * 60;

export function integrationRoot(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
}

export function registryPath(): string {
  return process.env.GITNEXUS_REGISTRY_PATH ?? path.join(os.homedir(), '.gitnexus', 'registry.json');
}

export interface GitnexusRegistryEntry {
  name: string;
  path?: string;
  lastCommit?: string;
  indexedAt?: string;
}

/**
 * Read one repo's entry out of `~/.gitnexus/registry.json`. Every failure mode — file
 * absent, unparseable, not an array, alias not present — collapses to `null`, which the
 * decision below reads as "no index" and therefore "build one". A missing registry must
 * never throw a routine tick.
 */
export function readRegistryEntry(file: string, repoName: string): GitnexusRegistryEntry | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return null;
    const hit = raw.find((e) => e && typeof e === 'object' && (e as { name?: unknown }).name === repoName);
    return (hit as GitnexusRegistryEntry | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The two freshness fields the cadence gates consume, plus which writer's record won. */
export interface IndexFreshness {
  indexedAt: string | null;
  lastCommit: string | null;
  /** `meta` when `.gitnexus/meta.json` carries a newer completed index than the registry row. */
  source: 'registry' | 'meta' | 'none';
}

/**
 * Read `indexedAt` + `lastCommit` off `.gitnexus/meta.json` — the record gitnexus's `saveMeta`
 * writes the moment an analyze's index is complete and consistent. Fail-soft: an absent,
 * unreadable or mid-write file yields `null`, never a throw, so the registry read stays the
 * fallback. A meta still carrying `incrementalInProgress` is a build that has NOT completed
 * (its `indexedAt` is the PREVIOUS run's, spread forward), so it is reported as `null` rather
 * than as a completion.
 */
export function readIndexMetaFreshness(root: string): Pick<IndexFreshness, 'indexedAt' | 'lastCommit'> | null {
  try {
    const m: unknown = JSON.parse(readFileSync(gitnexusMetaPath(root), 'utf8'));
    if (typeof m !== 'object' || m === null) return null;
    const rec = m as Record<string, unknown>;
    if (readIncompleteIndexMarker(rec) !== null) return null;
    return {
      indexedAt: typeof rec.indexedAt === 'string' ? rec.indexedAt : null,
      lastCommit: typeof rec.lastCommit === 'string' ? rec.lastCommit : null,
    };
  } catch {
    return null;
  }
}

/**
 * PURE — pick the freshness record the cadence gates should trust.
 *
 * The index's freshness has TWO writers with different failure modes, and the interval floor
 * and the commits-behind gate must read the one that reflects the last COMPLETED analyze:
 *
 *  - `~/.gitnexus/registry.json` — written by gitnexus's `registerRepo`, which runs at the
 *    tail of a run, AFTER `saveMeta` and the parse-cache save. Measured 2026-09-05 (WI-39394):
 *    the live tick that completed at 20:19:38Z (meta.json `indexedAt`) left the registry at
 *    the seed's 17:07:51Z — that run had been orphaned from its bg-host by an external restart
 *    at 19:16Z and its registry write never landed — so the next fire, at 20:32Z, read the
 *    index as 3.4h old and 196 commits behind, sailed past the 45-minute floor, and launched a
 *    second 107-minute full pass 13 minutes after the first one finished.
 *  - `.gitnexus/meta.json` — written by `saveMeta` once the index is complete; it is what
 *    gitnexus itself trusts for its incremental decision and what `judgeCanary` reads.
 *
 * So: the FRESHER `indexedAt` of the two wins, carrying its own `lastCommit`. A lost registry
 * write then costs a stale `gitnexus list` row instead of a duplicate full pass. The registry
 * is still what decides `registered` (a repo the MCP cannot resolve by name must be rebuilt
 * regardless of how fresh the files under it are).
 */
export function pickIndexFreshness(
  registry: Pick<GitnexusRegistryEntry, 'indexedAt' | 'lastCommit'> | null,
  meta: Pick<IndexFreshness, 'indexedAt' | 'lastCommit'> | null,
): IndexFreshness {
  const ms = (s: string | null | undefined): number => (typeof s === 'string' ? Date.parse(s) : Number.NaN);
  const regMs = ms(registry?.indexedAt);
  const metaMs = ms(meta?.indexedAt);
  if (Number.isFinite(metaMs) && (!Number.isFinite(regMs) || metaMs > regMs)) {
    return {
      indexedAt: meta!.indexedAt,
      lastCommit: meta!.lastCommit ?? registry?.lastCommit ?? null,
      source: 'meta',
    };
  }
  if (Number.isFinite(regMs)) {
    return { indexedAt: registry!.indexedAt!, lastCommit: registry!.lastCommit ?? null, source: 'registry' };
  }
  return { indexedAt: null, lastCommit: registry?.lastCommit ?? meta?.lastCommit ?? null, source: 'none' };
}

/**
 * How many commits HEAD is ahead of the indexed commit. `null` means "unknowable" — the
 * indexed sha is no longer in this history (a rebase, a prune, a fresh clone), which the
 * decision treats as a reason to refresh rather than to skip.
 */
export function countCommitsBehind(root: string, indexedCommit: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['rev-list', '--count', `${indexedCommit}..HEAD`],
      { cwd: root, timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolvePromise(null);
        const n = Number.parseInt(String(stdout).trim(), 10);
        resolvePromise(Number.isFinite(n) ? n : null);
      },
    );
  });
}

export interface ReindexDecisionInput {
  /** Is the repo present in the gitnexus registry at all? */
  registered: boolean;
  /** Commits HEAD is ahead of the indexed sha; `null` = unknowable (see countCommitsBehind). */
  commitsBehind: number | null;
  /** 1-minute loadavg divided by core count. */
  loadPerCore: number;
  /** Age of the current index in seconds; `null` when unknown. */
  secondsSinceIndexed: number | null;
  /**
   * The memory-pressure band returned by the shared perf-budget writer. `null` means
   * the capture is absent/stale/unmeasured; do not turn that uncertainty into a block.
   */
  memoryPressure?: 'ok' | 'warn' | 'crit' | null;
  /** The writer's first reason, retained for an actionable skip log. */
  memoryPressureReason?: string | null;
  /**
   * Free bytes on the index's filesystem (measureFreeDiskBytes). `null`/omitted = could not
   * be measured; like memory pressure, that uncertainty never becomes a block.
   */
  freeDiskBytes?: number | null;
  /** What a full rebuild needs free (requiredFreeDiskBytes); ignored when freeDiskBytes is null. */
  requiredFreeDiskBytes?: number;
  /** Portion of requiredFreeDiskBytes reserved for PostgreSQL/shared critical writers. */
  protectedReserveBytes?: number;
  minCommitsBehind: number;
  maxLoadPerCore: number;
  minIntervalSec: number;
}

export interface ReindexDecision {
  run: boolean;
  reason: string;
}

/**
 * The entire cadence policy, pure and order-sensitive:
 *
 *  1. LOAD FIRST — it protects the box, so it outranks even a missing index. Deferring
 *     costs one hour; piling a 4-minute indexer onto an already-queueing box costs
 *     everyone.
 *  2. PSI MEMORY PRESSURE ⇒ defer. The perf-budget writer is the canonical owner of
 *     `some avg60 ≥ 10%` (sustained reclaim) and `full avg60 ≥ 5%` (thrashing). A full
 *     GitNexus analyze is a large memory consumer, so starting it during either band
 *     recreates the host-pressure incident this routine is meant to avoid. A null band
 *     means the capture is absent, stale, or missing a leg; it is intentionally fail-soft
 *     and does not invent pressure from missing data.
 *  3. LOW DISK ⇒ defer. A full rebuild writes a second database beside the live one and
 *     streams its embedding insert through a WAL; admitted into a nearly-full filesystem it
 *     runs its whole ~2h pass and then dies on ENOSPC — and, because Postgres shares `/`
 *     here, takes the operator database into PANIC/recovery with it (measured 2026-09-05,
 *     see GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES). This outranks a missing index for the same
 *     reason load does: the build cannot succeed, and attempting it hurts the box. An
 *     unmeasurable free-space reading is fail-soft, like a null memory band.
 *  4. NO INDEX ⇒ build. A missing graph is the WI-6445 failure mode (every lookup)
 *     returns "Symbol not found" while every call still looks well-formed), so it
 *     bypasses both the interval floor and the staleness check.
 *  5. INTERVAL FLOOR — bounds steady-state cost regardless of how fast commits land.
 *  6. STALENESS — the ordinary skip: nothing changed, nothing to do.
 */
export function decideReindex(i: ReindexDecisionInput): ReindexDecision {
  if (i.loadPerCore > i.maxLoadPerCore) {
    return {
      run: false,
      reason: `box oversubscribed (load/core ${i.loadPerCore.toFixed(2)} > ${i.maxLoadPerCore}) — deferring to the next tick`,
    };
  }
  if (i.memoryPressure === 'warn' || i.memoryPressure === 'crit') {
    return {
      run: false,
      reason:
        `memory pressure ${i.memoryPressure} — deferring GitNexus analyze to the next tick` +
        (i.memoryPressureReason ? ` (${i.memoryPressureReason})` : ''),
    };
  }
  if (i.freeDiskBytes != null && Number.isFinite(i.freeDiskBytes)) {
    const need = i.requiredFreeDiskBytes ?? requiredFreeDiskBytes(null);
    if (i.freeDiskBytes < need) {
      const protectedReserve =
        i.protectedReserveBytes != null && Number.isFinite(i.protectedReserveBytes) && i.protectedReserveBytes > 0
          ? i.protectedReserveBytes
          : 0;
      return {
        run: false,
        reason:
          `low disk (${gib(i.freeDiskBytes)} free on the index filesystem < ${gib(need)} a full rebuild needs` +
          (protectedReserve > 0 ? `, including ${gib(protectedReserve)} protected for PostgreSQL/shared writers` : '') +
          ') — ' +
          'deferring to the next tick; a rebuild admitted here dies on ENOSPC after its whole pass and can PANIC Postgres',
      };
    }
  }
  if (!i.registered) {
    return { run: true, reason: 'no gitnexus index registered for this repo — cold build' };
  }
  if (i.secondsSinceIndexed != null && i.secondsSinceIndexed < i.minIntervalSec) {
    return {
      run: false,
      reason: `indexed ${Math.round(i.secondsSinceIndexed / 60)}min ago, under the ${Math.round(i.minIntervalSec / 60)}min floor`,
    };
  }
  if (i.commitsBehind == null) {
    return { run: true, reason: 'indexed commit is not in the current history (rebase/prune) — refreshing' };
  }
  if (i.commitsBehind < i.minCommitsBehind) {
    return { run: false, reason: `only ${i.commitsBehind} commit(s) behind (floor ${i.minCommitsBehind})` };
  }
  return { run: true, reason: `${i.commitsBehind} commits behind HEAD` };
}

/**
 * The ONE place the analyze argv is built. `--skip-agents-md` is not optional and is not
 * a caller's choice — see this module's header for what happens without it. `--embeddings`
 * is likewise not a caller's choice: dropping it does not disable embeddings, it FREEZES
 * them (existing ones are preserved, new nodes are never embedded), see the header.
 * `--force` is not a caller's choice either: without it gitnexus takes the INCREMENTAL
 * writeback that breaches the LadybugDB ceiling and segfaults on this graph (header, D-002).
 *
 * `--embeddings` takes an OPTIONAL value in gitnexus's commander definition, so it is placed
 * LAST — a positional after it would be swallowed as the cap. `--force` therefore goes
 * BEFORE it, never after.
 */
export function buildAnalyzeArgs(
  root: string,
  repoName: string,
  embeddingsNodeCap: number = GITNEXUS_EMBEDDINGS_NODE_CAP,
): string[] {
  return [
    'analyze',
    root,
    '--skip-agents-md',
    '--name',
    repoName,
    '--force',
    '--embeddings',
    String(embeddingsNodeCap),
  ];
}

/**
 * PURE — does this argv ask gitnexus to GENERATE embeddings? Derived from the argv rather
 * than restated as a second boolean so the canary's expectation cannot drift from what the
 * spawn actually passed (`cli/analyze.js`: `embeddingsEnabled = !!options.embeddings`, and
 * `--embeddings 0` is the truthy string "0", i.e. enabled + uncapped).
 */
export function analyzeEmbeddingsExpected(args: readonly string[] = buildAnalyzeArgs('.', GITNEXUS_REPO_NAME)): boolean {
  return args.includes('--embeddings');
}

/**
 * P-004 — the environment that CAPS the analyze child (see GITNEXUS_ANALYZE_HEAP_MB).
 *
 * Setting `--max-old-space-size` here is load-bearing in a way that is easy to miss:
 * gitnexus's `ensureHeap()` returns EARLY when NODE_OPTIONS already carries that flag
 * ("A user-supplied NODE_OPTIONS heap wins (no re-exec)" -- its own comment, and the
 * override its OOM error text tells operators to use). So this both applies our cap
 * AND suppresses the self-re-exec that would otherwise replace it with 0.75x-cgroup.
 *
 * Because that early return skips the WHOLE re-exec, every flag gitnexus would have
 * applied there is now ours to carry. Semi-space is legal in NODE_OPTIONS and is set
 * here; --stack-size is NOT (Node 24+) and travels as argv in analyzeNodeArgs. Dropping
 * either would trade an OOM risk for a GC-churn or stack-overflow regression, and a
 * mid-analyze crash is not a cheap failure here -- it leaves the orphan shadow/WAL
 * residue that D-016 showed is unrecoverable by gitnexus itself.
 *
 * An operator-supplied heap is honoured untouched: this cap exists to stop gitnexus
 * granting ITSELF the whole shared cgroup, not to override a human who chose a value.
 */
export function analyzeEnv(
  base: NodeJS.ProcessEnv,
  heapMb: number = GITNEXUS_ANALYZE_HEAP_MB,
  semiSpaceMb: number = GITNEXUS_ANALYZE_SEMI_SPACE_MB,
  sourceLimitKb?: number,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (sourceLimitKb != null && base.GITNEXUS_MAX_FILE_SIZE != null) {
    const configured = Number(base.GITNEXUS_MAX_FILE_SIZE);
    if (!Number.isInteger(configured) || configured < sourceLimitKb) {
      throw new Error(`GITNEXUS_MAX_FILE_SIZE=${base.GITNEXUS_MAX_FILE_SIZE}KB excludes a selective corpus source requiring ${sourceLimitKb}KB`);
    }
  }
  // The LadybugDB ceiling is pinned on every spawn, independent of the heap branch
  // below: an operator overriding the HEAP must not silently also drop the DB pin.
  // An explicit caller-supplied value still wins.
  //
  // The buffer pool is pinned on the same terms and for a sharper reason: its default
  // (2 GiB) is not a ceiling nobody reaches but a wall this repo HITS — it is what killed
  // the 2026-09-02 rebuild. It rides in the same branch-independent object because the
  // heap and the pool are separate resources, so an operator tuning NODE_OPTIONS must not
  // silently drop the one that node flags cannot influence at all.
  //
  // The embedding device/threads ride here too (D-002): gitnexus reads them from env in
  // resolveEmbeddingConfig, an explicit caller value still wins, and — like the pool — no
  // node flag can influence them, so they must not depend on the heap branch either.
  //
  // The malloc arena cap and the WAL-checkpoint opt-out (P-012) are native-side for the same
  // reason. The opt-out is Linux-only: the driver it disables exists for a Windows rename race.
  const withDbCap: NodeJS.ProcessEnv = {
    ...base,
    ...(sourceLimitKb == null ? {} : { GITNEXUS_MAX_FILE_SIZE: base.GITNEXUS_MAX_FILE_SIZE ?? String(sourceLimitKb) }),
    GITNEXUS_LBUG_MAX_DB_SIZE: base.GITNEXUS_LBUG_MAX_DB_SIZE ?? String(GITNEXUS_LBUG_MAX_DB_BYTES),
    GITNEXUS_LBUG_BUFFER_POOL_SIZE:
      base.GITNEXUS_LBUG_BUFFER_POOL_SIZE ?? String(GITNEXUS_LBUG_BUFFER_POOL_BYTES),
    GITNEXUS_EMBEDDING_DEVICE: base.GITNEXUS_EMBEDDING_DEVICE ?? GITNEXUS_EMBEDDING_DEVICE,
    GITNEXUS_EMBEDDING_THREADS: base.GITNEXUS_EMBEDDING_THREADS ?? String(GITNEXUS_EMBEDDING_THREADS),
    MALLOC_ARENA_MAX: base.MALLOC_ARENA_MAX ?? String(GITNEXUS_ANALYZE_MALLOC_ARENA_MAX),
    ...(platform === 'linux'
      ? { GITNEXUS_WAL_MANUAL_CHECKPOINT: base.GITNEXUS_WAL_MANUAL_CHECKPOINT ?? GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX }
      : {}),
  };
  const existing = (withDbCap.NODE_OPTIONS ?? '').trim();
  if (/--max-old-space-size/.test(existing)) return withDbCap;
  const semi = /--max-semi-space-size/.test(existing) ? '' : ` --max-semi-space-size=${semiSpaceMb}`;
  return {
    ...withDbCap,
    NODE_OPTIONS: `${existing} --max-old-space-size=${heapMb}${semi}`.trim(),
  };
}

/**
 * P-004 — argv for spawning the PINNED gitnexus CLI under our own node.
 *
 * Two reasons this no longer goes through `npx`:
 *   1. npx does not forward node flags to the target, and --stack-size can ONLY be an
 *      argv flag (illegal in NODE_OPTIONS on Node 24+), so the cap is not expressible
 *      through the npx form at all.
 *   2. P-003 pinned an exact operator-owned gitnexus for precisely this reason and
 *      `canaryBin()` already reads it; the analyze spawn was still resolving `gitnexus`
 *      through ambient npx, so the two halves of this module disagreed about which
 *      binary "gitnexus" means.
 *
 * Fewer wrapper layers also makes the timeout kill STRICTER, not looser: the old chain
 * was npx -> sh -c -> node -> re-exec'd node, and only the process-group kill reached
 * the leaf. Here the child IS the worker.
 */
export function analyzeNodeArgs(
  cliPath: string,
  root: string,
  repoName: string,
  stackKb: number = GITNEXUS_ANALYZE_STACK_KB,
): string[] {
  return [`--stack-size=${stackKb}`, cliPath, ...buildAnalyzeArgs(root, repoName)];
}

/** The pinned gitnexus CLI entrypoint. `canaryBin()` resolves the same install; this
 *  resolves the JS entry node executes directly rather than the .bin shim. */
export function analyzeCliPath(): string {
  return (
    process.env.PAPERCUSP_GITNEXUS_CLI ??
    path.join(os.homedir(), '.papercusp', 'vendor', 'gitnexus', 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js')
  );
}

/**
 * Put the expensive graph rebuild behind the repository's existing host-wide
 * heavy-work admission wrapper. The wrapper is resolved from the integration
 * root rather than from the operator process's cwd, because routine fires can
 * run from a package or service directory. A partial install or a repo-less
 * harness must remain able to run the action, so an absent wrapper deliberately
 * falls back to the original direct invocation.
 */
export function buildAnalyzeInvocation(
  root: string,
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const pcHeavyPath = path.join(root, 'scripts', 'pc-heavy.sh');
  if (!existsSync(pcHeavyPath)) {
    return { command, args: [...args] };
  }
  return { command: 'bash', args: [pcHeavyPath, '--', command, ...args] };
}

// ---------------------------------------------------------------------------
// CRASH-RESIDUE PREFLIGHT — one policy over the whole (db x shadow x wal) state space.
//
// `gitnexus analyze` writes a `.gitnexus/lbug.shadow` (+ `.gitnexus/lbug.wal.checkpoint`)
// WHILE building, then promotes it to the real `.gitnexus/lbug` database file on success.
// A kill anywhere in that sequence leaves residue, and the residue is UNRECOVERABLE BY
// GITNEXUS ITSELF — which turns one dead process into a permanent, self-perpetuating
// wedge, because every later tick re-runs the same doomed sequence.
//
// There are TWO such residues, one on each side of the promote, and they fail in
// OPPOSITE directions:
//
//   (a) ORPHAN SHADOW — killed BEFORE the promote: shadow present, db ABSENT.
//       `analyze` then refuses to start at all ("Found shadow file ... but no
//       corresponding database file"). Measured 2026-08-08 (WI-35532): 66/66
//       consecutive hourly ticks failed this way, ~4.6 CPU-hours burned, silently.
//
//   (b) ORPHAN WAL — killed AFTER the promote: db present, shadow ABSENT, `lbug.wal`
//       left holding pending data. `analyze` starts fine, but every READ-ONLY OPEN now
//       replays that WAL and SEGFAULTS in the native LadybugDB binding. Measured
//       2026-08-21 (D-016): the 20-minute analyze timeout SIGKILLed the process group
//       at 04:55:34Z (fire 04:35:33Z + 20m01s), and from that moment BOTH the CLI and
//       the MCP bridge child died on every call — GitNexus was 100% dead fleet-wide
//       while still advertising 17 working tools.
//
// WHY (b) NEEDED ITS OWN ARM. The original guard's predicate was `shadow && !db`, which
// is the OPPOSITE CORNER of the same 2x2 — with the shadow absent it no-ops, so the
// wedge it was written to end recurred verbatim in the direction it did not test. The
// lesson, recorded as D-016: a crash-consistency guard must cover the whole state space
// of the artifacts it protects, not the one corner that was observed failing.
//
// WHY DELETING THE WAL HERE IS SAFE, precisely. Two measured facts, not assumptions:
//   1. A healthy index carries NO wal — verified 2026-08-21 by running repeated
//      successful reads and re-listing `.gitnexus/`: only `lbug` is present, never a
//      wal. So reads never produce one, and a wal is therefore always a WRITER's
//      residue rather than ordinary steady state.
//   2. This preflight runs immediately BEFORE we spawn a full `analyze`, which rebuilds
//      the index wholesale. Any pending WAL data is about to be superseded by that
//      rebuild, so discarding it cannot lose information the next step would have used.
// A wal sitting ALONGSIDE a shadow is a build genuinely in progress and is never
// touched, which is what keeps (b) from firing on a concurrent analyze.
//
// Raising GITNEXUS_ANALYZE_TIMEOUT_MS is deliberately NOT the fix (D-016): it moves the
// cliff without removing it, and ANY SIGKILL — timeout, OOM, reboot — reproduces the
// same residue. Recovery has to be unconditional.
// ---------------------------------------------------------------------------

export interface GitnexusDbPaths {
  db: string;
  shadow: string;
  walCheckpoint: string;
  /** Pending write-ahead log. Present only while a writer is mid-flight — or as residue. */
  wal: string;
}

export function gitnexusDbPaths(root: string): GitnexusDbPaths {
  const dir = path.join(root, '.gitnexus');
  return {
    db: path.join(dir, 'lbug'),
    shadow: path.join(dir, 'lbug.shadow'),
    walCheckpoint: path.join(dir, 'lbug.wal.checkpoint'),
    wal: path.join(dir, 'lbug.wal'),
  };
}

/** PURE — killed BEFORE the promote: a shadow with no promoted database beside it. */
export function isOrphanShadow(dbExists: boolean, shadowExists: boolean): boolean {
  return shadowExists && !dbExists;
}

/**
 * The `incrementalInProgress` marker gitnexus writes into `.gitnexus/meta.json` while a
 * build is mid-flight, as read back AFTER a failed analyze.
 *
 * ⚠ This is deliberately a REPORTER, not a repairer, and that is the whole design decision
 * (EI-22172147268902766). The obvious "fix" — clear the stranded marker so the next tick
 * stops being forced into a full rebuild — is actively harmful: the marker is what tells
 * gitnexus the index is half-written, so clearing it converts a loud, correct "forcing full
 * rebuild to restore a known-good index" into a SILENT stale/torn index served as if clean.
 * Forcing the rebuild is the right response to a dirty index; the real defect was that the
 * rebuild could not succeed (see GITNEXUS_LBUG_BUFFER_POOL_BYTES).
 *
 * What was genuinely missing is VISIBILITY. A failed analyze leaves the marker set, so every
 * subsequent hourly tick is forced into the same ~20-minute full rebuild and fails the same
 * way — a doom loop whose alert previously read only "exited 1", with nothing to distinguish
 * a one-off failure from an index wedged into permanent rebuild-and-fail.
 */
export interface GitnexusIncompleteIndex {
  /** The build phase gitnexus recorded (e.g. 'full-rebuild'), when it named one. */
  phase: string | null;
  /** When the stranded build started, epoch ms, when recorded. */
  startedAt: number | null;
  /** Pending writes at the moment it died — the "last dirty state: toWrite=N" figure. */
  toWriteCount: number | null;
}

/** Path to the metadata file carrying the marker above. */
export function gitnexusMetaPath(root: string): string {
  return path.join(root, '.gitnexus', 'meta.json');
}

/**
 * PURE — extract the marker from already-parsed meta.json content.
 *
 * Split from the read so the interesting half is testable without a filesystem, and so a
 * malformed/absent marker is in-band `null` rather than a throw: this runs on the FAILURE
 * path, where a second exception would replace a real diagnosis with a plumbing error.
 */
export function readIncompleteIndexMarker(meta: unknown): GitnexusIncompleteIndex | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const marker = (meta as { incrementalInProgress?: unknown }).incrementalInProgress;
  if (typeof marker !== 'object' || marker === null) return null;
  const m = marker as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    phase: typeof m.phase === 'string' ? m.phase : null,
    startedAt: num(m.startedAt),
    toWriteCount: num(m.toWriteCount),
  };
}

/**
 * Read the marker off disk. Fail-soft in BOTH directions: an unreadable or unparseable
 * meta.json yields `null` (unknown), never a throw, because the caller is already reporting
 * a failure and must not lose it to a diagnostic.
 *
 * ⚠ `null` means "no stranded marker OBSERVED" — absence of evidence. meta.json is ~3 MB of
 * mostly fileHashes and can legitimately be unreadable mid-write, so callers must phrase it
 * as unobserved rather than as a positive all-clear.
 */
export function readStrandedIncompleteIndex(root: string): GitnexusIncompleteIndex | null {
  try {
    return readIncompleteIndexMarker(JSON.parse(readFileSync(gitnexusMetaPath(root), 'utf8')));
  } catch {
    return null;
  }
}

/** PURE — the operator-facing one-liner for a stranded index, or '' when none was observed. */
export function describeStrandedIncompleteIndex(marker: GitnexusIncompleteIndex | null): string {
  if (marker === null) return '';
  const bits = [
    marker.phase ? `phase=${marker.phase}` : null,
    marker.toWriteCount !== null ? `toWrite=${marker.toWriteCount}` : null,
    marker.startedAt !== null ? `startedAt=${new Date(marker.startedAt).toISOString()}` : null,
  ].filter(Boolean);
  return (
    ` ⚠ The index is left INCOMPLETE (incrementalInProgress${bits.length ? `: ${bits.join(' ')}` : ''}), ` +
    `so every subsequent tick is forced into a fresh FULL rebuild until one succeeds — if this ` +
    `repeats, the failure is wedged, not intermittent. The marker is deliberately NOT cleared: it ` +
    `is what stops a half-written index being served as if it were clean.`
  );
}

/**
 * PURE — killed AFTER the promote: a pending WAL beside a real database, with no shadow
 * to say a build is in flight. This is the read-path poison (D-016).
 *
 * The `!shadowExists` term was what made this look safe to act on: shadow-present means a
 * build is genuinely running and its WAL is live data, not residue. The CONVERSE is false —
 * shadow-absent does not mean no build is running: a healthy analyze spends its whole
 * post-promote phase (the embedding insert) with exactly this shape. `cleanCrashResidue`
 * therefore corroborates this predicate with the WAL's own open handles before acting
 * (WI-2146606); on its own it is a shape test, not a liveness verdict.
 */
export function isOrphanWal(dbExists: boolean, shadowExists: boolean, walExists: boolean): boolean {
  return walExists && dbExists && !shadowExists;
}

/**
 * A shadow that is EMPTY and has not been touched for this long is not a build in
 * flight. Sized far above any plausible gap between a live analyze creating the shadow
 * file and writing its first byte, so a genuinely running build is never mistaken for
 * residue — the direction that matters, since acting on a live build corrupts it.
 */
export const DEAD_SHADOW_STALE_MS = 5 * 60_000;

/**
 * PURE — THE THIRD RESIDUE STATE. Observed live 2026-08-21T06:55Z, which is how it was
 * found: the 06:35 analyze hit its 20-minute timeout at 1198s, was SIGKILLed mid-build,
 * and left `lbug` (3.97 GiB, the intact 05:45 index) + `lbug.shadow` at ZERO BYTES +
 * `lbug.wal.checkpoint`. Every read then segfaulted (`gitnexus cypher` exit 139, core
 * dumped) — GitNexus dead for the whole fleet.
 *
 * NEITHER existing arm fires on it, which is the actual defect:
 *   isOrphanShadow = shadowExists && !dbExists   -> false, the database exists
 *   isOrphanWal    = walExists && dbExists && !shadowExists -> false, a shadow exists
 * So cleanCrashResidue returned kind:'none', the poison stayed, and the next tick would
 * re-run the same doomed sequence — precisely the self-perpetuating wedge this module's
 * header says the residue policy exists to prevent.
 *
 * The gap is in the `!shadowExists` term. Its stated reasoning is sound — "shadow-present
 * means a build is genuinely running and its WAL is live data, not residue" — but it
 * treats the shadow's EXISTENCE as proof of liveness. A zero-byte shadow proves the
 * opposite: a build that died before writing anything. Emptiness plus staleness
 * distinguishes the two without ever touching a live build.
 */
export function isDeadShadow(
  shadowExists: boolean,
  shadowSizeBytes: number,
  shadowAgeMs: number,
): boolean {
  return shadowExists && shadowSizeBytes === 0 && shadowAgeMs > DEAD_SHADOW_STALE_MS;
}

// ---------------------------------------------------------------------------
// THE OPEN-HANDLE DISCRIMINATOR (2026-08-23) — replacing a proxy with the fact.
//
// Every predicate above keys "is a build in flight?" on the shadow's SIZE. `size === 0`
// was chosen to mean "the writer is dead", but what it actually means is "the writer
// died at ONE PARTICULAR INSTANT" — after creating the shadow and before its first byte.
// A SIGKILL landing a second later leaves a NON-ZERO orphan that is byte-for-byte
// indistinguishable from a healthy live build, so it slips past BOTH size-keyed sites:
// `isDeadShadow` (the next tick's preflight) and the `writerKnownDead` branch (the kill
// site). Nothing then ever clears it, every read-only query fails with "Couldn't replay
// shadow pages under read-only mode", and the fleet-wide outage recurs looking like a
// brand-new bug.
//
// Not hypothetical: at 2026-08-23T20:50Z the live mid-analyze shadow on this box
// measured 800,280 bytes. A kill in that window strands exactly that shape.
//
// So stop testing the PROXY and test the FACT it proxies: does any process still hold
// the shadow open? A file no process has open cannot be being written to — that is a
// kernel guarantee, not an inference from a byte count or a clock.
// ---------------------------------------------------------------------------

/** The kernel appends this to an fd symlink whose file has been unlinked. */
const PROC_FD_DELETED_SUFFIX = ' (deleted)';

export interface OpenHandleProbe {
  /**
   * The scan itself ran to completion. FALSE means we learned nothing — no `/proc`
   * (non-Linux, or a container without it), or the target vanished — and the verdict is
   * UNKNOWN. It must never be read as "nobody has it open".
   */
  ok: boolean;
  /** Pids observed holding the path open (any mode). For a SHADOW, non-empty ⇒ a writer is alive. */
  holders: number[];
  /**
   * The subset of `holders` whose fd is open for WRITE (`O_WRONLY`/`O_RDWR`, read from
   * `/proc/<pid>/fdinfo/<fd>` flags). This is the discriminator for files READERS also
   * hold — `lbug` (held O_RDONLY by every `gitnexus cypher`/`query` for its lifetime) and
   * `lbug.wal` — where "any holder" would pin the tree as live whenever someone queries
   * it. A holder whose fdinfo cannot be read is COUNTED as a writer: unknown mode fails
   * toward "live", the direction that never corrupts a build (WI-2146606).
   */
  writers: number[];
  /** Process directories whose fd table was read successfully. */
  scannedPids: number;
  /**
   * Process directories that exist but are EACCES to us — almost always root daemons.
   * Reported so the assumption below is auditable rather than silent; see
   * `classifyWriterLiveness` for why it does not by itself force UNKNOWN.
   */
  unreadablePids: number;
}

export type WriterLiveness =
  /** A process holds the shadow open. NEVER touch it, whatever its size or age says. */
  | 'live'
  /** No process holds it. Nothing can be writing to it, whatever its size says. */
  | 'orphaned'
  /** The probe could not answer. Callers must degrade to the size/staleness proxy. */
  | 'unknown';

/**
 * PURE. Turn a probe into the verdict the residue policy actually needs.
 *
 * WHAT THIS PROBE CANNOT DISTINGUISH, stated rather than assumed — which is the whole
 * lesson the size proxy taught, applied to its own replacement:
 *
 *  1. **Another uid's fds.** `/proc/<pid>/fd` is EACCES across a uid boundary, so a
 *     holder running as a different user is invisible and `unreadablePids` counts it.
 *     That deliberately does NOT force 'unknown', because on every surface this ships
 *     to — the dev box and the packaged desktop app — the operator and any manual
 *     `gitnexus analyze` run as the SAME user, so the concurrent writer this exists to
 *     protect is always readable. Forcing 'unknown' on a nonzero count would disable
 *     the fix permanently on any box with a root daemon (i.e. all of them), trading a
 *     real observed outage for a hypothetical root-run analyze on this checkout.
 *  2. **A hard link under a different basename.** The inode cross-check below is
 *     narrowed by basename for cost, so a holder that opened the same inode by another
 *     name reads as absent. Nothing hard-links a LadybugDB shadow.
 *
 * Both unseen cases fail toward 'orphaned'. That is why the CALLER keeps a second,
 * independent corroborator (staleness away from the kill site; its own SIGKILL at it)
 * before acting on 'orphaned' — no single instrument gets to condemn a live build.
 */
export function classifyWriterLiveness(probe: OpenHandleProbe | null): WriterLiveness {
  if (!probe || !probe.ok) return 'unknown';
  return probe.holders.length > 0 ? 'live' : 'orphaned';
}

/**
 * PURE. The `writers`-keyed verdict for files READERS also hold (`lbug`, `lbug.wal`):
 * live only when some process has the file open for WRITE. Same blind spots as
 * `classifyWriterLiveness`, plus one: a holder whose open mode could not be read is
 * counted as a writer (see `OpenHandleProbe.writers`), so this errs toward 'live'.
 */
export function classifyWriteHolderLiveness(probe: OpenHandleProbe | null): WriterLiveness {
  if (!probe || !probe.ok) return 'unknown';
  return probe.writers.length > 0 ? 'live' : 'orphaned';
}

/**
 * Scan `/proc/*​/fd` for any process holding `targetPath` open.
 *
 * ⚠ `holders` vs `writers` — which one answers depends on the FILE. For the shadow, any
 * holder is a writer (nothing else opens a build-in-progress artifact). For `lbug` and
 * `lbug.wal`, readers hold them too — every `gitnexus cypher`/`query` opens the promoted
 * database O_RDONLY — so "any holder" would pin the tree as live for as long as anyone is
 * querying, the opposite failure. Those two files are judged on `writers` only, which is
 * why the probe reads each matching fd's open mode (WI-2146606).
 *
 * ⚠ NOT argv matching. `proc-guard.mjs check "gitnexus analyze"` is a measured FALSE
 * NEGATIVE on the real analyze process — its argv is `…/gitnexus/dist/cli/index.js
 * analyze`, whose basename is `index.js` (EI-21277960228841563). An open fd is a fact
 * about this file; a command line is a string about a process that may not even be the
 * one holding it.
 */
export function probeOpenHandles(targetPath: string, procRoot = '/proc'): OpenHandleProbe {
  const probe: OpenHandleProbe = { ok: false, holders: [], writers: [], scannedPids: 0, unreadablePids: 0 };

  let targetDev: number;
  let targetIno: number;
  try {
    const st = statSync(targetPath);
    targetDev = st.dev;
    targetIno = st.ino;
  } catch {
    // The target is gone. Callers gate this behind their own existence check, so rather
    // than claim a confident "no holders" for a file that isn't there, stay UNKNOWN and
    // let that existence check remain the authority on the vanished case.
    return probe;
  }

  let canonical = targetPath;
  try {
    canonical = realpathSync(targetPath);
  } catch {
    // Keep the literal path; the inode cross-check below still catches the holder.
  }
  const targetBase = path.basename(canonical);

  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return probe; // No /proc at all — verdict stays UNKNOWN, which is the safe direction.
  }
  probe.ok = true;

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `${procRoot}/${entry}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ENOENT/ESRCH is a process that exited mid-scan — not an unreadable one, and not
      // a holder either way. Only a permission refusal is a blind spot worth counting.
      if (code === 'EACCES' || code === 'EPERM') probe.unreadablePids += 1;
      continue;
    }
    probe.scannedPids += 1;
    const pid = Number(entry);
    let holds = false;
    let writes = false;
    for (const fd of fds) {
      const link = `${fdDir}/${fd}`;
      let dest: string;
      try {
        dest = readlinkSync(link);
      } catch {
        continue; // Closed between readdir and readlink.
      }
      // Sockets, pipes and anon_inodes read as `socket:[1234]` / `pipe:[…]` — never a file.
      if (!dest.startsWith('/')) continue;
      // An UNLINKED file still held open IS a live holder, so strip the kernel's marker
      // rather than skipping the row.
      const clean = dest.endsWith(PROC_FD_DELETED_SUFFIX)
        ? dest.slice(0, -PROC_FD_DELETED_SUFFIX.length)
        : dest;
      let matches = clean === canonical || clean === targetPath;
      if (!matches) {
        // Identity, not spelling: a bind mount or a symlinked parent directory yields the
        // same inode under a different path string, and a pure string compare would miss
        // that holder — the one direction of error that corrupts a live build. Narrowed by
        // basename so this costs one extra stat per genuinely similar fd, not per fd.
        if (path.basename(clean) !== targetBase) continue;
        try {
          const s = statSync(link);
          matches = s.ino === targetIno && s.dev === targetDev;
        } catch {
          // Deleted or vanished between readlink and stat — nothing further to learn.
        }
      }
      if (!matches) continue;
      holds = true;
      // One process may hold the file twice (a read fd and a write fd); keep scanning until
      // a WRITE handle is seen, so a reader-looking first fd cannot hide a writer.
      if (fdOpenForWrite(`${procRoot}/${entry}/fdinfo/${fd}`)) {
        writes = true;
        break;
      }
    }
    if (holds) {
      probe.holders.push(pid);
      if (writes) probe.writers.push(pid);
    }
  }
  return probe;
}

/** `O_ACCMODE` and the two access modes that can write, from <fcntl.h>. */
const O_ACCMODE = 0o3;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;

/**
 * Is the fd behind this `/proc/<pid>/fdinfo/<fd>` entry open for WRITE? The kernel reports
 * the open(2) flags there as an OCTAL `flags:` line. UNREADABLE ⇒ true: when the mode cannot
 * be established the holder is treated as a writer, because the only cost of that error is
 * a spared file, while the opposite error deletes a live build's WAL (WI-2146606).
 */
function fdOpenForWrite(fdinfoPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(fdinfoPath, 'utf8');
  } catch {
    return true;
  }
  const m = /^flags:\s*([0-7]+)\s*$/m.exec(text);
  if (!m) return true;
  const mode = Number.parseInt(m[1], 8) & O_ACCMODE;
  return mode === O_WRONLY || mode === O_RDWR;
}

export interface OrphanShadowCleanup {
  cleaned: boolean;
  removed: string[];
  /** Which residue was found, for a log line that names the failure mode rather than the files. */
  kind: 'none' | 'orphan-shadow' | 'orphan-wal' | 'dead-shadow-wal';
  /**
   * How the shadow's liveness was established this run. Optional so no caller is
   * stranded; present so a journald line can say WHY a shadow was spared or removed
   * instead of leaving the next investigator to re-derive it.
   */
  writerLiveness?: WriterLiveness;
  /**
   * How the WAL's liveness was established — `writers`-keyed (`classifyWriteHolderLiveness`).
   * 'live' means a process holds `lbug.wal` open for write and NOTHING was touched, whatever
   * the shadow said: that is the post-promote embedding insert of an analyze the caller
   * cannot see (WI-2146606). Absent when no WAL was present to judge.
   */
  walWriterLiveness?: WriterLiveness;
}

/**
 * Remove whichever crash residue is present so the next `analyze` — and, for the WAL
 * arm, every read in the meantime — can proceed. No-ops when the tree is healthy or a
 * build is genuinely in progress. Never throws: a missing/racing file during unlink is
 * exactly the "someone else already cleaned it" case and is swallowed like the rest of
 * this fail-soft action.
 */
export interface CleanCrashResidueOptions {
  /**
   * Set ONLY by a caller that has itself just killed the writer for this root.
   *
   * `DEAD_SHADOW_STALE_MS` is a PROXY for "no writer is alive"; a caller standing
   * at the kill site holds the FACT, so the proxy is redundant there — and
   * actively harmful, because the shadow it must clean is by definition seconds
   * old and so fails the staleness term for the next five minutes.
   *
   * It relaxes ONLY the staleness term. Until 2026-08-23 it also kept a zero-byte
   * requirement, on the reasoning that "a shadow with bytes in it could belong to a
   * concurrent MANUAL `gitnexus analyze`, which this must never delete" — sound intent,
   * wrong instrument. Size cannot tell a concurrent writer from a mid-write corpse, so
   * that term protected the manual analyze by ALSO protecting the orphan it was
   * supposed to clean. The open-handle probe answers the real question directly, so the
   * size term is now the FALLBACK for when the probe cannot run, not the primary test.
   */
  writerKnownDead?: boolean;
  /**
   * Seam for tests, and the escape hatch for a host without a usable `/proc`. Defaults
   * to the real scan. A probe that returns `ok:false` — or throws — yields UNKNOWN,
   * which degrades this function to exactly its pre-2026-08-23 size-only behaviour.
   */
  probeOpenHandles?: (targetPath: string) => OpenHandleProbe;
}

export function cleanCrashResidue(
  root: string,
  opts: CleanCrashResidueOptions = {},
): OrphanShadowCleanup {
  const { db, shadow, walCheckpoint, wal } = gitnexusDbPaths(root);
  const dbExists = existsSync(db);
  const shadowExists = existsSync(shadow);
  const walExists = existsSync(wal);

  // A shadow only counts as "a build is in flight" if it shows any sign of being one.
  // An empty, stale shadow is a corpse, and treating it as live is what left the tree
  // segfaulting on 2026-08-21 with NEITHER arm firing (see isDeadShadow).
  const probeFn = opts.probeOpenHandles ?? probeOpenHandles;
  const runProbe = (target: string): OpenHandleProbe | null => {
    try {
      return probeFn(target);
    } catch {
      // A probe that throws taught us nothing. UNKNOWN, never "nobody holds it".
      return null;
    }
  };
  let shadowIsDead = false;
  let writerLiveness: WriterLiveness = 'unknown';
  if (shadowExists) {
    try {
      const st = statSync(shadow);
      const probe = runProbe(shadow);
      writerLiveness = classifyWriterLiveness(probe);
      const shadowAgeMs = Date.now() - st.mtimeMs;

      if (writerLiveness === 'live') {
        // The kernel says a process still has this shadow open. That outranks every
        // other signal here — INCLUDING zero-bytes-and-stale, which the pre-probe code
        // would have deleted out from under a build that was merely slow to start.
        shadowIsDead = false;
      } else if (writerLiveness === 'orphaned') {
        // No process holds it, so nothing can be writing to it — whatever its size says.
        // THIS is the arm that closes the non-zero orphan gap. It still demands a second,
        // independent corroborator before condemning the file, because the probe has
        // stated blind spots (see classifyWriterLiveness): away from the kill site that
        // corroborator is staleness — a writer between two open() calls would still be
        // touching the file — and at the kill site it is the caller's own SIGKILL, which
        // is stronger evidence than any clock.
        shadowIsDead = opts.writerKnownDead === true || shadowAgeMs > DEAD_SHADOW_STALE_MS;
      } else {
        // No usable probe (no /proc, or it threw). Degrade to exactly the
        // pre-2026-08-23 rule: size is a poor instrument, but it is the one that
        // survives without the kernel's help, and it errs toward leaving files alone.
        shadowIsDead = opts.writerKnownDead
          ? st.size === 0
          : isDeadShadow(true, st.size, shadowAgeMs);
      }
    } catch {
      // Vanished between the check and the stat — that IS the not-present case.
      shadowIsDead = false;
    }
  }
  // What the two existing predicates should have been asking all along: is a build LIVE?
  const liveShadow = shadowExists && !shadowIsDead;

  // WI-2146606 — THE WAL GETS THE SAME DISCRIMINATOR. `isOrphanWal` reads "WAL, database, no
  // shadow" as "killed after the promote", but that is ALSO the shape of a HEALTHY analyze in
  // its post-promote phase: the shadow was renamed over `lbug` and the writer is now inserting
  // (cache-restored embeddings, 20+ min on this graph) through `lbug.wal`. Observed live
  // 2026-09-05T19:16:59Z: a bg-host restarted mid-tick, the analyze survived in its own
  // scope, and the successor host's preflight deleted the live run's WAL as "ORPHAN-WAL
  // residue", then double-spawned. The shadow's absence proves nothing about the WAL's
  // writer; the WAL's own open handles do. `writers`-keyed, because readers open the WAL
  // too (a read-only open replays it) — a reader must never pin residue as live.
  let walWriterLiveness: WriterLiveness | undefined;
  let walIsLive = false;
  if (walExists) {
    try {
      const st = statSync(wal);
      walWriterLiveness = classifyWriteHolderLiveness(runProbe(wal));
      const walAgeMs = Date.now() - st.mtimeMs;
      if (walWriterLiveness === 'live') {
        walIsLive = true;
      } else {
        // 'orphaned' or 'unknown': corroborate before condemning, exactly as for the shadow.
        // A live writer touches its WAL continuously, so a WAL untouched for the staleness
        // floor has no writer; a FRESH one with no visible holder may belong to a writer
        // between two open() calls. At the kill site the caller's own SIGKILL is the proof.
        walIsLive = opts.writerKnownDead !== true && walAgeMs <= DEAD_SHADOW_STALE_MS;
      }
    } catch {
      // Vanished between the check and the stat — that IS the not-present case.
      walIsLive = false;
    }
  }
  if (walIsLive) {
    // A writer owns the whole tree while it is alive. Not even a dead shadow beside it is
    // ours to remove right now — `lbug.wal.checkpoint` may be its checkpoint in flight — and
    // the corpse costs nothing until the next tick, when no writer will be holding anything.
    return { cleaned: false, removed: [], kind: 'none', writerLiveness, walWriterLiveness };
  }

  let kind: OrphanShadowCleanup['kind'] = 'none';
  let targets: string[] = [];
  if (isOrphanShadow(dbExists, liveShadow)) {
    kind = 'orphan-shadow';
    targets = [shadow, walCheckpoint];
  } else if (isOrphanWal(dbExists, liveShadow, walExists)) {
    // The dead shadow goes too: leaving it behind re-arms the exact trap, because the
    // NEXT tick would again read shadow-present as build-in-flight.
    kind = shadowIsDead ? 'dead-shadow-wal' : 'orphan-wal';
    targets = shadowIsDead ? [wal, walCheckpoint, shadow] : [wal, walCheckpoint];
  } else if (shadowIsDead && dbExists) {
    // Dead shadow with no WAL: not yet poisoning reads, but it still masks the next
    // real orphan-WAL from being classified. Clear it while it is cheap.
    kind = 'dead-shadow-wal';
    targets = [shadow, walCheckpoint];
  } else {
    return { cleaned: false, removed: [], kind: 'none', writerLiveness, walWriterLiveness };
  }

  const removed: string[] = [];
  for (const f of targets) {
    if (!existsSync(f)) continue;
    try {
      unlinkSync(f);
      removed.push(f);
    } catch {
      // Racing with another cleanup (or the file vanished between the check and the
      // unlink) — not our job to report, the residue condition is gone either way.
    }
  }
  return { cleaned: removed.length > 0, removed, kind, writerLiveness, walWriterLiveness };
}

// ---------------------------------------------------------------------------
// WI-2146606 — THE CROSS-RESTART CONCURRENCY GUARD.
//
// The routine row is `concurrency: 'skip'`, and the timeout rationale above leans on it: a
// fire that lands while the previous tick is still awaiting its analyze is skipped. That
// guard is IN-PROCESS — it knows about the analyze because the same bg-host is awaiting
// its promise. The analyze itself runs in its own transient scope (managedSpawn, detached),
// so it SURVIVES a bg-host stop/restart; the successor host holds no promise, sees no
// concurrency, and on its first fire runs the preflight and spawns a SECOND analyze onto
// the same index (observed 2026-09-05T19:17:03Z, 44 min into a 40–60 min tick). Two writers
// on one LadybugDB is not a slow tick, it is a corrupted one.
//
// So ask the FACT, not the process table: does any process hold one of this index's files
// open for WRITE? Same instrument as the residue policy, same blind spots, same direction
// of error (a spared tick, never a corrupted build). Deliberately NOT a pid/lock file — a
// lock file records the writer this host launched, and the writer that matters here is
// precisely the one it did not — and NOT argv matching (see probeOpenHandles).
// ---------------------------------------------------------------------------

export interface LiveAnalyzeWriter {
  /** A process holds the shadow (any mode) or `lbug.wal`/`lbug` (write mode) open. */
  live: boolean;
  /** 'unknown' when no probe could run on any present file — a caller must NOT read that as clear. */
  verdict: WriterLiveness;
  /** The holding pids, ascending. */
  pids: number[];
  /** Basename of the first file found held (probe order: shadow, wal, db). */
  files: string[];
}

/**
 * Is an analyze — ours or anyone's — currently writing this index? Probes the files a
 * writer can hold, in the order a build touches them: the shadow (any holder is a writer),
 * then `lbug.wal` and `lbug` (write-mode holders only — readers hold both). Stops at the
 * first file with a live writer; a `/proc` scan per file is the cost.
 */
export function detectLiveAnalyzeWriter(
  root: string,
  opts: { probeOpenHandles?: (targetPath: string) => OpenHandleProbe } = {},
): LiveAnalyzeWriter {
  const { db, shadow, wal } = gitnexusDbPaths(root);
  const probeFn = opts.probeOpenHandles ?? probeOpenHandles;
  const pids = new Set<number>();
  const files: string[] = [];
  let probed = false;
  for (const target of [shadow, wal, db]) {
    if (!existsSync(target)) continue;
    let probe: OpenHandleProbe | null = null;
    try {
      probe = probeFn(target);
    } catch {
      probe = null;
    }
    if (!probe || !probe.ok) continue;
    probed = true;
    const writers = target === shadow ? probe.holders : probe.writers;
    if (writers.length === 0) continue;
    for (const p of writers) pids.add(p);
    files.push(path.basename(target));
    break;
  }
  const live = pids.size > 0;
  return {
    live,
    verdict: live ? 'live' : probed ? 'orphaned' : 'unknown',
    pids: [...pids].sort((a, b) => a - b),
    files,
  };
}

/** Kernel clock ticks per second for `/proc/<pid>/stat` starttime. USER_HZ is 100 on every
 *  Linux ABI Node ships for, and this value feeds a log line, never a decision. */
const USER_HZ = 100;

/**
 * Best-effort age of a process from `/proc/<pid>/stat` (field 22, starttime in ticks since
 * boot) and `/proc/stat` btime. `null` when either cannot be read. Diagnostic only: it lets
 * the skip line say whether the writer being yielded to is a fresh tick or a runaway.
 */
export function processAgeMs(pid: number, procRoot = '/proc', nowMs: number = Date.now()): number | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    // comm may contain spaces/parens; everything after the LAST ')' is fixed-shape.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = Number(rest[19]); // field 22 overall; rest[0] is field 3 (state)
    const btime = /^btime\s+(\d+)/m.exec(readFileSync(`${procRoot}/stat`, 'utf8'));
    if (!Number.isFinite(startTicks) || !btime) return null;
    const startedAtMs = (Number(btime[1]) + startTicks / USER_HZ) * 1000;
    return Math.max(0, nowMs - startedAtMs);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WI-2146015 / D-008 — ADOPTING a routine-launched analyze across a bg-host restart.
//
// The analyze child runs in its own systemd scope (managedSpawn), so it SURVIVES the host
// that spawned it — but the `ok in` line, the canary and the gitnexus_health record lived
// in that host's awaiting promise and died with it. Measured 2026-09-05: the 18:32Z and
// 22:36Z routine ticks BOTH completed (meta.json indexedAt 20:19:38Z / 01:17:06Z) and
// NEITHER was recorded, because peers restarted bg-host mid-run (19:16Z, 03:32Z; restarts
// landed every 3–222 min that day against a ~107-min run). WI-2146606 taught the next host
// to YIELD to that writer; this teaches it to FINISH the tick the dead host started.
//
// The discriminator is an env stamp the routine puts on every analyze it spawns and reads
// back off `/proc/<pid>/environ`: a stamped writer is ours to adopt (wait inside the fire
// budget, judge the result off meta.json, run the same finish path); an unstamped one is a
// manual `gitnexus analyze` and is still only yielded to.
// ---------------------------------------------------------------------------

/** Env stamp (epoch ms of the spawn) the routine puts on every analyze it launches. */
export const GITNEXUS_REINDEX_SPAWN_MARKER_ENV = 'PAPERCUSP_GITNEXUS_REINDEX_SPAWNED_AT_MS';

/** How long past the child's own scope deadline an adopting tick keeps waiting before it
 *  hands the residue to the next preflight. The scope kills the child AT the deadline, so
 *  this only covers kill latency. */
export const GITNEXUS_ADOPT_GRACE_MS = 60_000;

/** Read the spawn stamp back off a live process, or null when it is unstamped/unreadable. */
export function readRoutineSpawnMarker(pid: number, procRoot = '/proc'): number | null {
  try {
    const environ = readFileSync(`${procRoot}/${pid}/environ`, 'utf8');
    const prefix = `${GITNEXUS_REINDEX_SPAWN_MARKER_ENV}=`;
    for (const kv of environ.split('\0')) {
      if (!kv.startsWith(prefix)) continue;
      const v = Number(kv.slice(prefix.length));
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

export interface AdoptableWriter {
  pid: number;
  spawnedAtMs: number;
  /** false ⇒ recognised by argv only (spawned before the stamp existed); spawn time is then
   *  the process age, which is exact to the tick, not to the ms. */
  stamped: boolean;
}

/** Read a live process's argv off `/proc/<pid>/cmdline` (NUL-separated), or null. */
export function readProcessArgv(pid: number, procRoot = '/proc'): string[] | null {
  try {
    const argv = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0');
    if (argv.length && argv[argv.length - 1] === '') argv.pop();
    return argv.length ? argv : null;
  } catch {
    return null;
  }
}

/** PURE — is this argv the routine's OWN analyze invocation for `root` (the pinned CLI
 *  followed by exactly buildAnalyzeArgs)? The fallback discriminator for a writer spawned by
 *  a host that predates the env stamp; a hand-typed `gitnexus analyze` does not match. */
export function argvIsRoutineAnalyze(
  argv: readonly string[] | null,
  root: string,
  repoName: string,
  cliPath: string = analyzeCliPath(),
): boolean {
  if (!argv) return false;
  const want = buildAnalyzeArgs(root, repoName);
  const at = argv.indexOf(cliPath);
  if (at < 0) return false;
  const tail = argv.slice(at + 1);
  return tail.length === want.length && tail.every((a, i) => a === want[i]);
}

/**
 * PURE over injected readers — the EARLIEST writer that is OURS to adopt: env-stamped, or
 * (fallback) running the routine's exact argv, in which case the spawn time is derived from
 * the process age. Null when every writer is a manual analyze: yield to it, never adopt it.
 */
export function findAdoptableWriter(
  pids: readonly number[],
  readMarker: (pid: number) => number | null = readRoutineSpawnMarker,
  fallback?: { isRoutineArgv: (pid: number) => boolean; ageMs: (pid: number) => number | null; nowMs?: number },
): AdoptableWriter | null {
  let best: AdoptableWriter | null = null;
  for (const pid of pids) {
    let candidate: AdoptableWriter | null = null;
    const stamp = readMarker(pid);
    if (stamp != null) {
      candidate = { pid, spawnedAtMs: stamp, stamped: true };
    } else if (fallback?.isRoutineArgv(pid)) {
      const age = fallback.ageMs(pid);
      if (age != null) candidate = { pid, spawnedAtMs: (fallback.nowMs ?? Date.now()) - age, stamped: false };
    }
    if (candidate && (!best || candidate.spawnedAtMs < best.spawnedAtMs)) best = candidate;
  }
  return best;
}

/**
 * P-012 (host-memory-reduction-2026-09-27) — the routine's own analyze processes for `root`,
 * found by ARGV instead of by an open index handle. `detectLiveAnalyzeWriter` only sees a run
 * once it holds the shadow, `lbug.wal` or `lbug`, but a `--force` rebuild parses for many
 * minutes before it opens any of them, and a run still queued for a pc-heavy slot opens
 * nothing. Measured 2026-09-27: bg-host restarted at 09:41:39Z, 6.5 min into the 09:35Z run
 * (pid 1080156, still parsing, no index file held), and the new host spawned a second
 * `--force` analyze at 09:41:53Z that sat in the heavy-slot queue until it was killed by hand.
 * The pc-heavy wrapper carries the same argv tail, so a queued run is found too. Ascending.
 */
export function findRoutineAnalyzePids(
  root: string,
  repoName: string,
  procRoot = '/proc',
  cliPath: string = analyzeCliPath(),
): number[] {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (argvIsRoutineAnalyze(readProcessArgv(pid, procRoot), root, repoName, cliPath)) pids.push(pid);
  }
  return pids.sort((a, b) => a - b);
}

/** Signal-0 liveness. EPERM means "alive, not ours" — still alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll a pid until it exits or `deadlineMs` (epoch) passes. Every clock/sleep/liveness seam
 *  is injectable so the policy is testable without a real process. */
export async function waitForPidExit(
  pid: number,
  deadlineMs: number,
  opts: {
    pollMs?: number;
    isAlive?: (pid: number) => boolean;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ exited: boolean; waitedMs: number }> {
  const pollMs = opts.pollMs ?? 5_000;
  const isAlive = opts.isAlive ?? isPidAlive;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();
  for (;;) {
    if (!isAlive(pid)) return { exited: true, waitedMs: now() - startedAt };
    const t = now();
    if (t >= deadlineMs) return { exited: false, waitedMs: t - startedAt };
    await sleep(Math.min(pollMs, Math.max(1, deadlineMs - t)));
  }
}

/**
 * PURE — did an ADOPTED analyze finish cleanly? gitnexus writes meta.json (`indexedAt`
 * advanced, `incrementalInProgress` cleared) as its LAST act, so a completed run leaves an
 * indexedAt at or after its spawn and no marker; anything else is a death mid-run. The exit
 * code itself is unobservable from a different host, which is why the artifact is judged.
 */
export function judgeAdoptedRun(
  spawnedAtMs: number,
  meta: { indexedAt: string | null } | null,
  stranded: GitnexusIncompleteIndex | null,
): { code: 0 | 1; reason: string } {
  if (stranded !== null) {
    return { code: 1, reason: 'meta.json still carries incrementalInProgress — the adopted analyze died mid-run' };
  }
  const indexedMs = meta?.indexedAt ? Date.parse(meta.indexedAt) : Number.NaN;
  if (!Number.isFinite(indexedMs)) {
    return { code: 1, reason: 'meta.json has no readable indexedAt after the adopted analyze exited' };
  }
  if (indexedMs < spawnedAtMs) {
    return {
      code: 1,
      reason:
        `meta.json indexedAt ${meta!.indexedAt} predates the adopted spawn ` +
        `${new Date(spawnedAtMs).toISOString()} — it never completed`,
    };
  }
  return { code: 0, reason: `meta.json indexedAt ${meta!.indexedAt} postdates the spawn — completed` };
}

/**
 * Stats for the health record from whichever of registry.json / meta.json records the LATER
 * completed analyze — the same rule pickIndexFreshness applies to cadence (D-005). A
 * routine-launched run's registry write is exactly what goes missing with the host that
 * spawned it, and an adopted run must not report the PREVIOUS run's embedding count.
 */
export function readIndexStatsForHealth(
  root: string,
  repoName: string,
): { files: number | null; embeddings: number | null; source: 'registry' | 'meta' | 'none' } {
  type Stats = { files?: number; embeddings?: number };
  const reg = readRegistryEntry(registryPath(), repoName) as (GitnexusRegistryEntry & { stats?: Stats }) | null;
  let meta: { indexedAt: string | null; stats: Stats | null } | null = null;
  try {
    const m = JSON.parse(readFileSync(gitnexusMetaPath(root), 'utf8')) as Record<string, unknown>;
    meta = {
      indexedAt: typeof m.indexedAt === 'string' ? m.indexedAt : null,
      stats: typeof m.stats === 'object' && m.stats !== null ? (m.stats as Stats) : null,
    };
  } catch {
    meta = null;
  }
  const pick = pickIndexFreshness(reg, meta ? { indexedAt: meta.indexedAt, lastCommit: null } : null);
  const src = pick.source === 'meta' ? meta?.stats : reg?.stats;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { files: n(src?.files), embeddings: n(src?.embeddings), source: pick.source };
}

// ---------------------------------------------------------------------------
// WI-35532 (b) — the failure alarm.
//
// This action is deliberately fail-soft (a wedged/failing indexer must never wedge the
// routines tick) and previously logged failures to journald ONLY — so a 100%-failing
// routine burning CPU every tick produced ZERO signal anywhere an owner or agent would
// see it. `decideGitnexusHealthUpdate` is the pure state machine; the handler below
// persists it into the SAME routine-metadata convention green-checkpoint's `gate_health`
// uses (`metadata->'gitnexus_health'`) and fires exactly once per failure streak — never
// once per tick — via the shared `notifyAttention` escalation rail.
// ---------------------------------------------------------------------------

export interface GitnexusHealth {
  consecutiveFailures: number;
  /** True once the streak has alerted — suppresses a re-alert on every subsequent
   *  failing tick until a success clears it (mirrors green-checkpoint's `stallAlerted`). */
  alerted: boolean;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  /** Latest on-disk LadybugDB size telemetry (optional for pre-monitor rows). */
  dbBytes?: number | null;
  dbMaxBytes?: number;
  dbUtilization?: number | null;
  dbHeadroomBytes?: number | null;
  /** Suppresses repeated ceiling alerts until usage falls below the threshold. */
  dbAlerted?: boolean;
  /**
   * WHOLE-index on-disk footprint, graded against the code-intelligence layer's
   * `indexDiskMbMax` selection budget (WI-2142942).
   *
   * Deliberately SEPARATE from `dbBytes` above, which stats the `lbug` file
   * alone against a different quantity — LadybugDB's 16GiB mmap cliff. Those
   * are not two readings of one number: measured 2026-09-03, lbug was 4946MB
   * of a 6558MB `.gitnexus/`, so 1607MB of parse caches was outside every
   * pre-existing instrument.
   */
  indexDiskMb?: number | null;
  indexDiskBudgetMb?: number;
  /** `within-budget` | `accepted-exceedance` | `over-ceiling` | `not-measured`. */
  indexDiskStatus?: string;
  /** Suppresses repeated over-ceiling alerts until the footprint comes back under. */
  indexDiskAlerted?: boolean;
  /** Vector-leg status from the last canary that ran (plan gitnexus-embeddings-enablement). */
  vectorSearch?: GitnexusVectorSearchHealth;
}

/**
 * The vector leg's health, persisted beside the failure streak so a DEGRADED graph (answers
 * definitions/callers, cannot answer a paraphrase) is visible in `/admin/schedules` and to
 * `routines:list` instead of only in a journald line nobody reads.
 */
export interface GitnexusVectorSearchHealth {
  /** `stats.embeddings` after the analyze; null ⇒ the registry did not report it. */
  embeddings: number | null;
  /** Did the analyze argv ask for embeddings? (analyzeEmbeddingsExpected) */
  expected: boolean;
  /** True when expected and absent — the canary's `degraded` verdict for this probe. */
  degraded: boolean;
  checkedAt: number;
}

export const GITNEXUS_HEALTH_DEFAULT: GitnexusHealth = {
  consecutiveFailures: 0,
  alerted: false,
  lastFailureAt: null,
  lastSuccessAt: null,
};

export interface GitnexusDbUsage {
  dbBytes: number | null;
  dbMaxBytes: number;
  dbUtilization: number | null;
  dbHeadroomBytes: number | null;
}

/** Read the real LadybugDB file size; a missing/unreadable index is in-band unknown. */
export function measureGitnexusDbUsage(
  root: string,
  maxBytes: number = GITNEXUS_LBUG_MAX_DB_BYTES,
): GitnexusDbUsage {
  const dbMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : GITNEXUS_LBUG_MAX_DB_BYTES;
  try {
    const dbBytes = statSync(gitnexusDbPaths(root).db).size;
    return {
      dbBytes,
      dbMaxBytes,
      dbUtilization: dbBytes / dbMaxBytes,
      dbHeadroomBytes: Math.max(0, dbMaxBytes - dbBytes),
    };
  } catch {
    return { dbBytes: null, dbMaxBytes, dbUtilization: null, dbHeadroomBytes: null };
  }
}

/** Wall-clock bound for the `.gitnexus/` walk. Truncation here is REPORTED. */
const GITNEXUS_INDEX_WALK_BUDGET_MS = 4_000;

/**
 * Measure the WHOLE `.gitnexus/` footprint and grade it against the
 * code-intelligence layer's `indexDiskMbMax` selection budget (WI-2142942).
 *
 * This is not a second reading of `measureGitnexusDbUsage`. That one stats the
 * `lbug` FILE against LadybugDB's mmap cliff — an outage threshold for the
 * storage engine. This one sizes the whole index directory against a selection
 * policy. Measured 2026-09-03 the two differ by 1607MB of parse caches that no
 * pre-existing instrument could see.
 *
 * ⚠ `maxEntries` is deliberately unbounded here, and that is a correctness
 * choice, not laziness: `dirSizeBytes` sets `budget.truncated` when it stops on
 * the wall-clock deadline but breaks SILENTLY when it hits `maxEntries`, so an
 * entry-capped walk under-counts with no way for a caller to know. Under-counting
 * is the dangerous direction — it turns a real breach into a clean pass — so the
 * only limit left binding is the one that reports itself, and a walk that runs
 * out of time grades `not-measured` rather than passing on a partial total.
 */
export function measureGitnexusIndexDisk(
  root: string,
  budgetMb: number = DEFAULT_RESOURCE_BUDGET.indexDiskMbMax,
): IndexDiskVerdict {
  const dir = path.join(root, '.gitnexus');
  if (!existsSync(dir)) return classifyIndexDisk('gitnexus', null, { budgetMb });

  const budget = { deadlineMs: Date.now() + GITNEXUS_INDEX_WALK_BUDGET_MS, truncated: false };
  let bytes: number;
  try {
    bytes = dirSizeBytes(dir, Number.MAX_SAFE_INTEGER, budget);
  } catch {
    // Absence, never a fabricated 0 — a zero would read as "costs nothing".
    return classifyIndexDisk('gitnexus', null, { budgetMb });
  }
  return classifyIndexDisk('gitnexus', Math.round(bytes / (1024 * 1024)), {
    truncated: budget.truncated === true,
    budgetMb,
  });
}

/**
 * PURE — fold an index-disk verdict into health, alerting ONCE per crossing.
 *
 * Alerts only on `over-ceiling`, never on `accepted-exceedance`. That
 * distinction is the whole reason the exceedance record exists: gitnexus is
 * knowingly 3.2x the budget today, so alerting on the breach itself would fire
 * on every tick from day one, and a gauge that is always red is one everyone
 * learns to scroll past — which is how this budget came to be ignored in the
 * first place. What is worth waking someone for is GROWTH past the bounded
 * ceiling we accepted.
 *
 * `not-measured` deliberately neither alerts nor clears the flag: it is an
 * absence of evidence, and letting it clear `indexDiskAlerted` would re-arm the
 * alert so a flapping measurement could page repeatedly for one condition.
 */
export function decideIndexDiskHealthUpdate(
  prev: GitnexusHealth,
  verdict: IndexDiskVerdict,
): { next: Pick<GitnexusHealth, 'indexDiskMb' | 'indexDiskBudgetMb' | 'indexDiskStatus' | 'indexDiskAlerted'>; shouldAlert: boolean } {
  const measuredMb = verdict.status === 'not-measured' ? null : verdict.measuredMb;
  const wasAlerted = prev.indexDiskAlerted === true;

  if (verdict.status === 'not-measured') {
    return {
      next: {
        indexDiskMb: null,
        indexDiskBudgetMb: verdict.budgetMb,
        indexDiskStatus: verdict.status,
        indexDiskAlerted: wasAlerted,
      },
      shouldAlert: false,
    };
  }

  const overCeiling = verdict.status === 'over-ceiling';
  return {
    next: {
      indexDiskMb: measuredMb,
      indexDiskBudgetMb: verdict.budgetMb,
      indexDiskStatus: verdict.status,
      indexDiskAlerted: overCeiling,
    },
    shouldAlert: overCeiling && !wasAlerted,
  };
}

export interface GitnexusDbHealthUpdate {
  next: Pick<GitnexusHealth, 'dbBytes' | 'dbMaxBytes' | 'dbUtilization' | 'dbHeadroomBytes' | 'dbAlerted'>;
  shouldAlert: boolean;
}

/** PURE — one alert when measured usage crosses the configured ceiling ratio. */
export function decideGitnexusDbHealthUpdate(
  prev: GitnexusHealth,
  usage: GitnexusDbUsage,
  threshold: number,
): GitnexusDbHealthUpdate {
  const ratio = Number.isFinite(threshold) ? Math.max(0, threshold) : GITNEXUS_LBUG_DB_ALERT_RATIO;
  if (usage.dbUtilization == null) {
    return {
      next: { ...usage, dbAlerted: prev.dbAlerted === true },
      shouldAlert: false,
    };
  }
  const above = usage.dbUtilization >= ratio;
  const shouldAlert = above && prev.dbAlerted !== true;
  return {
    next: { ...usage, dbAlerted: above },
    shouldAlert,
  };
}

/** Alert on the 3rd consecutive failure — one bad tick can be a transient timeout; three
 *  in a row (across an hourly cadence, ~3h of silent burn) is a real, durable wedge. */
export const GITNEXUS_FAILURE_ALERT_THRESHOLD = 3;

export interface GitnexusHealthUpdate {
  next: GitnexusHealth;
  /** True on EXACTLY the tick that crosses the threshold — the caller fires the alert
   *  only then, not on every failing tick after. */
  shouldAlert: boolean;
  /** True on EXACTLY the recovery tick that follows an alerted streak — the caller
   *  resolves/logs the recovery only then. */
  shouldResolve: boolean;
}

/** PURE — the whole alarm policy, order-sensitive and independently testable from the
 *  4-minute subprocess it observes. */
export function decideGitnexusHealthUpdate(
  prev: GitnexusHealth,
  success: boolean,
  threshold: number,
  nowMs: number,
): GitnexusHealthUpdate {
  if (success) {
    return {
      next: {
        ...prev,
        consecutiveFailures: 0,
        alerted: false,
        lastFailureAt: prev.lastFailureAt,
        lastSuccessAt: nowMs,
      },
      shouldAlert: false,
      shouldResolve: prev.alerted,
    };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const shouldAlert = consecutiveFailures >= threshold && !prev.alerted;
  return {
    next: {
      ...prev,
      consecutiveFailures,
      alerted: prev.alerted || shouldAlert,
      lastFailureAt: nowMs,
      lastSuccessAt: prev.lastSuccessAt,
    },
    shouldAlert,
    shouldResolve: false,
  };
}

/** Persist capacity telemetry on every tick and alert once per threshold crossing. */
async function trackGitnexusDbCapacity(
  ctx: SystemActionCtx,
  root: string,
  threshold: number,
): Promise<void> {
  const usage = measureGitnexusDbUsage(root);
  const indexDisk = measureGitnexusIndexDisk(root);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT metadata->'gitnexus_health' AS gh FROM harness_shared.routines
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug],
    )) as Array<{ gh: Partial<GitnexusHealth> | null }>;
    const prev: GitnexusHealth = { ...GITNEXUS_HEALTH_DEFAULT, ...(rows[0]?.gh ?? {}) };
    const update = decideGitnexusDbHealthUpdate(prev, usage, threshold);
    const indexUpdate = decideIndexDiskHealthUpdate(prev, indexDisk);
    const next: GitnexusHealth = { ...prev, ...update.next, ...indexUpdate.next };
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug, JSON.stringify({ gitnexus_health: next })],
    );
    if (update.shouldAlert) {
      const { notifyAttention } = await import('../../attention-notify');
      const pct = Math.round((usage.dbUtilization ?? 0) * 1000) / 10;
      const gib = (usage.dbBytes ?? 0) / 1024 ** 3;
      const capGib = usage.dbMaxBytes / 1024 ** 3;
      await notifyAttention({
        kind: 'intervention',
        title: 'GitNexus LadybugDB is approaching its configured size ceiling',
        body:
          `The GitNexus LadybugDB for ${ctx.installSlug} is ${gib.toFixed(2)} GiB / ${capGib.toFixed(0)} GiB ` +
          `(${pct}% consumed; alert threshold ${Math.round(threshold * 100)}%). ` +
          'Raise GITNEXUS_LBUG_MAX_DB_BYTES deliberately before analyze reaches the ceiling; it is a virtual-address reservation, not resident memory.',
        importance: 'urgent',
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        data: {
          dbBytes: usage.dbBytes,
          dbMaxBytes: usage.dbMaxBytes,
          dbUtilization: usage.dbUtilization,
          dbHeadroomBytes: usage.dbHeadroomBytes,
          threshold,
        },
      });
    }
    if (indexUpdate.shouldAlert && indexDisk.status === 'over-ceiling') {
      const { notifyAttention } = await import('../../attention-notify');
      const ceiling = indexDisk.acceptedCeilingMb;
      await notifyAttention({
        kind: 'intervention',
        title: 'GitNexus index has grown past its accepted on-disk ceiling',
        body:
          `The GitNexus index for ${ctx.installSlug} is ${indexDisk.measuredMb}MB, past the ` +
          `${ceiling === null ? `${indexDisk.budgetMb}MB selection budget` : `${ceiling}MB bounded allowance`} ` +
          'recorded in KNOWN_INDEX_DISK_EXCEEDANCES. That allowance accepts a MEASURED breach of the ' +
          `${indexDisk.budgetMb}MB budget; it does not accept unbounded growth, which is what this is. ` +
          'Either reclaim index disk or re-record the exceedance deliberately with a fresh measurement.',
        importance: 'urgent',
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        data: {
          indexDiskMb: indexDisk.measuredMb,
          indexDiskBudgetMb: indexDisk.budgetMb,
          acceptedCeilingMb: ceiling,
          status: indexDisk.status,
        },
      });
    }
  } catch (e) {
    console.warn(`[gitnexus-reindex] DB capacity tracking failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ---------------------------------------------------------------------------
// P-004 — SEMANTIC CANARIES.
//
// WHY EXIT 0 IS NOT ENOUGH. Everything upstream of this point measures whether the
// INDEXER RAN. Nothing measured whether the resulting graph ANSWERS. Those came apart
// completely on 2026-08-21: the MCP bridge kept advertising all 17 of its tools (the
// handshake needs no graph) while every actual call died on the poisoned index. To an
// agent that reads as "gitnexus has nothing useful to say" rather than "gitnexus is
// broken" — the same indistinguishable-failure shape D-004 was written to end, one layer
// up. A canary is what turns that into a detectable condition.
//
// DESIGN RULE: NO HARDCODED SYMBOL NAMES. The obvious canary — "look up
// `someKnownFunction` and assert it resolves" — rots the first time someone renames it,
// and then fires as a false alarm on a perfectly healthy index. False alarms are how a
// health signal gets ignored, which costs exactly the outage it was built for. So the
// round-trip probe reads a symbol OUT of the graph and then looks THAT up: it asserts
// the read path resolves what the graph actually contains, which is the real property,
// and cannot be invalidated by a rename.
// ---------------------------------------------------------------------------

export interface CanaryProbe {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * A failing probe that DEGRADES the graph rather than making it unusable: reported in the
   * summary and persisted in health metadata, but it never flips `healthy`. Only the
   * vector-search probe uses it (a graph with no embeddings still answers every
   * definition/caller question — it just cannot answer a paraphrase).
   */
  degraded?: boolean;
}

export interface CanaryVerdict {
  /** False when any probe that indicates a genuinely unusable graph failed. */
  healthy: boolean;
  /** True when a `degraded` probe failed — the graph answers, but a capability is missing. */
  degraded: boolean;
  probes: CanaryProbe[];
  summary: string;
}

export interface CanaryInputs {
  /** Files in the graph; null ⇒ the query itself failed (crash, segfault, timeout). */
  fileCount: number | null;
  /** Symbol (Function/Class) nodes — definition truth. null ⇒ query failed. */
  symbolCount: number | null;
  /** Call edges — the "who calls this" capability. null ⇒ query failed. */
  callEdgeCount: number | null;
  /** Definition edges — the "where is this defined" capability. null ⇒ query failed. */
  defEdgeCount: number | null;
  /**
   * Did a symbol read straight out of the graph resolve back through the lookup path?
   * null ⇒ could not be attempted (no symbol to sample, or the read failed).
   */
  roundTripOk: boolean | null;
  /** A source file pinned by the selective corpus must actually occur in the graph. */
  knownSourceFileCount?: number | null;
  /** Embeddings present, from registry stats (`stats.embeddings`); null ⇒ not reported. */
  embeddings: number | null;
  /**
   * Did the analyze that produced this index ask for embeddings (`--embeddings` in the
   * argv — see analyzeEmbeddingsExpected)? When true, `embeddings == 0` is a DEGRADATION
   * (the vector leg silently died: cap re-armed, model failed to load, cache wiped) rather
   * than the accepted WI-35557 state it was before plan gitnexus-embeddings-enablement.
   */
  embeddingsExpected: boolean;
}

/**
 * PURE — the whole canary policy, testable without a graph, a subprocess, or a clock.
 *
 * Only the probes that mean "the graph cannot answer" set healthy=false. Vector status is
 * a DEGRADATION, never a failure: a graph with 0 embeddings still answers every definition
 * and caller question, and a canary that fails on a condition the graph survives is a canary
 * that gets muted — taking the real signal with it. It is still not silent: `degraded` is
 * set, the summary names it, and the routine persists it in `gitnexus_health.vectorSearch`.
 * Before embeddings were enabled (WI-35557) 0 was the accepted state, which is what the
 * `embeddingsExpected:false` branch still describes.
 */
export function judgeCanary(i: CanaryInputs): CanaryVerdict {
  const probes: CanaryProbe[] = [
    {
      name: 'graph-answers',
      ok: i.fileCount != null && i.fileCount > 0,
      detail:
        i.fileCount == null
          ? 'the count query did not return — the graph is unreadable (crash/segfault/timeout), NOT merely empty'
          : `${i.fileCount} files`,
    },
    {
      name: 'definitions',
      ok: i.symbolCount != null && i.symbolCount > 0,
      detail: i.symbolCount == null ? 'query failed' : `${i.symbolCount} symbol nodes`,
    },
    {
      name: 'call-edges',
      ok: i.callEdgeCount != null && i.callEdgeCount > 0,
      detail: i.callEdgeCount == null ? 'query failed' : `${i.callEdgeCount} call edges`,
    },
    {
      name: 'definition-edges',
      ok: i.defEdgeCount != null && i.defEdgeCount > 0,
      detail: i.defEdgeCount == null ? 'query failed' : `${i.defEdgeCount} definition edges`,
    },
    {
      name: 'symbol-round-trip',
      ok: i.roundTripOk === true,
      detail:
        i.roundTripOk == null
          ? 'not attempted — no symbol could be sampled from the graph'
          : i.roundTripOk
            ? 'a symbol sampled from the graph resolved back through the lookup path'
            : 'a symbol PRESENT in the graph did NOT resolve through the lookup path — the read path is broken, not the data',
    },
    vectorSearchProbe(i.embeddings, i.embeddingsExpected),
  ];
  if (i.knownSourceFileCount !== undefined) {
    probes.push({
      name: 'known-source-coverage',
      ok: i.knownSourceFileCount === 1,
      detail: i.knownSourceFileCount == null
        ? `${GITNEXUS_KNOWN_SOURCE_PATH}: coverage query failed`
        : `${GITNEXUS_KNOWN_SOURCE_PATH}: ${i.knownSourceFileCount} indexed file nodes (expected 1)`,
    });
  }
  const failed = probes.filter((p) => !p.ok && !p.degraded);
  const degradedProbes = probes.filter((p) => !p.ok && p.degraded);
  const degradedNote =
    degradedProbes.length === 0 ? '' : ` (DEGRADED: ${degradedProbes.map((p) => `${p.name}: ${p.detail}`).join(' | ')})`;
  return {
    healthy: failed.length === 0,
    degraded: degradedProbes.length > 0,
    probes,
    summary:
      failed.length === 0
        ? `canary OK${degradedNote} — ${probes.map((p) => p.detail).join('; ')}`
        : `canary FAILED (${failed.length}/${probes.length}): ${failed.map((p) => `${p.name}: ${p.detail}`).join(' | ')}${degradedNote}`,
  };
}

/** PURE — the vector-search probe. Degrades (never fails) when embeddings were asked for
 *  and are absent; pure status when they were not. */
export function vectorSearchProbe(embeddings: number | null, embeddingsExpected: boolean): CanaryProbe {
  const name = 'vector-search';
  if (embeddings != null && embeddings > 0) return { name, ok: true, detail: `${embeddings} embeddings` };
  if (!embeddingsExpected) {
    return {
      name,
      ok: true,
      detail:
        embeddings == null
          ? 'embeddings unknown (not requested by this analyze)'
          : '0 embeddings — not requested by this analyze (WI-35557 state); gitnexus.query has no vector leg, use context/cypher or grep',
    };
  }
  return {
    name,
    ok: false,
    degraded: true,
    detail:
      embeddings == null
        ? 'embeddings UNKNOWN after an embeddings-enabled analyze — registry stats carry no `embeddings`; the vector leg cannot be confirmed'
        : '0 embeddings after an embeddings-enabled analyze — the vector leg is DEAD (node cap re-armed, embedder failed to load, or cache wiped); definitions/callers still answer, paraphrase queries do not',
  };
}

export interface AnalyzeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A completed index is healthy only after its graph canary actually passed. */
export function analyzeTickSucceeded(run: AnalyzeRunResult, canary: CanaryVerdict | null): boolean {
  return !run.timedOut && run.code === 0 && canary?.healthy === true;
}

/**
 * P-012 (D-015) — where the analyze's combined stdout+stderr goes: a FILE the task owns, not a
 * pipe into this host. Through a pipe, a bg-host restart mid-run killed pc-heavy's capture
 * `tee` (SIGPIPE on its stdout), stranded the output FIFO with no reader, and left the
 * adopting host nothing to say — measured 2026-09-27, 8 of 15 runs in 3 days read
 * `ended_unobserved` with no reason, and one 2 h run's capture stopped at 605 bytes.
 */
export function analyzeLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAPERCUSP_GITNEXUS_ANALYZE_LOG_DIR ?? path.join(os.homedir(), '.papercusp', 'logs', 'gitnexus-analyze');
}

/** Named by the spawn stamp, so an adopting host incarnation finds it from the stamp alone. */
export function analyzeLogPath(spawnedAtMs: number, dir: string = analyzeLogDir()): string {
  return path.join(dir, `analyze-${spawnedAtMs}.log`);
}

/** Two days of hourly ticks. */
export const GITNEXUS_ANALYZE_LOGS_KEPT = 48;

/** Delete all but the newest `keep` analyze logs in `dir`. Best-effort: a failed prune never blocks a run. */
export function pruneAnalyzeLogs(dir: string, keep: number = GITNEXUS_ANALYZE_LOGS_KEPT): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const stamped = names
    .map((name) => ({ name, stamp: /^analyze-(\d+)\.log$/.exec(name)?.[1] }))
    .filter((e): e is { name: string; stamp: string } => e.stamp != null)
    .sort((a, b) => Number(b.stamp) - Number(a.stamp));
  for (const e of stamped.slice(Math.max(0, keep))) {
    try {
      unlinkSync(path.join(dir, e.name));
    } catch {
      /* raced another prune, or not ours to delete */
    }
  }
}

/** The last `maxBytes` of an analyze log; null when it cannot be read (e.g. a pre-P-012 run had none). */
export function readAnalyzeLogTail(logPath: string, maxBytes = 16 * 1024): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    fd = openSync(logPath, 'r');
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, size - len);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Create the log for one spawn and return its fd, or null to fall back to piped stdio. */
function openAnalyzeLog(logPath: string): number | null {
  try {
    const dir = path.dirname(logPath);
    mkdirSync(dir, { recursive: true });
    // keep - 1: the file about to be created is the newest.
    pruneAnalyzeLogs(dir, GITNEXUS_ANALYZE_LOGS_KEPT - 1);
    return openSync(logPath, 'a');
  } catch (e) {
    console.warn(`[gitnexus-reindex] cannot open analyze log ${logPath} — falling back to piped output: ${String(e)}`);
    return null;
  }
}

export function runGitnexusAnalyze(root: string, repoName: string, timeoutMs: number): Promise<AnalyzeRunResult> {
  return (async () => {
    const directCommand = process.env.GITNEXUS_NODE_BIN ?? process.execPath;
    const directArgs = analyzeNodeArgs(analyzeCliPath(), root, repoName);
    const invocation = buildAnalyzeInvocation(root, directCommand, directArgs);
    const spawnedAtMs = Date.now();
    const logPath = analyzeLogPath(spawnedAtMs);
    const logFd = openAnalyzeLog(logPath);
    let managed: Awaited<ReturnType<typeof managedSpawn>>;
    try {
      managed = await managedSpawn(
        invocation.command,
        invocation.args,
        {
          class: 'build',
          title: `gitnexus analyze ${repoName}`,
          argv: [invocation.command, ...invocation.args],
          cwd: root,
          launchedBy: 'system:gitnexus-reindex',
          memoryMaxBytes: GITNEXUS_ANALYZE_MEMORY_MAX_BYTES,
          runtimeMaxSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
          ...(logFd == null ? {} : { logPath }),
          detail: { subsystem: 'gitnexus', operation: 'analyze', repoName },
        },
        {
          // Keep the process-group kill fallback for unconfined hosts. On Linux,
          // managedSpawn adds the same deadline to the transient scope, so the
          // payload remains bounded even if this operator process dies mid-run.
          spawnOptions: {
            cwd: root,
            // The spawn stamp is what lets a LATER host incarnation adopt this run (WI-2146015),
            // and it names the log that incarnation reads (analyzeLogPath).
            env: {
              ...analyzeEnv(
                process.env,
                GITNEXUS_ANALYZE_HEAP_MB,
                GITNEXUS_ANALYZE_SEMI_SPACE_MB,
                selectiveSourceLimitKb(root),
              ),
              [GITNEXUS_REINDEX_SPAWN_MARKER_ENV]: String(spawnedAtMs),
            },
            ...(logFd == null ? {} : { stdio: ['ignore', logFd, logFd] as const }),
            detached: true,
          },
        },
      );
    } finally {
      // The child holds its own copy; ours would only keep the file open past the run.
      if (logFd != null) closeSync(logFd);
    }
    const child = managed.child;

    return new Promise<AnalyzeRunResult>((resolvePromise) => {
    // detached ⇒ own process-group leader, so a timeout kills the whole tree
    // (npx → node → tree-sitter workers), never just the wrapper. Same precedent as
    // cargo-test-action.ts / p2p-perf-actions.ts.
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let escalate: NodeJS.Timeout | null = null;
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };
    const killer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      escalate = setTimeout(() => killTree('SIGKILL'), 15_000);
      escalate.unref();
    }, timeoutMs);
    const finish = (res: AnalyzeRunResult): void => {
      clearTimeout(killer);
      if (escalate) clearTimeout(escalate);
      // With file stdio the child's pipes are null, so its output is the log's tail.
      const logged = logFd == null ? null : readAnalyzeLogTail(logPath);
      resolvePromise(logged == null ? res : { ...res, stdout: logged + res.stdout });
    };
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: stderr + String(e), timedOut }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr, timedOut }));
    });
  })();
}

/** Resolve the gitnexus binary for canary probes, mirroring the bridge's own resolution
 *  order. Absent ⇒ the canary reports "not attempted" rather than a false failure. */
export function canaryBin(): string {
  return process.env.PAPERCUSP_GITNEXUS_BIN ?? path.join(os.homedir(), '.papercusp', 'vendor', 'gitnexus', 'node_modules', '.bin', 'gitnexus');
}

/**
 * The argv for one canary probe. ⚠ ALWAYS names the repo. `gitnexus cypher` resolves its
 * target from the GLOBAL registry (~/.gitnexus/registry.json), not from cwd, and with a
 * second registered repo it refuses outright — `Multiple repositories indexed. Specify
 * which one with the "repo" parameter` — which cypherScalar maps to null, i.e. UNREADABLE.
 * Measured 2026-09-06T07:13Z: a leftover cost-measurement registration
 * (`papercusp-wi39394` → /tmp) failed 4/6 canary probes on a perfectly healthy index
 * (221,202 embeddings) and recorded a tick failure. The name is the same one the spawn
 * passes as `--name`, so the probe and the index it verifies cannot drift apart.
 */
export function canaryCypherArgv(repoName: string, query: string): string[] {
  return ['cypher', '--repo', repoName, query];
}

function cypherScalar(bin: string, root: string, repoName: string, query: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolvePromise) => {
    execFile(bin, canaryCypherArgv(repoName, query), { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // A CRASH (segfault) arrives here as an error with no usable stdout — which is
      // exactly the condition the canary exists to catch, so it must map to null
      // ("unreadable"), never to 0 ("empty"). Conflating those two is what made the
      // original outage look like an empty graph instead of a broken one.
      if (err) return resolvePromise(null);
      const m = /\|\s*(\d+)\s*\|/.exec(String(stdout));
      resolvePromise(m ? Number.parseInt(m[1], 10) : null);
    });
  });
}

function cypherFirstString(bin: string, root: string, repoName: string, query: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(bin, canaryCypherArgv(repoName, query), { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolvePromise(null);
      // Rows render as a markdown table; take the first data cell after the separator.
      const rows = String(stdout).split('\\n');
      for (const r of rows) {
        const m = /^\s*\|\s*([^|\s][^|]*?)\s*\|/.exec(r.replace(/\\\\n/g, '\n'));
        if (m && m[1] !== '---' && !/^-+$/.test(m[1])) {
          const v = m[1].trim();
          if (v && v !== 'name' && v !== 'n') return resolvePromise(v);
        }
      }
      resolvePromise(null);
    });
  });
}

export const CANARY_PROBE_TIMEOUT_MS = 90_000;

/**
 * Run the canary against the live index. Fail-soft in the same spirit as the rest of
 * this action: every probe collapses to null on any error, and `judgeCanary` decides
 * what that means — the policy stays in the pure function.
 */
export async function runCanary(
  root: string,
  registryFiles: number | null,
  embeddings: number | null,
  // Derived from the SAME argv builder the spawn uses, so the expectation cannot drift
  // from what was actually asked of gitnexus.
  embeddingsExpected: boolean = analyzeEmbeddingsExpected(buildAnalyzeArgs(root, GITNEXUS_REPO_NAME)),
  // The registry name the probes target — the same one the spawn passes as `--name`.
  repoName: string = GITNEXUS_REPO_NAME,
): Promise<CanaryVerdict> {
  const bin = canaryBin();
  if (!existsSync(bin)) {
    return judgeCanary({
      fileCount: null,
      symbolCount: null,
      callEdgeCount: null,
      defEdgeCount: null,
      roundTripOk: null,
      embeddings,
      embeddingsExpected,
    });
  }
  const t = CANARY_PROBE_TIMEOUT_MS;
  const fileCount = await cypherScalar(bin, root, repoName, 'MATCH (f:File) RETURN count(f) AS n', t);
  const symbolCount = await cypherScalar(bin, root, repoName, 'MATCH (f:Function) RETURN count(f) AS n', t);
  // ⚠ THE EDGE TYPE IS A PROPERTY, NOT A TABLE. This graph has exactly ONE relationship
  // table — `CodeRelation` — and the kind lives in `r.type` ('CALLS', 'DEFINES',
  // 'IMPORTS', ...). The natural-looking `MATCH ()-[r:CALLS]->()` does NOT return zero;
  // it throws "Binder exception: Table CALLS does not exist", which cypherScalar maps to
  // null — i.e. it would have reported the read as UNREADABLE and failed this canary on
  // every single healthy index, forever. Caught only by running it against the live
  // graph; the pure judge cannot see a wrong query. Verify with:
  //   MATCH ()-[r:CodeRelation]->() RETURN r.type AS t, count(r) AS n ORDER BY n DESC
  const callEdgeCount = await cypherScalar(bin, root, repoName, "MATCH ()-[r:CodeRelation]->() WHERE r.type = 'CALLS' RETURN count(r) AS n", t);
  const defEdgeCount = await cypherScalar(bin, root, repoName, "MATCH ()-[r:CodeRelation]->() WHERE r.type = 'DEFINES' RETURN count(r) AS n", t);
  const knownSourceFileCount = existsSync(path.join(root, GITNEXUS_KNOWN_SOURCE_PATH))
    ? await cypherScalar(
      bin, root, repoName,
      `MATCH (f:File) WHERE f.filePath = '${GITNEXUS_KNOWN_SOURCE_PATH}' RETURN count(f) AS n`, t,
    )
    : null;

  // The round trip: sample a name OUT of the graph, then assert the graph can find that
  // same name again. No hardcoded symbol, so a rename can never false-alarm it.
  let roundTripOk: boolean | null = null;
  const sampled = await cypherFirstString(bin, root, repoName, 'MATCH (f:Function) WHERE f.name IS NOT NULL RETURN f.name AS name LIMIT 1', t);
  if (sampled) {
    const safe = sampled.replace(/'/g, '');
    const found = await cypherScalar(bin, root, repoName, `MATCH (f:Function) WHERE f.name = '${safe}' RETURN count(f) AS n`, t);
    roundTripOk = found != null && found > 0;
  }
  return judgeCanary({
    fileCount: fileCount ?? registryFiles,
    symbolCount,
    callEdgeCount,
    defEdgeCount,
    roundTripOk,
    knownSourceFileCount,
    embeddings,
    embeddingsExpected,
  });
}

/** The graph indexes the operator-home repo; a per-hive coding repo has no business
 *  re-indexing it, so a stray routine there cleanly no-ops. A blank installSlug (manual
 *  or legacy fire) is treated as operator-home, matching cargo-test-action's convention. */
export function shouldSkipForHive(
  installSlug: string | null | undefined,
  homeSlug: string,
): { skip: true; reason: string } | { skip: false } {
  if (installSlug && installSlug !== homeSlug) {
    return { skip: true, reason: `not the operator-home harness (got "${installSlug}", home is "${homeSlug}")` };
  }
  return { skip: false };
}

function num(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

registerSystemAction('gitnexus-reindex', async (ctx: SystemActionCtx) => {
  const gate = shouldSkipForHive(ctx.installSlug, operatorHomeHarnessSlug());
  if (gate.skip) {
    console.log(`[gitnexus-reindex] skip: ${gate.reason}`);
    return;
  }
  const cfg = ctx.triggerConfig ?? {};
  const root = integrationRoot();
  const repoName = typeof cfg.repo_name === 'string' ? cfg.repo_name : GITNEXUS_REPO_NAME;
  const dbAlertRatio = num(cfg, 'db_alert_ratio', GITNEXUS_LBUG_DB_ALERT_RATIO);

  // Capacity telemetry is cheap and independent of whether this tick elects to run
  // the expensive analyzer, so record it before the cadence gates (including skips).
  await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);

  const timeoutMs = num(cfg, 'timeout_ms', GITNEXUS_ANALYZE_TIMEOUT_MS);

  // WI-2146606 — a writer this host cannot see. The routine's `concurrency: 'skip'` only
  // knows about an analyze THIS host is awaiting; one launched by a previous host
  // incarnation survives the restart in its own scope and is invisible here. Yield to it:
  // no residue cleanup (its WAL would read as orphan), no spawn (two writers corrupt it).
  let writer = detectLiveAnalyzeWriter(root);
  // P-012 — no handle held is not "no run": a --force rebuild parses for minutes before it
  // opens the index, and a run queued for a pc-heavy slot opens nothing. Fall back to argv.
  if (!writer.live) {
    const pids = findRoutineAnalyzePids(root, repoName);
    if (pids.length > 0) writer = { live: true, verdict: 'live', pids, files: [] };
  }
  const held = writer.files.length
    ? `${writer.files.join(' + ')} held for write`
    : 'no index file open yet — parsing, or queued for a heavy slot';
  if (writer.live) {
    const ages = writer.pids.map((p) => {
      const age = processAgeMs(p);
      return age == null ? String(p) : `${p} (${Math.round(age / 60_000)} min old)`;
    });
    const overBudget = writer.pids.some((p) => (processAgeMs(p) ?? 0) > timeoutMs);
    const adoptable = overBudget
      ? null
      : findAdoptableWriter(writer.pids, readRoutineSpawnMarker, {
          isRoutineArgv: (p) => argvIsRoutineAnalyze(readProcessArgv(p), root, repoName),
          ageMs: processAgeMs,
        });
    if (adoptable) {
      // WI-2146015 / D-008 — OUR run, spawned by a host incarnation that is gone. Finish
      // its tick instead of skipping ours: wait inside this fire's budget (the child's own
      // scope deadline bounds the wait, +grace for kill latency), judge the artifact, then
      // run the very same canary/health/ok-line path a same-host completion takes.
      const spawnedAt = new Date(adoptable.spawnedAtMs).toISOString();
      const deadlineMs = adoptable.spawnedAtMs + timeoutMs + GITNEXUS_ADOPT_GRACE_MS;
      const how = adoptable.stamped
        ? 'env-stamped'
        : 'unstamped, matched by the routine argv; spawn time from process age';
      console.log(
        `[gitnexus-reindex] adopting live analyze pid ${adoptable.pid} (spawned ${spawnedAt} by a previous host ` +
          `incarnation — ${how}; ${held}) — waiting up to ` +
          `${Math.max(0, Math.round((deadlineMs - Date.now()) / 60_000))} min for it to finish (WI-2146015)`,
      );
      const waited = await waitForPidExit(adoptable.pid, deadlineMs);
      if (!waited.exited) {
        console.warn(
          `[gitnexus-reindex] adopted analyze pid ${adoptable.pid} is still alive past its scope deadline ` +
            `(${spawnedAt} + ${Math.round(timeoutMs / 60_000)} min) — leaving it to the scope's own kill; ` +
            `the next tick's preflight recovers any residue`,
        );
        return;
      }
      const verdict = judgeAdoptedRun(
        adoptable.spawnedAtMs,
        readIndexMetaFreshness(root),
        readStrandedIncompleteIndex(root),
      );
      const elapsedSec = Math.round((Date.now() - adoptable.spawnedAtMs) / 1000);
      // Only a stamped spawn names its log exactly; an unstamped one's time is a process-age estimate.
      const adoptedLogPath = adoptable.stamped ? analyzeLogPath(adoptable.spawnedAtMs) : null;
      const logged = (adoptedLogPath ? readAnalyzeLogTail(adoptedLogPath) : null) ?? '';
      console.log(
        `[gitnexus-reindex] adopted analyze pid ${adoptable.pid} exited (waited ${Math.round(waited.waitedMs / 1000)}s) — ${verdict.reason}` +
          (adoptedLogPath ? ` (log: ${adoptedLogPath})` : ''),
      );
      await finishAnalyzeTick({
        ctx,
        root,
        repoName,
        dbAlertRatio,
        timeoutMs,
        elapsedSec,
        adopted: { pid: adoptable.pid, spawnedAt },
        // The reason goes LAST: failure messages keep the tail of stderr.
        r: {
          code: verdict.code,
          stdout: logged,
          stderr: verdict.code === 0 ? '' : `${logged.trimEnd()}\n${verdict.reason}`.trimStart(),
          timedOut: false,
        },
      });
      return;
    }
    const line =
      `[gitnexus-reindex] skip: an analyze writer is ALIVE on ${root} — pid(s) ${ages.join(', ')}, ` +
      `${held}; not cleaning residue, not spawning (WI-2146606)`;
    if (overBudget) {
      console.warn(
        `${line} ⚠ older than the ${Math.round(timeoutMs / 60_000)}-min timeout budget. A routine-launched ` +
          `run is bounded by its own scope deadline (managedSpawn runtimeMaxSec); a manual run is not ours to kill.`,
      );
    } else {
      console.log(line);
    }
    return;
  }

  // Crash residue is a READ-AVAILABILITY fault, not an analyze-admission concern.
  // Clean it before cadence/load/memory gates: a skipped analyze is legitimate,
  // but leaving an orphan shadow or WAL in place makes every read-only GitNexus
  // query fail until some future tick happens to elect a full rebuild.
  const residue = cleanCrashResidue(root);
  if (residue.cleaned) {
    const why =
      residue.kind === 'orphan-shadow'
        ? 'shadow present, no database — a prior analyze died BEFORE promoting it'
        : residue.kind === 'dead-shadow-wal'
          ? 'an EMPTY, stale shadow beside a real database — a prior analyze was SIGKILLed mid-build (the 20-minute timeout does this). The empty shadow used to make this state match neither residue arm, so nothing cleaned it and every read-only open segfaulted on WAL replay'
          : 'pending WAL beside a real database with no shadow — a prior analyze was killed AFTER promoting it; every read-only open was segfaulting on WAL replay';
    console.warn(
      `[gitnexus-reindex] cleaned ${residue.kind.toUpperCase()} residue (${why}): ${residue.removed.join(', ')}`,
    );
  }

  const entry = readRegistryEntry(registryPath(), repoName);
  // Freshness comes from whichever of the registry row / meta.json records the later
  // COMPLETED analyze — a registry write lost to an orphaned run must not read as "stale,
  // rebuild" (see pickIndexFreshness). `registered` stays a registry question.
  const freshness = pickIndexFreshness(entry, readIndexMetaFreshness(root));
  const commitsBehind = freshness.lastCommit ? await countCommitsBehind(root, freshness.lastCommit) : null;
  const indexedAtMs = freshness.indexedAt ? Date.parse(freshness.indexedAt) : Number.NaN;
  const secondsSinceIndexed = Number.isFinite(indexedAtMs) ? (Date.now() - indexedAtMs) / 1000 : null;
  if (freshness.source === 'meta' && entry?.indexedAt) {
    console.log(
      `[gitnexus-reindex] freshness: meta.json (${freshness.indexedAt}) is newer than the registry row (${entry.indexedAt}) — trusting the completed index on disk`,
    );
  }
  const cores = Math.max(1, os.cpus().length);

  // Reuse the same writer and thresholds that power the infra panel and
  // host.memoryPressure. This is an admission guard, not a second PSI policy:
  // `warn` (memory some >= 10%) and `crit` (memory full >= 5%) both defer a full
  // GitNexus analyze; absent/stale/unmeasured captures return null and remain
  // fail-soft, matching the writer's in-band unknown contract.
  let memoryPressure: ReindexDecisionInput['memoryPressure'] = null;
  let memoryPressureReason: string | null = null;
  try {
    const { evaluateMemoryPressure, readLatestPerfSignals } = await import('../../system-health/perf-budgets');
    const memory = evaluateMemoryPressure(await readLatestPerfSignals(), Date.now());
    memoryPressure = memory.pressure;
    memoryPressureReason = memory.reasons[0] ?? null;
  } catch (e) {
    // A missing/unreadable perf surface must not wedge the routine itself. Load/core
    // and the remaining staleness gates still protect the ordinary path.
    console.warn(`[gitnexus-reindex] memory-pressure admission unavailable: ${e instanceof Error ? e.message : e}`);
  }

  // Free-disk admission (2026-09-05 ENOSPC): measured on the index directory's filesystem
  // against the live database size, so the requirement tracks the graph as it grows. The
  // rebuild demand is additive to the alarm's critical reserve: the 2026-09-07 recurrence
  // first skipped at 13.7 GiB, then launched between alarm samples that kept the shared root
  // at 0.5–0.7% free — already inside its 2% critical band — before PostgreSQL PANICked on
  // pg_wal. Admission must leave that reserve untouched.
  const indexDir = path.join(root, '.gitnexus');
  const diskCapacity = measureDiskCapacityBytes(existsSync(indexDir) ? indexDir : root);
  const protectedReserveBytes =
    diskCapacity == null ? 0 : criticalWriteHeadroomBytes(diskCapacity.totalBytes, diskPolicyFromEnv());
  const requiredFree = requiredFreeDiskBytes(
    measureGitnexusDbUsage(root).dbBytes,
    num(cfg, 'min_free_disk_bytes', GITNEXUS_REINDEX_MIN_FREE_DISK_BYTES),
    protectedReserveBytes,
  );

  const decision = decideReindex({
    registered: entry != null,
    commitsBehind,
    loadPerCore: os.loadavg()[0] / cores,
    secondsSinceIndexed,
    memoryPressure,
    memoryPressureReason,
    freeDiskBytes: diskCapacity?.freeBytes ?? null,
    requiredFreeDiskBytes: requiredFree,
    protectedReserveBytes,
    minCommitsBehind: num(cfg, 'min_commits_behind', DEFAULT_MIN_COMMITS_BEHIND),
    maxLoadPerCore: num(cfg, 'max_load_per_core', DEFAULT_MAX_LOAD_PER_CORE),
    minIntervalSec: num(cfg, 'min_interval_sec', DEFAULT_MIN_INTERVAL_SEC),
  });

  if (!decision.run) {
    console.log(`[gitnexus-reindex] skip: ${decision.reason}`);
    return;
  }

  const startedAt = Date.now();
  console.log(`[gitnexus-reindex] running analyze (${decision.reason}) — root=${root} name=${repoName}`);
  const r = await runGitnexusAnalyze(root, repoName, timeoutMs);
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  await finishAnalyzeTick({ ctx, root, repoName, dbAlertRatio, timeoutMs, r, elapsedSec, adopted: null });
}, { routineTimeoutMs: GITNEXUS_REINDEX_ROUTINE_TIMEOUT_MS });

interface FinishAnalyzeTickInput {
  ctx: SystemActionCtx;
  root: string;
  repoName: string;
  dbAlertRatio: number;
  timeoutMs: number;
  r: AnalyzeRunResult;
  /** Wall seconds from the SPAWN — for an adopted run, the previous host's spawn. */
  elapsedSec: number;
  /** Set when this tick did not spawn the run it is finishing (WI-2146015). */
  adopted: { pid: number; spawnedAt: string } | null;
}

/**
 * The post-run half of a tick — canary, capacity refresh, the `ok in` / `exited` / `TIMED
 * OUT` line, and the gitnexus_health record — shared by a same-host completion and an
 * ADOPTED one, so the two can never diverge in what they record.
 */
async function finishAnalyzeTick(i: FinishAnalyzeTickInput): Promise<void> {
  const { ctx, root, repoName, dbAlertRatio, timeoutMs, r, elapsedSec } = i;
  const ranClean = !r.timedOut && r.code === 0;

  // P-004: a clean exit says the INDEXER ran, not that the GRAPH answers. Those came
  // apart completely on 2026-08-21 (D-016). Verify the artifact we just produced, and
  // treat a canary failure as a failure of this tick — otherwise the existing alarm rail
  // keeps reporting success over an index nobody can query.
  let canary: CanaryVerdict | null = null;
  let vectorSearch: GitnexusVectorSearchHealth | null = null;
  if (ranClean) {
    try {
      const after = readIndexStatsForHealth(root, repoName);
      const embeddingsAfter = after.embeddings;
      const embeddingsExpected = analyzeEmbeddingsExpected(buildAnalyzeArgs(root, repoName));
      canary = await runCanary(root, after.files, embeddingsAfter, embeddingsExpected, repoName);
      vectorSearch = { embeddings: embeddingsAfter, expected: embeddingsExpected, degraded: canary.degraded, checkedAt: Date.now() };
      console.log(`[gitnexus-reindex] ${canary.healthy ? 'canary OK' : 'CANARY FAILED'} — ${canary.summary}`);
      if (canary.degraded) {
        // Not a tick failure (the graph answers), but not silence either: the vector leg
        // regressing to 0 after bootstrap is exactly the state this plan exists to end.
        console.warn(`[gitnexus-reindex] canary DEGRADED — ${canary.summary}`);
      }
    } catch (e) {
      // A clean analyze exit cannot certify an index whose graph could not be read.
      // Keep the routine alive so the health ledger records a failed tick.
      console.warn(`[gitnexus-reindex] CANARY FAILED: could not run: ${e instanceof Error ? e.message : e}`);
    }
  }
  // A successful analyze can grow the DB across the threshold during this very tick;
  // refresh immediately instead of waiting an hour for the next cadence.
  if (ranClean) await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);
  const success = analyzeTickSucceeded(r, canary);

  // Read the incomplete-index marker on the FAILURE path only: on a success it is expected
  // to be absent, and on a failure it is the fact that separates a one-off from a wedged
  // rebuild loop. Reported, never cleared — see readStrandedIncompleteIndex.
  const stranded = success ? null : readStrandedIncompleteIndex(root);
  const strandedNote = describeStrandedIncompleteIndex(stranded);
  if (strandedNote) console.warn(`[gitnexus-reindex]${strandedNote}`);

  if (r.timedOut) {
    // Recover the residue HERE, not on the next tick.
    //
    // Deferring it to the preflight was measured to leave GitNexus segfaulting
    // fleet-wide for the whole gap — on 2026-08-23 the 19:35 tick was killed at
    // 19:55 and the next preflight was not due until 20:35, so every graph read
    // died for ~40 minutes of that hour. The kill above is positive proof the
    // writer is gone, which is exactly the fact `writerKnownDead` exists to
    // carry: without it the just-created shadow is younger than
    // DEAD_SHADOW_STALE_MS and no arm fires.
    //
    // Fail-soft like the rest of this action: a cleanup that cannot run must
    // never turn a timed-out tick into a thrown one, because the next tick's
    // preflight is still there as the backstop.
    let recovered: OrphanShadowCleanup | null = null;
    try {
      recovered = cleanCrashResidue(root, { writerKnownDead: true });
    } catch (e) {
      console.warn(
        `[gitnexus-reindex] post-timeout residue cleanup could not run: ${e instanceof Error ? e.message : e}`,
      );
    }
    // Name the liveness verdict, not just the outcome. "No residue was present" and "a
    // holder made us spare it" look identical from the outside and mean opposite things,
    // and re-deriving which one happened after the fact is exactly what cost this bug a
    // second investigation.
    const livenessNote =
      recovered?.writerLiveness === 'live'
        ? ' ⚠ A process still holds the shadow open despite the kill (a concurrent manual `gitnexus analyze`?) — it was deliberately SPARED.'
        : recovered?.writerLiveness === 'unknown'
          ? ' (open-handle probe unavailable — fell back to the zero-byte size proxy, which cannot see a mid-write orphan.)'
          : '';
    console.warn(
      `[gitnexus-reindex] TIMED OUT after ${timeoutMs}ms (${elapsedSec}s) — process tree killed. ` +
        (recovered?.cleaned
          ? `Crash residue (D-016) recovered IMMEDIATELY (${recovered.kind}): ${recovered.removed.join(', ')} — ` +
            'reads stay answerable instead of segfaulting until the next tick.'
          : "No crash residue was present to recover; the next tick's cleanCrashResidue() preflight remains the backstop.") +
        livenessNote,
    );
  } else if (r.code !== 0) {
    console.warn(`[gitnexus-reindex] exited ${r.code} after ${elapsedSec}s — ${(r.stderr || r.stdout).slice(-500)}`);
  } else if (!success) {
    console.warn(`[gitnexus-reindex] CANARY FAILED after ${elapsedSec}s — ${canary?.summary ?? 'canary could not run'}`);
  } else {
    const adoptedNote = i.adopted
      ? ` (ADOPTED: pid ${i.adopted.pid} was spawned ${i.adopted.spawnedAt} by a previous host incarnation; elapsed is measured from that spawn)`
      : '';
    console.log(`[gitnexus-reindex] ok in ${elapsedSec}s${adoptedNote} — ${(r.stdout || '').trim().split('\n').slice(-1)[0]}`);
  }

  // WI-35532 (b): persist the consecutive-failure streak and alert past the threshold.
  // Fully fail-soft — a DB or notify hiccup here must never fail the routine tick itself,
  // it merely means this one tick's health bookkeeping is lost (the next tick re-derives it).
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT metadata->'gitnexus_health' AS gh FROM harness_shared.routines
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug],
    )) as Array<{ gh: Partial<GitnexusHealth> | null }>;
    const prevHealth: GitnexusHealth = { ...GITNEXUS_HEALTH_DEFAULT, ...(rows[0]?.gh ?? {}) };
    const update = decideGitnexusHealthUpdate(prevHealth, success, GITNEXUS_FAILURE_ALERT_THRESHOLD, Date.now());
    // The vector leg's status rides in the same record; a tick whose canary did not run
    // keeps the previous reading rather than erasing it.
    const nextHealth: GitnexusHealth = vectorSearch ? { ...update.next, vectorSearch } : update.next;
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = now()
        WHERE install_slug = $1 AND target_role = 'system:gitnexus-reindex'`,
      [ctx.installSlug, JSON.stringify({ gitnexus_health: nextHealth })],
    );
    if (update.shouldAlert) {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: 'gitnexus-reindex failing repeatedly — code graph going stale/dead',
        body:
          `system:gitnexus-reindex has now failed ${update.next.consecutiveFailures} consecutive time(s) on ` +
          `${ctx.installSlug}. gitnexus.query / gitnexus.context lookups may be erroring while this persists. ` +
          `Latest failure: ${r.timedOut ? `timed out after ${timeoutMs}ms` : r.code !== 0 ? `exited ${r.code}` : canary?.summary ?? 'canary could not run'} — ` +
          `${(r.stderr || r.stdout).slice(-300)}${strandedNote}`,
        importance: 'urgent',
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.installSlug,
        data: {
          consecutiveFailures: update.next.consecutiveFailures,
          timedOut: r.timedOut,
          code: r.code,
          incompleteIndex: stranded,
        },
      });
    } else if (update.shouldResolve) {
      console.log(`[gitnexus-reindex] recovered after a ${prevHealth.consecutiveFailures}-failure streak`);
    }
  } catch (e) {
    console.warn(`[gitnexus-reindex] health tracking failed: ${e instanceof Error ? e.message : e}`);
  }
}
