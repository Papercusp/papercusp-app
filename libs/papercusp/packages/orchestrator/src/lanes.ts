/**
 * Parallel-lane / competition-mode lane manager.
 *
 * Bash run.sh tracks lanes via OS PIDs in `<stateDir>/lanes.json`. The TS
 * port runs all lanes in-process via Promises — each "lane" is a
 * `Promise<void>` representing an in-flight worker invocation. We persist
 * a minimal lanes.json so the harness UI's status panels (which the bash
 * tooling already reads) keep working.
 *
 * Two modes:
 *   - **lane**: up to N workers run on different features in parallel.
 *     Each worker uses its own branch/worktree (Stage 3 subsystem). The
 *     orchestrator waits for an open lane before dispatching the next
 *     NEXT_WORKER.
 *   - **competition**: N workers run on the SAME feature in sibling
 *     worktrees. After all finish, validator picks a winner via
 *     COMPETITION_WINNER lane-N in its output. Winner branch is merged;
 *     loser worktrees are dropped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configGet } from './config';
import type { HarnessConfig } from './types';

export interface LaneRecord {
  /** Internal monotonic id (replaces bash's OS PID; PIDs aren't meaningful in-process). */
  id: number;
  feature_id: string;
  started_at: number;
  /** Set when the lane finishes. UI reads this to show lane completion. */
  finished_at?: number;
}

export interface LanePool {
  /** Wait for an open slot under `max`; returns when count < max. */
  acquire(featureId: string): Promise<number>;
  /** Mark a lane finished. Called when the worker promise resolves. */
  release(id: number): void;
  /** Block until every active lane has resolved. Used before validator runs. */
  waitAll(): Promise<void>;
  /** Block until no lanes match `featureId`. Used to drain a single
   *  feature's competitors before its validator runs (other features'
   *  competitions keep running in the background). */
  waitForFeature(featureId: string): Promise<void>;
  /** How many lanes are currently in flight. */
  count(): number;
  /** How many lanes are tagged with `featureId`. */
  countForFeature(featureId: string): number;
}

let _idCounter = 0;

function nextId(): number {
  _idCounter += 1;
  return _idCounter;
}

/** Read the configured concurrency cap (default 1). */
export function parallelMaxWorkers(cfg: HarnessConfig): number {
  const v = configGet<unknown>(cfg, 'parallelWorkers.max', 1);
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * Worker-count tier configuration.
 *
 * When tiers are configured under `parallelWorkers.adaptive`, the
 * orchestrator LLM picks how many workers to dispatch per feature from
 * this bounded vocabulary. Defaults: {1, 2, 4} = trivial / normal / hard.
 *
 * Returning an immutable shape (cloned arrays) so callers can't mutate
 * cached config.
 */
export interface WorkerCountTiers {
  tiers: number[];
  labels: string[];
  rubric: string;
}

export const DEFAULT_WORKER_COUNT_TIERS: WorkerCountTiers = {
  tiers: [1, 2, 4],
  labels: ['trivial', 'normal', 'hard'],
  rubric: '',
};

/**
 * Whether worker-count tiers are configured for this harness. True when
 * either an explicit `parallelWorkers.adaptive` block exists OR the
 * legacy `parallelWorkers.mode: 'adaptive'` field is set without a
 * block (in which case the default tier set [1,2,4] applies). The
 * legacy fallback keeps pre-synthesizer adaptive configs from silently
 * degrading to single-worker; removable once configs are migrated.
 */
export function hasWorkerCountTiers(cfg: HarnessConfig): boolean {
  if (configGet<unknown>(cfg, 'parallelWorkers.adaptive', undefined) !== undefined) {
    return true;
  }
  return configGet<string>(cfg, 'parallelWorkers.mode', '') === 'adaptive';
}

export function workerCountTiers(cfg: HarnessConfig): WorkerCountTiers {
  const raw = configGet<unknown>(cfg, 'parallelWorkers.adaptive', undefined);
  if (!raw || typeof raw !== 'object') {
    return {
      tiers: [...DEFAULT_WORKER_COUNT_TIERS.tiers],
      labels: [...DEFAULT_WORKER_COUNT_TIERS.labels],
      rubric: DEFAULT_WORKER_COUNT_TIERS.rubric,
    };
  }
  const obj = raw as Record<string, unknown>;
  const tiersIn = Array.isArray(obj.tiers) ? obj.tiers : DEFAULT_WORKER_COUNT_TIERS.tiers;
  const labelsIn = Array.isArray(obj.labels) ? obj.labels : DEFAULT_WORKER_COUNT_TIERS.labels;
  const tiers = tiersIn
    .map((n) => (typeof n === 'number' ? n : parseInt(String(n), 10)))
    .filter((n): n is number => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  const labels = labelsIn.map((s) => String(s ?? ''));
  if (tiers.length < 2 || tiers.length !== labels.length) {
    return {
      tiers: [...DEFAULT_WORKER_COUNT_TIERS.tiers],
      labels: [...DEFAULT_WORKER_COUNT_TIERS.labels],
      rubric: typeof obj.rubric === 'string' ? obj.rubric : '',
    };
  }
  return {
    tiers,
    labels,
    rubric: typeof obj.rubric === 'string' ? obj.rubric : '',
  };
}

/**
 * Resolve the worker count for one NEXT_WORKER dispatch.
 *
 * Single source of truth that replaces the lane/competition/adaptive
 * branching at dispatcher time. Logic:
 *
 *   - max=1 → always 1.
 *   - If `parallelWorkers.adaptive` tiers are configured AND the
 *     orchestrator passed an `N=<k>` via `requestedN`: validate k against
 *     the tier set (clamp to closest valid tier ≤ k, else smallest tier).
 *   - Else (no tiers OR no requestedN): use `parallelWorkersPerFeature`.
 *   - Final result is clamped to `min(max, availableSlots)` with a floor
 *     of 1.
 *
 * Pure function — does not log, does not record telemetry. Caller is
 * responsible for surfacing tier-mismatch or slot-clamp events.
 */
export function resolveWorkerCount(
  cfg: HarnessConfig,
  requestedN: number | undefined,
  availableSlots: number,
): number {
  const max = parallelMaxWorkers(cfg);
  if (max === 1) return 1;

  const hasTiers = hasWorkerCountTiers(cfg);

  let desired: number;
  if (hasTiers && requestedN !== undefined) {
    const tiers = workerCountTiers(cfg).tiers;
    if (tiers.includes(requestedN)) {
      desired = requestedN;
    } else {
      const lower = tiers.filter((t) => t <= requestedN);
      desired = lower.length > 0 ? lower[lower.length - 1] : tiers[0];
    }
  } else {
    desired = parallelWorkersPerFeature(cfg);
  }

  const cap = Math.min(max, Math.max(0, availableSlots));
  return Math.max(1, Math.min(desired, cap || 1));
}

/**
 * How many workers compete on EACH feature in competition mode.
 *
 * Pre-2026-05-07: competition always used `max` (i.e. all available
 * concurrency on a single feature, validator picks winner). That works
 * but doesn't let a user run multiple smaller competitions in parallel.
 *
 * Post-2026-05-07: `parallelWorkers.workersPerFeature` lets users tune
 * the per-feature competition size separately. Example: max=10,
 * workersPerFeature=2 → up to 5 simultaneous 2-way competitions
 * (5 features × 2 workers each = 10 lanes).
 *
 * Default for back-compat: when unset and mode=='competition', return
 * `max` (preserves the legacy "all-on-one" behavior). When unset and
 * mode=='lane', return 1 (one worker per feature, the lane-mode
 * semantics).
 */
export function parallelWorkersPerFeature(cfg: HarnessConfig): number {
  const v = configGet<unknown>(cfg, 'parallelWorkers.workersPerFeature', undefined);
  if (v !== undefined && v !== null) {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  // Back-compat fallback: pre-synthesizer harnesses configured competition
  // mode via `parallelWorkers.mode: 'competition'` (now ignored at runtime)
  // and left workersPerFeature unset, expecting it to default to `max`.
  // Without this fallback those harnesses silently degrade to 1 worker per
  // feature on first run after upgrade. Removable once configs are migrated
  // via the Settings UI (which writes workersPerFeature explicitly).
  const legacyMode = configGet<string>(cfg, 'parallelWorkers.mode', '');
  if (legacyMode === 'competition') {
    return parallelMaxWorkers(cfg);
  }
  return 1;
}

/**
 * `parallelWorkers.maxFeaturesInFlight` — caps the number of distinct
 * features that can have workers dispatched simultaneously. The
 * orchestrator's batch-dispatch greedy fit consults this AND
 * AVAILABLE_SLOTS; the smaller of the two limits the batch size.
 *
 *   - null/unset → no separate cap; only AVAILABLE_SLOTS limits.
 *   - 1 → traditional one-feature-at-a-time behavior.
 *   - >1 → cap multi-feature concurrency below the worker budget.
 *
 * Useful for lane mode (cap "width" without reducing worker count)
 * and for adaptive (cap distinct features so the orchestrator doesn't
 * spread workers too thin).
 */
export function maxFeaturesInFlight(cfg: HarnessConfig): number | null {
  const v = configGet<unknown>(cfg, 'parallelWorkers.maxFeaturesInFlight', null);
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Compatibility reader for the retired `parallelWorkers.useChunkLoop` knob.
 * The worker chunk-loop is no longer an execution route; callers that still
 * import this helper get the safe ordinary-worker path regardless of stale
 * configuration. The setting is intentionally absent from blueprint/UI
 * schemas, but this shim keeps old harness config files readable during rollout.
 */
export function useChunkLoop(cfg: HarnessConfig): boolean {
  void cfg;
  return false;
}

/**
 * `parallelWorkers.workingStateCheck` — the L1 typecheck command the
 * worker chunk loop runs after each chunk's edits. Defaults to
 * `pnpm typecheck` because that's what the papercup-shaped repo
 * targets. Other repos (Python, Rust, Go) override this via the blueprint knob
 * `parallelWorkers.workingStateCheck` or a per-install PG configOverride
 * (delivered via the HARNESS_CONFIG_JSON env-transport —
 * deprecate-harness-config-json-2026-06-06). Empty string disables the gate
 * (workers commit without a check; not recommended).
 */
export function workingStateCheckCommand(cfg: HarnessConfig): string {
  const v = configGet<string>(cfg, 'parallelWorkers.workingStateCheck', 'pnpm typecheck');
  return typeof v === 'string' ? v : 'pnpm typecheck';
}

/**
 * `parallelWorkers.replanStrikes` — how many times the worker chunk
 * loop will replan a single chunk after the L1 typecheck rejects it
 * before escalating to the debugger. Defaults to 3 — three rounds is
 * usually enough for the LLM to converge on a working bundle, and
 * past that escalation gets a smarter look at the failure.
 */
export function replanStrikes(cfg: HarnessConfig): number {
  const v = configGet<unknown>(cfg, 'parallelWorkers.replanStrikes', 3);
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
}

/**
 * `parallelWorkers.escalateToRole` — which agent role takes over when
 * a chunk hits replanStrikes. Defaults to 'debugger'. Other reasonable
 * values: 'scoper' (if you suspect the feature is misscoped),
 * 'architect' (if structural rework is needed). The role just has to
 * exist in the harness's prompt set; misspelled roles fall back to
 * marking the feature `failing` for user visibility.
 */
export function escalateToRole(cfg: HarnessConfig): string {
  const v = configGet<string>(cfg, 'parallelWorkers.escalateToRole', 'debugger');
  return typeof v === 'string' && v.length > 0 ? v : 'debugger';
}

/**
/**
 * Create an in-process lane pool. The pool persists snapshots to
 * `<stateDir>/lanes.json` so the harness UI's lane indicator keeps
 * working without depending on the bash schema.
 */
export function createLanePool(stateDir: string, max: number): LanePool {
  const lanes = new Map<number, LaneRecord & { settled: () => void }>();
  const lanesPath = join(stateDir, 'lanes.json');

  const persist = (): void => {
    const records = [...lanes.values()].map((l) => {
      // Don't persist the resolver function — only the on-disk shape.
      const { settled, ...rest } = l;
      void settled;
      return rest;
    });
    try {
      writeFileSync(lanesPath, JSON.stringify({ lanes: records }, null, 2));
    } catch {
      // Best-effort persistence; never crash the loop.
    }
  };

  return {
    async acquire(featureId: string): Promise<number> {
      // If we're at cap, wait for a lane to release.
      while (lanes.size >= max) {
        await new Promise<void>((resolve) => {
          const tick = (): void => {
            if (lanes.size < max) resolve();
            else setTimeout(tick, 50);
          };
          tick();
        });
      }
      const id = nextId();
      const record: LaneRecord & { settled: () => void } = {
        id,
        feature_id: featureId,
        started_at: Math.floor(Date.now() / 1000),
        settled: () => {},
      };
      lanes.set(id, record);
      persist();
      return id;
    },

    release(id: number): void {
      const lane = lanes.get(id);
      if (!lane) return;
      lane.finished_at = Math.floor(Date.now() / 1000);
      lanes.delete(id);
      persist();
    },

    async waitAll(): Promise<void> {
      // Active lanes have outstanding work; wait until count drops to 0.
      while (lanes.size > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    async waitForFeature(featureId: string): Promise<void> {
      const isMatch = (l: LaneRecord): boolean => l.feature_id === featureId;
      while ([...lanes.values()].some(isMatch)) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    count(): number {
      return lanes.size;
    },

    countForFeature(featureId: string): number {
      let n = 0;
      for (const l of lanes.values()) if (l.feature_id === featureId) n += 1;
      return n;
    },
  };
}

// ─── Competition manifest ────────────────────────────────────────

export interface CompetitionLane {
  lane: number;
  worktree: string;
  branch: string;
}

export interface CompetitionManifest {
  parentFeatureId: string;
  lanes: CompetitionLane[];
  n: number;
}

/** Path for `<stateDir>/competition-<fid>.json`. */
export function competitionManifestPath(stateDir: string, featureId: string): string {
  return join(stateDir, `competition-${featureId}.json`);
}

/** Build the manifest object for N competition lanes. Pure function. */
export function buildCompetitionManifest(
  stateDir: string,
  featureId: string,
  n: number,
): CompetitionManifest {
  const lanes: CompetitionLane[] = [];
  for (let i = 1; i <= n; i++) {
    lanes.push({
      lane: i,
      worktree: join(stateDir, 'worktrees', `${featureId}-lane-${i}`),
      branch: `harness/${featureId}-lane-${i}`,
    });
  }
  return { parentFeatureId: featureId, lanes, n };
}

/** Persist the manifest to disk for the validator to consume. */
export function writeCompetitionManifest(
  stateDir: string,
  featureId: string,
  n: number,
): CompetitionManifest {
  const manifest = buildCompetitionManifest(stateDir, featureId, n);
  writeFileSync(
    competitionManifestPath(stateDir, featureId),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

/** Read an existing manifest. Returns null when absent or malformed. */
export function readCompetitionManifest(
  stateDir: string,
  featureId: string,
): CompetitionManifest | null {
  const path = competitionManifestPath(stateDir, featureId);
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (
      obj &&
      typeof obj === 'object' &&
      typeof obj.parentFeatureId === 'string' &&
      Array.isArray(obj.lanes) &&
      typeof obj.n === 'number'
    ) {
      return obj as CompetitionManifest;
    }
  } catch {
    // ignore
  }
  return null;
}
