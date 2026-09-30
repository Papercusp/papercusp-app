"use strict";
/**
 * @papercupai/orchestrator-spawn — Phase 9 spawn primitive.
 *
 * Lets one agent launch another via 4 tools: spawn / poll / list_active /
 * cancel. State lives in a module-level Map (lost on operator restart;
 * acceptable for v1). The actual child agent runs via the orchestrator's
 * `invoke()`, fired as a background Promise — `spawn` returns immediately
 * with a spawnId.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md (Phase 9).
 *
 * Hand-written CommonJS; mirrored by index.ts. Edit both in lockstep.
 */

const { randomUUID } = require('node:crypto');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const { existsSync, readFileSync, realpathSync } = require('node:fs');

/* ─── PG persistence (Phase 9 v1.5) ───────────────────────────────────
 * Mirrors the in-memory Map into harness_shared.spawned_agents so
 * poll/list_active are durable across operator restarts. PG failures are
 * best-effort — the plugin still works in pure-memory mode if the table
 * isn't reachable. */

let _pgClient = null;
const reapedWorkspaces = new Set();

function pg() {
  if (_pgClient) return _pgClient;
  try {
    const postgres = require('postgres');
    const url = process.env.HARNESS_DATABASE_URL ||
      'postgresql://harness_app:harness_app_pwd@localhost:5432/papercusp';
    _pgClient = postgres(url, { max: 4, idle_timeout: 30, connect_timeout: 5 });
  } catch (e) {
    // postgres package missing or connection unconfigured — degrade
    // gracefully to memory-only mode.
    return null;
  }
  return _pgClient;
}

async function pgWithWs(workspaceId, fn) {
  const client = pg();
  if (!client) return null;
  try {
    return await client.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      return await fn(tx);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[orchestrator-spawn] PG op failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function pgInsertSpawn(rec) {
  return pgWithWs(rec.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role,
         child_role, feature_id, chunk_id, run_id, status, started_at,
         session_owner, coordination_domain)
      VALUES (
        ${rec.spawnId}, ${rec.workspaceId}, ${rec.harnessSlug},
        ${rec.parentSpawnId}, ${rec.parentRole}, ${rec.childRole},
        ${rec.featureId}, ${rec.chunkId}, ${rec.runId},
        ${rec.status}, to_timestamp(${rec.startedAtMs}::double precision / 1000.0),
        ${rec.sessionOwner}, ${rec.coordinationDomain}
      )
      ON CONFLICT (spawn_id) DO NOTHING
    `;
  });
}

async function pgFinalizeSpawn(rec) {
  return pgWithWs(rec.workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.spawned_agents
         SET status = ${rec.status},
             finished_at = ${rec.finishedAtMs ? new Date(rec.finishedAtMs) : null},
             duration_ms = ${rec.durationMs},
             exit_code = ${rec.exitCode},
             output_tail = ${rec.output ? rec.output.slice(-2000) : null},
             error_message = ${rec.error}
       WHERE spawn_id = ${rec.spawnId}
    `;
  });
}

async function pgGetSpawn(workspaceId, spawnId) {
  return pgWithWs(workspaceId, async (tx) => {
    const rows = await tx`
      SELECT spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role,
             child_role, feature_id, chunk_id, run_id, status,
             started_at, finished_at, duration_ms, exit_code,
             output_tail, error_message, cancel_requested
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${spawnId}
       LIMIT 1
    `;
    return rows[0] ?? null;
  });
}

async function pgListActive(workspaceId, parentSpawnId) {
  return pgWithWs(workspaceId, async (tx) => {
    if (parentSpawnId) {
      return await tx`
        SELECT spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role,
               child_role, feature_id, chunk_id, run_id, status,
               started_at, finished_at, duration_ms, exit_code,
               output_tail, error_message, cancel_requested
          FROM harness_shared.spawned_agents
         WHERE parent_spawn_id = ${parentSpawnId}
           AND status = 'running'
         ORDER BY started_at DESC
         LIMIT 200
      `;
    }
    return await tx`
      SELECT spawn_id, workspace_id, harness_slug, parent_spawn_id, parent_role,
             child_role, feature_id, chunk_id, run_id, status,
             started_at, finished_at, duration_ms, exit_code,
             output_tail, error_message, cancel_requested
        FROM harness_shared.spawned_agents
       WHERE status = 'running'
       ORDER BY started_at DESC
       LIMIT 200
    `;
  });
}

/**
 * Transitive cancel (fleet-as-supervised-blackboard D-003): flip cancel_requested +
 * status='cancelled' on the named spawn AND every descendant, in one statement. The
 * "cancellation flows DOWN the nursery" invariant at the durable-tree layer. Lock /
 * work-item-claim release-NOW is the operator engine's job (fleet:cancel, which reads
 * this same tree and uses session_owner); otherwise the leases reclaim them. Returns
 * the rows it transitioned.
 */
async function pgCancelSubtree(workspaceId, spawnId) {
  return pgWithWs(workspaceId, async (tx) => {
    const rows = await tx`
      WITH RECURSIVE tree AS (
        SELECT spawn_id, 0 AS depth
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId} AND spawn_id = ${spawnId}
        UNION ALL
        SELECT c.spawn_id, t.depth + 1
          FROM harness_shared.spawned_agents c
          JOIN tree t ON c.parent_spawn_id = t.spawn_id
         WHERE c.workspace_id = ${workspaceId} AND t.depth < 32
      )
      UPDATE harness_shared.spawned_agents s
         SET cancel_requested = true,
             status = CASE WHEN s.status IN ('running', 'restarting') THEN 'cancelled' ELSE s.status END,
             finished_at = COALESCE(s.finished_at, now()),
             cancelled_at = COALESCE(s.cancelled_at, now())
       WHERE s.workspace_id = ${workspaceId}
         AND s.spawn_id IN (SELECT spawn_id FROM tree)
      RETURNING s.spawn_id, s.status
    `;
    return rows;
  });
}

/**
 * Reap rows still 'running' at process boot for this workspace. Their
 * owning operator process is gone (we just started); mark them definitively
 * dead so list_active and the Intel panel don't show ghost rows. One-shot
 * per workspace per process lifetime.
 */
async function pgReapStaleRunning(workspaceId) {
  if (reapedWorkspaces.has(workspaceId)) return;
  reapedWorkspaces.add(workspaceId);
  await pgWithWs(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.spawned_agents
         SET status = 'reaped',
             finished_at = COALESCE(finished_at, now()),
             error_message = 'reaped at operator restart — owning process is gone'
       WHERE status = 'running'
         AND workspace_id = ${workspaceId}
    `;
  });
}

function pgRowToView(row) {
  if (!row) return null;
  const startedAtMs = row.started_at instanceof Date ? row.started_at.getTime() : Number(row.started_at);
  const finishedAtMs = row.finished_at instanceof Date ? row.finished_at.getTime() : (row.finished_at ? Number(row.finished_at) : null);
  return {
    spawnId: row.spawn_id,
    parentSpawnId: row.parent_spawn_id,
    parentRole: row.parent_role,
    childRole: row.child_role,
    featureId: row.feature_id,
    chunkId: row.chunk_id,
    runId: row.run_id,
    harnessSlug: row.harness_slug,
    status: row.status,
    startedAtMs,
    finishedAtMs,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    exitCode: row.exit_code,
    error: row.error_message,
    output: row.output_tail,
    cancelRequested: row.cancel_requested === true,
    fromPg: true,
  };
}

/* ─── Allowlist + caps ────────────────────────────────────────────── */

const ALLOWED = {
  architect: ['worker', 'validator', 'scoper', 'reviewer', 'debugger'],
  operator: ['worker', 'validator', 'scoper', 'reviewer', 'debugger', 'documenter', 'curator', 'architect'],
  debugger: ['validator'],
  scoper: ['validator', 'reviewer'],
  reviewer: ['architect'],
  worker: [],
  validator: [],
  documenter: [],
  curator: [],
};

const MAX_DEPTH = 3;
const MAX_CHILDREN_PER_PARENT = 5;
const MAX_CONCURRENT = 10;

/* ─── State ────────────────────────────────────────────────────────── */

/** Map<spawnId, SpawnRecord> */
const spawns = new Map();

function depthOf(parentSpawnId) {
  // Walk parent chain via the Map; counts how many spawns are in our
  // own ancestry. Bounded at MAX_DEPTH+1 so a malformed loop can't blow
  // up. The recursive view in PG handles cross-restart depth; this
  // in-process check is the same-session-only guard.
  let depth = 0;
  let cur = parentSpawnId;
  while (cur && depth <= MAX_DEPTH + 1) {
    const rec = spawns.get(cur);
    if (!rec) break;
    cur = rec.parentSpawnId;
    depth++;
  }
  return depth;
}

function countChildrenOf(parentSpawnId) {
  let n = 0;
  for (const rec of spawns.values()) {
    if (rec.parentSpawnId === parentSpawnId) n++;
  }
  return n;
}

function countConcurrent() {
  let n = 0;
  for (const rec of spawns.values()) {
    if (rec.status === 'running') n++;
  }
  return n;
}

/* ─── InvokeContext construction ──────────────────────────────────── */

function harnessPackageDir() {
  const fromEnv = process.env.PAPERCUSP_HARNESS_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), 'autonomous-harness');
}

function readPhaseFromConfig(stateDir) {
  try {
    const cfgPath = join(stateDir, 'config.json');
    if (!existsSync(cfgPath)) return 'staging';
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return cfg.phase || 'staging';
  } catch { return 'staging'; }
}

function buildInvokeContext(toolCtx) {
  const projectDir = toolCtx.projectDir;
  const stateDir = toolCtx.stateDir || join(projectDir, '.papercusp');
  const logDir = join(stateDir, 'logs');
  return {
    harnessDir: harnessPackageDir(),
    projectDir,
    stateDir,
    logDir,
    phase: readPhaseFromConfig(stateDir),
    claudeCmd: process.env.AGENT_CMD || process.env.CLAUDE || 'omp -p',
    agentBackend: 'omp',
    dept: '',
    log: (msg) => { /* swallow inside plugin handler — agent stdout writes via run.log.jsonl */ },
    workspaceId: toolCtx.workspaceId,
  };
}

/* ─── Spawn engine ─────────────────────────────────────────────────── */

// Register tsx's ESM loader once. The orchestrator package is source-
// only TypeScript (.ts files, extensionless imports) and exports point
// at src/*.ts directly. Plain Node 25 ESM can't resolve extensionless
// TS imports — tsx's loader handles both .ts resolution and the
// implicit .js→.ts extension mapping. We register lazily on first
// loadOrchestrator() call so plugins that never spawn don't pay the
// cost. Idempotent — tsx's register() de-dupes internally.
let _tsxRegistered = false;
function ensureTsxRegistered() {
  if (_tsxRegistered) return;
  try {
    // tsx/esm/api is ESM-only; we're in a .cjs context, so use dynamic
    // import. The register call hooks Node's loader globally for this
    // process from this point forward.
    return import('tsx/esm/api').then(({ register }) => {
      register();
      _tsxRegistered = true;
    });
  } catch (err) {
    // If tsx isn't available, we'll fall through and the import below
    // will fail with the original module-resolution error. That's the
    // honest signal that the runtime is misconfigured.
    console.warn('[orchestrator-spawn] tsx loader registration failed:', err);
  }
}

async function loadOrchestrator() {
  // The orchestrator package re-exports `invoke` from its root (no
  // `/invoke` subpath in package.json#exports). The package is source-
  // only TS with extensionless inner imports — register tsx's loader
  // before importing so Node can resolve them.
  await ensureTsxRegistered();
  return await import('@papercusp/orchestrator');
}

/** Walk up to the nearest `.git` ancestor (mirrors locks/coordination-domain.ts). */
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * The file-lock coordination domain a spawned child will use — the realpath repo
 * root (workspace-INDEPENDENT, per locks/coordination-domain.ts), so transitive
 * cancellation can release the child's file locks in papercusp_su. PAPERCUSP_LOCK_DOMAIN
 * overrides (matches the operator's resolver).
 */
function lockDomainFor(projectDir) {
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) return override.trim();
  const base = projectDir || process.cwd();
  try { return realpathSync(findRepoRoot(base)); } catch { return findRepoRoot(base); }
}

function makeSpawnRecord(input, toolCtx, childRole) {
  const spawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    spawnId,
    parentSpawnId: toolCtx.spawnId || null,
    parentRole: toolCtx.role,
    childRole,
    featureId: input.featureId || null,
    chunkId: input.chunkId || null,
    runId: toolCtx.runId,
    workspaceId: toolCtx.workspaceId,
    harnessSlug: toolCtx.harnessSlug,
    // The child's ?client= is its spawnId (spawn-mcp.ts §signed-su-url), so its
    // coordination/lock owner IS its spawnId — the link fleet:cancel uses to release
    // its locks/claims (migration 146, D-003).
    sessionOwner: spawnId,
    coordinationDomain: lockDomainFor(toolCtx.projectDir),
    startedAtMs: Date.now(),
    finishedAtMs: null,
    status: 'running',
    abortController: new AbortController(),
    extras: Array.isArray(input.extras) ? [...input.extras] : [],
    output: null,
    error: null,
    exitCode: null,
    durationMs: null,
  };
}

/* ─── Tool handlers ────────────────────────────────────────────────── */

async function spawn(input, ctx) {
  const callerRole = ctx.role;
  const childRole = String(input.role || '').trim();

  // 1. Allowlist
  const allowed = ALLOWED[callerRole] || [];
  if (!allowed.includes(childRole)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_role_not_allowed',
        message: `Role "${callerRole}" cannot spawn "${childRole}". Allowed: ${allowed.length ? allowed.join(', ') : '(none)'}.`,
      }, null, 2) }],
    };
  }

  // 2. Worker requires chunkId per the framework's quota window keying.
  if (childRole === 'worker' && !input.chunkId) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_invalid_input',
        message: 'role="worker" requires chunkId so the child\'s tool quotas window correctly.',
      }, null, 2) }],
    };
  }

  // 3. Depth cap (in-process portion; cross-restart depth comes from PG).
  const depth = depthOf(ctx.spawnId);
  if (depth >= MAX_DEPTH) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_depth_exceeded',
        message: `Spawn depth ${depth} >= cap ${MAX_DEPTH}. Cannot spawn another child from this lineage.`,
      }, null, 2) }],
    };
  }

  // 4. Per-parent cap.
  const childCount = countChildrenOf(ctx.spawnId);
  if (childCount >= MAX_CHILDREN_PER_PARENT) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_children_exceeded',
        message: `Parent already has ${childCount} children (cap ${MAX_CHILDREN_PER_PARENT}). Wait for some to finish or cancel before spawning more.`,
      }, null, 2) }],
    };
  }

  // 5. Global concurrency cap.
  const concurrent = countConcurrent();
  if (concurrent >= MAX_CONCURRENT) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_concurrent_exceeded',
        message: `${concurrent} spawns already running (cap ${MAX_CONCURRENT}). Wait or cancel.`,
      }, null, 2) }],
    };
  }

  // 6. Reap stale 'running' rows from prior process. One-shot per
  //    workspace per process. No-op if already done or if PG is down.
  await pgReapStaleRunning(ctx.workspaceId).catch(() => {});

  // 7. Build the spawn record + InvokeContext + extras.
  const record = makeSpawnRecord(input, ctx, childRole);
  spawns.set(record.spawnId, record);

  // 8. Mirror the launch into PG. Best-effort; we don't fail the spawn
  //    if PG isn't reachable — in-memory mode still works.
  await pgInsertSpawn(record).catch(() => {});

  const invokeCtx = buildInvokeContext(ctx);
  const extras = [...record.extras];
  if (record.featureId) extras.push(`FEATURE_ID=${record.featureId}`);
  if (record.chunkId) extras.push(`CHUNK_ID=${record.chunkId}`);

  // 9. Fire invoke() in the background. Don't await — return spawnId
  //    immediately. .then/.catch updates the record AND the PG row.
  const finalize = () => pgFinalizeSpawn(record).catch(() => {});
  loadOrchestrator()
    .then(({ invoke }) =>
      invoke(invokeCtx, childRole, extras, {
        parentSpawnId: record.spawnId,
        signal: record.abortController.signal,
      }),
    )
    .then((result) => {
      record.finishedAtMs = Date.now();
      record.durationMs = record.finishedAtMs - record.startedAtMs;
      record.exitCode = result?.exitCode ?? null;
      record.output = (result?.output ?? '').slice(-2000);
      record.status = record.abortController.signal.aborted
        ? 'cancelled'
        : (result?.exitCode === 0 ? 'done' : 'failed');
      void finalize();
    })
    .catch((err) => {
      record.finishedAtMs = Date.now();
      record.durationMs = record.finishedAtMs - record.startedAtMs;
      record.error = err instanceof Error ? err.message : String(err);
      record.status = record.abortController.signal.aborted ? 'cancelled' : 'failed';
      void finalize();
    });

  return {
    content: [{ type: 'text', text: JSON.stringify({
      spawnId: record.spawnId,
      childRole,
      parentSpawnId: record.parentSpawnId,
      status: 'running',
      startedAtMs: record.startedAtMs,
      depth: depth + 1,
    }, null, 2) }],
  };
}

function recordToView(rec) {
  return {
    spawnId: rec.spawnId,
    parentSpawnId: rec.parentSpawnId,
    parentRole: rec.parentRole,
    childRole: rec.childRole,
    featureId: rec.featureId,
    chunkId: rec.chunkId,
    runId: rec.runId,
    harnessSlug: rec.harnessSlug,
    status: rec.status,
    startedAtMs: rec.startedAtMs,
    finishedAtMs: rec.finishedAtMs,
    durationMs: rec.durationMs,
    exitCode: rec.exitCode,
    error: rec.error,
    output: rec.output,
  };
}

async function poll(input, ctx) {
  const spawnId = String(input.spawnId || '').trim();
  // In-memory first (live abort handle, freshest state).
  const rec = spawns.get(spawnId);
  if (rec) {
    return { content: [{ type: 'text', text: JSON.stringify(recordToView(rec), null, 2) }] };
  }
  // Fall back to PG — survives operator restarts.
  const row = await pgGetSpawn(ctx.workspaceId, spawnId).catch(() => null);
  if (row) {
    return { content: [{ type: 'text', text: JSON.stringify(pgRowToView(row), null, 2) }] };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      code: 'spawn_not_found',
      message: `No spawn with id "${spawnId}" in memory or PG.`,
    }, null, 2) }],
  };
}

async function list_active(input, ctx) {
  const scope = (input && input.scope) === 'all' ? 'all' : 'mine';

  // Reap stale rows once per workspace. No-op after the first call.
  await pgReapStaleRunning(ctx.workspaceId).catch(() => {});

  // Read in-memory first; merge with PG rows we don't already know about.
  const seen = new Set();
  const out = [];
  for (const rec of spawns.values()) {
    if (rec.status !== 'running') continue;
    if (scope === 'mine' && rec.parentSpawnId !== ctx.spawnId) continue;
    out.push(recordToView(rec));
    seen.add(rec.spawnId);
  }
  const pgRows = await pgListActive(
    ctx.workspaceId,
    scope === 'mine' ? ctx.spawnId : null,
  ).catch(() => []);
  for (const row of pgRows || []) {
    if (seen.has(row.spawn_id)) continue;
    out.push(pgRowToView(row));
  }
  out.sort((a, b) => b.startedAtMs - a.startedAtMs);
  return {
    content: [{ type: 'text', text: JSON.stringify({ spawns: out, count: out.length, scope }, null, 2) }],
  };
}

/**
 * Abort the named spawn + every in-process descendant NOW (the in-memory half of
 * transitive cancellation, D-003). BFS over the spawns Map by parentSpawnId. Returns
 * the spawnIds it aborted. Parent authority covers the whole subtree, so descendant
 * role-permission is not re-checked (the caller already owns this lineage).
 */
function abortSubtreeInMemory(rootId) {
  const aborted = [];
  const queue = [rootId];
  const seen = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const r = spawns.get(id);
    if (r && r.status === 'running') {
      try { r.abortController.abort(); } catch { /* ignore */ }
      r.status = 'cancelled';
      r.finishedAtMs = Date.now();
      r.durationMs = r.finishedAtMs - r.startedAtMs;
      aborted.push(id);
      void pgFinalizeSpawn(r).catch(() => {});
    }
    for (const child of spawns.values()) {
      if (child.parentSpawnId === id) queue.push(child.spawnId);
    }
  }
  return aborted;
}

async function cancel(input, ctx) {
  const spawnId = String(input.spawnId || '').trim();
  const callerRole = ctx.role;
  const allowed = ALLOWED[callerRole] || [];

  // Resolve the NAMED spawn's childRole for the auth check (memory first, then PG).
  const rec = spawns.get(spawnId);
  let namedChildRole = rec ? rec.childRole : null;
  if (!namedChildRole) {
    const row = await pgGetSpawn(ctx.workspaceId, spawnId).catch(() => null);
    if (!row) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          code: 'spawn_not_found',
          message: `No spawn with id "${spawnId}" in memory or PG.`,
        }, null, 2) }],
      };
    }
    namedChildRole = row.child_role;
  }
  if (!allowed.includes(namedChildRole)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        code: 'spawn_role_not_allowed',
        message: `Role "${callerRole}" cannot cancel a "${namedChildRole}" spawn.`,
      }, null, 2) }],
    };
  }

  // Transitive cancellation (D-003): abort live descendants in-process NOW, and flip
  // cancel_requested + status across the whole durable subtree. The operator engine's
  // fleet:cancel performs the locks/claims release-now (it reads this tree's
  // session_owner); leases reclaim anything that path misses.
  const abortedInMemory = abortSubtreeInMemory(spawnId);
  const cancelledRows = await pgCancelSubtree(ctx.workspaceId, spawnId).catch(() => []);

  return {
    content: [{ type: 'text', text: JSON.stringify({
      spawnId,
      cancelled: (cancelledRows || []).map((r) => r.spawn_id),
      abortedInMemory,
      note: 'Transitive cancel: this spawn + all descendants flagged cancel_requested + status=cancelled in the durable tree, and aborted in-process where live. Lock/work-item-claim release-NOW is the operator fleet:cancel path (reads session_owner); otherwise leases reclaim them.',
    }, null, 2) }],
  };
}

/* ─── Plugin export ────────────────────────────────────────────────── */

const tools = { spawn, poll, list_active, cancel };

const plugin = {
  kind: 'plugin',
  name: '@papercupai/orchestrator-spawn',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Phase 9 spawn primitive — agents spawning agents as a tool call.',
  capabilities: [
    'tools:orchestrator:spawn:worker',
    'tools:orchestrator:spawn:validator',
    'tools:orchestrator:spawn:scoper',
    'tools:orchestrator:spawn:reviewer',
    'tools:orchestrator:spawn:debugger',
    'tools:orchestrator:spawn:architect',
    'tools:orchestrator:spawn:documenter',
    'tools:orchestrator:spawn:curator',
  ],
  tools,
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.tools = tools;

/** Test-only: drop all in-flight + finished spawns. */
module.exports._resetSpawnsForTests = function _resetSpawnsForTests() {
  for (const rec of spawns.values()) {
    try { rec.abortController.abort(); } catch { /* ignore */ }
  }
  spawns.clear();
};
// touch 1778408247
// touch 1778408955
