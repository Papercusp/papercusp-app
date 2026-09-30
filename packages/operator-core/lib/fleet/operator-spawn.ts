/**
 * fleet/operator-spawn — the operator→agent spawn engine over the durable nursery
 * (Brief 4, agent-briefs-2026-06-05; findings folded into
 * autoloop-pot-operator-rebuild-2026-06-05).
 *
 * The one spawn path the operator (chat `<spawn>` tag, the `cup:spawn` tool, and
 * any future admin trigger) goes through:
 *
 *   resolveProject(harness) → recordSpawn (harness_shared.spawned_agents)
 *     → spawnInvokeOnce in the background → finishSpawn on exit.
 *
 * Replaces the dead POST /api/plugins/orchestrator/spawn dispatch (the
 * @papercupai/orchestrator-spawn plugin is not installed, so its projected HTTP
 * path 404s and its tracking lived in a plugin-local in-memory Map that
 * fleet:tree could not see). Tracking here is the SAME durable nursery the
 * fleet:* tools read — what's spawned appears in fleet:tree immediately and the
 * row transitions running→done/failed when the child exits.
 *
 * Resolution failures are recorded as status='failed' nursery rows (with the
 * error in error_message) rather than dropped — the old path's silent
 * fire-and-forget 404 is exactly the failure mode this module removes.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { canonicalCoordRole } from '../agent-tools/coordination/roles';
import { resolveProject } from '../harness-core';
import { loadHarnessRegistry, isEphemeralForeignProject } from '../harness-registry';
import { spawnInvokeOnceWithFallback, invokeTimeoutMs } from '../dbos/orchestrator-runner';
import { buildPipelineExtraEnv } from '../dbos/orchestrator-spawn-env';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveSpawnGatewayEnv } from '../inference-gateway/spawn-env';
import { logSpawnReadinessShadow } from '../inference-gateway/spawn-readiness';
import { ensureStallWakerLoop } from '../inference-gateway/stall-waker-loop';
import { evaluateOpusBudgetForSpawn } from '../deployment/account-pool-store';
import { classifyRoleCriticality, type WorkCriticality } from '../opus-budget-governor';
import { inferBackendFromModelSpec, resolveSpawnBackendModel } from '../harness-invoke-once';
import { roleModelDefault } from '@papercusp/orchestrator/role-models';
import { lockDomainForProjectDir } from '../agent-tools/locks/coordination-domain';
import { desktopEnvForHive } from '../agent-tools/computer/desktop-lease';
import { recordSpawn, finishSpawn } from './spawn-tree';
import { assembleSpawnHydration } from './spawn-hydration';
import { productionSpawnHydrationDeps } from './spawn-hydration-deps';
import type { Db } from './pg-stores';
import { recordSpawnGovernorObservation } from '../resource-governor/spawn-observation-writer';
import {
  heartbeatSpawns,
  isSpawnProcessAlive,
  reclaimOrphanedSpawns,
  recordSpawnPid,
  removeSpawnResultArtifact,
  SPAWN_HEARTBEAT_INTERVAL_MS,
  spawnResultArtifactPath,
  WEDGE_REAP_SILENT_MS,
} from './spawn-reclaim';
// WI-36237: the SAME strip the classify path applies, so the persisted
// error_message and the judged stderr cannot disagree about whether a death
// was silent.
import { stripActivityHeartbeat } from './invoke-outcome';
// Re-exported for back-compat: the wedge-reap action threshold is now centralised in
// spawn-reclaim.ts (beside the other reclaim thresholds) so the in-memory reaper here
// and the durable DB `reclaimWedgedSpawns` sweep cannot drift. Existing importers
// (`./operator-spawn`) keep working.
export { WEDGE_REAP_SILENT_MS } from './spawn-reclaim';
import { wakeParentOnChildDeath } from './parent-wake';
import { maybeReconcileBeeCompletion } from './bee-completion-reconcile';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { getCachedRateLimitConfig } from '../rate-limit-config';
// P-009: the governor's LIVE adaptive window, read by spawnConcurrencyCeiling() so a
// seed-sourced host-profile guess can never freeze into a spawn maximum.
import { effectiveConcurrencySnapshot } from '@papercusp/papercusp-shared/agent';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { backendFeatureGuard, interactiveBackendFromSpawnBackend } from '../backend-feature-capabilities';
import { releaseWorkItem } from '../work-items';

/**
 * The deterministic SAFETY-FLOOR ceiling on concurrently-running spawns — the
 * single fleet-wide number, NOT a per-path allocator (P-007). Folds the old
 * hardcoded operator-spawn cap (`MAX_CONCURRENT_SPAWNS=10`) and the orchestrator
 * dispatch cap into ONE configurable value: `operator:rate_limit_config`'s
 * `maxSimultaneousAgents` (live-editable, clamped ≤ RATE_LIMIT_SANITY_BOUND).
 * The governor's global gate + the orchestrator dispatch ceiling + the await pump
 * already read this same number, so every spawn path now draws from one ledger.
 * The WORTH-IT allocation is the brain's call (P-005), informed by `getSpawnHeadroom`.
 *
 * P-009 — WHETHER THIS IS A CAP AT ALL depends on `maxSimultaneousAgentsSource`:
 *
 * - `'user'` an explicit, deliberate throttle ("I'm using Claude myself, fleet back
 *            off"). Real user intent, so it installs a hard ceiling. D-002 forbids
 *            *Papercusp* configuring a maximum; it never forbade the owner setting one.
 * - `'seed'` nobody asked for a limit — the number is only the host resource-profile's
 *            boot-time starting point. It must NOT become a productive-capacity
 *            maximum, so this returns the governor's LIVE adaptive window instead of
 *            the frozen guess, letting capacity grow past it exactly as the global
 *            gate already allows.
 *
 * `applyCached` (rate-limit-config.ts) has always honoured this at the governor's
 * global gate — a seed installs NO cap there, only a probe start. This function is
 * the SECOND, independent count ceiling (`getSpawnHeadroom` derives `globalHeadroom`
 * from it, and `effectiveSpawnCeiling` hard-enforces it at admission), and it used to
 * read the raw number unconditionally — so on any seed-sourced host the resource-profile
 * guess silently became a spawn maximum: precisely the failure mode P-009 exists to
 * prevent, and it survived because the enforcement scan's STATIC_CAP pattern cannot see
 * a ceiling that arrives from a function call rather than a digit literal.
 * Found by independent acceptance grading of capless-adaptive-resource-governor-2026-08-26
 * (criterion `no-artificial-ceiling`); see WI-586538.
 *
 * FAIL-SAFE: before the governor has a finite window installed (pre-init, when `cached`
 * is still the source-absent resource-profile default), fall back to the seed number.
 * This never returns an unbounded ceiling, so boot behaviour is unchanged.
 */
export function spawnConcurrencyCeiling(): number {
  const cfg = getCachedRateLimitConfig();
  if ((cfg.maxSimultaneousAgentsSource ?? 'seed') === 'user') return cfg.maxSimultaneousAgents;
  const { effectiveAfterExpiry } = effectiveConcurrencySnapshot();
  return effectiveAfterExpiry ?? cfg.maxSimultaneousAgents;
}

/**
 * The EFFECTIVE spawn-concurrency ceiling for a workspace: the system safety-floor
 * ceiling ({@link spawnConcurrencyCeiling}) clamped DOWN by the owner's `max-bees`
 * steering knob for the home hive (queen-steering-panel P-006, D-005). The owner can
 * only LOWER the ceiling (throttle the fleet), never raise it past the system cap.
 * Read at BOTH the headroom read (so the brain sees the reduced budget) and the
 * atomic admission cap (so it is HARD-enforced — spawns past it queue). Fail-soft:
 * any owner-steering read failure leaves the system ceiling in effect. Resolves the
 * home hive the same way the model-tier session override does (resolvePotHomeSlug).
 */
async function ownerMaxBeesCeiling(workspaceId: string): Promise<number | null> {
  const base = spawnConcurrencyCeiling();
  try {
    const [{ getOwnerSteering, effectiveMaxBees }, { resolvePotHomeSlug }] = await Promise.all([
      import('../owner-steering'),
      import('../pot/wake'),
    ]);
    const home = resolvePotHomeSlug();
    if (!home) return null;
    const s = await getOwnerSteering(workspaceId, home);
    const effective = effectiveMaxBees(s, base);
    return effective < base ? effective : null;
  } catch {
    return null;
  }
}

export async function effectiveSpawnCeiling(workspaceId: string): Promise<number> {
  return ownerMaxBeesCeiling(workspaceId).then((n) => n ?? spawnConcurrencyCeiling());
}

/**
 * The wake key an over-ceiling spawn attempt sleeps on (D-004 — queue + await,
 * never silent-drop): `events:await { event: spawnSlotEventKey(ws) }`, end the
 * turn, retry the spawn on wake. Emitted whenever a slot frees — a spawn
 * completes (done/failed/cancelled) or the P-011 reclaim frees orphaned rows.
 * The wake is a BROADCAST to all waiters (they re-check the ceiling on retry;
 * the await pump's per-tick resume cap + per-subscriber coalescing keep a
 * mass-wake paced) — slot fairness is re-check-on-wake, not a granted ticket
 * like lock:grant.
 */
export function spawnSlotEventKey(workspaceId: string): string {
  return `spawn-slot:freed:${workspaceId}`;
}

const DEFAULT_CHILD_START_TIMEOUT_MS = 180_000;

function spawnChildStartTimeoutMs(): number {
  const raw = process.env.PAPERCUSP_SPAWN_CHILD_START_TIMEOUT_MS;
  if (!raw) return DEFAULT_CHILD_START_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(1_000, Math.floor(n)) : DEFAULT_CHILD_START_TIMEOUT_MS;
}

/**
 * EI-6476 root cause: this used to hand-roll a `harness_features_consolidated`-only
 * UPDATE, which silently no-op'd for an ISSUE-family work-item (bug/change/task,
 * `engineer_issues` — the family a `WI-`/`EI-` id is as likely to be as a feature).
 * A fresh spawn placed onto a bug whose child never started (childStartTimer
 * timeout, or the launch throwing before `childStarted`) would then keep that bug
 * claimed by the dead spawn id with NO immediate release — "the spawn/claim path
 * can create a holder that never becomes live, leaving the item orphaned" (the
 * bug's own words) — until the separate `sweepStaleSpawnClaims` periodic backstop
 * eventually caught up. `releaseWorkItem` is the ONE unified release (work-items.ts)
 * that already dispatches correctly by family (issue → `releaseIssue`, feature →
 * the equivalent SQL) and fires the `claim:released`/`work-item:claimable` wake —
 * reuse it here instead of re-deriving a feature-only subset of it.
 */
async function releaseSpawnWorkItemClaim(
  _sql: Sql,
  opts: { harness: string; workItemId: string | null | undefined; spawnId: string },
): Promise<void> {
  const workItemId = (opts.workItemId ?? '').trim();
  if (!workItemId) return;
  await releaseWorkItem(workItemId, { harness: opts.harness, expectedAssignee: opts.spawnId });
}

/**
 * Memoized lazy import of the await engine — keeps this module's load graph
 * light (the engine pulls the coord/messages surface) and gives concurrent
 * announces ONE shared import promise (concurrent dynamic imports of the same
 * module can reject under the vitest module runner).
 */
let awaitEngine: Promise<typeof import('../events/await/engine')> | null = null;
const loadAwaitEngine = () => (awaitEngine ??= import('../events/await/engine'));

/**
 * Announce freed spawn capacity to over-ceiling waiters (best-effort, never
 * throws).
 */
async function announceSpawnSlotFreed(workspaceId: string, summary: string): Promise<void> {
  try {
    const { emitAwaitedEvent } = await loadAwaitEngine();
    await emitAwaitedEvent({
      key: spawnSlotEventKey(workspaceId),
      summary,
      source: 'operator-spawn',
      workspaceId,
    });
  } catch {
    /* best-effort — a missed announce just means waiters retry on their
       await timeout instead of the early wake */
  }
}

/**
 * Reclaim orphaned rows AND wake over-ceiling waiters in every workspace the
 * reclaim freed slots in (D-004). The reclaim itself stays the pure sql unit
 * (spawn-reclaim.ts); the announce rides this call-site wrapper.
 */
async function reclaimAndAnnounce(): Promise<void> {
  const r = await reclaimOrphanedSpawns(getOrgPg().sql).catch(() => ({ reclaimed: 0, spawnIds: [], workspaces: [] }));
  // Rare (only when orphans were actually freed) — await so the announce lands
  // before the caller's cap check; announceSpawnSlotFreed never throws.
  await Promise.all(
    r.workspaces.map((ws) => announceSpawnSlotFreed(ws, `${r.reclaimed} orphaned spawn slot(s) reclaimed`)),
  );
}

/**
 * Host-saturation-aware headroom shed (EI-73 Fix #1, host-load-aware ceiling —
 * su-1d995 2026-07-17). PURE, so it's unit-testable without a live perf capture.
 *
 * EI-73 asked for the admission ceiling to incorporate a host-load signal
 * (load-avg/cpu). Raw loadavg is the WRONG signal here: this box has 128 cores,
 * so loadavg-absolute LIES (round-4 D-002 reframe, see system-health/perf-budgets.ts
 * header) — a loadavg of 84 that alarmed EI-73's report is a ratio of ~0.66, not
 * necessarily saturation. The box already has the CORRECT ratio-free per-thread
 * saturation verdict (`evaluatePerfSignals` — PSI cpu `some avg60`, event-loop-lag,
 * CLOSE_WAIT, reachability) feeding the `infra` health panel; this just extends that
 * SAME verdict into spawn admission instead of inventing a second, worse signal.
 *
 * Only a DEFINITIVE crit (an active per-thread wedge) sheds headroom to zero —
 * spawning MORE agents onto an already-wedged host makes the wedge worse (the
 * exact EI-73 empirical finding: the route timed out under load but the spawn
 * still landed, compounding the saturation). `warn`/`ok`/`unknown`/stale never
 * shed — this is a narrow, fail-soft addition: no perf capture ⇒ unchanged
 * behavior, exactly as it was before this fix.
 */
export function applyHostSaturationShed(
  headroom: number,
  verdict: { status: 'ok' | 'warn' | 'crit' | 'unknown'; reasons: readonly string[] },
): { headroom: number; shed: boolean; reason: string | null } {
  if (verdict.status !== 'crit') return { headroom, shed: false, reason: null };
  return {
    headroom: 0,
    shed: true,
    reason: `host saturation crit — ${verdict.reasons[0] ?? 'per-thread wedge signal'}`,
  };
}

/**
 * The live limit/headroom the brain consults before deciding whether a spawn is
 * worth it (P-007): the unified ceiling, how many slots are in use right now, and
 * the remaining headroom. Reclaims orphaned rows first so the count reflects live
 * spawns only. This is the read the brain-as-allocator (P-005) is fed.
 *
 * EI-73 Fix #1: also folds in the host per-thread saturation verdict (see
 * `applyHostSaturationShed` above) — fail-soft (an unreadable/absent/stale perf
 * capture leaves headroom exactly as it was: count-based only).
 *
 * EI-5678 Fix: `opts.skipHostSaturationShed` lets a caller opt OUT of the
 * saturation shed entirely, computing headroom from the raw count-based
 * ceiling only. This is for the INTERACTIVE safety floor
 * (`interactive-safety-floor.ts`), whose own doc comment states human-initiated
 * launches WAIVE brain admission and pass only "the absolute concurrency
 * ceiling" — host-saturation shedding is a brain-admission-style load throttle
 * (built for autonomous spawns, EI-73), so silently applying it here made an
 * interactive launch refusable with `running: 0 ≥ ceiling: 8` (a self-
 * contradicting message whose real cause — host saturation — was never
 * surfaced). Default false: every other caller (brain admission / batch
 * placement) is unaffected.
 */
export async function getSpawnHeadroom(
  workspaceId: string,
  opts?: { skipHostSaturationShed?: boolean },
): Promise<{
  ceiling: number;
  running: number;
  headroom: number;
  hostSaturated?: boolean;
  hostSaturationReason?: string | null;
}> {
  await reclaimAndAnnounce();
  const systemCeiling = spawnConcurrencyCeiling();
  const ownerBeeCeiling = await ownerMaxBeesCeiling(workspaceId);
  const ceiling = ownerBeeCeiling ?? systemCeiling;
  const [running, runningBees] = await Promise.all([
    countRunning(workspaceId).catch(() => 0),
    countRunningByRole(workspaceId, 'cup').catch(() => 0),
  ]);
  const globalHeadroom = Math.max(0, systemCeiling - running);
  const beeHeadroom = ownerBeeCeiling == null ? globalHeadroom : Math.max(0, ownerBeeCeiling - runningBees);
  const countHeadroom = Math.min(globalHeadroom, beeHeadroom);

  let shedResult: { headroom: number; shed: boolean; reason: string | null } = {
    headroom: countHeadroom,
    shed: false,
    reason: null,
  };
  if (!opts?.skipHostSaturationShed) {
    try {
      const { readLatestPerfSignals, evaluatePerfSignals } = await import('../system-health/perf-budgets');
      const signals = await readLatestPerfSignals();
      const verdict = evaluatePerfSignals(signals, Date.now());
      shedResult = applyHostSaturationShed(countHeadroom, verdict);
    } catch {
      /* fail-soft — perf module unreadable leaves headroom count-based only */
    }
  }

  return {
    ceiling,
    running: runningBees,
    headroom: shedResult.headroom,
    ...(shedResult.shed ? { hostSaturated: true, hostSaturationReason: shedResult.reason } : {}),
  };
}

/**
 * In-process abort handles for spawns THIS host launched, keyed by spawnId
 * (EI-40). `fleet:cancel` flips the durable rows + releases locks/claims; this
 * is the other half — actually SIGTERM/SIGKILL the running child so a cancelled
 * spawn stops making edits instead of running to INVOKE_TIMEOUT. Only this
 * host's live spawns are here; spawns on another operator process aren't — those
 * are reclaimed by the P-011 heartbeat-staleness sweep (`reclaimOrphanedSpawns`):
 * a host that dies stops heartbeating, and its 'running' rows are freed once
 * stale so they stop poisoning the concurrency ceiling.
 */
const localSpawnAborts = new Map<string, AbortController>();

/**
 * Per-spawn CHILD pid (liveness-hardening, EI-493), set once `onChildPid`
 * fires — i.e. only once the real invoke-once child exists (before that, the
 * `childStartTimer` admission window already guards a wedged/slow launch).
 * The heartbeat tick /proc-liveness-checks this before bumping `heartbeat_at`
 * (see `ensureSpawnHeartbeatLoop`): a same-host row whose child process is
 * confirmed dead must NOT keep reading "falsely fresh" forever — that was the
 * leak class EI-493 reports ("bees exit without releasing nursery slots"),
 * because `reclaimOrphanedSpawns`'s candidate query only selects rows whose
 * `heartbeat_at` has actually gone stale. Entries die with the spawn (cleared
 * beside localSpawnAborts).
 */
const localSpawnPids = new Map<string, number>();

/**
 * Per-spawn stream activity (liveness-hardening P-008): epoch-ms of the
 * latest stdout/stderr chunk each LOCAL spawn emitted (set by the runner's
 * onOutputActivity callback — in-process, no tee files) and the value last
 * persisted, so the heartbeat tick only stamps rows whose output actually
 * advanced. Entries die with the spawn (cleared beside localSpawnAborts).
 */
const localSpawnOutput = new Map<string, { at: number; persistedAt: number }>();

function noteSpawnOutput(spawnId: string): void {
  const e = localSpawnOutput.get(spawnId);
  if (e) e.at = Date.now();
  else localSpawnOutput.set(spawnId, { at: Date.now(), persistedAt: 0 });
}

/** Spawns currently being reaped — guards double-fire across ticks while the
 *  cancel + process death settle. */
const wedgeReapInFlight = new Set<string>();

/**
 * Pure candidate filter for the wedge reaper (exported for tests): tracked
 * local spawns with OBSERVED output whose stream has been silent past the
 * threshold, minus those already mid-reap. Never-output spawns are excluded —
 * absence of signal is not evidence of a wedge (mirrors isPossiblyWedged).
 */
export function selectWedgeReapCandidates(
  output: ReadonlyMap<string, { at: number }>,
  tracked: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
  now: number,
  silentMs: number = WEDGE_REAP_SILENT_MS,
): string[] {
  const out: string[] = [];
  for (const [id, e] of output) {
    if (tracked.has(id) && !inFlight.has(id) && e.at > 0 && now - e.at > silentMs) out.push(id);
  }
  return out;
}

/**
 * Reap local spawns that are wedged past the threshold (flag-gated, D-006):
 * the durable cancel (claims + locks released, coord notice — the SAME engine
 * as fleet:cancel) then the local process abort. Only spawns THIS host
 * supervises are candidates — the host that holds the handle owns the verdict.
 * Spawns with NO observed output are never reaped (absence ≠ wedge).
 */
async function reapWedgedLocalSpawns(now: number): Promise<void> {
  const candidates = selectWedgeReapCandidates(
    localSpawnOutput,
    new Set(localSpawnAborts.keys()),
    wedgeReapInFlight,
    now,
  );
  if (candidates.length === 0) return;
  if (!(await getFlag(FLAGS.WEDGE_AUTO_REAP, 'system'))) return;
  const { cancelSubtree } = await import('./nursery');
  const { sql } = getOrgPg();
  for (const spawnId of candidates) {
    wedgeReapInFlight.add(spawnId);
    try {
      const rows = await sql<{ workspace_id: string }[]>`
        SELECT workspace_id FROM harness_shared.spawned_agents
         WHERE spawn_id = ${spawnId} AND status IN ('running', 'restarting') LIMIT 1`;
      const workspaceId = rows[0]?.workspace_id;
      if (!workspaceId) continue; // already terminal — nothing to reap
      const silentMin = Math.round((now - (localSpawnOutput.get(spawnId)?.at ?? now)) / 60_000);
      console.warn(`[wedge-reap] ${spawnId}: stream silent ${silentMin}min with a live process — cancelling (D-006)`);
      await cancelSubtree(sql, {
        workspaceId,
        rootSpawnId: spawnId,
        reason: `wedge-reap: alive but stream-silent ${silentMin}min (> ${Math.round(WEDGE_REAP_SILENT_MS / 60_000)}min, D-006)`,
        actor: {
          ownerId: 'wedge-reaper',
          ownerLabel: 'system · wedge-reaper',
          source: 'signed-spawn',
          workspaceId,
          userId: null,
        },
      });
      abortLocalSpawn(spawnId);
    } catch (err) {
      console.warn(`[wedge-reap] ${spawnId} failed (will retry next tick):`, err);
      wedgeReapInFlight.delete(spawnId);
    }
  }
}

/**
 * Pure filter (liveness-hardening, EI-493 — exported for tests): split the
 * ids this host is CURRENTLY tracking into 'alive' (heartbeat as normal —
 * includes an id with no recorded pid yet, since the admission-time
 * `childStartTimer` already guards that narrow pre-onChildPid window) and
 * 'dead' (a same-host /proc check confirms the recorded child process is
 * gone). A leaked local-tracking entry — the child died but
 * `spawnInvokeOnceWithFallback`'s completion promise never settled, e.g. an
 * external SIGKILL/cgroup-reap that bypasses a normal Node child-process exit
 * event — must stop being heartbeated, or its row reads "falsely fresh"
 * forever and `reclaimOrphanedSpawns`'s candidate query (`WHERE heartbeat_at
 * < now() - staleMs`) never selects it: a ceiling slot occupied until a
 * manual `fleet:cancel`, every wave (the exact EI-493 symptom).
 */
export function partitionHeartbeatCandidatesByLiveness(
  ids: readonly string[],
  pids: ReadonlyMap<string, number>,
  isAlive: (pid: number, kind?: 'spawn' | 'launch') => boolean = isSpawnProcessAlive,
): { alive: string[]; dead: string[] } {
  const alive: string[] = [];
  const dead: string[] = [];
  for (const id of ids) {
    const pid = pids.get(id);
    if (pid == null) {
      alive.push(id); // no child pid recorded yet — child-start window, guarded elsewhere
      continue;
    }
    if (isAlive(pid, 'spawn')) alive.push(id);
    else dead.push(id);
  }
  return { alive, dead };
}

/**
 * Heartbeat loop (P-011): while this host has live spawns, bump their
 * `heartbeat_at` every SPAWN_HEARTBEAT_INTERVAL_MS so the reclaim sweep can tell
 * a live spawn from one whose host died. Lazily started on the first spawn and
 * self-stopping when the last local spawn finishes. `unref`'d so it never holds
 * the process open. The same tick stamps `last_output_at` for spawns whose
 * stream moved since the last persist (P-008 — zero extra write cadence).
 *
 * EI-493: before bumping, each id with a known child pid is /proc-liveness
 * checked (`partitionHeartbeatCandidatesByLiveness`) — a confirmed-dead child
 * drops out of local tracking (never heartbeated again) instead of being kept
 * falsely fresh forever, so its row goes heartbeat-stale and the EXISTING
 * `reclaimOrphanedSpawns` sweep frees the ceiling slot on its own within
 * RECLAIM_STALE_MS, with no manual `fleet:cancel` required.
 */
let heartbeatTimer: ManagedHandle | null = null;
function ensureSpawnHeartbeatLoop(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = managedSetInterval(
    'operator-spawn-heartbeat',
    SPAWN_HEARTBEAT_INTERVAL_MS,
    () => {
      const trackedIds = [...localSpawnAborts.keys()];
      if (trackedIds.length === 0) {
        if (heartbeatTimer) heartbeatTimer.stop();
        heartbeatTimer = null;
        return;
      }
      const { alive: ids, dead } = partitionHeartbeatCandidatesByLiveness(trackedIds, localSpawnPids);
      for (const id of dead) {
        console.warn(
          `[operator-spawn] heartbeat loop: ${id}'s recorded child process is confirmed dead — dropping ` +
            'leaked local tracking (EI-493) so the row goes heartbeat-stale and reclaimOrphanedSpawns frees the ceiling slot',
        );
        // Best-effort nudge: if anything is still listening on the abort signal
        // (e.g. the completion promise is merely slow, not truly stuck), give it
        // one more chance to settle normally and run its own durable cleanup.
        localSpawnAborts.get(id)?.abort();
        localSpawnAborts.delete(id);
        localSpawnOutput.delete(id);
        localSpawnPids.delete(id);
      }
      if (ids.length === 0) {
        if (heartbeatTimer) heartbeatTimer.stop();
        heartbeatTimer = null;
        return;
      }
      const outputAt = new Map<string, number>();
      for (const id of ids) {
        const e = localSpawnOutput.get(id);
        if (e && e.at > e.persistedAt) {
          outputAt.set(id, e.at);
          e.persistedAt = e.at;
        }
      }
      void heartbeatSpawns(getOrgPg().sql, ids, outputAt).catch(() => {
        /* best-effort — a missed beat at worst risks an early reclaim, which is
         itself recoverable (an autonomous spawn re-runs; an interactive one is
         the human's to relaunch). */
      });
      // P-010/D-006: same tick, after the beat — reap local spawns wedged past
      // the threshold (flag-gated inside; double-fire guarded).
      void reapWedgedLocalSpawns(Date.now()).catch(() => {
        /* best-effort — a failed reap retries next tick */
      });
    },
    { category: 'lifecycle' },
  );
}

/**
 * Abort a locally-tracked running spawn (SIGTERM → SIGKILL). Returns true when a
 * live local handle was found and signalled. Called by the fleet:cancel tool for
 * each cancelled spawn id after the durable subtree flip.
 */
export function abortLocalSpawn(spawnId: string): boolean {
  const ctrl = localSpawnAborts.get(spawnId);
  if (!ctrl) return false;
  try {
    ctrl.abort();
  } catch {
    /* already aborted */
  }
  return true;
}

export interface OperatorSpawnInput {
  workspaceId: string;
  /** Registry slug of the harness to spawn into. Optional ONLY when the
   *  workspace has exactly one registered harness (it becomes the default). */
  harness?: string | null;
  /** Child agent role (AGENT_ROLES or a plugin-namespaced role). */
  role: string;
  /** Internal callers that must claim work before launch can pre-mint the durable spawn id. */
  spawnId?: string | null;
  featureId?: string | null;
  chunkId?: string | null;
  /** Queen-authored brief: the situational overlay the bee is MISSING. P-060. */
  brief?: string | null;
  /**
   * DESCRIPTIVE caller label for the observe-only governor receipt (plan
   * spawn-door-governor-migration-2026-08-31, D-011). Attribution ONLY: it binds
   * nothing, gates nothing, and is not the `parent` AdmissionContext that
   * P-005..P-011 will later thread — setting it is not migrating a caller.
   *
   * It exists because P-004 must produce a per-caller distribution and the door
   * otherwise cannot tell its callers apart: `parentRole` is the parent agent's
   * role, and several distinct callsites share the role 'operator', so splitting
   * on it would silently merge them. Unset is honest — the receipt records the
   * `caller-attribution-unavailable` caveat rather than guessing.
   */
  spawnCaller?: string | null;
  /** Named-fleet placement (fleet-color-schemes): when set, the bee launches INTO
   *  this fleet — its env carries PAPERCUSP_FLEET_SLUG/ROLE + the scheme colors so
   *  it auto-joins (the presence fleet label) + recolors its terminal at launch,
   *  with no brief directive. */
  fleet?: { slug: string; role: string; bg?: string; fg?: string; cursor?: string } | null;
  /**
   * Per-spawn model escalation (queen-model-tier-selection-2026-06-11).
   * `tier` names an entry in the user-defined tier menu (AgentConfig.tiers,
   * default quick/standard/deep/luna/max) — resolved + clamped to [role floor,
   * role ceiling] by resolveTierSpec. `modelSpec` is a direct
   * `<modelId>[:<effort>]` spec (operator/human escape hatch — NOT exposed to
   * the queen, whose lever is tier names only). When both are set, the
   * explicit spec wins. Unset → the role's standing resolution
   * (AGENT_MODELS → ROLE_MODEL_DEFAULTS → CLI default) applies unchanged.
   */
  tier?: string | null;
  modelSpec?: string | null;
  /**
   * Per-spawn account-routing override (account-routing-3-options, 2026-06-30) — the cup:spawn
   * `account` arg, mirroring the interactive psu path (resolveAccountPin). One of:
   *   • '<pool-id>'               → HARD pin this spawn to that account via the inference gateway.
   *   • 'auto' / 'gateway'        → gateway auto-route (it selects an available account + fails over).
   *   • 'default' / 'none' / 'system' → skip the gateway entirely (system credential, direct egress).
   * Unset → today's behavior (env pin → multi-account select → gateway active()). Threaded verbatim to
   * resolveSpawnGatewayEnv, which interprets the mode.
   */
  accountOverride?: string | null;
  /**
   * Per-spawn opus-budget criticality (B-GW-4). Overrides the role-derived default
   * (`classifyRoleCriticality`). When the fleet's aggregate 5h opus budget is tight, a
   * non-critical opus tier-escalation is shed to sonnet (background sheds first, then
   * normal); `critical` is never downgraded. Unset → derived from `role`.
   */
  criticality?: WorkCriticality | null;
  /** Extra KEY=value positional args for the child invoke. */
  extras?: string[];
  /** Optional per-spawn invoke timeout override (ms), threaded to
   *  spawnInvokeOnce (audit P-015 / EI-172). Unset → the runner's
   *  PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS default. */
  timeoutMs?: number | null;
  /** Lineage: the spawning turn/agent. Recorded as parent_spawn_id. */
  parentSpawnId?: string | null;
  /** Role of the spawner (default 'operator'). */
  parentRole?: string;
  planSlug?: string | null;
  itemId?: string | null;
  /** Per-turn TRIGGER (B-TOK-4): WHY this spawn ran — 'coord-wake' | 'cron' |
   *  'autoloop' | 'user'. Stamped as PAPERCUSP_TURN_TRIGGER so the run's usage
   *  sample (invoke.ts → recordUsageSamplePg) records turn_trigger and
   *  coordination-driven spend is summable. Omit → NULL ('unattributed'). */
  turnTrigger?: string | null;
  /**
   * Caller-supplied dedupe key (audit P-017, EI-73). A retry of the SAME
   * logical spawn (e.g. after a route timeout) passes the same key and gets
   * the original spawnId back (`deduped: true`) instead of a second agent.
   * Scoped per workspace; unique-indexed (migration 219).
   */
  idempotencyKey?: string | null;
}

export interface OperatorSpawnResult {
  ok: boolean;
  /** Set on ok AND on recorded failures (the failed nursery row's id). */
  spawnId: string | null;
  harness: string | null;
  projectDir: string | null;
  error: string | null;
  /** Set on an over-ceiling rejection: the wake key to sleep on (D-004 —
   *  `events:await { event: awaitEvent }`, end the turn, retry on wake). */
  awaitEvent?: string | null;
  /** True when idempotencyKey matched an existing spawn — `spawnId` is that
   *  original spawn; no new agent was launched (P-017/EI-73). */
  deduped?: boolean;
}

function newSpawnId(): string {
  return `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function countRunning(workspaceId: string, db?: Db): Promise<number> {
  const sql = db ?? getOrgPg().sql;
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

async function countRunningByRole(workspaceId: string, role: string, db?: Db): Promise<number> {
  const sql = db ?? getOrgPg().sql;
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND child_role = ${role}
       AND status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

export type SpawnAdmission =
  | { kind: 'admitted' }
  | { kind: 'duplicate'; spawnId: string }
  | { kind: 'over_cap'; running: number; cap: number; role?: string };

/**
 * Atomic spawn admission (audit P-017 + P-039, EI-73): reclaim → idempotency
 * dedupe → cap count → record, in ONE transaction serialized per workspace by
 * an advisory xact lock. Closes two races the old
 * reclaim-then-count-then-insert sequence had under read-committed:
 *   • two concurrent spawns both read running<cap and both recorded
 *     (ceiling overshoot, P-039);
 *   • a route-timeout retry of the SAME logical spawn launched a second agent
 *     (EI-73) — a caller-supplied idempotencyKey now returns the original row
 *     instead. The partial unique index from migration 219 backstops the
 *     dedupe even outside this lock.
 *
 * `record` runs inside the transaction only when admission succeeds; it must
 * use the handed tx. Exported for the real-PG concurrency tests.
 */
export async function admitSpawn(
  sql: Sql,
  opts: {
    workspaceId: string;
    /** The spawn id `record` inserts — the idempotency key is stamped on it. */
    spawnId: string;
    idempotencyKey: string | null;
    cap: number;
    roleCap?: { role: string; cap: number } | null;
    record: (tx: Db) => Promise<void>;
  },
): Promise<{ admission: SpawnAdmission; reclaimed: { count: number; workspaces: string[] } }> {
  let reclaimed = { count: 0, workspaces: [] as string[] };
  const admission = (await sql.begin(async (tx): Promise<SpawnAdmission> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`opspawn:${opts.workspaceId}`}))`;

    // Reclaim orphaned rows (a host that died mid-spawn left 'running' rows
    // that never flip) BEFORE counting, so the ceiling reflects live spawns
    // only and a dead host's rows can never wedge it (P-011). Announce is the
    // caller's job, AFTER commit.
    const r = await reclaimOrphanedSpawns(tx);
    reclaimed = { count: r.reclaimed, workspaces: r.workspaces };

    if (opts.idempotencyKey) {
      const dup = await tx<{ spawn_id: string }[]>`
        SELECT spawn_id FROM harness_shared.spawned_agents
         WHERE workspace_id = ${opts.workspaceId} AND idempotency_key = ${opts.idempotencyKey}
         LIMIT 1`;
      if (dup.length > 0) return { kind: 'duplicate', spawnId: dup[0].spawn_id };
    }

    const running = await countRunning(opts.workspaceId, tx);
    if (running >= opts.cap) return { kind: 'over_cap', running, cap: opts.cap };

    if (opts.roleCap) {
      const roleRunning = await countRunningByRole(opts.workspaceId, opts.roleCap.role, tx);
      if (roleRunning >= opts.roleCap.cap) {
        return { kind: 'over_cap', running: roleRunning, cap: opts.roleCap.cap, role: opts.roleCap.role };
      }
    }

    await opts.record(tx);
    if (opts.idempotencyKey) {
      // Separate UPDATE so the recordSpawn input type stays untouched; same
      // transaction, so the key is never observable without the row.
      await tx`UPDATE harness_shared.spawned_agents
                  SET idempotency_key = ${opts.idempotencyKey}
                WHERE spawn_id = ${opts.spawnId}`;
    }
    return { kind: 'admitted' };
  })) as SpawnAdmission;
  return { admission, reclaimed };
}

/**
 * Record a spawn attempt that failed BEFORE a child process existed (unknown
 * harness, role validation, cap). Durable visibility for what used to be a
 * silent console.warn — the row shows in fleet:tree / the Brew tab with the
 * reason in error_message.
 */
async function recordFailedAttempt(input: OperatorSpawnInput, error: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const spawnId = newSpawnId();
    await recordSpawn(sql, {
      spawnId,
      workspaceId: input.workspaceId,
      harnessSlug: input.harness ?? null,
      parentSpawnId: input.parentSpawnId ?? null,
      parentRole: input.parentRole ?? 'operator',
      childRole: input.role || '(missing)',
      runId: `opspawn-${Date.now()}`,
      featureId: input.featureId ?? null,
      chunkId: input.chunkId ?? null,
      planSlug: input.planSlug ?? null,
      itemId: input.itemId ?? null,
      sessionOwner: spawnId,
      status: 'running', // recordSpawn has no terminal-insert; flip immediately below
    });
    await finishSpawn(sql, {
      spawnId,
      workspaceId: input.workspaceId,
      status: 'failed',
      errorMessage: error,
    });
    return spawnId;
  } catch (err) {
    console.error(
      `[operator-spawn] failed to record failed attempt: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * EI-249: a brief must reach the bee FULLY SUBSTITUTED. The 2026-06-10
 * dispatch-pack launched agents whose brief still held the literal `brief-NN`
 * template placeholder (no number filled in), so six surplus bees had to
 * race-claim lanes off coord presence — a claim-race stampede. The queen-wave
 * compiler now substitutes `{item}` up front (`buildWaveFeatures`), but
 * `spawnAgentInHarness` is the ONE chokepoint every launch path funnels through
 * (chat `<spawn>`, `cup:spawn`, `place_batch`), so a fail-loud backstop here
 * refuses ANY un-substituted brief regardless of caller — option (a) of the
 * issue ("refuse to launch when the prompt still matches the placeholder").
 *
 * Detects the repo's `{item}` template token (the one `buildWaveFeatures`
 * substitutes) and the historical `brief-NN` dispatch-pack placeholder. Tight
 * by design — a real brief never contains either — so false positives are nil.
 * Returns the offending placeholder text (for the error message), or null.
 */
const BRIEF_PLACEHOLDER_RE = /\{item\}|\bbrief-NN\b/i;
export function findBriefPlaceholder(brief: string | null | undefined): string | null {
  if (!brief) return null;
  const m = BRIEF_PLACEHOLDER_RE.exec(brief);
  return m ? m[0] : null;
}

async function readEffectiveSpawnTierConfig(workspaceId: string): Promise<{
  tiers?: readonly import('../agent-config-constants').ModelTier[];
  tierCeilings?: Record<string, string>;
}> {
  const [{ effectiveTierConfig }, { readAgentConfig }] = await Promise.all([
    import('./model-tiers'),
    import('../agent-config'),
  ]);
  const cfg = await readAgentConfig().catch(() => null);
  // Session model-tier override (queen-steering-panel D-006): the owner's 👑-tab
  // override for the home hive takes PRECEDENCE over the workspace agent-config —
  // so "retune the fleet's tiers for this session" changes autonomous spawns even
  // when the Queen/recovery path did not pass an explicit per-item tier.
  let session: import('../owner-steering').OwnerSteering | null = null;
  try {
    const [{ getOwnerSteering }, { resolvePotHomeSlug }] = await Promise.all([
      import('../owner-steering'),
      import('../pot/wake'),
    ]);
    const home = resolvePotHomeSlug();
    if (home) session = await getOwnerSteering(workspaceId, home);
  } catch {
    /* fail-soft → the workspace default tiers */
  }
  return effectiveTierConfig(cfg, session);
}

/**
 * Spawn one agent of `role` into the named harness's project dir, tracked in the
 * durable nursery. Returns immediately after the child process is launched
 * (fire-and-forget); the background completion flips the row to done/failed.
 */
export async function spawnAgentInHarness(input: OperatorSpawnInput): Promise<OperatorSpawnResult> {
  const role = (input.role ?? '').trim();
  const fail = async (error: string): Promise<OperatorSpawnResult> => {
    console.error(`[operator-spawn] ${error}`);
    const spawnId = await recordFailedAttempt(input, error);
    return { ok: false, spawnId, harness: input.harness ?? null, projectDir: null, error };
  };

  // Role sanity: a known built-in or a plugin-namespaced role. A typo'd role
  // would otherwise burn a full agent boot before failing inside invoke-once.
  if (!role) return fail('spawn rejected: missing role');
  const knownRole = (AGENT_ROLES as readonly string[]).includes(role) || role.includes(':');
  if (!knownRole) {
    return fail(`spawn rejected: unknown role "${role}" — known roles: ${AGENT_ROLES.join(', ')}`);
  }
  if (role === 'worker' && !input.chunkId) {
    return fail(
      'spawn rejected: role="worker" requires a chunk id — that\'s the coding-FACTORY pipeline ' +
        '(scoper→worker, push-based). For a self-pulling worker that claims its own work via a ' +
        'claim-spec (scheduler:get_next), launch an su fleet — fleet:launch-on-plan. ' +
        '(This used to say role="cup"; that tier is RETIRED and every cup spawn is refused below, ' +
        'so pointing callers at it sent them into a guaranteed rejection — P-068.)',
    );
  }

  // coding-hive `bee` vs coding-factory `scoper` mix-up guard
  // (coding-hive-bee-vs-coding-factory-scoper-2026-06-23). Two distinct execution models share this
  // chokepoint and were being CONFLATED: the coding-FACTORY is a PUSH pipeline (scoper→architect→worker→…)
  // where each role is handed a FEATURE_ID by the orchestrator's spine (NEXT_SCOPER/NEXT_ARCHITECT/… all
  // carry `extras:["FEATURE_ID={feature}"]`); the coding-HIVE worker is the `bee` — a SELF-PULLING agent
  // the Queen steers with a claim-spec (scheduler:set_claim_spec) and that pulls its own work via
  // scheduler:get_next. The observed failure mode: an agent spawned role="scoper" and set claim-specs on it
  // to test the hive handoff — a scoper NEVER calls get_next, so the spec is INERT and the scoper, lacking a
  // pushed FEATURE_ID, has nothing to do. A factory role launched with NO pushed-feature context is almost
  // always this mistake. The factory's own spine ALWAYS pushes FEATURE_ID (blueprint.yaml edges), so a
  // legitimate factory spawn carries it (as input.featureId / a FEATURE_ID= extra) or an input.chunkId — and
  // this guard does NOT fire for those. Role-scoped + conservative: only the push-pipeline roles, only when
  // NO feature context is present.
  const FACTORY_PIPELINE_ROLES = new Set(['scoper', 'architect', 'validator', 'documenter', 'curator', 'director']);
  if (FACTORY_PIPELINE_ROLES.has(role)) {
    const hasFeatureExtra = (input.extras ?? []).some((e) => e.startsWith('FEATURE_ID='));
    const hasFeatureContext = !!input.featureId || hasFeatureExtra || !!input.chunkId;
    if (!hasFeatureContext) {
      return fail(
        `spawn rejected: role="${role}" is a coding-FACTORY push-pipeline role ` +
          '(scoper→architect→worker→validator→…) — these are normally PUSHED a FEATURE_ID by the ' +
          'orchestrator spine (NEXT_SCOPER/NEXT_ARCHITECT/… all carry FEATURE_ID), so spawning one with no ' +
          'pushed-feature context (no featureId, no FEATURE_ID= extra, no chunkId) has nothing to do. ' +
          'If you meant a self-pulling worker that claims its own work via a claim-spec ' +
          '(scheduler:set_claim_spec + scheduler:get_next), that is an su fleet ' +
          '(fleet:launch-on-plan), NOT a factory role — the cup tier this used to name is RETIRED. ' +
          'To genuinely run the factory pipeline, push the FEATURE_ID (pass featureId / a FEATURE_ID= extra).',
      );
    }
  }
  // RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-008 / D-018). The
  // mug/kettle/cup tier is retired (D-001), and THIS is the chokepoint the
  // comment below already identifies as the one "cup:spawn + every agent-driven
  // launch funnel through" — so one gate here covers the role family across
  // cup:spawn, fleet:place_batch, chat `<spawn>`, the supervision relaunch, the
  // wake-executor's fresh-context spawn and the p2p offer executor, instead of
  // five hand-placed copies free to drift apart.
  //
  // `isRetiredTierRole` CANONICALIZES before testing, which is load-bearing: the
  // pot rename left live aliases (bee→cup, queen→mug, overwatch→kettle) and this
  // file's own neighbours still hand-roll `role === 'queen' || role === 'mug'`,
  // so a raw-string match would leave all three reachable under their old names.
  // It is shared with the OTHER spawn chokepoint (the /invoke route) so the two
  // cannot drift — see pot/retired-tier-roles.ts for why it is its own module.
  const { isRetiredTierRole } = await import('../pot/retired-tier-roles');
  if (isRetiredTierRole(role)) {
    const { mugKettleSystemEnabled } = await import('../pot/started');
    if (!(await mugKettleSystemEnabled())) {
      return fail(
        `spawn rejected: role="${role}" belongs to the Mug/Kettle/Cup tier, which is RETIRED ` +
          `permanently. Launch an su fleet instead — fleet:launch-on-plan. ` +
          `There is no longer a flag to flip: the reversible escape hatch ` +
          `(papercusp-mug-kettle-system) was deleted in P-068, which is how that flag ` +
          `was always specified to graduate.`,
      );
    }
  }

  // WI-38240: the papercusp-overwatch spawn-door gate that used to sit here
  // (overwatch-role-2026-06-15 B-10 / D-009) is DELETED — `kettle` was the ONLY role it
  // governed, and the retirement gate above refuses every retired-tier role first, so it
  // was unreachable. Do NOT re-add a role gate here: operator-spawn.test.ts asserts kettle
  // is refused for RETIREMENT and explicitly NOT for overwatch, and a gate above the
  // retirement refusal would change which error a caller sees.
  // FLAGS.OVERWATCH itself is NOT retired and must stay — overwatch/{cross-monitor,
  // snapshot,watchdog}.ts and the wake-loop routine registration still read it.

  // EI-249: refuse to launch a bee whose brief still holds an un-substituted
  // template placeholder. A literal `{item}` / `brief-NN` means an upstream
  // substitution step was skipped — the 2026-06-10 dispatch-pack stampede, where
  // surplus bees raced to claim lanes off coord presence. This central chokepoint
  // backstops every launch path (cup:spawn, chat `<spawn>`, place_batch), so the
  // guard fails loud + durable (recordFailedAttempt) rather than spawn a mis-briefed
  // bee. The queen-wave compiler substitutes templates up front; this catches any
  // caller that bypassed it.
  const briefPlaceholder = findBriefPlaceholder(input.brief);
  if (briefPlaceholder) {
    return fail(
      `spawn rejected: brief contains an un-substituted placeholder "${briefPlaceholder}" — ` +
        `the brief must be fully substituted before launch (EI-249). Resolve the template ` +
        `(buildWaveFeatures substitutes {item}) before spawning.`,
    );
  }

  // Per-spawn model resolution (queen-model-tier-selection-2026-06-11): an
  // explicit spec wins; otherwise a tier name resolves against the user's
  // menu, clamped to [role floor, role ceiling]. Resolved BEFORE admission so
  // the spec/tier land on the nursery row (the queen's pick vs. the task's
  // outcome is the trust telemetry). An unknown tier fails loud — a typo'd
  // tier silently running at the default would be the EI-7 class of bug.
  let spawnModelSpec: string | null = (input.modelSpec ?? '').trim() || null;
  let spawnModelTier: string | null = null;
  let spawnModelBackend: string | null = null;
  let spawnCompactionLimit: number | null = null;
  // WI-38240: `spawnModelSpecIsImplicitDefault` used to be tracked here so the
  // bench-scoped opus pin (P-033 Fix 2) could out-rank an account-steering DEFAULT
  // fallback. That pin was `role === 'cup'` only and has been deleted with the rest of
  // the retired-tier bench block, leaving this flag write-only — so it is gone too.
  if (!spawnModelSpec && input.tier && input.tier.trim()) {
    const [{ resolveTierSpec }, { tiers, tierCeilings }] = await Promise.all([
      import('./model-tiers'),
      readEffectiveSpawnTierConfig(input.workspaceId),
    ]);
    const resolved = resolveTierSpec({ tier: input.tier, role, tiers, tierCeilings });
    if (!resolved.ok) return fail(`spawn rejected: ${resolved.error}`);
    spawnModelSpec = resolved.spec;
    spawnModelTier = resolved.tier;
    spawnModelBackend = resolved.backend ?? null;
    spawnCompactionLimit = resolved.compactionLimit;
    if (resolved.note) console.log(`[operator-spawn] ${resolved.note}`);

    // Fleet opus-budget pacing (B-GW-4 — inference-gateway-robustness-audit-2026-06-20 gateway P2):
    // when the aggregate Claude-Max 5h opus budget is tight, shed a NON-CRITICAL opus ESCALATION
    // back to sonnet so the fleet paces UNDER the 5h ceiling instead of blow-then-starve. Only the
    // TIER path (a Queen escalation) is eligible — an explicit `modelSpec` (operator/bench escape
    // hatch) never reaches here. `downgradeOpusTierForBudget` re-resolves through `resolveTierSpec`,
    // so the role-floor clamp guarantees an opus-floored role is never dropped below it (EI-7/EI-286;
    // the downgrade is then a no-op). Flag-gated + fail-soft: any fault leaves the resolved tier
    // verbatim — pacing can never wedge or mis-route a spawn.
    try {
      if (await getFlag(FLAGS.OPUS_BUDGET_PACING, 'system')) {
        const criticality: WorkCriticality = input.criticality ?? classifyRoleCriticality(role);
        const budget = await evaluateOpusBudgetForSpawn(criticality, input.workspaceId);
        if (budget.downgrade) {
          const { downgradeOpusTierForBudget } = await import('./model-tiers');
          const dg = downgradeOpusTierForBudget({
            currentSpec: spawnModelSpec,
            currentTier: spawnModelTier,
            role,
            tiers,
            tierCeilings,
          });
          if (dg.downgraded) {
            console.log(
              `[operator-spawn] opus-budget pacing: ${role} (${criticality}) tier "${spawnModelTier}" (${dg.from}) → ` +
                `"${dg.tier}" (${dg.spec}) — ${budget.reason}`,
            );
            spawnModelSpec = dg.spec;
            spawnModelTier = dg.tier;
            spawnModelBackend = dg.backend ?? null;
            spawnCompactionLimit = dg.compactionLimit ?? spawnCompactionLimit;
          }
        } else if (budget.pace) {
          console.log(
            `[operator-spawn] opus-budget: ${role} (${criticality}) keeps opus but is paced — ${budget.reason}`,
          );
        }
      }
    } catch (e) {
      console.warn(`[operator-spawn] opus-budget pacing skipped (fail-soft): ${(e as Error).message}`);
    }
  } else if (!spawnModelSpec) {
    try {
      const [{ resolveRoleOwnModelSpec, roleTierCeiling }, eff] = await Promise.all([
        import('./model-tiers'),
        readEffectiveSpawnTierConfig(input.workspaceId),
      ]);
      const spec = resolveRoleOwnModelSpec(role, eff);
      if (spec) {
        spawnModelSpec = spec;
        spawnModelTier = roleTierCeiling(eff.tierCeilings, role) ?? null;
      }
    } catch (e) {
      console.warn(`[operator-spawn] default model steering skipped (fail-soft): ${(e as Error).message}`);
    }
  }
  // account-steering-path fix (autonomous-loop-prod-audit-2026-07-02 P-020): the
  // branches above only populate `spawnModelSpec` from an EXPLICIT per-spawn
  // tier/spec or an owner session override (`resolveRoleOwnModelSpec`, itself
  // null unless the owner configured tiers/ceilings). The common case — a role
  // with no override, relying purely on the COMMITTED `ROLE_MODEL_DEFAULTS`
  // floor — leaves `spawnModelSpec` null HERE even though `applyRoleModel`
  // (deep inside buildInvokeOnce) WILL fall back to that same committed
  // default for the actual `--model` flag. Without this fallback,
  // `inferBackendFromModelSpec` never sees a codex-shaped spec, so a role
  // whose ONLY pin is a codex-family committed default (e.g. mug/cup/kettle's
  // `gpt-5.6-luna:high`) would launch with the OpenAI model text applied to
  // the CLAUDE binary — an unrunnable combination (the EI-7/EI-286/EI-12657/
  // WI-1979 "selected model unavailable" outage class). Scoped narrowly: only
  // promotes the committed default into `spawnModelSpec` when it actually
  // resolves to a DIFFERENT backend, so every role whose committed default
  // stays on the inherited backend (worker/validator/documenter/release-
  // manager/…) sees byte-identical `spawnModelSpec`/nursery-row behavior.
  if (!spawnModelSpec) {
    const committedDefault = roleModelDefault(role);
    if (committedDefault && inferBackendFromModelSpec(committedDefault)) {
      spawnModelSpec = committedDefault;
    }
  }
  const inferredBackend = inferBackendFromModelSpec(spawnModelSpec ?? undefined);
  if (inferredBackend) {
    spawnModelBackend = inferredBackend;
  }

  // Harness resolution. Explicit slug wins; with no slug, a single-harness
  // workspace has an unambiguous default. Anything else fails loud.
  let slug = (input.harness ?? '').trim();
  if (!slug) {
    try {
      const reg = await loadHarnessRegistry(input.workspaceId);
      // WI-1937: an ephemeral P-104 foreign-clone row must never win the
      // "only one harness registered" default-inference — it's not a real
      // harness a human registered, and picking it here would silently cwd an
      // unrelated spawn into a peer's sandboxed clone. (Explicitly naming its
      // slug still resolves it fine — that's resolveProject below, untouched.)
      const registeredProjects = reg.projects.filter((p) => !isEphemeralForeignProject(p));
      if (registeredProjects.length === 1) slug = registeredProjects[0].slug;
      else {
        return fail(
          `spawn rejected: no harness named and ${registeredProjects.length} are registered — pass harness=<slug> (registered: ${registeredProjects.map((p) => p.slug).join(', ') || '(none)'})`,
        );
      }
    } catch (err) {
      return fail(`spawn rejected: harness registry unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let project = (await resolveProject(slug, input.workspaceId)) ?? (await resolveProject(slug)); // cross-workspace safety net (matches harness routes)
  if (!project) {
    // EI-429: the Queen sometimes passes its SU MCP server slug ("<project>-su",
    // or the legacy "papercusp-su") as a spawn target instead of the project.
    // Remap a KNOWN -su MCP slug to its project — strip the "-su" suffix, aliasing
    // the legacy "papercusp-su" to the operator-home project (operatorHomeHarnessSlug() —
    // PAPERCUSP_POT_HOME_SLUG when set, else the legacy "papercup"). Deterministic
    // remap of the known MCP slugs ONLY, never a silent normalize of arbitrary slugs.
    const suBase = slug === 'papercusp-su' ? operatorHomeHarnessSlug() : /^(.+)-su$/.exec(slug)?.[1];
    if (suBase && suBase !== slug) {
      const remapped = (await resolveProject(suBase, input.workspaceId)) ?? (await resolveProject(suBase));
      if (remapped) {
        project = remapped;
        slug = remapped.slug;
      }
    }
  }
  if (!project) {
    let registered = '';
    try {
      const reg = await loadHarnessRegistry(input.workspaceId);
      registered = reg.projects.filter((p) => !isEphemeralForeignProject(p)).map((p) => p.slug).join(', ') || '(none)';
    } catch {
      /* best-effort */
    }
    return fail(`spawn rejected: harness "${slug}" is not a registered project (registered: ${registered})`);
  }
  if (!existsSync(project.path)) {
    return fail(`spawn rejected: harness "${slug}" project dir missing on disk: ${project.path}`);
  }

  const spawnId = (input.spawnId ?? '').trim() || newSpawnId();
  const runId = `opspawn-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const { sql } = getOrgPg();
  const idemKey = (input.idempotencyKey ?? '').trim() || null;
  const { backend } = resolveSpawnBackendModel(
    role,
    spawnModelSpec ?? undefined,
    spawnModelBackend ?? undefined,
  );

  // Resolve an explicit account route before durable admission. Auto/pin are
  // contracts: if the gateway, pool, provider, or credential cannot honor one,
  // reject without creating a running nursery row that no child can satisfy.
  let resolvedGatewayEnv: Record<string, string>;
  try {
    resolvedGatewayEnv = await resolveSpawnGatewayEnv({
      workspaceId: input.workspaceId,
      slug,
      ownerId: spawnId,
      backend,
      role,
      model: spawnModelSpec ?? undefined,
      account: input.accountOverride ?? undefined,
    });
  } catch (error) {
    return fail(`spawn rejected: ${error instanceof Error ? error.message : String(error)}`);
  }

  // WI-390 layer 1 (SHADOW mode, non-enforcing): log whether the gateway would have
  // deferred this spawn for pool exhaustion — fire-and-forget, never awaited into the
  // critical path and never allowed to affect admission. See spawn-readiness.ts STATUS.
  void logSpawnReadinessShadow({ role, spawnId });

  // Atomic admission (audit P-017 + P-039, EI-73) — see admitSpawn.
  // Over-ceiling stays a QUEUE+AWAIT, not a silent drop (D-004): the result
  // carries the wake key the caller sleeps on.
  let admission: SpawnAdmission;
  let reclaimed: { count: number; workspaces: string[] };
  try {
    ({ admission, reclaimed } = await admitSpawn(sql, {
      workspaceId: input.workspaceId,
      spawnId,
      idempotencyKey: idemKey,
      // Always enforce the global safety cap against every spawned role. WI-38240: the
      // second, bee-only owner max-bees cap that used to be passed here is GONE — it was
      // `role === 'cup'` only, and cup is refused by the retirement gate above, so it
      // resolved to null on every reachable path. The owner max-bees knob itself is NOT
      // dead and must stay: `ownerMaxBeesCeiling()` still governs live spawns through
      // `getSpawnHeadroom()` and `effectiveSpawnCeiling()`, neither of which is behind
      // the retirement gate. Only this unreachable branch is removed.
      cap: spawnConcurrencyCeiling(),
      roleCap: null,
      record: (tx) =>
        recordSpawn(tx, {
          spawnId,
          workspaceId: input.workspaceId,
          harnessSlug: slug,
          parentSpawnId: input.parentSpawnId ?? null,
          parentRole: input.parentRole ?? 'operator',
          childRole: role,
          runId,
          featureId: input.featureId ?? null,
          chunkId: input.chunkId ?? null,
          planSlug: input.planSlug ?? null,
          itemId: input.itemId ?? null,
          modelSpec: spawnModelSpec,
          modelTier: spawnModelTier,
          // Persist the brief (mig 230): the dock's brief-pane shows "what
          // started this agent" long after the MUG_BRIEF env is gone.
          brief: input.brief ?? null,
          // The child's coord/lock owner is its spawnId — the link
          // fleet:cancel uses to release its locks/claims transitively.
          sessionOwner: spawnId,
          coordinationDomain: lockDomainForProjectDir(project.path),
          status: 'running',
        }),
    }));
  } catch (err) {
    return fail(`spawn admission failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Announce reclaimed slots AFTER commit (the announce wakes waiters who
  // immediately re-count — they must see our committed admission).
  await Promise.all(
    reclaimed.workspaces.map((ws) => announceSpawnSlotFreed(ws, `${reclaimed.count} orphaned spawn slot(s) reclaimed`)),
  );

  // P-003 (plan spawn-door-governor-migration-2026-08-31): OBSERVE-ONLY governor
  // receipt — record the admission decision the governor WOULD have made for this
  // spawn. `void`-ed and never awaited: this is evidence, and a defect in it must
  // never be able to fail a spawn (D-009) — the WI-390 shadow probe's contract.
  //
  // The over_cap branch below observes SEPARATELY, after `fail()` has minted the
  // row its receipt attaches to (D-010); it is deliberately not handled here.
  const observeSpawn = (
    doorOutcome: 'admitted' | 'duplicate' | 'over_cap',
    failedAttemptSpawnId?: string | null,
  ) =>
    recordSpawnGovernorObservation({
      sql,
      workspaceId: input.workspaceId,
      spawnId,
      failedAttemptSpawnId,
      doorOutcome,
      doorCap: spawnConcurrencyCeiling(),
      doorRoleCap: null, // WI-38240: was `ownerBeeCeiling`, always null since cup is retired.
      parentRole: input.parentRole ?? 'operator',
      childRole: role,
      fleetSlug: input.fleet?.slug ?? null,
      planSlug: input.planSlug ?? null,
      caller: input.spawnCaller ?? null,
    });

  if (admission.kind === 'admitted') void observeSpawn('admitted');

  if (admission.kind === 'duplicate') {
    void observeSpawn('duplicate');
    console.log(
      `[operator-spawn] idempotent replay: key "${idemKey}" already spawned ${admission.spawnId} — not spawning again (EI-73)`,
    );
    return {
      ok: true,
      spawnId: admission.spawnId,
      harness: slug,
      projectDir: project.path,
      error: null,
      deduped: true,
    };
  }
  if (admission.kind === 'over_cap') {
    const awaitEvent = spawnSlotEventKey(input.workspaceId);
    // WI-38240: both labels used to branch on `admission.role === 'cup'`. Cup is refused
    // by the retirement gate above, so only the non-cup arm was ever reachable.
    const capLabel = 'maxSimultaneousAgents';
    const runningLabel = `${admission.running} spawns`;
    const res = await fail(
      `spawn rejected: ${runningLabel} already running (fleet ceiling ${admission.cap} — ${capLabel}). ` +
        `Do not drop or busy-wait: events:await { event: "${awaitEvent}" }, end your turn, and retry this spawn on wake (a slot-free wakes you) — or fleet:cancel one.`,
    );
    // Observe AFTER fail(): `recordFailedAttempt` mints the row this receipt
    // attaches to, under a fresh id (res.spawnId), not our `spawnId` (D-010).
    // Cap refusals are where P-004's burst shape lives — a burst IS the moments
    // the ceiling was hit — so dropping them would understate bursts invisibly.
    void observeSpawn('over_cap', res.spawnId);
    return { ...res, awaitEvent };
  }

  // WI-4894: scope isolation lets the child survive a deploy restart, but the
  // old operator's stdout pipe + completion promise do not. Give every governed
  // spawn a deterministic invoke-once artifact and persist its path before the
  // child starts; the fresh operator's boot/periodic reconcile harvests it.
  const resultPath = spawnResultArtifactPath(project.path, spawnId);
  try {
    await sql`
      UPDATE harness_shared.spawned_agents
         SET result_path = ${resultPath}
       WHERE workspace_id = ${input.workspaceId} AND spawn_id = ${spawnId}`;
  } catch (e) {
    console.warn(
      `[operator-spawn] record result_path failed (mig 608 pending?): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // EI-2186/EI-85 hardening: close the admission -> child-pid gap. A row exists
  // as soon as recordSpawn commits, but the real child pid is only known after
  // spawnInvokeOnce starts the subprocess. If the operator restarts in between,
  // an unstamped row has no launcher_boot_id, so boot reconcile cannot prove it
  // belongs to the dead prior incarnation and it later dies as a stale anonymous
  // heartbeat. Stamp THIS supervisor process immediately; onChildPid overwrites it
  // with the actual invoke-once child pid once available.
  try {
    await recordSpawnPid(sql, spawnId, process.pid);
  } catch (e) {
    console.warn(
      `[operator-spawn] provisional pid stamp failed for ${spawnId} (spawn continues): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // WI-1813 (WI-1764 #4 follow-up): stamp the named-fleet slug on the nursery row so a
  // per-fleet beeCount is RELIABLE. input.fleet threads the fleet to the child's ENV
  // (presence auto-join + terminal recolor) but the spawned_agents row itself carried NO
  // fleet linkage — so countRunningWorkspaceBees had to stay workspace-wide and could not
  // attribute a running bee to its fleet. Stamping it here makes countRunningFleetBees
  // deterministic (presence-independent). Best-effort + fail-soft: a not-yet-migrated DB
  // (fleet_slug from mig 475) must never break a spawn — same guard as the session_id
  // stamp below. Only fires for a fleet-placed spawn; an ungrouped bee keeps NULL.
  if (input.fleet?.slug) {
    try {
      await sql`UPDATE harness_shared.spawned_agents SET fleet_slug = ${input.fleet.slug} WHERE spawn_id = ${spawnId}`;
    } catch (e) {
      console.warn(
        `[operator-spawn] record fleet_slug failed (mig 475 pending?): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // P-016/D-007: claude bees get a forced native session id, recorded here so the
  // unified hive-tabs bee pane can attach `claude --resume <session_id>` (P-004).
  // resolveSpawnBackendModel predicts the backend buildInvokeOnce will run (reads
  // AGENT_CMD/AGENT_MODELS for the role); omp resumes by thread id + codex by
  // rollout, so they mint none. The UPDATE is best-effort — a not-yet-migrated DB
  // (session_id from mig 203) must never break a spawn.
  const nativeSessionGuard = backendFeatureGuard(
    interactiveBackendFromSpawnBackend(backend),
    'forced-native-session-id',
  );
  const forceSessionId = nativeSessionGuard.supported ? randomUUID() : undefined;
  if (forceSessionId) {
    try {
      await sql`UPDATE harness_shared.spawned_agents SET session_id = ${forceSessionId} WHERE spawn_id = ${spawnId}`;
    } catch (e) {
      console.warn(
        `[operator-spawn] record session_id failed (mig 203 pending?): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // queen-autonomy P-112: route the per-spawn model-tier choice through the
  // disposition log (agent-lifecycle, reversible — the next spawn can differ).
  // Fire-and-forget + flag-gated; a ledger miss must never break a spawn.
  void (async () => {
    try {
      const { recordProactiveDisposition } = await import('../decision-ledger/disposition');
      const links: Record<string, unknown> = { spawnId, runId };
      if (input.featureId) links.featureId = input.featureId;
      if (input.chunkId) links.chunkId = input.chunkId;
      if (input.parentSpawnId) links.parentSpawnId = input.parentSpawnId;
      await recordProactiveDisposition({
        workspaceId: input.workspaceId,
        harnessSlug: slug,
        // `fleet:spawn-agent` names what this ENGINE does, not the retired verb
        // that used to be its only caller (P-059 retired `cup:spawn`; the engine
        // is shared by capability:launch-agent + fleet:launch-on-plan and is
        // untouched). Category is unchanged: `^fleet:` matches the SAME
        // `cat:fleet` → agent-lifecycle rule that `^cup:` did, so autonomy
        // gating does not move. An unmapped action would default to never-auto.
        decisionInput: { action: 'fleet:spawn-agent', riskTier: 'low', authority: 'system', reversibility: 'reversible' },
        why: `model tier ${spawnModelTier ?? 'default'} for ${role}`,
        links,
        metadata: { modelTier: spawnModelTier ?? null, modelSpec: spawnModelSpec ?? null, role },
        actorRole: input.parentRole ?? 'operator',
        actorSpawnId: input.parentSpawnId ?? null,
      });
    } catch {
      /* never break a spawn on a ledger miss */
    }
  })();

  const extras = [...(input.extras ?? [])];
  if (input.featureId) extras.push(`FEATURE_ID=${input.featureId}`);
  if (input.chunkId) extras.push(`CHUNK_ID=${input.chunkId}`);
  // Per-hive override (domain-generic-hive-architecture-2026-06-18 P-012/P-013/D-013):
  // materialize the home Hive's FEDERATED promptOverride.* into a local-tier blueprint
  // tree and pass its root via BLUEPRINT_LOCAL_ROOT= so the AUTONOMOUS spawn's prompt
  // resolver (invoke.ts, tier-aware per P-014) picks the hive's customized role prompts
  // over the built-in. Closes the gap where only interactive/psu launches got per-hive
  // overrides — required for dogfood (P-026/P-027). Best-effort + only when a BLUEPRINT_ID
  // is set: a miss leaves extras unchanged → built-in-only resolution (byte-identical).
  try {
    const hiveBlueprintId = extras.find((e) => e.startsWith('BLUEPRINT_ID='))?.slice('BLUEPRINT_ID='.length);
    if (hiveBlueprintId) {
      const { resolveHiveLocalBlueprintRoot, blueprintLocalRootExtra } =
        await import('../hive-local-blueprint-resolve');
      const extra = blueprintLocalRootExtra(
        await resolveHiveLocalBlueprintRoot({
          workspaceId: input.workspaceId,
          harnessSlug: slug,
          harnessDir: project.path,
          hiveBlueprintId,
        }),
      );
      if (extra) extras.push(extra);
    }
  } catch {
    /* best-effort: never break a spawn on a per-hive-override miss */
  }

  const extraEnv = buildPipelineExtraEnv({
    harnessSlug: slug,
    idempotencyKey: runId,
    workspaceId: input.workspaceId,
  });

  // WI-38240: the external-bench bee SELF-SUFFICIENCY block (impartial-benchmark D-020 /
  // P-033 Fix 2) that used to sit here is DELETED. Everything in it hung off
  // `benchBeeDirective`, which was `role === 'cup' ? … : ''` — the brief append, the
  // per-spawn PAPERCUSP_SPAWN_BACKEND/PAPERCUSP_FLEET_SANDBOX pins, and the bench-scoped
  // opus pin. `cup` is refused by the retirement gate above, so the directive was '' on
  // every reachable path and the whole block was unreachable.
  // The PAPERCUSP_XBENCH_* env vars are NOT dead and must stay: blueprint/launch-blueprint.ts
  // (the Queen/mug pin), external-bench/su-independent-backlog.ts and
  // external-bench/hive-backlog-realqueen.ts all still set and read them.
  // THE UMBILICAL (voice gap fix): thread the operator's durable `s-…` spawnId into
  // the child's env so invoke()/spawn-mcp bakes it as the signed MCP URL's STABLE
  // `client=` param. Without this the child minted a fresh random `spawnId` per boot
  // AND carried no `client`, so the operator's resolveAgentIdentity() found no
  // attributable coord identity and THREW on every coord:send / plans:set-status /
  // improvements:capture — the child's file edits landed but it was MUTE on coord.
  // The `s-…` id is the SAME owner recorded as `sessionOwner` on the spawned_agents
  // row, so a bee's coord messages, its file-lock owner, and fleet:cancel's release
  // target all line up. parentSpawnId carries lineage onto the child's MCP URL too.
  extraEnv.PAPERCUSP_SPAWN_ID = spawnId;
  // EI-13668 root cause fix (mirrors the /invoke chokepoint in
  // endpoint-route/routes/harness/spawn.ts): `deriveAgentRole` (identity.ts) only
  // ever derives a role from `PAPERCUSP_AGENT_ROLE` env or a coarse identity.source
  // fallback ('fleet-spawn'/'signed-spawn' → the generic 'cup', never a specific
  // pipeline/singleton role like 'kettle'/'mug'). Without this env stamp, EVERY
  // role spawned through this chokepoint (this is the "central role-admission
  // chokepoint that cup:spawn + every agent-driven launch funnel through" per the
  // header doc above) reports the wrong `agentRole` on its own presence writes the
  // moment it makes its first coord:orient/declare-intent/heartbeat call — so
  // `@role:<x>` addressing (role-slot-live-resolve.ts) never finds a truly-live
  // holder for any role this chokepoint spawns other than plain 'cup'.
  extraEnv.PAPERCUSP_AGENT_ROLE = canonicalCoordRole(role);
  if (input.parentSpawnId) extraEnv.PAPERCUSP_PARENT_SPAWN_ID = input.parentSpawnId;
  // Per-turn trigger attribution (B-TOK-4): stamp WHY this run was spawned so the
  // subprocess usage sample (invoke.ts → recordUsageSamplePg) records turn_trigger
  // and the Tokens dashboard can sum coordination-driven spend. Only when supplied.
  if (input.turnTrigger) extraEnv.PAPERCUSP_TURN_TRIGGER = input.turnTrigger;
  // P-050/P-060: thread the Queen brief through the invocation so the invoke-once
  // prompt path (invoke.ts → buildPrompt's `## Queen brief` section) injects it into
  // the bee's prompt. The brief rides in extraEnv as MUG_BRIEF; the child reads
  // process.env.MUG_BRIEF. (NOTE: the cup:spawn child does NOT use
  // assembleRolePrompt — it goes through invoke-once → buildPrompt; an earlier
  // comment naming assembleRolePrompt was the mis-wiring the plan flagged.)
  if (input.brief) {
    extraEnv.MUG_BRIEF = input.brief;
  }
  // Named-fleet placement (fleet-color-schemes): thread the fleet label + scheme
  // colors so the bee auto-joins (PAPERCUSP_FLEET_SLUG/ROLE → its presence fold)
  // and recolors its terminal at launch (PAPERCUSP_FLEET_BG/FG/CURSOR → the psu
  // host's fleetOscFromEnv write), with no brief directive.
  if (input.fleet?.slug) {
    extraEnv.PAPERCUSP_FLEET_SLUG = input.fleet.slug;
    extraEnv.PAPERCUSP_FLEET_ROLE = input.fleet.role || 'member';
    if (input.fleet.bg) extraEnv.PAPERCUSP_FLEET_BG = input.fleet.bg;
    if (input.fleet.fg) extraEnv.PAPERCUSP_FLEET_FG = input.fleet.fg;
    if (input.fleet.cursor) extraEnv.PAPERCUSP_FLEET_CURSOR = input.fleet.cursor;
    // The env above only COLORS the bee's terminal at launch (its OWN process reads
    // PAPERCUSP_FLEET_*). The JOIN can't ride env — writePresence's fold runs in the
    // operator, not the bee. WI-1893 (cluster-safe fleet stamp, mirrors bootstrap-su/
    // bootstrap-role): append the DURABLE membership fact keyed by the spawnId — the
    // old in-memory setPendingFleet placement lived in ONE :3070 cluster worker and
    // was lost when the bee's first presence write landed on ANOTHER worker
    // (node:cluster + SO_REUSEPORT), leaving the bee fleet_slug=null and invisible
    // to fleet:assignments. The mig-430 triggers apply the fact regardless of
    // fact-vs-presence-row ordering. FAIL LOUD: a spawn that would produce a fleet-
    // invisible ghost member must not proceed silently.
    const { appendFleetMembershipIfAbsent } = await import('../fleet-membership-store');
    try {
      await appendFleetMembershipIfAbsent({
        workspaceId: input.workspaceId,
        ownerId: spawnId,
        ownerLabel: null,
        fleetSlug: input.fleet.slug,
        fleetRole: input.fleet.role || 'member',
      });
    } catch (e: any) {
      throw new Error(
        `fleet membership stamp failed for spawn ${spawnId} → fleet ${input.fleet.slug}: ${e?.message ?? e} — refusing to spawn a member that would be invisible to its fleet (WI-1893)`,
      );
    }
  }

  // directed-wake-honesty-and-spawn-handoff P-021/P-012: assemble the ONE bounded
  // spawn/wake-hydration block (predecessor handoff + hive-roster snapshot +
  // work-item carry-note) and thread it via extraEnv.SPAWN_HANDOFF. invoke.ts reads
  // it and buildPrompt renders it VERBATIM in the volatile tail (`## Handoff`). This
  // is the AUTONOMOUS spawn path's call of the shared seam (the interactive launch
  // calls assembleSpawnHydration from bootstrap-role). Gated on
  // SPAWN_HANDOFF_HYDRATION (default on). FAIL-SOFT TWICE: each source degrades to
  // empty inside assembleSpawnHydration, and this outer guard means a hydration
  // failure (flag read, DB hiccup) NEVER blocks the spawn.
  try {
    if (await getFlag(FLAGS.SPAWN_HANDOFF_HYDRATION, 'system')) {
      const hydration = await assembleSpawnHydration({
        harness: slug,
        featureId: input.featureId ?? undefined,
        planSlug: input.planSlug ?? undefined,
        // The bee resumes the work-item it was dispatched on; its carry-note is
        // keyed by that id (work-item-checkpoint store).
        workItemId: input.featureId ?? input.itemId ?? undefined,
        workspaceId: input.workspaceId,
        ownerId: spawnId,
        // B2 deliver-on-spawn (P-023): role drives @role:<role> slot draining;
        // ownerId is the delivered_to. nowMs is the drain expiry cutoff.
        role,
        nowMs: Date.now(),
        deps: productionSpawnHydrationDeps(),
        log: (m) => console.log(`[operator-spawn] ${spawnId} ${m}`),
      });
      if (hydration.text) extraEnv.SPAWN_HANDOFF = hydration.text;
    }
  } catch (err) {
    // fail-soft: hydration is additive context, never a spawn blocker.
    console.warn(
      `[operator-spawn] ${spawnId}: spawn-handoff hydration failed (degraded, spawn continues): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Per-spawn model escalation: buildInvokeOnce reads this to apply `--model`/
  // `--effort` to THIS child's command (outranking AGENT_MODELS + the committed
  // default), and the child's own invoke.ts resolveModel consults it first —
  // covering the aiBackend agentCmd-swap path the command-level append can't reach.
  if (spawnModelSpec) {
    extraEnv.PAPERCUSP_SPAWN_MODEL = spawnModelSpec;
  }
  // Per-tier backend: buildInvokeOnce swaps the base command to this backend's
  // default and pins the child's AGENT_BACKEND to match.
  if (spawnModelBackend) {
    extraEnv.PAPERCUSP_SPAWN_BACKEND = spawnModelBackend;
  }
  // context-trimming-tiers P-006: the resolved tier's soft compaction limit
  // (explicit per-tier value, else the spec's model-derived default) rides the
  // spawn env; an explicit modelSpec (no tier) derives its spec's default. The
  // compliance watchdog backstops sessions this env never reaches with the
  // model-derived default.
  {
    const { defaultCompactionLimitForSpec } = await import('../agent-config-constants');
    const spawnLimit = spawnCompactionLimit ?? (spawnModelSpec ? defaultCompactionLimitForSpec(spawnModelSpec) : null);
    if (spawnLimit != null) extraEnv.PAPERCUSP_SPAWN_COMPACTION_LIMIT = String(spawnLimit);
  }

  // P-012/P-005: route spawned agents through the backend-aware gateway/account helper.
  // Claude gets Anthropic base-url + custom account/owner headers; Codex gets only the
  // provider-filtered account id consumed by its per-spawn CODEX_HOME gateway config; OMP
  // gets no account/gateway env until an OMP adapter exists.
  const gwOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
  Object.assign(extraEnv, resolvedGatewayEnv);
  // Start the stall-waker poll loop once the gateway is in play (idempotent + unref'd): it watches the
  // gateway for rate-limit sheds and wakes a stalled bee when its account recovers (P-003).
  if (gwOn) ensureStallWakerLoop(input.workspaceId);

  // capability:computer desktop lease (computer-tool-plan 2.4): if THIS hive holds a
  // leased sandbox desktop, thread its display into the bee's env so capability:computer
  // resolves the right Xvfb (never host :0). Keyed by the harness slug (== the hive home-
  // harness slug). desktopEnvForHive() returns {} when the hive has no lease → a clean
  // no-op (the tool then errors "no desktop leased" = deny-by-default). Mirrors the frame
  // path's acquireAgentDisplay→DISPLAY injection (orchestrator-runner). The lease lives in
  // THIS operator loop's in-process map, the same loop that builds this spawn.
  Object.assign(extraEnv, desktopEnvForHive(slug));

  // Register an abort handle so fleet:cancel can stop the child (EI-40).
  const abort = new AbortController();
  localSpawnAborts.set(spawnId, abort);
  ensureSpawnHeartbeatLoop();

  // Fire-and-forget: the spawn returns now; completion lands on the nursery row.
  // The row is already admitted/running here, but spawnInvokeOnce still performs
  // async prep before runChild can report the real child pid. Bound that admission
  // → child-start window so a wedged flag/gateway/hydration read cannot hold a
  // fleet slot and work-item claim forever while only the supervisor pid is stamped.
  let finalStatus: 'done' | 'failed' | 'cancelled' | null = null;
  let childStarted = false;
  let terminalRecorded = false;
  let childStartTimer: ReturnType<typeof setTimeout> | null = null;
  const workItemId = input.featureId ?? input.itemId ?? null;
  const completeSpawn = async (args: {
    status: 'done' | 'failed' | 'cancelled';
    exitCode?: number | null;
    errorMessage?: string | null;
    outputTail?: string | null;
    releaseClaim?: boolean;
  }): Promise<void> => {
    if (terminalRecorded) return;
    terminalRecorded = true;
    if (childStartTimer) {
      clearTimeout(childStartTimer);
      childStartTimer = null;
    }
    finalStatus = args.status;
    try {
      await finishSpawn(sql, {
        spawnId,
        workspaceId: input.workspaceId,
        status: args.status,
        exitCode: args.exitCode ?? null,
        errorMessage: args.errorMessage ?? null,
        outputTail: args.outputTail ?? null,
      });
      // Normal completion won the durable status race; the recovery artifact is
      // no longer needed. If finishSpawn throws, keep it for the reclaim sweep.
      //
      // WI-36237: …but ONLY on a SUCCESSFUL terminal. This unlink used to run on
      // every normal completion, which destroyed the child's full teed
      // stdout/stderr at the exact moment it became the only way to diagnose a
      // failure — the row keeps just a 2000-char tail, and for these deaths that
      // tail was a bare activity marker. It presents as "the log is never
      // written": measured 2026-08-08, the spawn-results dir held 8 files whose
      // newest was 2026-07-16, and a SUCCESSFUL 5-minute cup run that same day
      // left none either. That last case is the falsifier — absence of the file
      // is uncorrelated with failure, so it was never a write-path bug. (The 8
      // survivors are leaked orphans from non-harvest terminal paths,
      // EI-19425373640931996.) Retaining it on failed/cancelled costs one file
      // per failed spawn and is what makes the next occurrence diagnosable
      // instead of blind.
      if (args.status === 'done') removeSpawnResultArtifact(resultPath);
      if (args.releaseClaim) {
        await releaseSpawnWorkItemClaim(sql, { harness: slug, workItemId, spawnId }).catch(() => {});
      }
    } catch (err) {
      // EI-7235 (dispatch-orphan-rate regression): a durable-write failure here
      // must NOT leave this spawn's local bookkeeping dangling. The heartbeat
      // loop (ensureSpawnHeartbeatLoop) unconditionally re-heartbeats every id
      // still in localSpawnAborts, with NO per-id liveness check — so if this
      // throw skipped the cleanup below, a dead child's row would keep getting
      // a "falsely fresh" heartbeat_at forever, and reclaimOrphanedSpawns's
      // candidate query (WHERE heartbeat_at < now() - staleMs) would NEVER
      // select it: a permanent ghost holding a concurrency-ceiling slot,
      // invisible to every existing reclaim path (this file's own periodic
      // sweep and the boot-time reconcile alike). The finally block below
      // clears the local map regardless of this failure, so the heartbeat
      // stops immediately; the DB row (still 'running'/'restarting' since this
      // write failed) then goes heartbeat-stale within RECLAIM_STALE_MS and the
      // EXISTING stale-heartbeat reclaim sweep settles it on its own next tick
      // — no new mechanism needed, just don't let this catch suppress the
      // cleanup that starts that sweep's staleness clock ticking.
      console.warn(
        `[operator-spawn] ${spawnId} completeSpawn durable-write failed — local bookkeeping ` +
          `cleared anyway so the heartbeat stops (row will self-heal via the stale-heartbeat reclaim sweep):`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      localSpawnAborts.delete(spawnId);
      localSpawnOutput.delete(spawnId);
      localSpawnPids.delete(spawnId);
    }
    // The terminal flip above freed a ceiling slot — wake any over-ceiling
    // waiter sleeping on the slot key (D-004). Best-effort, off the hot path.
    void announceSpawnSlotFreed(input.workspaceId, `spawn ${spawnId} finished — ceiling slot freed`);
    // EI-108: Wake parent on child death (if the spawn has a parent)
    void wakeParentOnChildDeath(sql, spawnId, input.workspaceId, args.status).catch(() => {
      /* best-effort — logged inside wakeParentOnChildDeath */
    });
  };

  childStartTimer = setTimeout(() => {
    if (childStarted || terminalRecorded) return;
    const timeoutMs = spawnChildStartTimeoutMs();
    abort.abort();
    void completeSpawn({
      status: 'failed',
      errorMessage: `spawn launch timed out before child process start after ${timeoutMs}ms`,
      releaseClaim: true,
    }).catch(() => {
      /* PG down — nothing left to record to */
    });
  }, spawnChildStartTimeoutMs());
  childStartTimer.unref?.();

  // WI-344 ③: route through the spawner-sidecar front door — when
  // PAPERCUSP_SPAWNER_SIDECAR=1 (bg-host only) the child_process.spawn + buildInvokeOnce
  // run in the sidecar process, OFF this main loop; env unset ⇒ in-process, byte-identical.
  void spawnInvokeOnceWithFallback(project.path, role, extras, extraEnv, {
    signal: abort.signal,
    forceSessionId,
    resultPath,
    taskSpawnId: spawnId,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    // EI-85: record the child OS pid + this host so the reclaim sweep can
    // /proc-liveness-check the process instead of mislabeling a stale-heartbeat
    // row (host briefly paused) as a dead child. Best-effort — a missed write
    // just degrades to the heartbeat-stale reclaim.
    onChildPid: (pid) => {
      childStarted = true;
      if (childStartTimer) {
        clearTimeout(childStartTimer);
        childStartTimer = null;
      }
      // EI-493: track the child pid locally too (not just durably) so the
      // heartbeat loop can /proc-liveness-check it every tick without a DB
      // round trip — see partitionHeartbeatCandidatesByLiveness.
      localSpawnPids.set(spawnId, pid);
      void recordSpawnPid(getOrgPg().sql, spawnId, pid).catch(() => {});
    },
    // P-008: per-chunk stream signal, persisted by the heartbeat tick.
    onOutputActivity: () => noteSpawnOutput(spawnId),
  })
    .then(async (r) => {
      finalStatus = abort.signal.aborted ? 'cancelled' : r.exitCode === 0 ? 'done' : 'failed';
      // WI-222: post-bee-exit work-item completion safety net. A bee placed on a
      // feature that claimed it (→ in_progress), implemented + committed, and exited
      // rc=0 WITHOUT landing work_items:complete leaves the feature non-terminal — the
      // placement-watchdog then re-places the dead-holder/non-terminal unit until the
      // cursed breaker trips. The DBOS pipeline closes this loop on its terminal DONE
      // (reconcileDoneStatus), but that path never runs for hive members, so settle it
      // here with the SAME conservative guard (in_progress/validating → passed only;
      // never force-pass todo/failing/deprecated). The predicate no-ops every non-bee /
      // crashed / cancelled / featureless exit; the call is best-effort (never throws).
      await maybeReconcileBeeCompletion(
        {
          role,
          exitCode: r.exitCode,
          aborted: abort.signal.aborted,
          featureId: input.featureId,
          harnessSlug: slug,
          workspaceId: input.workspaceId,
        },
        { log: (m) => console.log(`[operator-spawn] ${spawnId} ${m}`) },
      );
      // EI-361: a timeout kill (SIGTERM at the invoke-timeout budget) almost always
      // produces EMPTY stderr — the child is just killed, it never gets a chance to
      // write anything — so falling back to `(r.stderr || '') || null` recorded exit
      // 143 with error_message NULL, indistinguishable from an unexplained crash. `r`
      // already carries `timedOut` (set by runChild's timer in orchestrator-runner.ts);
      // surface it explicitly with the actual budget that was exceeded, so the nursery
      // row self-explains instead of requiring a "was it exactly N seconds" forensic.
      const effectiveTimeoutMs = input.timeoutMs ?? invokeTimeoutMs();
      // WI-36237: STRIP the outer activity-heartbeat marker before persisting.
      // invoke.ts echoes `[papercusp:activity]` to the outer process's stderr
      // purely to keep last_output_at fresh (WI-3302); it carries no diagnostic
      // content. Persisting it raw did two kinds of damage, both measured
      // 2026-08-08 on live cup rows:
      //   - a SUCCESSFUL spawn (s-1786223325613, exit 0, 303s) carried 14 marker
      //     lines in error_message — an error field populated on a clean run;
      //   - a FAILED spawn carried error_message = "[papercusp:activity]\n"
      //     EXACTLY, i.e. a row that looks like it has a diagnostic and has none.
      // The latter is the expensive one: the capacity_shed fingerprint keys on
      // `stderr === ''` (invoke-outcome.ts:227), so marker-only noise makes a
      // genuinely-silent death read as non-silent. The CLASSIFY path already
      // strips (invoke-outcome.ts:226); this PERSIST path did not — same input,
      // two answers. After the strip a truly-silent death persists as NULL,
      // which is what "no diagnostic" is supposed to look like.
      const childStderr = stripActivityHeartbeat(r.stderr || '');
      const errorMessage = r.timedOut
        ? `invoke timeout after ${effectiveTimeoutMs}ms (${Math.round(effectiveTimeoutMs / 1000)}s) — SIGTERM'd (EI-361)` +
          (childStderr ? `; termination detail: ${childStderr.slice(-1200)}` : '')
        : childStderr.slice(-2000) || null;
      return completeSpawn({
        status: finalStatus,
        exitCode: r.exitCode,
        errorMessage,
        outputTail: (r.output || r.rawStdoutTail || '').slice(-2000) || null,
      });
    })
    .catch((err) => {
      finalStatus = abort.signal.aborted ? 'cancelled' : 'failed';
      return completeSpawn({
        status: finalStatus,
        errorMessage: err instanceof Error ? err.message : String(err),
        releaseClaim: !childStarted,
      }).catch(() => {
        /* PG down — nothing left to record to */
      });
    })
    .finally(() => {
      if (childStartTimer && terminalRecorded) {
        clearTimeout(childStartTimer);
        childStartTimer = null;
      }
    });

  return { ok: true, spawnId, harness: slug, projectDir: project.path, error: null };
}
