/**
 * fleet/spawn-reclaim — reclaim orphaned `spawned_agents` rows
 * (unify-agent-spawn-chokepoint-2026-06-06, P-011).
 *
 * A 'running'/'restarting' nursery row whose launching operator host died was
 * never reclaimed — it counted forever against the global concurrency ceiling
 * (the `operator-spawn.ts` "lease/timeout reclaims them" comment was aspirational;
 * no such mechanism existed). The live host now heartbeats `heartbeat_at` for its
 * own in-flight spawns (`heartbeatSpawns`); a row whose heartbeat goes stale
 * beyond `RECLAIM_STALE_MS` is presumed orphaned (host dead) and reclaimed to
 * 'failed' (`reclaimOrphanedSpawns`), freeing the ceiling.
 *
 * This is the deterministic SAFETY-floor half of the spawn chokepoint
 * (Phase 2 / durability-by-class): fail-loud + free. Re-running an autonomous
 * spawn idempotently on crash is the durable-spawn-wrapper's job (P-010); this
 * sweep only un-wedges the concurrency ceiling.
 *
 * Migration 174 adds `heartbeat_at` + the partial sweep index.
 * EI-108: When reclaiming a spawn with a parent, also wake the parent.
 */
import { hostname } from 'node:os';
import { readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import { wakeParentOnChildDeath } from './parent-wake';
import { spawnRowKind, isInProcessLaunchIdentity } from './spawn-row-class';
import { FEATURE_NON_REQUEUE_STATES, FEATURE_TERMINAL_STATES } from '../work-item-dispatch-states';
import { maybeReconcileBeeCompletion } from './bee-completion-reconcile';

/** A query handle — a pooled client or an open transaction. */
type Db = Sql | TransactionSql;

const INVOCATION_RESULT_MARKER = '__INVOCATION_RESULT__:';
const INVOCATION_DONE_SENTINEL = '__INVOCATION_DONE__';

/**
 * Stable, host-local completion artifact for a governed agent spawn. The path is
 * persisted on spawned_agents before launch; invoke-once writes it from inside
 * the scope, so it survives the launching operator process and its stdout pipe.
 */
export function spawnResultArtifactPath(projectDir: string, spawnId: string): string {
  const safeId = spawnId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(projectDir, '.papercusp', 'spawn-results', `${safeId}.log`);
}

export interface CompletedSpawnArtifact {
  exitCode: number;
  outputTail: string;
}

/** Parse only a complete artifact: the final structured marker must be followed
 * by the legacy done sentinel. A partial write is unknown, never failure. */
export function readCompletedSpawnArtifact(resultPath: string | null | undefined): CompletedSpawnArtifact | null {
  if (!resultPath) return null;
  try {
    const text = readFileSync(resultPath, 'utf8');
    const markerAt = text.lastIndexOf(INVOCATION_RESULT_MARKER);
    if (markerAt < 0) return null;
    const doneAt = text.indexOf(INVOCATION_DONE_SENTINEL, markerAt);
    if (doneAt < 0) return null;
    const encoded = text.slice(markerAt + INVOCATION_RESULT_MARKER.length, doneAt).trim();
    const parsed = JSON.parse(encoded) as { exitCode?: unknown };
    if (!Number.isInteger(parsed.exitCode)) return null;
    const output = text.slice(0, markerAt).trimEnd();
    return { exitCode: Number(parsed.exitCode), outputTail: output.slice(-2_000) };
  } catch {
    return null;
  }
}

export function removeSpawnResultArtifact(resultPath: string | null | undefined): boolean {
  if (!resultPath) return true;
  try {
    unlinkSync(resultPath);
    return true;
  } catch (error) {
    // A missing artifact is already clean. Keep the DB pointer for other
    // failures (permissions, transient filesystem errors) so the next sweep
    // can retry instead of silently losing the cleanup handle.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Keep terminal invoke-once artifacts available for post-mortem inspection,
 * then remove them once their owning spawn has been terminal for seven days. */
export const SPAWN_RESULT_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface TerminalSpawnResultArtifactReapResult {
  reaped: number;
  spawnIds: string[];
}

/**
 * Remove result artifacts left behind by terminal paths that never pass through
 * `settleCompletedSpawnArtifacts` (cancel/reclaim/normal completion). The DB
 * row is the authority for ownership and terminal age; the bounded batch keeps
 * a large historic backlog from turning the periodic sweep into an unbounded
 * filesystem loop. A terminal row's pointer is cleared only after unlinking
 * succeeds (or the file is already absent), so transient filesystem failures
 * remain retryable on the next tick.
 */
export async function reapTerminalSpawnResultArtifacts(
  sql: Db,
  opts: { retentionMs?: number; limit?: number } = {},
): Promise<TerminalSpawnResultArtifactReapResult> {
  const retentionSec = Math.max(
    1,
    Math.ceil((opts.retentionMs ?? SPAWN_RESULT_ARTIFACT_RETENTION_MS) / 1_000),
  );
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 500)));
  const candidates = await sql<{ spawn_id: string; result_path: string }[]>`
    SELECT spawn_id, result_path
      FROM harness_shared.spawned_agents
     WHERE status NOT IN ('running', 'restarting')
       AND result_path IS NOT NULL
       AND finished_at IS NOT NULL
       AND finished_at < now() - ${retentionSec}::int * interval '1 second'
     ORDER BY finished_at ASC
     LIMIT ${limit}`;

  const spawnIds: string[] = [];
  for (const candidate of candidates) {
    if (!removeSpawnResultArtifact(candidate.result_path)) continue;
    const cleared = await sql<{ spawn_id: string }[]>`
      UPDATE harness_shared.spawned_agents
         SET result_path = NULL
       WHERE spawn_id = ${candidate.spawn_id}
         AND result_path = ${candidate.result_path}
         AND status NOT IN ('running', 'restarting')
         AND finished_at IS NOT NULL
         AND finished_at < now() - ${retentionSec}::int * interval '1 second'
       RETURNING spawn_id`;
    if (cleared.length > 0) spawnIds.push(candidate.spawn_id);
  }

  return { reaped: spawnIds.length, spawnIds };
}

/** Cadence the live host bumps `heartbeat_at` for its in-flight spawns. */
export const SPAWN_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Per-process boot id (EI-2186) — a nonce minted ONCE when this operator process
 * starts. Stamped on every nursery row this process launches (`recordSpawnPid`).
 * Its job: tell a row launched by THIS live process apart from one left behind by
 * a DEAD prior incarnation on the same host, WITHOUT depending on a pid — which is
 * not stable across a host restart (the rebooted box reuses the same low pids for
 * unrelated processes, so a stale row's recorded pid can read as "alive" and wedge
 * the concurrency ceiling forever). A `running` row whose `launcher_host` is mine
 * but whose `launcher_boot_id` ≠ this is provably orphaned. Mutable only via
 * `__setLauncherBootIdForTests` so the integration tests can simulate "a row from
 * a prior boot".
 */
let LAUNCHER_BOOT_ID: string = randomUUID();

/** The current process's boot id (EI-2186). */
export function launcherBootId(): string {
  return LAUNCHER_BOOT_ID;
}

/** Test-only: override the boot id to simulate rows left by a prior incarnation. */
export function __setLauncherBootIdForTests(id: string): void {
  LAUNCHER_BOOT_ID = id;
}

/**
 * Record the child OS pid + this launcher host on a nursery row (EI-85). The
 * reclaim sweep uses these to /proc-liveness-check a stale-heartbeat row on the
 * SAME host before reclaiming it — so a child that is actually still alive (its
 * launching host was only briefly paused, not dead) is not reclaimed out from
 * under itself, and a dead one is reclaimed with an accurate reason. Best-effort.
 */
export async function recordSpawnPid(
  sql: Db,
  spawnId: string,
  pid: number,
  opts: { handoff?: boolean } = {},
): Promise<void> {
  await sql`
    UPDATE harness_shared.spawned_agents
       SET pid = ${pid},
           launcher_host = ${hostname()},
           launcher_boot_id = ${LAUNCHER_BOOT_ID},
           run_id = CASE
             WHEN ${opts.handoff === true}
              AND (run_id LIKE 'launch-%' OR spawn_id LIKE 'durable-spawn:%')
             THEN 'invoke-' || run_id
             ELSE run_id
           END
     WHERE spawn_id = ${spawnId} AND status IN ('running', 'restarting')`;
}

/**
 * Spawn-row CLASS MEMBERSHIP lives in the leaf module `./spawn-row-class` — the
 * single source of truth every classifier imports (EI-21344971525195182). It is
 * re-exported here because this module was its historical home and most callers
 * (`fixer-liveness.ts`, the integration tests, `pot/placement-watchdog.ts`)
 * already import it from this path. Change the predicates THERE, never here.
 *
 * The handoff UPDATE above (`markSpawnHandoff`) carries the one copy that module
 * cannot own — the same boundary expressed as SQL `LIKE` patterns. `spawn-row-class.test.ts`
 * pins the two against each other so they cannot drift apart again.
 */
export { spawnRowKind, isInProcessLaunchIdentity } from './spawn-row-class';
export type { SpawnRowKind } from './spawn-row-class';

/**
 * Is the recorded child process still alive on THIS host (EI-85)? Linux /proc
 * check, hardened against PID reuse: the pid must exist AND its cmdline must
 * name the invoke-once entrypoint (a reused pid running something else reads as
 * dead). Returns false on any non-Linux / unreadable case, so the caller falls
 * back to the heartbeat-stale reclaim — never a false "alive" that strands a
 * ceiling slot.
 *
 * IN-PROCESS LOOPBACK LAUNCHES (P-033, the real-Queen-reclaim fix). A
 * kind:'hive' Queen wake (and overwatch loops) is NOT a spawned `invoke-once`
 * child — it is an IN-PROCESS `/invoke` handler whose `defaultFire` row
 * (launch-blueprint.ts → `loopbackFetch`) is recorded by the firing process with
 * THAT process's pid (`recordSpawnPid(process.pid)`). The firing process is the
 * long-lived operator host (or, for the bench, the long-lived launcher that holds
 * the loopback connection open) — alive for the whole wake. So a launch row's
 * liveness is "the firing PROCESS still exists", NOT "an invoke-once child still
 * exists": this sweep proves it WITHOUT a fragile heartbeat `setInterval` (whose
 * 60s beat starves past RECLAIM_STALE_MS(300s) under multi-task load → a live
 * Queen reaped at ~310s, the 7-reclaim bench symptom). `launch` rows therefore use
 * a plain /proc-existence check (any live process), `spawn` (bee) rows keep the
 * strict invoke-once-cmdline PID-reuse hardening. A pid equal to THIS process is
 * alive by construction (we run this code in it) regardless of kind — covers the
 * reclaim running inside the very process that fired the launch.
 *
 * @param kind 'spawn' (default, an invoke-once bee child — strict cmdline check)
 *             or 'launch' (an in-process loopback launch — /proc-existence check).
 */
export function isSpawnProcessAlive(pid: number, kind: 'spawn' | 'launch' = 'spawn'): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  // The recorded pid IS this running process → alive by construction (this code
  // runs in it). Platform-agnostic, immune to PID reuse for the process lifetime.
  if (pid === process.pid) return true;
  if (process.platform !== 'linux') return false;
  try {
    // cmdline is NUL-separated. For a bee the entrypoint names invoke-once (the
    // reuse-hardening guard); for an in-process loopback launch the firing process
    // is the operator host / bench launcher — any live process counts as alive.
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return kind === 'launch' ? cmdline.length > 0 : cmdline.includes('invoke-once');
  } catch {
    return false; // /proc/<pid> gone (dead) or unreadable → treat as dead
  }
}

/**
 * A running row un-heartbeated for longer than this is presumed orphaned
 * (launching host dead). Generously larger than the heartbeat interval so a
 * live spawn whose host was briefly paused (GC, restart-in-progress) is not
 * reclaimed out from under itself.
 */
export const RECLAIM_STALE_MS = 5 * 60_000;

/**
 * P-005 (gate-verdict-liveness): role-scoped stale budget for `release-fixer` rows.
 * The generic 5-minute window reclaimed 31 live fixers in the 2026-08-31 streak
 * ("heartbeat>300s"): the launcher's 60s heartbeat `setInterval` starves under
 * multi-task load (the same starvation P-033 documents for Queen wakes), so a busy
 * host's healthy fixer drifts past RECLAIM_STALE_MS and is reclaimed mid-repair.
 * Three heartbeat-misses of headroom (15m) keeps a genuinely-dead host's fixer
 * reclaimable within one gate cron tick while riding out load-starved beats. The
 * /proc same-host liveness check still SHORT-CIRCUITS a live process regardless of
 * threshold; this budget only governs the presumption for rows it cannot probe.
 */
export const RELEASE_FIXER_RECLAIM_STALE_MS = 15 * 60_000;

/**
 * Bump `heartbeat_at` for the given live spawnIds (only while still active).
 *
 * `outputAtMs` (liveness-hardening P-008): epoch-ms of the latest stdout/
 * stderr chunk the supervising host observed per spawn — stamped onto
 * `last_output_at` in the SAME tick, so stream activity costs zero extra
 * write cadence. Monotonic guard (GREATEST) tolerates ticks racing.
 */
export async function heartbeatSpawns(
  sql: Db,
  spawnIds: string[],
  outputAtMs?: ReadonlyMap<string, number>,
): Promise<void> {
  if (spawnIds.length === 0) return;
  const withOutput = outputAtMs ? spawnIds.filter((id) => outputAtMs.has(id)) : [];
  const plain = withOutput.length === 0 ? spawnIds : spawnIds.filter((id) => !outputAtMs!.has(id));
  if (plain.length > 0) {
    await sql`
      UPDATE harness_shared.spawned_agents
         SET heartbeat_at = now()
       WHERE spawn_id = ANY(${plain}::text[])
         AND status IN ('running', 'restarting')`;
  }
  if (withOutput.length > 0) {
    const ids = withOutput;
    const stamps = withOutput.map((id) => new Date(outputAtMs!.get(id)!).toISOString());
    // WI-85288: both arrays MUST go through sql.array(). A bare `${array}` works for the
    // single-parameter `ANY(${plain}::text[])` above, but TWO array parameters in one
    // statement make postgres.js fall back to a serializer that throws
    // `The "string" argument must be of type string ... Received an instance of Array`.
    // The throw is swallowed by the caller's best-effort catch (routes/harness/spawn.ts),
    // so the only symptom was last_output_at silently staying NULL for every spawn that
    // streams output — which then reads as "this spawn has produced nothing since launch"
    // to every liveness observer. Reproduced and fixed against the live DB before landing.
    await sql`
      UPDATE harness_shared.spawned_agents AS a
         SET heartbeat_at = now(),
             last_output_at = GREATEST(coalesce(a.last_output_at, 'epoch'::timestamptz), u.output_at)
        FROM unnest(${sql.array(ids)}::text[], ${sql.array(stamps)}::timestamptz[]) AS u(spawn_id, output_at)
       WHERE a.spawn_id = u.spawn_id
         AND a.status IN ('running', 'restarting')`;
  }
}

/**
 * A bee alive-but-silent past this long is a "possibly wedged" candidate
 * (liveness-hardening P-009): the supervisor still beats for it (process
 * alive) but its stream hasn't moved — hung network call, stuck rate-limit
 * loop. This is the DISPLAY/TRIAGE threshold (the fleet:tree badge + the
 * placement-watchdog liveness derive) — a heads-up, not an action trigger.
 * The RECLAIM action waits for the longer, owner-decided WEDGE_REAP_SILENT_MS
 * below before killing a live agent.
 */
export const WEDGE_SILENT_MS = 10 * 60_000;

/**
 * The ACTION threshold (P-010 / D-006, owner decision 2026-06-11): a bee
 * stream-silent THIS long with a still-LIVE process is hung, not thinking —
 * bees stream with --include-partial-messages, so thinking deltas + tool_use
 * events keep the stream moving; the only legitimate long silence is awaiting a
 * long local tool call, which 30 minutes absorbs. Used by BOTH the in-memory
 * wedge reaper (operator-spawn `reapWedgedLocalSpawns`, re-exports this) and the
 * durable DB-truth `reclaimWedgedSpawns` below, so the two paths cannot drift.
 * Generously longer than WEDGE_SILENT_MS (the display badge) precisely because
 * this one KILLS. Override: PAPERCUSP_WEDGE_REAP_MS (floor 60s).
 * (Centralised here beside the other reclaim thresholds; was in operator-spawn.ts.)
 */
export const WEDGE_REAP_SILENT_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_WEDGE_REAP_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 30 * 60_000;
})();

/**
 * Classify a spawn row as possibly wedged: actively supervised (running, fresh
 * heartbeat) yet stream-silent past the threshold. A row with NO last_output_at
 * (pre-233, or no output observed yet) is never flagged — absence of signal is
 * not evidence of a wedge. Pure; exported for tests + fleet:tree.
 */
export function isPossiblyWedged(
  // heartbeatAt/lastOutputAt accept string too: raw PG reads return ISO strings,
  // and getMs() below normalizes Date|string|number (EI-482/EI-492). The type now
  // matches that tested contract (was Date|null — too narrow for the string path).
  row: { status: string; heartbeatAt?: Date | string | null; lastOutputAt?: Date | string | null },
  opts: { now?: number; silentMs?: number; staleMs?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const silentMs = opts.silentMs ?? WEDGE_SILENT_MS;
  const staleMs = opts.staleMs ?? RECLAIM_STALE_MS;
  if (row.status !== 'running' && row.status !== 'restarting') return false;
  if (!row.heartbeatAt) return false;
  const getMs = (v: unknown): number => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') return new Date(v).getTime();
    if (typeof v === 'number') return v;
    return NaN;
  };
  const heartbeatMs = getMs(row.heartbeatAt);
  if (isNaN(heartbeatMs) || now - heartbeatMs > staleMs) return false; // not supervised-live → the reclaim path owns it
  if (!row.lastOutputAt) return false;
  const lastOutputMs = getMs(row.lastOutputAt);
  return !isNaN(lastOutputMs) && now - lastOutputMs > silentMs;
}

export interface ReclaimResult {
  reclaimed: number;
  spawnIds: string[];
  /** Distinct workspaces whose ceiling the reclaim freed slots in — callers
   *  announce `spawn-slot:freed:<ws>` per entry so over-ceiling waiters wake
   *  (D-004 queue+await; the announce lives at the call sites, this module
   *  stays a pure sql unit). */
  workspaces: string[];
  /** Boot reconcile only (EI-85): spawnIds whose dead row was settled `failed`
   *  AND re-launched because its durable work-item is still non-terminal — i.e.
   *  the work survived the host restart. Empty for the periodic sweep. */
  relaunched?: string[];
  /** spawnIds that were NOT reclaimed because their child process is confirmed
   *  still alive on this host (a scope-isolated agent turn that survived a host/
   *  process restart) despite a `launcher_boot_id` mismatch — RE-ATTACHED to this
   *  fresh incarnation (launcher_boot_id bumped + heartbeat refreshed) instead of
   *  being flipped to `failed`. Populated by BOTH the boot reconcile (WI-1499) and
   *  the periodic sweep (WI-3961 — a mid-run boot-id mismatch, e.g. a brief
   *  bg-host restart while a cup is in flight, is only PRESUMPTIVE for a `spawn`
   *  kind row; this is the same liveness-checked re-attach, just at periodic-sweep
   *  cadence instead of boot-only). */
  reattached?: string[];
  /** Scope-isolated spawns whose launching operator disappeared but whose
   * restart-safe result artifact supplied the real terminal status. These free
   * a ceiling slot without being misclassified as an infra failure (WI-4894). */
  recovered?: string[];
  /** Durable claims freed alongside the reclaim (dead-holder release — see
   *  releaseClaimsOfDeadSpawns). */
  claimsReleased?: DeadSpawnClaimsReleased;
}

export interface DeadSpawnClaimsReleased {
  features: number;
  issues: number;
  planClaims: number;
}

/**
 * Free the durable claims a set of DEAD spawn ids still hold. Reclaiming a
 * nursery row to 'failed' frees the concurrency ceiling but NOT the work-item
 * grip: `taken_by` (features), `assignee` (engineer_issues) and
 * `plan_item_claims.owner` all still name the dead spawn, so every
 * re-placement's compare-and-claim rejects ("could not be claimed for the new
 * bee") until a slower lane ages the claim off — the Queen saw hours of
 * fleet_assignments calling the holder dead while the claim stayed held
 * (2026-07-02, WI-1508 thread). A spawned agent's owner id IS its spawn id
 * (`s-…`), so the release keys directly on the reclaimed ids. Feature items are
 * re-queued to 'todo' (unless in a non-requeue state) so dispatch sees them
 * again — mirroring operator-spawn's releaseSpawnWorkItemClaim.
 */
export async function releaseClaimsOfDeadSpawns(sql: Db, spawnIds: string[]): Promise<DeadSpawnClaimsReleased> {
  if (spawnIds.length === 0) return { features: 0, issues: 0, planClaims: 0 };
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];
  const features = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.harness_features_consolidated
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL,
           status = CASE WHEN status <> ALL(${nonRequeue}::text[]) THEN 'todo' ELSE status END,
           updated_ts = ${Date.now()}
     WHERE taken_by = ANY(${spawnIds}::text[])
    RETURNING feature_id`;
  const issues = await sql<{ issue_id: string }[]>`
    UPDATE harness_shared.engineer_issues
       SET assignee = NULL, assigned_at = NULL, origin = 'local', updated_at = now()
     WHERE assignee = ANY(${spawnIds}::text[])
    RETURNING issue_id`;
  const planClaims = await sql<{ item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims
     WHERE owner = ANY(${spawnIds}::text[])
    RETURNING item_id`;
  const released = { features: features.length, issues: issues.length, planClaims: planClaims.length };
  if (released.features || released.issues || released.planClaims) {
    console.log(
      `[spawn-reclaim] released dead-holder claims: ${released.features} feature(s) [${features.map((f) => f.feature_id).join(', ')}], ${released.issues} issue(s), ${released.planClaims} plan claim(s)`,
    );
  }
  return released;
}

interface SpawnArtifactCandidate {
  spawn_id: string;
  workspace_id: string;
  harness_slug: string | null;
  child_role: string;
  work_item_id: string | null;
  result_path: string | null;
}

interface SettledSpawnArtifact extends SpawnArtifactCandidate {
  exitCode: number;
}

/**
 * Settle complete restart-safe artifacts before any dead-PID classifier runs.
 * A prior operator may have vanished, but invoke-once is still the authority on
 * whether the scoped child succeeded. The status guard makes this race-safe
 * against the original parent finishing normally at the same time.
 */
async function settleCompletedSpawnArtifacts(
  sql: Db,
  candidates: SpawnArtifactCandidate[],
): Promise<{ rows: SettledSpawnArtifact[]; claimsReleased: DeadSpawnClaimsReleased }> {
  const settled: SettledSpawnArtifact[] = [];
  for (const candidate of candidates) {
    const artifact = readCompletedSpawnArtifact(candidate.result_path);
    if (!artifact) continue;
    const status = artifact.exitCode === 0 ? 'done' : 'failed';
    const outputTail = artifact.outputTail || null;
    const rows = await sql<{ spawn_id: string }[]>`
      UPDATE harness_shared.spawned_agents
         SET status = ${status},
             finished_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
             exit_code = ${artifact.exitCode},
             output_tail = COALESCE(${outputTail}::text, output_tail),
             last_output_at = CASE
               WHEN ${outputTail}::text IS NOT NULL THEN GREATEST(COALESCE(last_output_at, now()), now())
               ELSE last_output_at
             END,
             error_message = CASE
               WHEN ${artifact.exitCode}::int <> 0 THEN COALESCE(
                 error_message,
                 'recovered after launcher restart: invoke-once exited ' || ${artifact.exitCode}::text
               )
               ELSE error_message
             END
       WHERE spawn_id = ${candidate.spawn_id}
         AND workspace_id = ${candidate.workspace_id}
         AND status IN ('running', 'restarting')
      RETURNING spawn_id`;
    // Terminal already won elsewhere: the artifact is redundant and can go.
    if (rows.length === 0) {
      removeSpawnResultArtifact(candidate.result_path);
      continue;
    }
    settled.push({ ...candidate, exitCode: artifact.exitCode });
    removeSpawnResultArtifact(candidate.result_path);

    // Preserve the normal operator-spawn completion path's conservative Cup
    // work-item safety net. This is best-effort and only flips a claimed,
    // in-flight item on a clean rc=0.
    await maybeReconcileBeeCompletion({
      role: candidate.child_role,
      exitCode: artifact.exitCode,
      aborted: false,
      featureId: candidate.work_item_id,
      harnessSlug: candidate.harness_slug ?? '',
      workspaceId: candidate.workspace_id,
    });
    void wakeParentOnChildDeath(sql as Sql, candidate.spawn_id, candidate.workspace_id, status).catch(() => {});
  }
  const claimsReleased = await releaseClaimsOfDeadSpawns(sql, settled.map((r) => r.spawn_id));
  return { rows: settled, claimsReleased };
}

/**
 * Backstop for the HISTORIC class: claims whose `s-…` holder's nursery row is
 * already terminal (settled by an earlier sweep that predates the dead-holder
 * release above) — or absent entirely AND the claim is old (the absent-row guard
 * keeps a just-reserved claim in cup:spawn's claim-then-insert window safe).
 * Runs every periodic sweep; each matched claim is a re-placement the Queen was
 * being refused.
 */
export async function sweepStaleSpawnClaims(sql: Db): Promise<DeadSpawnClaimsReleased> {
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];
  const features = await sql<{ feature_id: string; taken_by: string }[]>`
    UPDATE harness_shared.harness_features_consolidated f
       SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL,
           status = CASE WHEN f.status <> ALL(${nonRequeue}::text[]) THEN 'todo' ELSE f.status END,
           updated_ts = ${Date.now()}
     WHERE f.taken_by LIKE 's-%'
       AND (
         EXISTS (SELECT 1 FROM harness_shared.spawned_agents a
                  WHERE a.spawn_id = f.taken_by AND a.status NOT IN ('running', 'restarting'))
         OR (NOT EXISTS (SELECT 1 FROM harness_shared.spawned_agents a WHERE a.spawn_id = f.taken_by)
             AND f.taken_at < now() - interval '1 hour')
       )
    RETURNING f.feature_id, f.taken_by`;
  const issues = await sql<{ issue_id: string }[]>`
    UPDATE harness_shared.engineer_issues i
       SET assignee = NULL, assigned_at = NULL, origin = 'local', updated_at = now()
     WHERE i.assignee LIKE 's-%'
       AND (
         EXISTS (SELECT 1 FROM harness_shared.spawned_agents a
                  WHERE a.spawn_id = i.assignee AND a.status NOT IN ('running', 'restarting'))
         OR (NOT EXISTS (SELECT 1 FROM harness_shared.spawned_agents a WHERE a.spawn_id = i.assignee)
             AND i.assigned_at < now() - interval '1 hour')
       )
    RETURNING i.issue_id`;
  const planClaims = await sql<{ item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims c
     WHERE c.owner LIKE 's-%'
       AND EXISTS (SELECT 1 FROM harness_shared.spawned_agents a
                    WHERE a.spawn_id = c.owner AND a.status NOT IN ('running', 'restarting'))
    RETURNING c.item_id`;
  const released = { features: features.length, issues: issues.length, planClaims: planClaims.length };
  if (released.features || released.issues || released.planClaims) {
    console.log(
      `[spawn-reclaim] stale-claim backstop freed: ${released.features} feature(s) [${features.map((f) => `${f.feature_id}←${f.taken_by}`).join(', ')}], ${released.issues} issue(s), ${released.planClaims} plan claim(s)`,
    );
  }
  return released;
}

/**
 * The durable identity of a reclaimed spawn the boot reconcile may RE-LAUNCH
 * (EI-85). Carries exactly the fields the re-fire needs to recreate an equivalent
 * launch — the role decides the fire path (a `queen` re-fires its hive blueprint;
 * a `bee` re-places onto its work-item), and the work-item id + its non-terminal
 * status decide WHETHER to re-launch at all.
 */
export interface RelaunchableSpawn {
  spawnId: string;
  workspaceId: string;
  harnessSlug: string;
  childRole: string;
  parentSpawnId: string | null;
  parentRole: string | null;
  /** The work-item the spawn was working (bee: `feature_id`/`item_id`). */
  workItemId: string | null;
  /** The work-item's current status, resolved by the reconcile's LEFT JOIN; null
   *  when the spawn carried no work-item id or the row no longer exists. */
  workItemStatus: string | null;
  planSlug: string | null;
  modelSpec: string | null;
  modelTier: string | null;
  brief: string | null;
}

/**
 * The re-launch seam (EI-85) — INJECTED by the caller (host-bootstrap) so this
 * module stays a pure sql unit and the integration test drives the
 * non-terminal→relaunched / terminal→reclaimed branches without a live operator.
 * Implementations re-fire the spawn (queen → fireLaunchBlueprint; bee →
 * operatorSpawn) and resolve to `true` when the re-fire was accepted. A `false` or
 * a throw leaves the row reclaimed-`failed` (the safe default — the next cadence
 * tick / Queen wake still re-places it).
 */
export type RelaunchSpawnFn = (spawn: RelaunchableSpawn) => Promise<boolean>;

/**
 * Pure: should the boot reconcile RE-LAUNCH this reclaimed spawn (vs reclaim it to
 * `failed`)? Exported for the unit test of the branch logic.
 *
 *   • only `queen`/`bee` roles re-launch (the hive members whose loss is the EI-85
 *     symptom); every other role keeps the reclaim-to-`failed` floor.
 *   • a `queen` is the per-workspace hive DRIVER — it has no single work-item, so it
 *     re-launches unconditionally (re-firing the hive blueprint is ceiling-bounded
 *     and is exactly what the routine cadence does, only sooner — closing the gap
 *     that lost orchestration between the restart and the next tick).
 *   • a `bee` re-launches IFF it carried a work-item that is still NON-TERMINAL; a
 *     bee with no work-item, or one whose work-item is already terminal/gone, has
 *     nothing durable to resume → reclaim.
 */
export function shouldRelaunchReclaimedSpawn(spawn: {
  childRole: string;
  workItemId: string | null;
  workItemStatus: string | null;
}): boolean {
  if (spawn.childRole === 'mug') return true;
  if (spawn.childRole !== 'cup') return false;
  if (!spawn.workItemId) return false;
  // Unknown status (the join found no row — the work-item was deleted) is treated
  // as terminal: nothing to resume.
  if (!spawn.workItemStatus) return false;
  return !FEATURE_TERMINAL_STATES.includes(spawn.workItemStatus);
}

/**
 * Reclaim active rows whose heartbeat went stale (host presumed dead): flip to
 * 'failed' with a clear reason + a terminal `finished_at`/`duration_ms`, freeing
 * the concurrency ceiling. Workspace-agnostic — one sweep covers every workspace
 * on the org PG. Idempotent (a row already terminal is skipped). Best-effort:
 * callers swallow errors (a missed sweep just defers the reclaim to the next one
 * or to the opportunistic reclaim on the next spawn).
 */
export async function reclaimOrphanedSpawns(
  sql: Db,
  opts: { staleMs?: number; isAlive?: (pid: number, kind?: 'spawn' | 'launch') => boolean } = {},
): Promise<ReclaimResult> {
  const staleSec = Math.max(1, Math.round((opts.staleMs ?? RECLAIM_STALE_MS) / 1000));
  const isAlive = opts.isAlive ?? isSpawnProcessAlive; // injectable for tests

  // EI-85: a stale heartbeat no longer blindly reclaims. First gather the
  // candidates with their recorded pid + launcher host; a candidate that is
  // SAME-HOST and whose process is still alive (/proc) is NOT reclaimed — its host
  // was only briefly paused, the process survived (e.g. spawned into its own
  // systemd scope, or — P-033 — an in-process loopback launch whose firing
  // operator/launcher process is still up). Such rows get their heartbeat bumped so
  // this host keeps them fresh. Everything else (process confirmed dead, no pid, or
  // a different host we can't liveness-check) is reclaimed — with a reason saying which.
  //
  // `run_id` distinguishes the row CLASS for the liveness check (P-033): a
  // `launch-%` run_id is a `defaultFire` in-process loopback launch (Queen wake /
  // overwatch) → liveness = the firing process exists; otherwise it is an
  // invoke-once bee spawn → liveness = the strict invoke-once-cmdline check.
  const candidates = await sql<
    {
      spawn_id: string;
      workspace_id: string;
      harness_slug: string | null;
      child_role: string;
      work_item_id: string | null;
      result_path: string | null;
      pid: number | null;
      launcher_host: string | null;
      run_id: string | null;
      launcher_boot_id: string | null;
    }[]
  >`
    SELECT spawn_id, workspace_id, harness_slug, child_role,
           COALESCE(item_id, feature_id) AS work_item_id, result_path,
           pid, launcher_host, run_id, launcher_boot_id
      FROM harness_shared.spawned_agents
     WHERE status IN ('running', 'restarting')
       -- P-005: release-fixers carry a role-scoped stale budget (see
       -- RELEASE_FIXER_RECLAIM_STALE_MS) so a load-starved heartbeat cannot get a
       -- healthy repair reclaimed at ~301s. An explicit staleMs override still
       -- applies uniformly (tests and targeted sweeps pass their own threshold).
       AND heartbeat_at < now() - (CASE
             WHEN ${opts.staleMs == null} AND child_role = 'release-fixer'
             THEN ${Math.max(1, Math.round(RELEASE_FIXER_RECLAIM_STALE_MS / 1000))}
             ELSE ${staleSec}
           END)::int * interval '1 second'`;
  if (candidates.length === 0) {
    // No fresh orphans — but still run the stale-claim backstop: the HISTORIC
    // class (claims whose holder was settled terminal by a pre-fix sweep) must
    // clear on idle sweeps too, not only when a new orphan happens to appear.
    const claimsReleased = await sweepStaleSpawnClaims(sql);
    return { reclaimed: 0, spawnIds: [], workspaces: [], claimsReleased };
  }

  const me = hostname();
  const alive: string[] = [];
  const deadChild: string[] = [];
  const hostGone: string[] = [];
  const priorBoot: string[] = [];
  // WI-3961: alive rows recovered from a boot-id-mismatch candidate — a `spawn`
  // kind row confirmed alive via /proc despite the mismatch (see below). These
  // need their `launcher_boot_id` REWRITTEN (not just a heartbeat bump), or every
  // future sweep re-hits the same mismatch branch for as long as the row runs.
  const reattachBoot: string[] = [];
  const completedArtifacts: SpawnArtifactCandidate[] = [];
  for (const c of candidates) {
    const sameHost = c.launcher_host != null && c.launcher_host === me;
    // A legacy/durable row is a loopback launch only until the /invoke route
    // hands off the actual child pid. After that handoff use the strict
    // invoke-once probe; the firing process and route may be different
    // operator/cluster processes.
    const kind = spawnRowKind({ spawnId: c.spawn_id, runId: c.run_id, pid: c.pid });
    // WI-4894: the durable artifact outranks a now-dead PID. A scoped Cup can
    // finish after its launching operator restarted; classifying the dead PID
    // first manufactured a failure even though invoke-once exited cleanly.
    if (kind === 'spawn' && readCompletedSpawnArtifact(c.result_path)) {
      completedArtifacts.push(c);
      continue;
    }
    // EI-2186: a same-host row stamped with a DIFFERENT (non-null) boot id was
    // launched by a prior incarnation of this operator on this host. For a
    // `launch`-kind row that is provably orphaned (its firing process IS the
    // dead predecessor, by construction — see reconcileSpawnAdmissionOnBoot's
    // doc comment) — immune to pid reuse (a rebooted host reassigns the same
    // pids, which is how a stale `launch`-kind row's recorded pid used to read
    // as "alive" and wedge the ceiling forever), so it short-circuits straight
    // to priorBoot.
    //
    // A `spawn`-kind row is DIFFERENT (WI-3961, matching WI-1499's boot-reconcile
    // fix): since bg-host-agent-spawn-scope-isolation-2026-07-02, a spawn is an
    // actual OS child launched into its own systemd user scope and can OUTLIVE
    // the operator process that launched it — including a brief mid-run bg-host
    // restart that bumps LAUNCHER_BOOT_ID out from under a still-running cup. A
    // boot-id mismatch alone is therefore only PRESUMPTIVE for a spawn row; verify
    // via the same /proc liveness check used for the non-mismatched candidates
    // below before treating it as dead. (This mirrors reconcileSpawnAdmissionOnBoot
    // exactly, just at periodic-sweep cadence instead of boot-only.)
    if (sameHost && c.launcher_boot_id != null && c.launcher_boot_id !== LAUNCHER_BOOT_ID) {
      if (kind === 'spawn' && c.pid != null && isAlive(c.pid, kind)) {
        reattachBoot.push(c.spawn_id);
      } else {
        priorBoot.push(c.spawn_id);
      }
      continue;
    }
    if (sameHost && c.pid != null) {
      if (isAlive(c.pid, kind)) alive.push(c.spawn_id);
      else deadChild.push(c.spawn_id);
    } else {
      // Different host (can't liveness-check), or a row predating pid recording.
      hostGone.push(c.spawn_id);
    }
  }

  const recovered = await settleCompletedSpawnArtifacts(sql, completedArtifacts);

  // Keep the live-but-host-paused children: bump their heartbeat so neither this
  // sweep nor the next reclaims them (their own host will resume heartbeating).
  if (alive.length > 0) await heartbeatSpawns(sql, alive);

  // WI-3961: re-attach confirmed-alive boot-id-mismatched rows to THIS incarnation
  // (boot id + heartbeat both refreshed) so they stop being a mismatch candidate —
  // same effect as reconcileSpawnAdmissionOnBoot's re-attach, run inline here since
  // the periodic sweep (unlike the boot reconcile) can hit this mid-run.
  if (reattachBoot.length > 0) {
    await sql`
      UPDATE harness_shared.spawned_agents
         SET launcher_boot_id = ${LAUNCHER_BOOT_ID}, heartbeat_at = now()
       WHERE status IN ('running', 'restarting')
         AND spawn_id = ANY(${reattachBoot}::text[])`;
  }

  const reclaimable = [...deadChild, ...hostGone, ...priorBoot];
  if (reclaimable.length === 0) {
    const recoveredIds = recovered.rows.map((r) => r.spawn_id);
    return {
      reclaimed: recoveredIds.length,
      spawnIds: recoveredIds,
      workspaces: [...new Set(recovered.rows.map((r) => r.workspace_id))],
      reattached: reattachBoot,
      recovered: recoveredIds,
      claimsReleased: recovered.claimsReleased,
    };
  }

  // Reclaim the confirmed-dead + unverifiable rows. The status guard keeps it
  // idempotent + race-safe against a concurrent sweep on another host. The
  // reason distinguishes a child we PROVED dead from a host we merely presume
  // dead — accurate diagnosis (EI-85's mislabel was exactly this).
  const rows = await sql<{ spawn_id: string; workspace_id: string }[]>`
    UPDATE harness_shared.spawned_agents
       SET status = 'failed',
           finished_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
           error_message = COALESCE(
             error_message,
             CASE
               WHEN spawn_id = ANY(${priorBoot}::text[])
                 THEN 'reclaimed: launched by a prior operator incarnation (boot-id mismatch on '
                      || COALESCE(launcher_host, '?')
                      || ') — host restarted, concurrency ceiling freed by the reclaim sweep (EI-2186)'
               WHEN spawn_id = ANY(${deadChild}::text[])
                 THEN 'reclaimed: child process (pid ' || COALESCE(pid::text, '?')
                      || ') confirmed dead on ' || COALESCE(launcher_host, '?')
                      || ' — concurrency ceiling freed by the P-011 reclaim sweep (EI-85)'
               ELSE 'reclaimed: spawn heartbeat stale > ' || ${staleSec}::text
                      || 's (launching operator host presumed dead) — concurrency ceiling freed by the P-011 reclaim sweep'
             END
           )
     WHERE status IN ('running', 'restarting')
       AND spawn_id = ANY(${reclaimable}::text[])
    RETURNING spawn_id, workspace_id`;

  // Dead-holder release (2026-07-02): free the work-item claims the reclaimed
  // spawns still hold — WITH the reclaim, not hours later via a slower lane —
  // plus the backstop for claims settled terminal by pre-fix sweeps.
  const claimsReleased = await releaseClaimsOfDeadSpawns(
    sql,
    rows.map((r) => r.spawn_id),
  );
  const backstop = await sweepStaleSpawnClaims(sql);

  // EI-108: Wake parents of reclaimed spawns (best-effort, concurrent, no await)
  for (const row of rows) {
    void wakeParentOnChildDeath(sql as Sql, row.spawn_id, row.workspace_id, 'failed').catch(() => {
      /* best-effort — logged inside wakeParentOnChildDeath */
    });
  }

  return {
    reclaimed: rows.length + recovered.rows.length,
    spawnIds: [...recovered.rows.map((r) => r.spawn_id), ...rows.map((r) => r.spawn_id)],
    workspaces: [
      ...new Set([
        ...recovered.rows.map((r) => r.workspace_id),
        ...rows.map((r) => r.workspace_id),
      ].filter(Boolean)),
    ],
    reattached: reattachBoot,
    recovered: recovered.rows.map((r) => r.spawn_id),
    claimsReleased: {
      features: recovered.claimsReleased.features + claimsReleased.features + backstop.features,
      issues: recovered.claimsReleased.issues + claimsReleased.issues + backstop.issues,
      planClaims: recovered.claimsReleased.planClaims + claimsReleased.planClaims + backstop.planClaims,
    },
  };
}

/**
 * CEILING-JAM min-age / stream-silence thresholds (EI-7204/EI-7197) — mirror the
 * watchdog's `collectCeilingJamSignals` detection window (15/15 min,
 * `packages/operator-core/lib/harness/improvements/watchdog.ts`) so the ALERT
 * and this RECLAIM ACTION agree on what "no stream activity" means. Exported so
 * the periodic sweep + tests share one knob.
 */
export const CEILING_JAM_MIN_AGE_MS = 15 * 60_000;
export const CEILING_JAM_SILENT_MS = 15 * 60_000;

/**
 * Is this nursery row a supervised invoke-once child? Legacy `launch-*` and
 * durable-spawn rows remain in-process-launch rows only until the /invoke route
 * records the actual child pid; after that handoff they use the same strict
 * liveness/ceiling rules as other supervised children.
 */
function isSupervisedBeeRow(row: { spawn_id: string; run_id: string | null; pid?: number | null }): boolean {
  return spawnRowKind({
    spawnId: row.spawn_id,
    runId: row.run_id,
    pid: row.pid ?? null,
  }) === 'spawn';
}

/**
 * `isInProcessLaunchIdentity` — the ids-only identity predicate — now lives in
 * `./spawn-row-class` and is re-exported from this module (see the re-export beside
 * `spawnRowKind` above). Its full rationale, including why it is deliberately NOT
 * `!isSupervisedBeeRow(row)` and the 71%-of-the-population measurement behind that,
 * is in that module's docblock.
 *
 * WHAT THE CONSOLIDATION FIXED (EI-21344971525195182): watchdog.ts and
 * pot/placement-watchdog.ts each carried their own hand-copied version of this
 * boundary, and watchdog's docblock claimed it "mirrors spawn-reclaim.ts's `kind`
 * classifier (the single source of truth)". It did not — its copy was ids-only and
 * stayed correct while the classifier it claimed to mirror grew an `invoke-*`
 * short-circuit. They were kept in step only by that sentence. All three now import
 * one implementation, and `spawn-row-class.test.ts` fails if a fourth copy appears.
 */

/**
 * The ceiling-jam verdict for ONE candidate row — pure, so {@link
 * reclaimCeilingJamDebits}'s decision logic (and its EI-8528/EI-8839 guards) is
 * unit-testable without a live PG:
 *   • 'stream-silent' — a supervised bee that DID stream once then went silent
 *     past `silentMs` (the original EI-7204 signal; a fresh heartbeat, e.g. a
 *     reused-pid false-alive, can't hide it).
 *   • 'proc-dead' — a supervised bee that NEVER streamed, but is SAME-HOST with a
 *     recorded pid whose child process is /proc-confirmed DEAD (EI-8839: an
 *     orphaned admission debit — reclaim it now instead of waiting for the next
 *     operator restart's boot reconcile).
 *   • 'skip' — everything else: not a supervised bee (an in-process loopback
 *     launch), too young to judge, a genuine recent stream, a NULL-output row we
 *     cannot liveness-check locally (a different host, no recorded pid, or a still-
 *     ALIVE child — the EI-8528 protection for a genuinely-working cup), or bad
 *     timestamp data (never guess).
 */
export type CeilingJamVerdict = 'stream-silent' | 'proc-dead' | 'skip';

export function classifyCeilingJamRow(
  row: {
    spawnId: string;
    runId: string | null;
    startedAt: Date | string | null;
    lastOutputAt: Date | string | null;
    launcherHost: string | null;
    pid: number | null;
  },
  opts: {
    now: number;
    minAgeMs: number;
    silentMs: number;
    me: string;
    isAlive: (pid: number, kind?: 'spawn' | 'launch') => boolean;
  },
): CeilingJamVerdict {
  if (!isSupervisedBeeRow({ spawn_id: row.spawnId, run_id: row.runId, pid: row.pid })) return 'skip';
  const getMs = (v: Date | string | null): number => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') return new Date(v).getTime();
    return NaN;
  };
  const startedMs = getMs(row.startedAt);
  if (isNaN(startedMs) || opts.now - startedMs <= opts.minAgeMs) return 'skip'; // not old enough to judge
  const outAt = row.lastOutputAt ? getMs(row.lastOutputAt) : null;
  if (outAt == null) {
    // EI-8839 second signal (see reclaimCeilingJamDebits doc): a never-streamed row
    // is jam evidence ONLY when its recorded child process is /proc-confirmed DEAD
    // on THIS host. A live child (a genuinely-working cup — the EI-8528 case) reads
    // alive and is left alone; a row we cannot liveness-check locally (different
    // host, or no recorded pid) is deferred to the orphan sweep / boot reconcile,
    // never reclaimed on a guess.
    if (row.launcherHost === opts.me && row.pid != null && !opts.isAlive(row.pid, 'spawn')) return 'proc-dead';
    return 'skip';
  }
  if (isNaN(outAt)) return 'skip'; // unparseable timestamp — never trust a jam call to bad data
  if (opts.now - outAt <= opts.silentMs) return 'skip'; // genuinely live — proved by real stream output
  return 'stream-silent';
}

/**
 * Reclaim spawn-ADMISSION debits stuck by the spawn-ceiling-jam class
 * (EI-2186/EI-7204/EI-7197) — the periodic (not just boot-time) half of the
 * recurrence guard. {@link reclaimOrphanedSpawns}'s pid-liveness check can be
 * defeated on a long-lived (never-restarted) operator process: a same-boot-id
 * row whose recorded pid happens to be reused by an UNRELATED
 * 'invoke-once'-cmdline process on a busy, high-pid-churn host reads as ALIVE
 * forever, so its heartbeat gets bumped every sweep (`heartbeatSpawns`) and it
 * NEVER satisfies that sweep's own `heartbeat_at < stale` precondition to even
 * become a candidate — the "reused-pid false-alive" class the watchdog's
 * spawn-ceiling-jam signal (`collectCeilingJamSignals`) already DETECTS via a
 * different, unfakeable proxy: stream output. A dead/wedged process cannot
 * advance `last_output_at` (stamped only by the real child-process stdout
 * supervisor), so a row old enough (`started_at` beyond {@link
 * CEILING_JAM_MIN_AGE_MS}) that has not streamed in {@link
 * CEILING_JAM_SILENT_MS} is provably stuck REGARDLESS of what its heartbeat
 * says — exactly the population this reclaims, closing the gap that
 * previously required a full operator restart (`reconcileSpawnAdmissionOnBoot`)
 * to self-heal.
 *
 * SCOPE — ceiling-DEBIT release ONLY (settles the spawned_agents row so it
 * stops counting against `maxSimultaneousAgents`), never the agent's WORK-ITEM
 * claim or its OS process: those are {@link reclaimWedgedSpawns} /
 * {@link reclaimFirstOutputStalledSpawns}'s job, gated behind the
 * RECLAIM_STALLED owner-authority dark flag (killing a live claim-holder is a
 * hot-path placement change, D-003). Settling just the ceiling row is
 * comparatively low-risk (worst case: one extra concurrent admission until the
 * real process's own `finishSpawn` — an unconditional UPDATE, so it just
 * overwrites this row again — or a later sweep catches up) and therefore
 * UNCONDITIONAL, matching `reclaimOrphanedSpawns`'s own no-flag safety-floor
 * precedent. Once this row is terminal, the EXISTING stale-claim sweep
 * (`sweepStaleSpawnClaims`, same 60s cadence) frees any claim it still held on
 * its own — no duplicate claims-release logic is needed here.
 *
 * EXCLUDES in-process loopback launches (`isSupervisedBeeRow` false, e.g.
 * durable-spawn / `launch-*` rows) — `last_output_at` is structurally NEVER
 * populated for them (EI-7215: their liveness proxy is process existence, not
 * stream recency), so this stream-recency signal cannot judge them; reclaiming
 * one on a false read (e.g. a genuinely-alive Queen singleton or long-running
 * durable-spawn worker) would be a correctness hazard this function must never
 * risk. That class's reclaim stays the boot-id-aware sweep's job.
 *
 * EI-8528 CORRECTION (2026-07-07): a NULL `last_output_at` on a SUPERVISED bee
 * row must NOT be treated as jam evidence either. This function originally read
 * "never streamed" the same as "streamed, then went silent" — but PG truth
 * across every real cup spawn in this deployment (0 of 149 supervised rows in a
 * 48h sample EVER populated `last_output_at`, root cause tracked separately as
 * the stdout-stream-wiring gap) shows `last_output_at` is currently NEVER set
 * for a live, working cup either — so "no signal" was being misread as "proof
 * of death" and this sweep was flipping genuinely-alive, mid-task cups to
 * `status='failed'` the moment they crossed {@link CEILING_JAM_MIN_AGE_MS} (15
 * min) — well within a normal long tool call (a build, a VM test cycle).
 * Confirmed empirically: WI-3282/WI-3286's real cups were reclaimed this way
 * while still working and went on to land genuine, evidenced completions 15+
 * minutes AFTER being marked 'failed' — plus each reclaim silently frees the
 * cup's work-item claim (comment above), inviting a duplicate re-placement of
 * the SAME item onto a fresh cup while the original is still legitimately
 * running. This mirrors the exact principle {@link isPossiblyWedged} already
 * documents ("absence of signal is not evidence of a wedge") — now applied
 * consistently here too: only a row that DID stream at some point and then
 * went silent past {@link CEILING_JAM_SILENT_MS} is jam evidence; a row that
 * has NEVER streamed is unproven either way and is left alone (its true
 * liveness stays the job of the heartbeat/`/proc`-liveness sweeps and, for a
 * genuinely wedged process, the flag-gated {@link reclaimWedgedSpawns}). Net
 * effect while the streaming gap is open: this sweep reclaims nothing FROM THE
 * STREAM SIGNAL — a disclosed, deliberate regression to "wait for the boot
 * reconcile" for THIS narrow signal, preferred over actively destroying live
 * work. Re-enables the stream path automatically once the streaming wiring is
 * fixed and real rows start carrying a non-null `last_output_at`.
 *
 * EI-8839 SECOND SIGNAL (2026-07-09): because the streaming gap left the sweep
 * reclaiming NOTHING for a never-streamed row, an ORPHANED admission debit —
 * a `running` row whose recorded child process actually DIED (host/process
 * restart, or the child exited) — jammed the ceiling full with ~nothing alive
 * until the next operator restart cleared it via {@link
 * reconcileSpawnAdmissionOnBoot}. The periodic {@link reclaimOrphanedSpawns}
 * misses it too: a reused-pid false-alive on a long-lived operator keeps its
 * heartbeat fresh, so it never becomes that sweep's stale-heartbeat candidate.
 * So for a never-streamed row that is old enough, SAME-HOST, and has a recorded
 * pid, we now consult a second, unfakeable signal — is the recorded child
 * process still alive on this host (`isSpawnProcessAlive`)? A /proc-confirmed
 * DEAD child proves the debit is stale regardless of the missing stream →
 * reclaim it, closing the jam WITHOUT a restart. A LIVE child (the EI-8528 case
 * — a genuinely-working cup whose 'invoke-once' process still exists) reads
 * alive → never reclaimed, so the EI-8528 protection is fully preserved. A row
 * we cannot liveness-check locally (a different host, or no recorded pid) is
 * left to the orphan sweep / boot reconcile exactly as before — never reclaimed
 * on a guess. The residual gap (a dead child whose pid was REUSED by another
 * live 'invoke-once' bee → false-alive → not reclaimed until the boot reconcile)
 * is the same, narrow false-alive limitation {@link reclaimOrphanedSpawns}
 * already carries, and is strictly no worse than the prior "reclaim nothing".
 */
export async function reclaimCeilingJamDebits(
  sql: Db,
  opts: {
    minAgeMs?: number;
    silentMs?: number;
    now?: number;
    isAlive?: (pid: number, kind?: 'spawn' | 'launch') => boolean;
  } = {},
): Promise<ReclaimResult> {
  const minAgeMs = opts.minAgeMs ?? CEILING_JAM_MIN_AGE_MS;
  const silentMs = opts.silentMs ?? CEILING_JAM_SILENT_MS;
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? isSpawnProcessAlive; // injectable for tests
  const me = hostname();

  const candidates = await sql<
    {
      spawn_id: string;
      workspace_id: string;
      harness_slug: string | null;
      child_role: string;
      work_item_id: string | null;
      result_path: string | null;
      run_id: string | null;
      started_at: string;
      last_output_at: string | null;
      launcher_host: string | null;
      pid: number | null;
    }[]
  >`
    SELECT spawn_id, workspace_id, harness_slug, child_role,
           COALESCE(item_id, feature_id) AS work_item_id, result_path,
           run_id, started_at, last_output_at, launcher_host, pid
      FROM harness_shared.spawned_agents
     WHERE status IN ('running', 'restarting')
     ORDER BY started_at ASC
     LIMIT 500`;
  if (candidates.length === 0) return { reclaimed: 0, spawnIds: [], workspaces: [] };

  // WI-4894 recurrence: this periodic path used to classify a dead invoke-once
  // PID before consulting its durable result artifact. A Cup that survived an
  // operator restart could therefore write rc=0 + DONE, exit, and still be
  // manufactured into a spawn-ceiling-jam failure on the next sweep. Harvest
  // complete supervised-spawn artifacts first, matching the orphan + boot
  // reconcilers. Once /proc says the child is dead, invoke-once's synchronous
  // final artifact append has already completed, so the artifact is the
  // authoritative terminal outcome and must outrank admission-debit cleanup.
  const recovered = await settleCompletedSpawnArtifacts(
    sql,
    candidates.filter((candidate) => isSupervisedBeeRow(candidate)),
  );
  const recoveredIds = new Set(recovered.rows.map((row) => row.spawn_id));

  const streamSilent: string[] = []; // DID stream then went silent (the original EI-7204 signal)
  const procDead: string[] = []; // never streamed, but /proc-confirmed dead on THIS host (EI-8839)
  for (const c of candidates) {
    if (recoveredIds.has(c.spawn_id)) continue;
    const verdict = classifyCeilingJamRow(
      {
        spawnId: c.spawn_id,
        runId: c.run_id,
        startedAt: c.started_at,
        lastOutputAt: c.last_output_at,
        launcherHost: c.launcher_host,
        pid: c.pid,
      },
      { now, minAgeMs, silentMs, me, isAlive },
    );
    if (verdict === 'stream-silent') streamSilent.push(c.spawn_id);
    else if (verdict === 'proc-dead') procDead.push(c.spawn_id);
  }
  const jammed = [...streamSilent, ...procDead];
  if (jammed.length === 0) {
    const recoveredSpawnIds = recovered.rows.map((row) => row.spawn_id);
    return {
      reclaimed: recoveredSpawnIds.length,
      spawnIds: recoveredSpawnIds,
      workspaces: [...new Set(recovered.rows.map((row) => row.workspace_id).filter(Boolean))],
      recovered: recoveredSpawnIds,
      claimsReleased: recovered.claimsReleased,
    };
  }

  const streamReason =
    `reclaimed: spawn-ceiling-jam — no stream activity for > ${Math.round(silentMs / 60_000)}min despite ` +
    'an apparently-fresh heartbeat (reused-pid false-alive, EI-7204/EI-7197) — periodic admission-debit ' +
    'reconcile freed the concurrency-ceiling slot; any held work-item claim is released by the next stale-claim sweep';
  const deadReason =
    'reclaimed: spawn-ceiling-jam — recorded child process confirmed dead on this host with no stream ' +
    'activity (orphaned admission debit, EI-8839) — periodic admission-debit reconcile freed the ' +
    'concurrency-ceiling slot without waiting for the next operator restart; any held work-item claim is ' +
    'released by the next stale-claim sweep';
  const rows = await sql<{ spawn_id: string; workspace_id: string }[]>`
    UPDATE harness_shared.spawned_agents
       SET status = 'failed',
           finished_at = now(),
           duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
           error_message = COALESCE(
             error_message,
             CASE WHEN spawn_id = ANY(${procDead}::text[]) THEN ${deadReason} ELSE ${streamReason} END
           )
     WHERE status IN ('running', 'restarting')
       AND spawn_id = ANY(${jammed}::text[])
    RETURNING spawn_id, workspace_id`;

  for (const row of rows) {
    void wakeParentOnChildDeath(sql as Sql, row.spawn_id, row.workspace_id, 'failed').catch(() => {
      /* best-effort — logged inside wakeParentOnChildDeath */
    });
  }

  return {
    reclaimed: rows.length + recovered.rows.length,
    spawnIds: [...recovered.rows.map((r) => r.spawn_id), ...rows.map((r) => r.spawn_id)],
    workspaces: [
      ...new Set([
        ...recovered.rows.map((r) => r.workspace_id),
        ...rows.map((r) => r.workspace_id),
      ].filter(Boolean)),
    ],
    recovered: recovered.rows.map((r) => r.spawn_id),
    claimsReleased: recovered.claimsReleased,
  };
}

/**
 * One WEDGED spawn the durable reaper may reclaim (RECLAIM_STALLED). Carries the
 * row's identity + the observed silence so the injected reap seam can frame the
 * cancellation reason without re-reading the row.
 */
export interface WedgedSpawnCandidate {
  spawnId: string;
  workspaceId: string;
  launcherHost: string | null;
  launcherBootId: string | null;
  pid: number | null;
  heartbeatAt: string | null;
  lastOutputAt: string | null;
  /** Observed stream silence at selection time (ms): now − last_output_at. */
  silentMs: number;
}

/**
 * The durable reap seam (INJECTED by the caller — host periodic sweep). Actually
 * KILL + durably cancel ONE wedged spawn: `cancelSubtree` releases its claims/locks
 * + flips the row (with a `reclaimed:`-prefixed reason so the placement watchdog
 * treats it as an infra reclaim, not item-pathology — WI-233), and
 * `abortLocalSpawn` SIGTERMs the live child. Returns true when reaped. Kept
 * injectable so this module stays a dependency-light sql unit (mirrors the
 * `RelaunchSpawnFn` seam) and the test drives the select/gate logic without the
 * cancel engine. A `false`/throw leaves the row running — the next tick (or the
 * in-memory reaper) retries; never a half-reap.
 */
export type ReapWedgedSpawnFn = (candidate: WedgedSpawnCandidate) => Promise<boolean>;

/**
 * Reclaim WEDGED spawns — the "stalled, not just dead" half of the spawn-reclaim
 * floor (RECLAIM_STALLED). Where {@link reclaimOrphanedSpawns} frees rows whose host
 * DIED (stale heartbeat), this frees rows that are supervised-LIVE (fresh heartbeat)
 * yet stream-silent past the action threshold — a hung bee that wedges the
 * concurrency ceiling WITHOUT ever going stale, so the orphan sweep never sees it.
 * This wires the previously DISPLAY-ONLY {@link isPossiblyWedged} classifier to a
 * real reclaim action.
 *
 * DURABLE SELECTION. Candidates come from DB truth (`heartbeat_at`/`last_output_at`
 * on `spawned_agents`), not the in-memory `localSpawnOutput` map — so this is a
 * floor that survives the in-memory wedge reaper's tracking being lost (e.g. across
 * an operator restart) and is the canonical, restart-safe sibling of the orphan
 * sweep. It complements (does not replace) the in-memory `reapWedgedLocalSpawns`
 * fast path; both reap via the same engine and are idempotent, so coexistence is
 * safe.
 *
 * SAFETY (it KILLS a live agent, so the bar is high):
 *   • Threshold = {@link WEDGE_REAP_SILENT_MS} (the owner-decided 30-min action
 *     window), NOT the 10-min display badge — a live agent in a legitimate long
 *     local tool call is never killed.
 *   • Only rows THIS operator incarnation launched + supervises are eligible
 *     (`launcher_host` = me AND `launcher_boot_id` = this boot id) — the only ones
 *     it can actually KILL; a wedged row owned by another live host is that host's
 *     to reap (the host that holds the handle owns the verdict, mirroring
 *     `reapWedgedLocalSpawns`).
 *   • In-process loopback launches (a Queen/overwatch wake recorded with the
 *     OPERATOR's own pid) are excluded (`pid` present AND `pid <> process.pid`) so
 *     this can never abort the operator process or a Queen.
 *   • `isPossiblyWedged` is re-applied per row as the authoritative gate (defends
 *     against clock skew / a row that emitted between the SELECT and now).
 *
 * Flag-gated OFF: the caller passes `reap` only when RECLAIM_STALLED is on. Returns
 * a {@link ReclaimResult} of what was actually reaped (the seam may decline a row).
 */
export async function reclaimWedgedSpawns(
  sql: Db,
  reap: ReapWedgedSpawnFn,
  opts: { silentMs?: number; staleMs?: number; now?: number } = {},
): Promise<ReclaimResult> {
  const silentMs = opts.silentMs ?? WEDGE_REAP_SILENT_MS;
  const staleMs = opts.staleMs ?? RECLAIM_STALE_MS;
  const now = opts.now ?? Date.now();
  const silentSec = Math.max(1, Math.round(silentMs / 1000));
  const staleSec = Math.max(1, Math.round(staleMs / 1000));
  const me = hostname();

  // DB-truth pre-filter: supervised-LIVE (fresh heartbeat → the orphan sweep does
  // not own it), stream-silent past the action threshold, launched by THIS
  // incarnation (killable here), with a real CHILD pid (not an in-process launch
  // recorded with the operator's own pid). `isPossiblyWedged` below is the
  // authoritative classification.
  const rawCandidates = await sql<
    {
      spawn_id: string;
      workspace_id: string;
      run_id: string;
      launcher_host: string | null;
      launcher_boot_id: string | null;
      pid: number | null;
      heartbeat_at: string;
      last_output_at: string | null;
    }[]
  >`
    SELECT spawn_id, workspace_id, run_id, launcher_host, launcher_boot_id, pid,
           heartbeat_at, last_output_at
      FROM harness_shared.spawned_agents
     WHERE status IN ('running', 'restarting')
       AND launcher_host = ${me}
       AND launcher_boot_id = ${LAUNCHER_BOOT_ID}
       AND pid IS NOT NULL
       AND pid <> ${process.pid}
       AND heartbeat_at >= now() - ${staleSec}::int * interval '1 second'
       AND last_output_at IS NOT NULL
       AND last_output_at < now() - ${silentSec}::int * interval '1 second'`;
  // WI-6113 (2026-08-24): DEFENCE IN DEPTH — added ALONGSIDE the `last_output_at IS NOT NULL`
  // predicate above, never in place of it. WI-41328 measured that substitution and ruled it a
  // DOWNGRADE (that predicate is 100% effective as a class filter where `isSupervisedBeeRow`
  // alone is 29%), so the SQL is deliberately left exactly as it was.
  //
  // What changes is the REASON the predicate protects this class. Until now it was the ONLY
  // thing keeping in-process/durable-spawn rows out of this reaper, and that protection is
  // INCIDENTAL — a property of the data, not an expressed intent. `last_output_at` is NULL on
  // 3,017 of 3,017 durable-spawn rows (measured 2026-08-24) purely because the class has no
  // writer for it. WI-6113 is chartered to ADD that writer. The moment it lands the incidental
  // filter evaporates and every such row becomes a live SIGTERM candidate here, because their
  // heartbeat is ALWAYS fresh — dbos/durable-spawn.ts runs an unconditional 60s keepalive that
  // is decoupled from progress — so they satisfy every remaining predicate of the SELECT.
  //
  // Stating the exclusion explicitly means the progress-signal half of WI-6113 CANNOT silently
  // arm this reaper, and the two halves can land in either order. Strictly protective: it can
  // only ever REMOVE rows from a kill list, never add one. Ids-only (mirrors the sibling
  // `reclaimFirstOutputStalledSpawns`), so the exclusion cannot be undone by a run_id rename.
  const candidates = rawCandidates.filter(
    (c) => isSupervisedBeeRow(c) && !isInProcessLaunchIdentity(c),
  );
  if (candidates.length === 0) {
    return { reclaimed: 0, spawnIds: [], workspaces: [] };
  }

  const reaped: string[] = [];
  const workspaces = new Set<string>();
  for (const c of candidates) {
    // Authoritative gate — re-classify against `now` (the SELECT used DB `now()`).
    if (
      !isPossiblyWedged(
        { status: 'running', heartbeatAt: c.heartbeat_at, lastOutputAt: c.last_output_at },
        { now, silentMs, staleMs },
      )
    ) {
      continue;
    }
    const outputMs = c.last_output_at ? new Date(c.last_output_at).getTime() : now;
    try {
      const ok = await reap({
        spawnId: c.spawn_id,
        workspaceId: c.workspace_id,
        launcherHost: c.launcher_host,
        launcherBootId: c.launcher_boot_id,
        pid: c.pid,
        heartbeatAt: c.heartbeat_at,
        lastOutputAt: c.last_output_at,
        silentMs: Math.max(0, now - outputMs),
      });
      if (ok) {
        reaped.push(c.spawn_id);
        if (c.workspace_id) workspaces.add(c.workspace_id);
      }
    } catch (err) {
      console.warn(
        `[wedge-reclaim] reap failed for ${c.spawn_id} (will retry next tick): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return { reclaimed: reaped.length, spawnIds: reaped, workspaces: [...workspaces] };
}

/**
 * FIRST-OUTPUT STALL threshold (EI-7345): a spawn that has NEVER produced a
 * single byte of output (`last_output_at IS NULL`) this long after `started_at`
 * is presumed stuck before its first model turn (the observed signature: "PG
 * bootstrap ok -> prompt-budget computed -> [nothing] -> eventual SIGTERM at
 * 15-52min"), not merely thinking — a bee that ever emits at all moves
 * `last_output_at` off NULL immediately, so this reaper and
 * {@link reclaimWedgedSpawns} are mutually exclusive by construction (one
 * requires `last_output_at IS NULL`, the other `IS NOT NULL`). Deliberately
 * SHORT relative to {@link WEDGE_REAP_SILENT_MS} (30min) — there is no
 * legitimate reason for zero output this early (unlike a long local tool call
 * once a turn is underway), so the safe wait is minutes, not half an hour.
 * Override: PAPERCUSP_FIRST_OUTPUT_STALL_MS (floor 60s).
 */
export const FIRST_OUTPUT_STALL_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_FIRST_OUTPUT_STALL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 5 * 60_000;
})();

/**
 * Classify a spawn row as first-output-stalled: supervised-live (fresh
 * heartbeat), has NEVER emitted any output, and was started longer ago than the
 * first-output threshold. Absence of a heartbeat, or a heartbeat gone stale
 * (the orphan sweep's territory), or ANY recorded output (however old — that is
 * {@link isPossiblyWedged}'s territory) all classify false. Pure; exported for
 * tests.
 */
export function isFirstOutputStalled(
  row: {
    status: string;
    heartbeatAt?: Date | string | null;
    lastOutputAt?: Date | string | null;
    startedAt?: Date | string | null;
  },
  opts: { now?: number; silentMs?: number; staleMs?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const silentMs = opts.silentMs ?? FIRST_OUTPUT_STALL_MS;
  const staleMs = opts.staleMs ?? RECLAIM_STALE_MS;
  if (row.status !== 'running' && row.status !== 'restarting') return false;
  if (row.lastOutputAt) return false; // has emitted at least once → not this reaper's case
  if (!row.heartbeatAt) return false;
  const getMs = (v: unknown): number => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') return new Date(v).getTime();
    if (typeof v === 'number') return v;
    return NaN;
  };
  const heartbeatMs = getMs(row.heartbeatAt);
  if (isNaN(heartbeatMs) || now - heartbeatMs > staleMs) return false; // not supervised-live → the orphan sweep owns it
  if (!row.startedAt) return false;
  const startedMs = getMs(row.startedAt);
  return !isNaN(startedMs) && now - startedMs > silentMs;
}

/**
 * One first-output-stalled spawn the durable reaper may reclaim. Mirrors
 * {@link WedgedSpawnCandidate}, substituting the observed silence-since-birth
 * for silence-since-last-output (there was never a last output).
 */
export interface FirstOutputStallCandidate {
  spawnId: string;
  workspaceId: string;
  launcherHost: string | null;
  launcherBootId: string | null;
  pid: number | null;
  heartbeatAt: string | null;
  startedAt: string;
  /** ms elapsed since started_at with zero output ever observed. */
  silentMs: number;
}

/**
 * The durable reap seam (INJECTED by the caller — host periodic sweep), mirrors
 * {@link ReapWedgedSpawnFn}. Returns true when reaped; a false/throw leaves the
 * row running for the next tick to retry.
 */
export type ReapFirstOutputStallFn = (candidate: FirstOutputStallCandidate) => Promise<boolean>;

/**
 * Reclaim FIRST-OUTPUT-STALLED spawns (EI-7345) — the "never even started, not
 * just wedged" half of the spawn-reclaim floor. Where {@link reclaimWedgedSpawns}
 * frees rows that emitted at least once and then went silent,
 * this frees rows that are supervised-LIVE (fresh heartbeat) yet have NEVER
 * produced a single byte of output past the (short) first-output threshold —
 * the exact class {@link isPossiblyWedged}'s "absence of signal is not evidence
 * of a wedge" guard deliberately excludes. Left unhandled, these spawns
 * previously rode all the way to whatever outer SIGTERM/budget timeout finally
 * killed them (observed: 15-52min average per role), burning wall-clock and
 * holding a concurrency-ceiling slot the whole time for a spawn that never got a
 * single model turn.
 *
 * SAFETY (mirrors reclaimWedgedSpawns — it kills a live process):
 *   • Only rows THIS operator incarnation launched + supervises are eligible
 *     (`launcher_host` = me AND `launcher_boot_id` = this boot id).
 *   • In-process loopback launches (pid = the operator's own pid) are excluded.
 *   • `isFirstOutputStalled` is re-applied per row as the authoritative gate.
 *   • EI-18729995135827661 (2026-08-02) CORRECTION: candidates are also filtered to
 *     {@link isSupervisedBeeRow} rows only — the SAME class-based exclusion
 *     {@link reclaimWedgedSpawns} gets for free (its own SQL requires `last_output_at
 *     IS NOT NULL`, which by construction can only ever match a supervised bee) and
 *     {@link classifyCeilingJamRow} applies explicitly. This reaper's query selects
 *     the OPPOSITE condition (`last_output_at IS NULL`), so without this filter a
 *     never-streamed row from ANY currently-active non-supervised class (overwatch /
 *     blueprint / implement / in-process loopback launches, none of which populate
 *     `last_output_at` BY DESIGN, per EI-7215/EI-18729995135827661) would misread as
 *     first-output-stalled the moment it crossed {@link FIRST_OUTPUT_STALL_MS} —
 *     these classes never emit that signal at ANY age, not just early on.
 *
 * Flag-gated OFF by the caller (same RECLAIM_STALLED switch as
 * reclaimWedgedSpawns — killing a live agent is a hot-path placement change).
 * Because the reap seam here does NOT route through the stale-claim sweep's
 * requeue-count bump (it settles the row directly, same as reclaimWedgedSpawns),
 * a spawn reaped by this sweep never has a "retry attempt" charged against its
 * work-item — it never got a model turn, so nothing was actually attempted; the
 * work-item's own dispatch/retry clock simply re-offers it next cadence.
 */
export async function reclaimFirstOutputStalledSpawns(
  sql: Db,
  reap: ReapFirstOutputStallFn,
  opts: { silentMs?: number; staleMs?: number; now?: number } = {},
): Promise<ReclaimResult> {
  const silentMs = opts.silentMs ?? FIRST_OUTPUT_STALL_MS;
  const staleMs = opts.staleMs ?? RECLAIM_STALE_MS;
  const now = opts.now ?? Date.now();
  const silentSec = Math.max(1, Math.round(silentMs / 1000));
  const staleSec = Math.max(1, Math.round(staleMs / 1000));
  const me = hostname();

  const rawCandidates = await sql<
    {
      spawn_id: string;
      workspace_id: string;
      run_id: string | null;
      launcher_host: string | null;
      launcher_boot_id: string | null;
      pid: number | null;
      heartbeat_at: string;
      started_at: string;
    }[]
  >`
    SELECT spawn_id, workspace_id, run_id, launcher_host, launcher_boot_id, pid,
           heartbeat_at, started_at
      FROM harness_shared.spawned_agents
     WHERE status IN ('running', 'restarting')
       AND launcher_host = ${me}
       AND launcher_boot_id = ${LAUNCHER_BOOT_ID}
       AND pid IS NOT NULL
       AND pid <> ${process.pid}
       AND heartbeat_at >= now() - ${staleSec}::int * interval '1 second'
       AND last_output_at IS NULL
       AND started_at < now() - ${silentSec}::int * interval '1 second'`;
  // EI-18729995135827661 (2026-08-02): a row's spawn CLASS, not merely its age, decides
  // whether "never streamed" is evidence of anything. `isSupervisedBeeRow` is the SAME
  // class filter {@link reclaimWedgedSpawns} gets for free (its own SQL requires
  // `last_output_at IS NOT NULL`, which structurally can only ever match the supervised-bee
  // population) and {@link classifyCeilingJamRow} applies explicitly — but this reaper's
  // query selects on `last_output_at IS NULL`, the OPPOSITE condition, so nothing here
  // excluded a non-supervised class by construction. Left unfiltered, every currently-active
  // in-process-loopback / overwatch / blueprint / implement spawn (per EI-18729995135827661's
  // survey: 0-for-thousands ever populate `last_output_at`, BY DESIGN, not merely "not yet")
  // would look identical to a genuinely first-output-stalled bee the moment it crossed
  // {@link FIRST_OUTPUT_STALL_MS} — and RECLAIM_STALLED (currently dark-OFF, EI-7685) gates
  // this reaper too, so the danger is latent, not live: the moment that flag is ever flipped
  // on without this filter, this reaper would SIGTERM essentially every non-opspawn spawn in
  // the fleet within minutes of it starting. Filter to the supervised-bee population BEFORE
  // classifying, exactly as the sibling reclaimers already do.
  //
  // WI-6113 (2026-08-24): `isSupervisedBeeRow` ALONE does not deliver the exclusion the
  // comment above claims. `spawnRowKind` short-circuits to 'spawn' on an `invoke-*` run_id
  // BEFORE its `durable-spawn:` test, and 56 of 79 durable-spawn rows measured in a 14-day
  // window carry exactly that prefix — so 71% of the population this filter is meant to
  // protect passed straight through it. Those rows have a FRESH heartbeat (an unconditional
  // 60s keepalive timer in dbos/durable-spawn.ts, decoupled from progress), a permanently
  // NULL `last_output_at` (0-of-5,457 in-process-launch rows have ever populated it), and a
  // `started_at` older than FIRST_OUTPUT_STALL_MS (5 min) within minutes of launching a run
  // that normally takes 20-45 — i.e. they satisfy EVERY predicate of the SELECT above. With
  // RECLAIM_STALLED on, this reaper would SIGTERM them, which is the precise outcome
  // EI-18729995135827661 added the class filter to prevent. Intersect with an ids-only
  // identity test so the exclusion cannot be undone by a run_id rename.
  const candidates = rawCandidates.filter((c) => isSupervisedBeeRow(c) && !isInProcessLaunchIdentity(c));
  if (candidates.length === 0) {
    return { reclaimed: 0, spawnIds: [], workspaces: [] };
  }

  const reaped: string[] = [];
  const workspaces = new Set<string>();
  for (const c of candidates) {
    if (
      !isFirstOutputStalled(
        { status: 'running', heartbeatAt: c.heartbeat_at, lastOutputAt: null, startedAt: c.started_at },
        { now, silentMs, staleMs },
      )
    ) {
      continue;
    }
    const startedMs = new Date(c.started_at).getTime();
    try {
      const ok = await reap({
        spawnId: c.spawn_id,
        workspaceId: c.workspace_id,
        launcherHost: c.launcher_host,
        launcherBootId: c.launcher_boot_id,
        pid: c.pid,
        heartbeatAt: c.heartbeat_at,
        startedAt: c.started_at,
        silentMs: Math.max(0, now - startedMs),
      });
      if (ok) {
        reaped.push(c.spawn_id);
        if (c.workspace_id) workspaces.add(c.workspace_id);
      }
    } catch (err) {
      console.warn(
        `[first-output-stall-reclaim] reap failed for ${c.spawn_id} (will retry next tick): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return { reclaimed: reaped.length, spawnIds: reaped, workspaces: [...workspaces] };
}

/**
 * Boot-time spawn-admission reconcile (EI-2186) — the release-on-host-restart
 * half of the spawn chokepoint.
 *
 * THE BUG IT FIXES. A host restart (or operator-process restart) kills every
 * in-flight spawn/launch BEFORE its normal admission-release runs, leaving
 * `running`/`restarting` nursery rows that count forever against the global
 * concurrency ceiling (`maxSimultaneousAgents`). The periodic
 * `reclaimOrphanedSpawns` could not clear them: it only considers rows whose
 * heartbeat is STALE, but a stale `launch`-kind row's recorded pid gets REUSED by
 * an unrelated process on the rebooted box, so the permissive launch liveness
 * check read it as "alive" and BUMPED its heartbeat each sweep — keeping it
 * permanently fresh and never a reclaim candidate. The ceiling read N/N with ~0
 * live bees and NO bee could be placed fleet-wide (the "idle Queen / no bees"
 * storm was actually a hard-jammed ceiling).
 *
 * THE RECONCILE. A fresh operator process has launched NOTHING yet, so any
 * `running` row attributed to THIS host that does not carry THIS process's boot id
 * was launched by a PRIOR incarnation — but "prior incarnation" no longer implies
 * "provably dead" (WI-1499). Since bg-host-agent-spawn-scope-isolation-2026-07-02,
 * a `spawn`-kind row (an actual OS child, launched into its own systemd user SCOPE
 * — see `orchestrator-runner.ts`'s `runChild`) can OUTLIVE the operator process
 * that launched it: a host/process restart no longer touches its cgroup. So the
 * reconcile now liveness-checks each same-host candidate's recorded pid
 * (`isSpawnProcessAlive`, same primitive the periodic sweep uses) before acting:
 *   • ALIVE (`spawn` kind only — see below) → RE-ATTACH: bump `launcher_boot_id`
 *     to this fresh incarnation's id + refresh `heartbeat_at`, and leave the row
 *     `running` untouched. The agent turn keeps executing; no reclaim row, no
 *     relaunch, no lost/duplicated work (WI-1499's acceptance criterion).
 *   • DEAD (or unverifiable) → reclaim to `failed`, exactly as before.
 * `launch`-kind rows (in-process loopback launches — a Queen wake, an overwatch
 * loop) are ALWAYS reclaimed here regardless of what their recorded pid's /proc
 * slot currently holds: unlike a `spawn`-kind OS child, a `launch` row's "process"
 * IS the firing operator process itself, and a fresh boot is BY DEFINITION a NEW
 * process — the prior one is gone. Treating a `launch` row's pid as possibly-alive
 * at boot would be a straight PID-reuse hazard (a rebooted-feeling but
 * still-running box can reassign that exact pid to an unrelated process within
 * seconds), which is exactly the false-alive bug EI-2186 introduced the boot
 * reconcile to fix in the first place — so the liveness check is deliberately
 * scoped to `spawn` kind only.
 *
 * Rows predating the boot-id column (`launcher_boot_id IS NULL`) fall back to the
 * stale-heartbeat rule to select as CANDIDATES (so a mid-insert current-process
 * row, not yet pid/boot-id-stamped, is never touched) — but still go through the
 * SAME alive/dead liveness split before being reclaimed or re-attached.
 * Different-host rows are left alone (a federated peer's live operator owns them).
 *
 * Call ONCE at host bootstrap, before arming the spawn paths. Idempotent + safe to
 * re-run. The caller announces `spawn-slot:freed:<ws>` per freed workspace so any
 * over-ceiling waiter wakes (the same contract as the periodic sweep).
 *
 * RE-LAUNCH (EI-85 — the restart-kills durability fix). Reclaiming to `failed`
 * frees the ceiling debit but LOSES the work: a queen mid-orchestration and every
 * bee it placed vanish on a host restart, doing zero work until the next routine
 * cadence re-fires the queen. So when a re-launcher is supplied (and the relaunch
 * is enabled), the reconcile re-launches each reclaimed (i.e. confirmed-DEAD) spawn
 * whose durable work-item is still NON-TERMINAL (`shouldRelaunchReclaimedSpawn`),
 * instead of just killing it — the dead row is still settled `failed` (with a
 * "superseded by boot relaunch" reason so the ceiling debit is freed and the
 * diagnosis is accurate), and a fresh `running` row owned by THIS process takes
 * its place. A spawn whose work-item is already terminal/gone (or a non-queen/bee
 * role) keeps the plain reclaim-to-`failed` floor. A RE-ATTACHED (alive) spawn is
 * never a relaunch candidate — it never died.
 *
 * @param opts.relaunch INJECTED re-fire seam (host-bootstrap); omitted ⇒ the legacy
 *        reclaim-only behaviour (also the flag-OFF path).
 * @param opts.isAlive INJECTED liveness check (default `isSpawnProcessAlive`) —
 *        overridable for tests, mirrors `reclaimOrphanedSpawns`'s seam.
 */
export async function reconcileSpawnAdmissionOnBoot(
  sql: Db,
  opts: {
    staleMs?: number;
    relaunch?: RelaunchSpawnFn;
    isAlive?: (pid: number, kind?: 'spawn' | 'launch') => boolean;
  } = {},
): Promise<ReclaimResult> {
  const staleSec = Math.max(1, Math.round((opts.staleMs ?? RECLAIM_STALE_MS) / 1000));
  const me = hostname();
  const isAlive = opts.isAlive ?? isSpawnProcessAlive;

  // First gather every same-host candidate from a prior incarnation (boot-id
  // mismatch, or no boot id + stale heartbeat) WITHOUT touching them yet — we
  // need each row's pid + run_id to classify alive-vs-dead before deciding
  // reclaim vs re-attach.
  const candidates = await sql<
    {
      spawn_id: string;
      workspace_id: string;
      harness_slug: string | null;
      child_role: string;
      work_item_id: string | null;
      result_path: string | null;
      pid: number | null;
      run_id: string | null;
    }[]
  >`
    SELECT a.spawn_id, a.workspace_id, a.harness_slug, a.child_role,
           COALESCE(a.item_id, a.feature_id) AS work_item_id, a.result_path,
           a.pid, a.run_id
      FROM harness_shared.spawned_agents AS a
     WHERE a.status IN ('running', 'restarting')
       AND a.launcher_host = ${me}
       AND (
             (a.launcher_boot_id IS NOT NULL AND a.launcher_boot_id <> ${LAUNCHER_BOOT_ID})
          OR (a.launcher_boot_id IS NULL AND a.heartbeat_at < now() - ${staleSec}::int * interval '1 second')
         )`;

  // Classify: a `spawn`-kind row (invoke-once bee/queen child) whose recorded pid
  // is confirmed alive survived the restart (scope-isolated, WI-1499) → re-attach.
  // A `launch`-kind row is ALWAYS reclaimed at boot (its firing process is THIS
  // process's dead predecessor by construction — see the doc comment above).
  const aliveIds: string[] = [];
  const deadIds: string[] = [];
  const completedArtifacts: SpawnArtifactCandidate[] = [];
  for (const c of candidates) {
    const kind = spawnRowKind({ spawnId: c.spawn_id, runId: c.run_id, pid: c.pid });
    if (kind === 'spawn' && readCompletedSpawnArtifact(c.result_path)) {
      completedArtifacts.push(c);
    } else if (kind === 'spawn' && c.pid != null && isAlive(c.pid, kind)) {
      aliveIds.push(c.spawn_id);
    } else {
      deadIds.push(c.spawn_id);
    }
  }

  const recovered = await settleCompletedSpawnArtifacts(sql, completedArtifacts);

  // Re-attach the survivors to this fresh incarnation: same row, same status,
  // just handed off — future sweeps (periodic + the next boot) now see it as
  // owned by THIS process. No reclaim row, no relaunch, no lost work.
  const reattached: string[] = [];
  if (aliveIds.length > 0) {
    const reattachedRows = await sql<{ spawn_id: string }[]>`
      UPDATE harness_shared.spawned_agents AS a
         SET launcher_boot_id = ${LAUNCHER_BOOT_ID},
             heartbeat_at = now()
       WHERE a.status IN ('running', 'restarting')
         AND a.spawn_id = ANY(${aliveIds}::text[])
      RETURNING a.spawn_id`;
    reattached.push(...reattachedRows.map((r) => r.spawn_id));
  }

  if (deadIds.length === 0) {
    const recoveredIds = recovered.rows.map((r) => r.spawn_id);
    return {
      reclaimed: recoveredIds.length,
      spawnIds: recoveredIds,
      workspaces: [...new Set(recovered.rows.map((r) => r.workspace_id))],
      relaunched: [],
      reattached,
      recovered: recoveredIds,
      claimsReleased: recovered.claimsReleased,
    };
  }

  // Settle every confirmed-dead prior-incarnation row to `failed` (freeing the
  // ceiling debit) and RETURN its durable identity + its work-item's current
  // status, so we can decide per row whether to re-launch. The work-item id is
  // `item_id` (the canonical work-item link) falling back to the legacy
  // `feature_id`; its status is resolved from harness_features_consolidated keyed
  // on (work-item id, workspace, harness) — a LEFT JOIN so a spawn with no
  // work-item (or a deleted one) returns NULL and is reclaimed, never re-launched.
  const rows = await sql<
    {
      spawn_id: string;
      workspace_id: string;
      harness_slug: string;
      child_role: string;
      parent_spawn_id: string | null;
      parent_role: string | null;
      work_item_id: string | null;
      work_item_status: string | null;
      plan_slug: string | null;
      model_spec: string | null;
      model_tier: string | null;
      brief: string | null;
    }[]
  >`
    WITH reclaimed AS (
      UPDATE harness_shared.spawned_agents AS a
         SET status = 'failed',
             finished_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - a.started_at)) * 1000)::bigint,
             error_message = COALESCE(
               a.error_message,
               'reclaimed at operator boot: launched by a prior incarnation on '
                 || COALESCE(a.launcher_host, '?')
                 || ' (host/process restarted before its admission-release ran, and its child'
                 || ' process is confirmed dead) — stale spawn-ceiling debit freed by the boot'
                 || ' reconcile (EI-2186 / WI-1499)'
             )
       WHERE a.status IN ('running', 'restarting')
         AND a.spawn_id = ANY(${deadIds}::text[])
      RETURNING a.spawn_id, a.workspace_id, a.harness_slug, a.child_role,
                a.parent_spawn_id, a.parent_role,
                COALESCE(a.item_id, a.feature_id) AS work_item_id,
                a.plan_slug, a.model_spec, a.model_tier, a.brief
    )
    SELECT r.spawn_id, r.workspace_id, r.harness_slug, r.child_role,
           r.parent_spawn_id, r.parent_role, r.work_item_id,
           f.status AS work_item_status,
           r.plan_slug, r.model_spec, r.model_tier, r.brief
      FROM reclaimed r
      LEFT JOIN harness_shared.harness_features_consolidated f
        ON f.feature_id = r.work_item_id
       AND f.workspace_id = r.workspace_id
       AND f.harness_slug = r.harness_slug`;

  // Dead-holder release (2026-07-02) — MUST run BEFORE the relaunch loop: a
  // re-launched bee re-claims its work-item under a NEW spawn id, and the dead
  // predecessor's still-held `taken_by` would reject that compare-and-claim
  // ("could not be claimed for the new bee"), turning every boot relaunch into
  // a refusal.
  await releaseClaimsOfDeadSpawns(
    sql,
    rows.map((r) => r.spawn_id),
  );

  // Re-launch the survivors whose durable work-item is still non-terminal (EI-85),
  // BEFORE waking parents — a successful re-launch means the child did not really
  // die, so we suppress the parent-death wake for it (a relaunched bee should not
  // signal its queen that it failed). The relaunch seam is best-effort + serialised
  // through the ceiling (operatorSpawn admits): a refusal/throw leaves the row
  // reclaimed (the next cadence tick re-places it).
  const relaunched: string[] = [];
  if (opts.relaunch) {
    for (const row of rows) {
      if (
        !shouldRelaunchReclaimedSpawn({
          childRole: row.child_role,
          workItemId: row.work_item_id,
          workItemStatus: row.work_item_status,
        })
      ) {
        continue;
      }
      try {
        const ok = await opts.relaunch({
          spawnId: row.spawn_id,
          workspaceId: row.workspace_id,
          harnessSlug: row.harness_slug,
          childRole: row.child_role,
          parentSpawnId: row.parent_spawn_id,
          parentRole: row.parent_role,
          workItemId: row.work_item_id,
          workItemStatus: row.work_item_status,
          planSlug: row.plan_slug,
          modelSpec: row.model_spec,
          modelTier: row.model_tier,
          brief: row.brief,
        });
        if (ok) relaunched.push(row.spawn_id);
      } catch (err) {
        console.warn(
          `[spawn-reclaim] boot re-launch failed for ${row.child_role} ${row.spawn_id} (${row.harness_slug}); left reclaimed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // Wake parents of the spawns that genuinely died (NOT the relaunched ones — those
  // live on in a fresh row). Best-effort, concurrent — same as the periodic sweep.
  const relaunchedSet = new Set(relaunched);
  for (const row of rows) {
    if (relaunchedSet.has(row.spawn_id)) continue;
    void wakeParentOnChildDeath(sql as Sql, row.spawn_id, row.workspace_id, 'failed').catch(() => {
      /* best-effort — logged inside wakeParentOnChildDeath */
    });
  }

  return {
    reclaimed: rows.length + recovered.rows.length,
    spawnIds: [...recovered.rows.map((r) => r.spawn_id), ...rows.map((r) => r.spawn_id)],
    workspaces: [
      ...new Set([
        ...recovered.rows.map((r) => r.workspace_id),
        ...rows.map((r) => r.workspace_id),
      ].filter(Boolean)),
    ],
    relaunched,
    reattached,
    recovered: recovered.rows.map((r) => r.spawn_id),
  };
}
