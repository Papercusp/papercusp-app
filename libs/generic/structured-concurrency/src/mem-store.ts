/**
 * mem-store — the in-memory reference implementation of every port.
 *
 * It is the substrate the conformance suite runs the algorithms against (proving they
 * are durable-store-agnostic), and a ready default for a host that wants the mechanisms
 * without a database (a single-process fleet, a test harness). FOR-UPDATE atomicity is
 * modelled by a serial transaction mutex — JS is single-threaded, so serialising the
 * transaction bodies reproduces row-lock semantics exactly.
 */
import type {
  BucketRow,
  CircuitRow,
  CreditRow,
  GovernorStore,
  GovernorTx,
  IntensityDecision,
  RestartWindowRow,
  SagaJournal,
  SagaStepLog,
  SpawnTreeStore,
  TombstoneRef,
  TombstoneStore,
} from './ports';
import { isActiveStatus, type IntensityResult, type RestartStrategy, type SpawnNode, type SpawnStatus } from './types';

// ── Spawn-tree store ──────────────────────────────────────────────────────────────

interface SpawnRec {
  spawnId: string;
  workspaceId: string;
  harnessSlug: string | null;
  parentSpawnId: string | null;
  parentRole: string | null;
  childRole: string;
  status: SpawnStatus;
  sessionOwner: string | null;
  coordinationDomain: string;
  featureId: string | null;
  chunkId: string | null;
  planSlug: string | null;
  itemId: string | null;
  modelSpec: string | null;
  modelTier: string | null;
  brief: string | null;
  restartStrategy: RestartStrategy;
  restartCount: number;
  restartWindowStart: Date | null;
  cancelReason: string | null;
  /** Insertion order — emulates started_at for sibling ordering. */
  seq: number;
}

function recToNode(r: SpawnRec, depth: number): SpawnNode {
  return {
    spawnId: r.spawnId,
    parentSpawnId: r.parentSpawnId,
    workspaceId: r.workspaceId,
    status: r.status,
    sessionOwner: r.sessionOwner,
    coordinationDomain: r.coordinationDomain,
    restartStrategy: r.restartStrategy,
    restartCount: r.restartCount,
    restartWindowStart: r.restartWindowStart,
    depth,
    harnessSlug: r.harnessSlug,
    parentRole: r.parentRole,
    childRole: r.childRole,
    featureId: r.featureId,
    chunkId: r.chunkId,
    planSlug: r.planSlug,
    itemId: r.itemId,
    modelSpec: r.modelSpec,
    modelTier: r.modelTier,
    brief: r.brief,
  };
}

const MAX_TREE_DEPTH = 32;

export function createInMemorySpawnTreeStore(): SpawnTreeStore {
  const rows = new Map<string, SpawnRec>(); // key: ws\0spawnId
  let seq = 0;
  const key = (ws: string, id: string) => `${ws}\x00${id}`;

  function subtreeRecs(ws: string, rootId: string): { rec: SpawnRec; depth: number }[] {
    const root = rows.get(key(ws, rootId));
    if (!root) return [];
    const out: { rec: SpawnRec; depth: number }[] = [{ rec: root, depth: 0 }];
    let frontier = [root];
    let depth = 0;
    while (frontier.length && depth < MAX_TREE_DEPTH) {
      depth++;
      const next: SpawnRec[] = [];
      for (const r of rows.values()) {
        if (r.workspaceId !== ws) continue;
        if (r.parentSpawnId && frontier.some((f) => f.spawnId === r.parentSpawnId)) {
          out.push({ rec: r, depth });
          next.push(r);
        }
      }
      frontier = next;
    }
    return out;
  }

  return {
    async recordSpawn(input) {
      const k = key(input.workspaceId, input.spawnId);
      const existing = rows.get(k);
      if (existing) {
        existing.sessionOwner = input.sessionOwner ?? existing.sessionOwner;
        existing.planSlug = input.planSlug ?? existing.planSlug;
        existing.itemId = input.itemId ?? existing.itemId;
        existing.restartStrategy = input.restartStrategy ?? 'one_for_one';
        return;
      }
      rows.set(k, {
        spawnId: input.spawnId,
        workspaceId: input.workspaceId,
        harnessSlug: input.harnessSlug ?? null,
        parentSpawnId: input.parentSpawnId ?? null,
        parentRole: input.parentRole ?? null,
        childRole: input.childRole,
        status: input.status ?? 'running',
        sessionOwner: input.sessionOwner ?? null,
        coordinationDomain: input.coordinationDomain ?? 'default',
        featureId: input.featureId ?? null,
        chunkId: input.chunkId ?? null,
        planSlug: input.planSlug ?? null,
        itemId: input.itemId ?? null,
        modelSpec: input.modelSpec ?? null,
        modelTier: input.modelTier ?? null,
        brief: input.brief ?? null,
        restartStrategy: input.restartStrategy ?? 'one_for_one',
        restartCount: 0,
        restartWindowStart: null,
        cancelReason: null,
        seq: seq++,
      });
    },

    async finishSpawn(input) {
      const r = rows.get(key(input.workspaceId, input.spawnId));
      if (r) r.status = input.status;
    },

    async getSpawn(ws, spawnId) {
      const r = rows.get(key(ws, spawnId));
      return r ? recToNode(r, 0) : null;
    },

    async getSubtree(query) {
      let recs = subtreeRecs(query.workspaceId, query.rootSpawnId);
      if (query.includeRoot === false) recs = recs.filter((x) => x.depth > 0);
      recs.sort((a, b) => a.depth - b.depth || (a.rec.spawnId < b.rec.spawnId ? -1 : a.rec.spawnId > b.rec.spawnId ? 1 : 0));
      return recs.map((x) => recToNode(x.rec, x.depth));
    },

    async openChildren(ws, parentSpawnId) {
      return subtreeRecs(ws, parentSpawnId).filter((x) => x.depth > 0 && isActiveStatus(x.rec.status)).length;
    },

    async directChildren(ws, parentSpawnId) {
      const kids = [...rows.values()].filter((r) => r.workspaceId === ws && r.parentSpawnId === parentSpawnId);
      kids.sort((a, b) => a.seq - b.seq || (a.spawnId < b.spawnId ? -1 : a.spawnId > b.spawnId ? 1 : 0));
      return kids.map((r) => recToNode(r, 1));
    },

    async cancelActiveSubtree(opts) {
      const recs = subtreeRecs(opts.workspaceId, opts.rootSpawnId);
      const active = recs.filter((x) => isActiveStatus(x.rec.status));
      const alreadyTerminal = recs.filter((x) => !isActiveStatus(x.rec.status)).map((x) => x.rec.spawnId);
      // Snapshot the cancelled nodes BEFORE mutating, then flip them.
      const cancelled = active.map((x) => recToNode(x.rec, x.depth));
      for (const x of active) {
        x.rec.status = 'cancelled';
        x.rec.cancelReason = opts.reason;
      }
      return { cancelled, alreadyTerminal, resourcesReleased: {} };
    },

    async recordRestartIntensity(opts, decide): Promise<IntensityResult | null> {
      const r = rows.get(key(opts.workspaceId, opts.spawnId));
      if (!r) return null;
      const nowMs = Date.now();
      const row: RestartWindowRow = { restartCount: r.restartCount, restartWindowStart: r.restartWindowStart };
      const decision: IntensityDecision = decide(row, nowMs);
      r.restartCount = decision.count;
      r.restartWindowStart = new Date(decision.windowStartMs);
      return {
        spawnId: opts.spawnId,
        count: decision.count,
        windowStart: r.restartWindowStart,
        windowReset: decision.windowReset,
        intensityExceeded: decision.intensityExceeded,
        maxRestarts: opts.maxRestarts,
        windowSec: opts.windowSec,
      };
    },

    async markRestarting(ws, spawnIds) {
      for (const id of spawnIds) {
        const r = rows.get(key(ws, id));
        if (r && ['running', 'failed', 'cancelled', 'restarting'].includes(r.status)) r.status = 'restarting';
      }
    },

    async markFailed(ws, spawnId, _reason) {
      const r = rows.get(key(ws, spawnId));
      if (r) r.status = 'failed';
    },
  };
}

// ── Governor store ──────────────────────────────────────────────────────────────────

interface GovRec {
  kind: 'bucket' | 'circuit' | 'credit';
  capacity?: number;
  refillPerSec?: number;
  tokens?: number;
  updatedAtMs?: number | null;
  cbState?: 'closed' | 'open' | 'half_open';
  cbFailures?: number;
  cbThreshold?: number | null;
  cbCooldownSec?: number | null;
  cbOpenedAtMs?: number | null;
  credits?: number;
  creditMax?: number | null;
}

export function createInMemoryGovernorStore(): GovernorStore {
  const rows = new Map<string, GovRec>(); // key: ws\0kind\0scope
  const key = (ws: string, kind: string, scope: string) => `${ws}\x00${kind}\x00${scope}`;
  // Serial transaction mutex — reproduces FOR-UPDATE row-lock serialisation.
  let chain: Promise<unknown> = Promise.resolve();

  const tx: GovernorTx = {
    async lockCircuit(ws, scope) {
      const r = rows.get(key(ws, 'circuit', scope));
      if (!r) return null;
      return {
        state: r.cbState ?? 'closed',
        failures: Number(r.cbFailures ?? 0),
        threshold: r.cbThreshold ?? null,
        cooldownSec: r.cbCooldownSec ?? null,
        openedAtMs: r.cbOpenedAtMs ?? null,
      } satisfies CircuitRow;
    },
    async setCircuit(ws, scope, patch) {
      const r = rows.get(key(ws, 'circuit', scope));
      if (!r) return;
      if (patch.state !== undefined) r.cbState = patch.state;
      if (patch.failures !== undefined) r.cbFailures = patch.failures;
      if (patch.openedAtMs !== undefined) r.cbOpenedAtMs = patch.openedAtMs;
    },
    async lockBucket(ws, scope) {
      const r = rows.get(key(ws, 'bucket', scope));
      if (!r) return null;
      return {
        capacity: Number(r.capacity ?? 0),
        refillPerSec: Number(r.refillPerSec ?? 0),
        tokens: Number(r.tokens ?? 0),
        updatedAtMs: r.updatedAtMs ?? null,
      } satisfies BucketRow;
    },
    async setBucketTokens(ws, scope, tokens, nowMs) {
      const r = rows.get(key(ws, 'bucket', scope));
      if (r) {
        r.tokens = tokens;
        r.updatedAtMs = nowMs;
      }
    },
    async lockCredit(ws, scope) {
      const r = rows.get(key(ws, 'credit', scope));
      if (!r) return null;
      return { credits: Number(r.credits ?? 0), creditMax: r.creditMax ?? null } satisfies CreditRow;
    },
    async consumeCredit(ws, scope) {
      const r = rows.get(key(ws, 'credit', scope));
      if (r && r.credits != null) r.credits = r.credits - 1;
    },
  };

  return {
    async configureBucket(opts) {
      const k = key(opts.workspaceId, 'bucket', opts.scopeKey);
      const wantTokens = opts.tokens ?? opts.capacity;
      const nowMs = opts.nowMs ?? Date.now();
      rows.set(k, {
        kind: 'bucket',
        capacity: opts.capacity,
        refillPerSec: opts.refillPerSec,
        tokens: Math.min(wantTokens, opts.capacity),
        updatedAtMs: nowMs,
      });
    },
    async configureCircuit(opts) {
      const k = key(opts.workspaceId, 'circuit', opts.scopeKey);
      const existing = rows.get(k);
      if (existing) {
        existing.cbThreshold = opts.threshold;
        existing.cbCooldownSec = opts.cooldownSec;
        return;
      }
      rows.set(k, { kind: 'circuit', cbState: 'closed', cbFailures: 0, cbThreshold: opts.threshold, cbCooldownSec: opts.cooldownSec, cbOpenedAtMs: null });
    },
    async configureCredits(opts) {
      const k = key(opts.workspaceId, 'credit', opts.scopeKey);
      rows.set(k, { kind: 'credit', credits: opts.credits, creditMax: opts.max ?? opts.credits });
    },
    async grantCredits(opts) {
      const r = rows.get(key(opts.workspaceId, 'credit', opts.scopeKey));
      if (!r) return 0;
      const raised = (r.credits ?? 0) + opts.n;
      r.credits = r.creditMax != null ? Math.min(r.creditMax, raised) : raised;
      return r.credits;
    },
    async recordCircuitSuccess(opts) {
      const r = rows.get(key(opts.workspaceId, 'circuit', opts.scopeKey));
      if (r) {
        r.cbState = 'closed';
        r.cbFailures = 0;
        r.cbOpenedAtMs = null;
      }
    },
    transaction<T>(fn: (t: GovernorTx) => Promise<T>): Promise<T> {
      const run = chain.then(() => fn(tx));
      // Keep the chain alive even if this txn rejects, so the mutex never wedges.
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

// ── Saga journal ──────────────────────────────────────────────────────────────────

export interface InMemorySagaJournal extends SagaJournal {
  get(sagaId: string): { name: string; status: string; steps: SagaStepLog[]; error?: string } | undefined;
}

export function createInMemorySagaJournal(): InMemorySagaJournal {
  const sagas = new Map<string, { name: string; status: string; steps: SagaStepLog[]; error?: string }>();
  return {
    async create(opts) {
      sagas.set(opts.sagaId, { name: opts.name, status: 'running', steps: opts.steps.map((s) => ({ ...s })) });
    },
    async update(opts) {
      sagas.set(opts.sagaId, { name: sagas.get(opts.sagaId)?.name ?? '', status: opts.status, steps: opts.steps.map((s) => ({ ...s })), error: opts.error });
    },
    get(sagaId) {
      return sagas.get(sagaId);
    },
  };
}

// ── Tombstone store ──────────────────────────────────────────────────────────────────

interface TombRec {
  refKind: string;
  refId: string;
  reason: string;
  deletedBy: string | null;
  deletedAtMs: number;
  gcAfterMs: number;
  restoredAtMs: number | null;
}

export function createInMemoryTombstoneStore(): TombstoneStore {
  const rows = new Map<string, TombRec>(); // key: ws\0kind\0id
  const key = (r: TombstoneRef) => `${r.workspaceId}\x00${r.refKind}\x00${r.refId}`;
  return {
    async upsert(ref, opts) {
      rows.set(key(ref), { refKind: ref.refKind, refId: ref.refId, reason: opts.reason, deletedBy: opts.deletedBy, deletedAtMs: opts.deletedAtMs, gcAfterMs: opts.gcAfterMs, restoredAtMs: null });
    },
    async restore(ref) {
      const r = rows.get(key(ref));
      if (r && r.restoredAtMs == null) {
        r.restoredAtMs = Date.now();
        return true;
      }
      return false;
    },
    async isTombstoned(ref) {
      const r = rows.get(key(ref));
      return !!r && r.restoredAtMs == null;
    },
    async gcExpired(opts) {
      const nowMs = opts.nowMs ?? Date.now();
      const out: string[] = [];
      for (const [k, r] of [...rows.entries()]) {
        const [ws, kind, id] = k.split('\x00');
        if (ws !== opts.workspaceId) continue;
        if (opts.refKind && kind !== opts.refKind) continue;
        if (r.restoredAtMs == null && r.gcAfterMs <= nowMs) {
          out.push(`${kind}:${id}`);
          rows.delete(k);
        }
      }
      return out;
    },
  };
}
