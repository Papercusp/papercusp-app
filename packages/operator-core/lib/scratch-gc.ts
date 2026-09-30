/**
 * Scratch storage garbage collection + quota — Phase 4 T2.3.
 *
 * Sweep policy:
 *   1. Walk ~/.papercusp/scratch/<workspace>/<toolName>/<runId>/ dirs;
 *      delete any older than RETENTION_MS (24h default).
 *   2. List ~/.papercusp/scratch/<workspace>/ dirs; if a workspace
 *      isn't in the registry, drop the whole tree (dead workspace).
 *   3. After deletion, check per-workspace usage against
 *      WORKSPACE_QUOTA_BYTES; FIFO-evict by run-dir mtime until
 *      under quota.
 *
 * Single-write overflow:
 *   - reserveScratchSpace(workspaceId, bytes) checks the workspace
 *     quota WITHOUT writing. Throws ScratchQuotaError on overflow.
 *   - The agent-tools route layer responds 507 Insufficient Storage
 *     when this throws on a tool's write path.
 *
 * The GC is conservative: it never deletes the currently-active run
 * of any tool (relies on mtime; the dispatcher bumps mtime on every
 * write). Acceptable race: a stale 24h+1min run with a slow trailing
 * write could be evicted mid-write; in practice tools either write
 * fast or extend mtime via fs.utimes if they keep the dir around.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.3.
 */

import {
  readdirSync,
  statSync,
  rmSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { scratchRoot, scratchRootForWorkspace } from './scratch-uri';

/** Retention window for run-dirs since last mtime. 24h default. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Per-workspace quota. 5 GB default. */
export const WORKSPACE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/** GC sweep cadence: 1h default. */
export const GC_INTERVAL_MS = 60 * 60 * 1000;

export class ScratchQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScratchQuotaError';
  }
}

/** Telemetry: total bytes evicted by FIFO sweeps since process start. */
let evictedBytesTotal = 0;

export function scratchEvictionBytes(): number {
  return evictedBytesTotal;
}

/** Reset the eviction counter — test-only. */
export function _resetScratchGcCountersForTests(): void {
  evictedBytesTotal = 0;
}

/**
 * Run one full GC sweep over the scratch tree.
 *
 *   workspaceRegistry: list of known workspace IDs. Dead workspaces
 *     (dirs present in scratch but not in the registry) are removed
 *     wholesale.
 *
 * Returns a summary for logging / tests. Designed to be safe even if
 * the scratch root doesn't exist (no-op).
 */
export function runScratchGc(opts: {
  workspaceRegistry: ReadonlyArray<string>;
  now?: number;
}): {
  retentionEvictions: number;
  retentionEvictedBytes: number;
  deadWorkspaces: number;
  deadWorkspaceBytes: number;
  quotaEvictions: number;
  quotaEvictedBytes: number;
} {
  const now = opts.now ?? Date.now();
  const root = scratchRoot();
  const summary = {
    retentionEvictions: 0,
    retentionEvictedBytes: 0,
    deadWorkspaces: 0,
    deadWorkspaceBytes: 0,
    quotaEvictions: 0,
    quotaEvictedBytes: 0,
  };
  if (!existsSync(root)) return summary;

  const registrySet = new Set(opts.workspaceRegistry);

  // Step 2 (before step 1 so we don't waste work on dead workspaces):
  // remove dead workspace dirs wholesale.
  for (const workspaceId of readdirSync(root)) {
    if (registrySet.has(workspaceId)) continue;
    const dir = join(root, workspaceId);
    const bytes = sizeOfDir(dir);
    rmSync(dir, { recursive: true, force: true });
    summary.deadWorkspaces += 1;
    summary.deadWorkspaceBytes += bytes;
  }

  // Step 1: retention sweep, per-workspace.
  for (const workspaceId of opts.workspaceRegistry) {
    const wsRoot = scratchRootForWorkspace(workspaceId);
    if (!existsSync(wsRoot)) continue;
    for (const toolName of readdirSync(wsRoot)) {
      const toolDir = join(wsRoot, toolName);
      let toolDirStat;
      try { toolDirStat = statSync(toolDir); } catch { continue; }
      if (!toolDirStat.isDirectory()) continue;
      for (const runId of readdirSync(toolDir)) {
        const runDir = join(toolDir, runId);
        let runStat;
        try { runStat = statSync(runDir); } catch { continue; }
        if (!runStat.isDirectory()) continue;
        if (now - runStat.mtimeMs > RETENTION_MS) {
          const bytes = sizeOfDir(runDir);
          rmSync(runDir, { recursive: true, force: true });
          summary.retentionEvictions += 1;
          summary.retentionEvictedBytes += bytes;
        }
      }
    }
  }

  // Step 3: per-workspace quota check + FIFO eviction by mtime.
  for (const workspaceId of opts.workspaceRegistry) {
    const wsRoot = scratchRootForWorkspace(workspaceId);
    if (!existsSync(wsRoot)) continue;
    const used = sizeOfDir(wsRoot);
    if (used <= WORKSPACE_QUOTA_BYTES) continue;
    // Build a list of (runDir, mtimeMs, bytes), sort oldest first,
    // delete until under quota.
    const runs: Array<{ dir: string; mtimeMs: number; bytes: number }> = [];
    for (const toolName of readdirSync(wsRoot)) {
      const toolDir = join(wsRoot, toolName);
      let toolDirStat;
      try { toolDirStat = statSync(toolDir); } catch { continue; }
      if (!toolDirStat.isDirectory()) continue;
      for (const runId of readdirSync(toolDir)) {
        const runDir = join(toolDir, runId);
        let runStat;
        try { runStat = statSync(runDir); } catch { continue; }
        if (!runStat.isDirectory()) continue;
        runs.push({ dir: runDir, mtimeMs: runStat.mtimeMs, bytes: sizeOfDir(runDir) });
      }
    }
    runs.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let usedRunning = used;
    for (const r of runs) {
      if (usedRunning <= WORKSPACE_QUOTA_BYTES) break;
      rmSync(r.dir, { recursive: true, force: true });
      usedRunning -= r.bytes;
      summary.quotaEvictions += 1;
      summary.quotaEvictedBytes += r.bytes;
      evictedBytesTotal += r.bytes;
    }
  }

  return summary;
}

/**
 * Single-write reservation. Throws ScratchQuotaError if writing
 * `bytes` would push the workspace past WORKSPACE_QUOTA_BYTES.
 * Caller is responsible for actually performing the write.
 * Doesn't reserve atomically — concurrent writes could race past
 * the quota by a small margin; acceptable for the chat-tool use
 * case (we're not transactional).
 */
export function reserveScratchSpace(opts: {
  workspaceId: string;
  bytes: number;
}): void {
  if (opts.bytes < 0) {
    throw new ScratchQuotaError(`scratch reservation: bytes must be non-negative (got ${opts.bytes})`);
  }
  if (opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError(
      `scratch reservation: single write of ${opts.bytes} bytes exceeds workspace quota ${WORKSPACE_QUOTA_BYTES}`,
    );
  }
  const wsRoot = scratchRootForWorkspace(opts.workspaceId);
  let used = 0;
  if (existsSync(wsRoot)) used = sizeOfDir(wsRoot);
  if (used + opts.bytes > WORKSPACE_QUOTA_BYTES) {
    throw new ScratchQuotaError(
      `scratch reservation: workspace ${opts.workspaceId} used ${used} + ${opts.bytes} > quota ${WORKSPACE_QUOTA_BYTES}`,
    );
  }
}

/** Ensure the scratch directory chain exists for a (workspace, tool, run). */
export function ensureScratchRunDir(opts: {
  workspaceId: string;
  toolName: string;
  runId: string;
}): string {
  const dir = join(scratchRootForWorkspace(opts.workspaceId), opts.toolName, opts.runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Recursive bytes-on-disk for a dir. Returns 0 if missing. */
function sizeOfDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      let st;
      try { st = statSync(child); } catch { continue; }
      if (st.isDirectory()) total += sizeOfDir(child);
      else total += st.size;
    }
  } catch { /* permission denied; skip */ }
  return total;
}

/* ─── GC scheduler ───────────────────────────────────────────────────── */

/**
 * Start the periodic GC sweep. Idempotent — calling twice is a no-op.
 * Hosts call this from instrumentation-node so it survives Next dev
 * HMR / module reloads.
 *
 * The workspace registry getter is passed in (not imported directly)
 * so this module stays free of any operator-side dependencies.
 */
// Legacy startScratchGcScheduler removed (dbos-scheduler-consolidation P-005): DBOS
// owns the schedule (periodic-workflows.ts `scratchGc`). `runScratchGc` above is the
// single-run tick that workflow calls.
