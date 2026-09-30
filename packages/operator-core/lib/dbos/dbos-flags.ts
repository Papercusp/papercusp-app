/**
 * Pure predicates for the DBOS default-on gates (P-009 + the timers migration).
 * Centralized so the bootstrap registration and the legacy stand-down checks
 * (periodic timers) use the EXACT same condition — guaranteeing exactly one of
 * {DBOS, legacy} runs for the pieces that still HAVE a legacy path (no gap, no
 * double-fire).
 *
 * Master switch: PAPERCUSP_DBOS_ORCHESTRATOR=0 turns the whole DBOS orchestration
 * substrate off (durable orchestrator + routines engine + periodic timers). The
 * legacy orchestrator run-loop and the director-cadence autoloop ticker are
 * RETIRED (0 importers — see _retired/orchestrator-run-loop), so =0 does NOT
 * bring a legacy orchestrator back; those paths simply don't run. Periodic
 * timers can still be disabled individually with PAPERCUSP_DBOS_TIMERS=0, and a
 * few timer pieces (push-cred refresher, harness-status sweep) retain a legacy
 * fallback that stands down on that predicate.
 */
import { utilityHostEnabled } from '../background-workers';

type DbosEnv = Record<string, string | undefined>;

/** The DBOS durable orchestrator is the default (on unless explicitly =0). */
export function dbosOrchestratorActive(env: DbosEnv = process.env): boolean {
  return env.PAPERCUSP_DBOS_ORCHESTRATOR !== '0';
}

// dbosAutoloopActive is GONE (autoloop-pot-operator-rebuild P-010 / D-009): the
// director-cadence autoloop (legacy ticker + its DBOS twin) is retired — the
// routines engine (blueprint triggers.schedule → system:blueprint-run) is the
// scheduled-fire loop, gated by dbosRoutinesActive below.

/** The DBOS periodic timers (telemetry flush, GC, embed backfill, backup cadence,
 *  …) are on by default with the orchestrator; disable with PAPERCUSP_DBOS_TIMERS=0.
 *
 *  Also requires DBOS itself to be LAUNCHED (PAPERCUSP_DBOS_ENABLE=1 — the
 *  host-bootstrap launch gate, default OFF). The legacy fallbacks (push-cred
 *  refresher, harness-status sweep) stand down on this predicate, so without
 *  the ENABLE check a non-DBOS host reported timers "active" for a DBOS that
 *  never started — BOTH sides off, violating the no-gap guarantee above.
 *  (Found on staging :3170, which sets PAPERCUSP_DBOS_ENABLE=0: push
 *  credentials were never minted, so server-originated FCM pushes silently
 *  skipped — mobile-apps-revival D-004 close-out.) */
export function dbosTimersActive(env: DbosEnv = process.env): boolean {
  return (
    env.PAPERCUSP_DBOS_ENABLE === '1' &&
    dbosOrchestratorActive(env) &&
    env.PAPERCUSP_DBOS_TIMERS !== '0'
  );
}

/**
 * Whether THIS host should REGISTER the periodic timers (backup cadence,
 * orphan-cleanup, GC sweeps, embed-backfill, …). The registration gate, distinct
 * from `dbosTimersActive` — which is left intact because it ALSO drives the
 * legacy-fallback stand-down (push-cred refresher, harness-status sweep) and must
 * not shift for non-utility hosts.
 *
 * EI-596: a headless UTILITY host (the gym-operator) launches DBOS + the
 * orchestrator/routines it needs for its own pipelines, but must NOT run these
 * shared-DB periodic drains — they're irrelevant to a short-lived dedicated
 * instance and error against its throwaway gym DB (backupHost has no config
 * there), spamming the boot log every cadence. `utilityHostEnabled()` is the
 * existing seam for exactly this "needs DBOS, not the shared-DB drains"
 * distinction (see background-workers.ts).
 */
export function dbosPeriodicTimersActive(env: DbosEnv = process.env): boolean {
  return dbosTimersActive(env) && !utilityHostEnabled(env);
}

/**
 * The DBOS provision/runner workflow (plan dbos-durable-flows-adoption, P-001/P-002).
 * Now **default-on** (like the orchestrator/autoloop/timers) — disable with
 * PAPERCUSP_DBOS_PROVISION=0. Still gated by the master orchestrator switch
 * (PAPERCUSP_DBOS_ORCHESTRATOR=0 also turns it off). DBOS's deduplicationID is the
 * cross-request mutex and DBOS recovery is the liveness. The hand-rolled
 * operator-claims advisory lock + 30s heartbeat in `provision/runner` were DELETED
 * in P-002 (no shim) once DBOS provisioning was live crash-resume-verified — so
 * this flag now only selects workflow-vs-direct dispatch, NOT a legacy claim path.
 */
export function dbosProvisionActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_PROVISION !== '0';
}

/**
 * The DBOS backup-snapshot durability seam (plan dbos-durable-flows-adoption,
 * P-011 / D-010). A fresh capability, so **opt-in** for now (enable with
 * PAPERCUSP_DBOS_BACKUP=1) — mirroring how provision started before its
 * live-verified flip to default-on (P-002 part 1). Still gated by the master
 * orchestrator switch so the full-legacy revert (PAPERCUSP_DBOS_ORCHESTRATOR=0)
 * also turns it off. When active, the manual `backup:snapshot_create` op routes
 * through the `backupSnapshot` DBOS workflow and the lib's `snapshot()` steps run
 * as durable checkpoints (a crash mid-snapshot resumes from the last step); when
 * off, `snapshot()` is called directly and the injected StepRunner is a no-op
 * pass-through — identical to today.
 */
export function dbosBackupActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_BACKUP === '1';
}

/**
 * The generic DBOS routines engine (git-sync-auto-commit Phase 1 / D-001) — the
 * durable `routinesTick` that drives `harness_shared.routines`, replacing the
 * dormant in-process `routine-ticker` loop. A fresh capability, so **opt-in**
 * (enable with PAPERCUSP_DBOS_ROUTINES=1) until it's live-verified — mirroring how
 * provision + backup started opt-in before their default-on flip. Still gated by
 * the master orchestrator switch (PAPERCUSP_DBOS_ORCHESTRATOR=0 also turns it off).
 * Opt-in is also the safe default: a host restart won't auto-fire stale/unknown
 * routines (e.g. the dormant git-sync routine seeded inactive) unsupervised.
 *
 * Registration boundary: this predicate selects the routines workflow only after
 * DBOS has been launched. `host-bootstrap.ts` separately requires
 * `backgroundWorkersEnabled()` and `PAPERCUSP_DBOS_ENABLE=1` before calling
 * `startDbos()`. Do not infer that a process claims routines from this flag alone;
 * request-only hosts can carry `PAPERCUSP_DBOS_ROUTINES=1` without registering a
 * routines executor.
 */
export function dbosRoutinesActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_ROUTINES === '1';
}

/**
 * The curator-operator curation loop (plan curator-operator-2026-06-04, P0) — the
 * scheduled `curationTick` that consumes the fleet's structured status, applies
 * the salience policy, and surfaces curated messages into the operator chat. A
 * fresh capability that writes into the user's conversation, so **opt-in**
 * (enable with PAPERCUSP_DBOS_CURATION=1) until live-verified — mirroring how
 * backup/routines started opt-in before any default-on flip. Still gated by the
 * master orchestrator switch (PAPERCUSP_DBOS_ORCHESTRATOR=0 also turns it off).
 * Opt-in is also the safe default on a shared dev box: a host restart won't
 * auto-arm a loop that injects messages into the operator conversation.
 */
export function dbosCurationActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_CURATION === '1';
}

/**
 * Durable event-reactions (plan event-reaction-system-2026-06-04, P1 / D-004). A
 * matched reaction runs as a DBOS-queued workflow — survives a restart, retried,
 * idempotent via a dedup id (migration 153) — instead of the default in-process
 * fire-and-forget. A fresh capability, so **opt-in** (enable with
 * PAPERCUSP_DBOS_REACTIONS=1) until live-verified — mirroring how
 * backup/routines/curation started opt-in. Still gated by the master orchestrator
 * switch (PAPERCUSP_DBOS_ORCHESTRATOR=0 also turns it off). Opt-in is the safe
 * default on a shared dev box: a host restart keeps reactions on the in-process
 * path (which works today) until the durable path is deliberately armed; and the
 * engine falls back to in-process if an enqueue ever fails, so a reaction is never
 * dropped either way.
 */
export function dbosReactionsActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_REACTIONS === '1';
}

/**
 * The plan-markdown auto-render projection (plan-markdown-auto-render-2026-06-06)
 * — a scheduled `planMarkdownRender` workflow that mirrors PG-canonical plans to
 * on-disk markdown under `apps/operator/docs/plans/` (incremental, coalesced,
 * settle-guarded). A fresh capability that WRITES into the tracked tree (git-sync
 * then commits the mirror), so **opt-in** (enable with PAPERCUSP_DBOS_PLAN_RENDER=1)
 * until an owner arms it — mirroring how routines/curation/reactions started
 * opt-in. Still gated by the master orchestrator switch (PAPERCUSP_DBOS_ORCHESTRATOR=0
 * also turns it off). Opt-in is the safe default on a shared box: a host restart
 * won't suddenly start committing ~260 plan files + ongoing churn unsupervised.
 */
export function dbosPlanRenderActive(env: DbosEnv = process.env): boolean {
  return dbosOrchestratorActive(env) && env.PAPERCUSP_DBOS_PLAN_RENDER === '1';
}
