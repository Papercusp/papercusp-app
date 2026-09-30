/**
 * Recurrence guard for active routines (EI-2224 recurrence guard P-2).
 *
 * Validates that no ACTIVE routine targets an unregistered harness. This catches drift where:
 *  - The harness registry gets cleared/rebuilt
 *  - Fire-paths still reference old harness slugs
 *  - A host restart introduces a slug mismatch
 *
 * When violations are found, logs a FATAL error so it surfaces in monitoring.
 * A production deployment would page on this error class.
 *
 * Called by: the boot sequence (apps/operator/bin/host-bootstrap.ts), beside its two sibling
 * guards — validateHomeHarnessResolution (does the HOME slug resolve?) and
 * validateDeclaredSingletons (do the routines we DECLARED exist at all?).
 *
 * There is NO periodic caller, deliberately. Every drift case above lands at boot or at a
 * registry rebuild, and a resolveProject() per active routine every 30-60s is a real cost for
 * a failure that cannot appear between two ticks. A prior version of this comment claimed a
 * health-check loop called it every 30-60s AND that boot called it. BOTH WERE FALSE — it had
 * ZERO callers for its entire life (EI-10660), and the docstring is what kept anyone from
 * noticing: it retired the very suspicion that would have found the gap. Do not describe a
 * caller here that you have not grepped for.
 *
 * EI-18678269428596559 (recurrence guard P-3): the boot caller now calls `enforceActiveRoutines`
 * (below), not this function directly — a violation gets auto-PAUSED, not just logged FATAL on
 * every boot forever. `validateActiveRoutines` itself stays pure-read (unchanged contract, its
 * own tests) so any other read-only caller is unaffected.
 */

import { getOrgPg } from '@papercusp/db-org';
import { backgroundWorkersEnabled } from '../background-workers';
import { resolveProject } from '../harness-core';
import { isReservedHarnesslessRoutineHost } from '../harness/routines/routine-host';
import { activeWorkspaceId } from '../workspace-registry';
import {
  EMPTY_INSTALL_SLUG,
  episodeSeverity,
  nextEpisodeMark,
  parseEpisodeMark,
  renderRecurrence,
  summarizeEpisode,
  type EpisodeMark,
  type RoutineValidationFatalClass,
} from './routine-validation-episode';

export interface RoutineValidationResult {
  ok: boolean;
  activeRoutineCount: number;
  /**
   * Names of every ACTIVE routine this scan found, as `"<name>@<install_slug>"` (WI-5704).
   * The bare `activeRoutineCount` alone can't say WHICH routines are active — during the
   * WI-5672 live-fed-gate triage that made it impossible to tell, without a live psql tap
   * before rig teardown, whether joiner frame B (1 active routine vs owner A's 5) was even
   * missing the hive-member-rekey/epoch-key-reconcile routine. This makes the startup log
   * self-sufficient evidence.
   */
  activeRoutineNames: string[];
  unregisteredHarnesses: Set<string>;
  problematicRoutines: Array<{ installSlug: string; routineName: string; workspaceId: string }>;
  /**
   * ACTIVE `system:<action>` routines with NO registered handler (EI-19367772473246483).
   * Their fire path reaches `getSystemAction(action)`, finds nothing, logs
   * `no handler registered … skipping` and does nothing — every tick, forever — while this
   * validator reported "startup validation passed — N active routine(s) resolve" and NAMED
   * the dead routine in that list, because it only ever checked that `install_slug` resolves.
   *
   * Deliberately a SEPARATE bucket from `problematicRoutines`: that one is auto-PAUSED by
   * `enforceActiveRoutines`, which is the wrong remedy here. The row is correct; the missing
   * piece is a side-effect `import './<name>-action'` in `register-system-actions.ts`. Pausing
   * would destroy the evidence and silently drop the routine — turning a loud, fixable bug
   * into the exact invisible no-op this field exists to expose.
   */
  unregisteredSystemActions: Array<{
    installSlug: string;
    routineName: string;
    action: string;
    workspaceId: string;
  }>;
  /**
   * Whether the unregistered-handler check ACTUALLY RAN on this host (WI-39810). It is
   * skipped on a host that does not execute routines — see `hostExecutesRoutines`. Callers
   * MUST distinguish this from "ran and found none": both leave `unregisteredSystemActions`
   * empty, but only the latter is evidence that the routines are healthy. Clearing a
   * persisted mark on a skip would delete a TRUE finding written by the host that does run
   * them.
   */
  systemActionCheckApplicable: boolean;
  /**
   * Registered `standing` system actions with NO `harness_shared.routines` row at all in
   * this workspace (EI-18752496371939475) — the THIRD direction of the handler/registration
   * cross-check, and the mirror image of `unregisteredSystemActions` above.
   *
   * There are three independent ways a scheduled routine can be dead:
   *   1. row ACTIVE, no registered handler  → `unregisteredSystemActions` (above).
   *   2. handler defined, never registered  → `automation/routine-classification.registry.test.ts`.
   *   3. handler registered, NO ROW EXISTS  → THIS field. It never fires, and because the
   *      code is green and its tests pass, nothing in the tree could see it.
   *
   * That is not hypothetical: `gc-dead-loops` shipped fully built and unit+integration
   * tested, its handler correctly imported, and sat dead because the seed script that
   * creates its row was never run — while the leak it existed to stop kept leaking.
   *
   * NOT the same check as `harness/routines/bespoke-active-seeds-check.ts`, and neither
   * subsumes the other — they ask different questions over different populations:
   *   - that one asks "is this SEEDED routine ACTIVE as intended?" over the seed scripts
   *     whose writer defaults `active=true`, and owns the pause/reviewBy/escalation logic;
   *   - this one asks "does a row EXIST at all?" over the REGISTRY. It is the only one that
   *     can see an action with no seed script, or one whose seed script makes `--active`
   *     opt-in (both real: `doc-anchor-reconcile`, `test-webview-reaper`).
   * Deliberately EXISTENCE-only: an existing row that is merely inactive is a different
   * condition with a different remedy, and is also what `enforceActiveRoutines` produces
   * when it auto-pauses — flagging that here would make the two guards fight.
   */
  unscheduledSystemActions: string[];
  /**
   * Whether the unscheduled check ACTUALLY RAN on this host — same three-case discipline as
   * `systemActionCheckApplicable` (WI-39810). Empty + applicable means "no offenders"; empty
   * + NOT applicable means "we did not look", and a caller must never read the second as the
   * first.
   */
  unscheduledCheckApplicable: boolean;
}

/**
 * Does THIS process execute routines — i.e. is its system-action registry the one whose
 * contents decide whether a routine's handler resolves at fire time? (WI-39810)
 *
 * The unregistered-handler check below asks "is this routine's handler registered?", but that
 * question is only answerable by the host that DISPATCHES it. `routinesTick` +
 * `ephemeral-executor` run only under `PAPERCUSP_BACKGROUND_WORKERS=1` (bg-host); the operator
 * API hosts boot request-only and never execute a routine, so their registry says nothing
 * about liveness.
 *
 * Measured 2026-08-18 (WI-39810), the concrete failure this prevents: `papercup-dev-api` runs
 * request-only (`PAPERCUSP_BACKGROUND_WORKERS=0`) out of the RELEASE checkout, which lagged
 * `staging` by four `import './<x>-action'` lines because `main` was frozen behind a red gate.
 * Its startup validator therefore reported `consult-expiry-sweep`, `coverage-census`,
 * `idle-backend-reaper` and `project-history-refresh` as having NO REGISTERED HANDLER — while
 * bg-host, running the same routines out of `staging`, was executing all four on cadence
 * (`[idle-backend-reaper] scanned 1` every 2m; `[coverage-census] … upserted 1105`). The
 * marks accumulated to 210+ "occurrences", `routines:list` rendered them as SILENTLY DEAD,
 * and the remedy it named — add the import — was already present in the tree being edited.
 *
 * So the two trees drifting is NOT the bug to fix here (that is normal: the release checkout
 * legitimately lags staging). The bug is a host answering a question it cannot see the
 * answer to.
 *
 * `backgroundWorkersEnabled` short-circuits to `false` under VITEST so unit tests never start
 * real background work. That clause is about STARTING work, not about the host-TOPOLOGY
 * question asked here, and honouring it would silently disable this check throughout its own
 * test suite — a vacuous green. Strip it, and delegate the rest so there is one source of
 * truth for the topology.
 */
export function hostExecutesRoutines(env: NodeJS.ProcessEnv = process.env): boolean {
  const { VITEST: _vitest, ...topology } = env;
  return backgroundWorkersEnabled(topology as NodeJS.ProcessEnv);
}

/**
 * Scan all ACTIVE routines and verify every harness-owned install_slug resolves to a registered
 * project. Reserved synthetic/workspace hosts are intentionally harness-less and follow their
 * system-action fire paths instead.
 * Returns violations in `problematicRoutines` array.
 *
 * This is PURE-read and non-blocking: it reports what's wrong, never modifies state.
 * Callers decide whether to log/escalate based on severity.
 *
 * `opts.silent` suppresses the FATAL console.error even when violations are found — for
 * `enforceActiveRoutines()` below, which does its OWN, more specific logging once it knows
 * what it could/couldn't auto-heal. Every existing caller/test omits `opts`, so default
 * behavior (log FATAL on violation) is unchanged.
 */
export async function validateActiveRoutines(
  workspaceId?: string,
  opts?: { silent?: boolean },
): Promise<RoutineValidationResult> {
  const ws = workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();

  // Read all active routines in this workspace. `target_role` + the two loop-fire columns
  // are needed by the unregistered-system-action check below, which must mirror the fire
  // path's dispatch precedence exactly (see `findUnregisteredSystemActions`).
  const activeRoutines = await sql`
    SELECT DISTINCT install_slug, name, workspace_id, target_role,
                    reschedule_interval_sec, target_owner_id
    FROM harness_shared.routines
    WHERE active = true AND workspace_id = ${ws}
    ORDER BY install_slug, name
  `;

  const unregisteredHarnesses = new Set<string>();
  const problematicRoutines: Array<{ installSlug: string; routineName: string; workspaceId: string }> = [];
  const activeRoutineNames: string[] = [];

  // Validate each routine's harness resolves
  for (const routine of activeRoutines) {
    const slug = (routine as any).install_slug;
    const name = (routine as any).name;
    const routineWs = (routine as any).workspace_id;

    activeRoutineNames.push(`${name || '<unnamed>'}@${slug || '<empty>'}`);

    if (!slug || !slug.trim()) {
      // Empty slug is a data integrity error, not a registration error
      problematicRoutines.push({ installSlug: slug || '<empty>', routineName: name, workspaceId: routineWs });
      unregisteredHarnesses.add(slug || '<empty>');
      continue;
    }

    if (isReservedHarnesslessRoutineHost(slug, routineWs)) continue;

    const proj = await resolveProject(slug, routineWs);
    if (!proj) {
      unregisteredHarnesses.add(slug);
      problematicRoutines.push({ installSlug: slug, routineName: name, workspaceId: routineWs });
    }
  }

  const { applicable: systemActionCheckApplicable, missing: unregisteredSystemActions } =
    await findUnregisteredSystemActions(activeRoutines);

  const { applicable: unscheduledCheckApplicable, unscheduled: unscheduledSystemActions } =
    await findUnscheduledSystemActions(ws);

  const ok =
    problematicRoutines.length === 0 &&
    unregisteredSystemActions.length === 0 &&
    unscheduledSystemActions.length === 0;

  if (unregisteredSystemActions.length > 0 && !opts?.silent) {
    console.error(formatUnregisteredSystemActions(unregisteredSystemActions));
  }

  if (unscheduledSystemActions.length > 0 && !opts?.silent) {
    console.error(formatUnscheduledSystemActions(unscheduledSystemActions));
  }

  if (problematicRoutines.length > 0 && !opts?.silent) {
    // Log a FATAL error so it surfaces in monitoring + pages ops
    console.error(
      `[routine-validation] FATAL: ${problematicRoutines.length} active routine(s) target ` +
      `unregistered harness(es): ${Array.from(unregisteredHarnesses).join(', ')}. ` +
      `Their fire paths may go dark or act on orphaned state. Details: ` +
      JSON.stringify(problematicRoutines),
    );
  }

  return {
    ok,
    activeRoutineCount: activeRoutines.length,
    activeRoutineNames,
    unregisteredHarnesses,
    problematicRoutines,
    unregisteredSystemActions,
    systemActionCheckApplicable,
    unscheduledSystemActions,
    unscheduledCheckApplicable,
  };
}

/**
 * Direction 3 (EI-18752496371939475): registered `standing` actions with NO routine row.
 *
 * Reads the LIVE registry, never a grep for `registerSystemAction(` — a grep also matches
 * handlers registered inside test files (the `dogfood-*` fixtures in
 * `dbos/ephemeral-cadence-dogfood.integration.test.ts`), which are not production actions and
 * would be permanent false positives that teach everyone to ignore this report.
 *
 * The row query is deliberately UNFILTERED by `active`: this asks whether a row EXISTS, not
 * whether it is enabled. An inactive row is a different condition with a different remedy, and
 * is exactly what `enforceActiveRoutines` writes when it auto-pauses — treating that as
 * "unscheduled" would make this guard fight its own sibling in a loop.
 */
async function findUnscheduledSystemActions(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ applicable: boolean; unscheduled: string[] }> {
  // Same WI-39810 rule as the unregistered-handler check: a host that does not dispatch
  // routines is reading a different process's registry, so it may neither raise nor clear.
  if (!hostExecutesRoutines(env)) {
    return { applicable: false, unscheduled: [] };
  }

  let standing: string[];
  try {
    // Side-effect import populates the registry; idempotent and module-cached.
    await import('../harness/routines/register-system-actions');
    const { listStandingSystemActions } = await import('../harness/routines/system-actions');
    standing = listStandingSystemActions();
  } catch (e) {
    console.warn(
      '[routine-validation] system-action registry import failed — skipping the ' +
        `unscheduled-action check (reporting none): ${e instanceof Error ? e.message : e}`,
    );
    return { applicable: false, unscheduled: [] };
  }

  // An EMPTY registry is not evidence that nothing is registered — it is evidence that the
  // import did not populate it (a module-record split, a partially-mocked module). Reporting
  // every action as unscheduled off an empty registry would be a spectacular false positive,
  // so treat it as "did not look" instead.
  if (standing.length === 0) {
    return { applicable: false, unscheduled: [] };
  }

  let rows: readonly unknown[];
  try {
    const { sql } = getOrgPg();
    rows = await sql`
      SELECT DISTINCT target_role
      FROM harness_shared.routines
      WHERE workspace_id = ${workspaceId} AND target_role LIKE 'system:%'
    `;
  } catch (e) {
    console.warn(
      '[routine-validation] could not read routine target_roles — skipping the ' +
        `unscheduled-action check (reporting none): ${e instanceof Error ? e.message : e}`,
    );
    return { applicable: false, unscheduled: [] };
  }

  const SYSTEM_PREFIX = 'system:';
  const scheduled = new Set<string>();
  for (const raw of rows) {
    const targetRole = (raw as { target_role?: string | null }).target_role ?? '';
    if (targetRole.startsWith(SYSTEM_PREFIX)) {
      scheduled.add(targetRole.slice(SYSTEM_PREFIX.length));
    }
  }

  return { applicable: true, unscheduled: standing.filter((a) => !scheduled.has(a)).sort() };
}

function formatUnscheduledSystemActions(
  unscheduled: readonly string[],
  severity: 'fatal' | 'chronic' = 'fatal',
): string {
  return (
    `[routine-validation] ${severity === 'fatal' ? 'FATAL' : 'CHRONIC'}: ${unscheduled.length} ` +
    `registered system action(s) have NO routine row in this workspace, so they have never ` +
    `fired and never will: ${unscheduled.join(', ')}. Each is built, imported and green — and ` +
    `dead. Fix by running that action's seed script (usually ` +
    `packages/operator-core/lib/harness/routines/seed-<action>-routine.ts, most of which need ` +
    `an explicit --active), or, if the row is meant to be materialized per object at runtime ` +
    `rather than seeded, declare it at its registerSystemAction() call as ` +
    `{ scheduling: 'on-demand' }. See EI-18752496371939475.`
  );
}

/**
 * Which ACTIVE routines would hit `no handler registered … skipping` on their next fire
 * (EI-19367772473246483).
 *
 * MIRRORS THE FIRE PATH'S DISPATCH PRECEDENCE, and must keep doing so — this is the whole
 * correctness argument. `routines-workflow.ts` dispatches:
 *
 *   if (rescheduleIntervalSec != null && targetOwnerId)  -> fireLoopWake(), handled INLINE
 *   else if (targetRole.startsWith('system:'))           -> getSystemAction() registry lookup
 *
 * So an engine loop (`loop-su-<uuid>`, `target_role = 'system:loop-wake'`) never reaches the
 * registry and correctly has no handler registered for it. Checking `system:%` alone would
 * flag every one of them: measured on this workspace, 36 of 155 active `system:%` routines are
 * inline loop fires, so the naive form would have reported 36 false positives — against a
 * guard whose sibling auto-PAUSES what it flags. Verified against live data: with the loop
 * exemption, an EMPTY registry flags 119 routines and 0 of the 36 loop rows.
 *
 * Fail-soft: the registry is populated by a side-effect import of ~100 action modules. If that
 * import throws, we report NO violations rather than guess — a false "handler missing" here is
 * far more damaging than a missed one, since it is the signal a human acts on.
 */
async function findUnregisteredSystemActions(
  activeRoutines: readonly unknown[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  applicable: boolean;
  missing: Array<{ installSlug: string; routineName: string; action: string; workspaceId: string }>;
}> {
  // WI-39810: a host that does not DISPATCH routines cannot answer whether their handlers
  // resolve — its registry is a different process's. Report nothing AND say we did not look,
  // so the caller neither raises nor clears on this host's behalf.
  if (!hostExecutesRoutines(env)) {
    return { applicable: false, missing: [] };
  }

  let getSystemAction: (name: string) => unknown;
  try {
    // Side-effect import: populates the registry. The boot sequence does NOT otherwise import
    // it (only `dbos/routines-workflow.ts` does), so without this the check would see an empty
    // registry and flag everything. Idempotent + module-cached, so a repeat call is free.
    await import('../harness/routines/register-system-actions');
    ({ getSystemAction } = await import('../harness/routines/system-actions'));
  } catch (e) {
    console.warn(
      '[routine-validation] system-action registry import failed — skipping the ' +
        `unregistered-handler check (reporting none): ${e instanceof Error ? e.message : e}`,
    );
    return { applicable: false, missing: [] };
  }

  const SYSTEM_PREFIX = 'system:';
  const missing: Array<{ installSlug: string; routineName: string; action: string; workspaceId: string }> = [];
  for (const raw of activeRoutines) {
    const r = raw as {
      install_slug?: string;
      name?: string;
      workspace_id?: string;
      target_role?: string | null;
      reschedule_interval_sec?: number | null;
      target_owner_id?: string | null;
    };
    const targetRole = r.target_role ?? '';
    if (!targetRole.startsWith(SYSTEM_PREFIX)) continue;
    // Inline loop fire — takes precedence over system dispatch, needs no registered handler.
    if (r.reschedule_interval_sec != null && r.target_owner_id) continue;

    const action = targetRole.slice(SYSTEM_PREFIX.length);
    if (getSystemAction(action)) continue;
    missing.push({
      installSlug: r.install_slug || '<empty>',
      routineName: r.name || '<unnamed>',
      action,
      workspaceId: r.workspace_id || '<empty>',
    });
  }
  return { applicable: true, missing };
}

/** The operator-facing message for a dead system-action routine — names the exact one-line fix. */
function formatUnregisteredSystemActions(
  missing: ReadonlyArray<{ installSlug: string; routineName: string; action: string }>,
  severity: 'fatal' | 'chronic' = 'fatal',
): string {
  const names = [...new Set(missing.map((m) => m.action))];
  return (
    `[routine-validation] ${severity === 'fatal' ? 'FATAL' : 'CHRONIC'}: ${missing.length} ACTIVE routine(s) target a system action with ` +
    `NO REGISTERED HANDLER: ${names.map((n) => `system:${n}`).join(', ')}. Each fire logs ` +
    `"no handler registered … skipping" and does NOTHING — the routine is silently dead, at its ` +
    `full cadence, indefinitely. Almost always a missing side-effect import in ` +
    `packages/operator-core/lib/harness/routines/register-system-actions.ts — add ` +
    `${names.map((n) => `import './${n}-action';`).join(' ')} (verify the filename). NOT ` +
    `auto-paused: the routine row is correct, the code is what is missing. ` +
    `Details: ${JSON.stringify(missing)}`
  );
}

export interface EnforceActiveRoutinesResult extends RoutineValidationResult {
  /** Routines THIS call actually flipped to active=false (won any concurrent race, see below). */
  autoDeactivated: Array<{ installSlug: string; routineName: string }>;
}

/**
 * `validateActiveRoutines()` + ENFORCEMENT (EI-18678269428596559 recurrence guard P-3): an
 * active routine whose install_slug no longer resolves gets PAUSED (active=false), not just
 * narrated forever. The validator alone was a detector with no fixer — "may go dark or act
 * on orphaned state" logged FATAL on every boot for as long as the harness stayed deleted,
 * changing nothing, which is a detector failure as much as a data failure (a live incident:
 * an unregistered harness's own `git-sync` and `green-checkpoint` singleton copies kept
 * FIRING against orphaned state for hours before this existed).
 *
 * There is deliberately no single "delete a harness" code path this hooks into — the routine
 * table has no hard FK to the harness registry (same cross-machine-tolerant design as
 * `hive-settings-store.ts`), and in practice harnesses have gone orphaned via ad-hoc/manual
 * registry edits, not one audited deletion function. Running this at every boot (in place of
 * the bare validator) IS the cascade: whatever mechanism orphaned the harness, the very next
 * boot pauses its dangling routines instead of re-detecting the same drift forever.
 *
 * Concurrency (the "~15 identical FATAL lines in the same second, one per operator worker
 * process" duplicate-emission complaint): every worker boots independently and calls this
 * independently — there is no shared coordinator. Rather than add a distributed lock, the
 * `UPDATE … WHERE active = true` predicate is what naturally serializes them: under READ
 * COMMITTED, whichever process commits first wins; every later process re-evaluates the
 * predicate against the now-updated row and affects 0 rows, so only the winner logs
 * anything. And because the base query only ever selects `active = true` rows, once a row
 * is paused, NO future boot (by any process) re-selects it at all — the FATAL simply stops
 * recurring instead of needing to be silenced.
 *
 * A blank/empty install_slug is never auto-healed — that is a data-integrity bug in the row
 * itself (not "a harness got deleted", the drift class this guard targets), so it keeps
 * logging FATAL every time until a human fixes the row directly.
 */
/**
 * The auto-deactivate UPDATE, extracted behind a `sql` seam for ONE reason: so the
 * recurrence guard can PREPARE the PRODUCTION statement against real Postgres instead
 * of a hand-copied duplicate that drifts away from it. Do not inline this back.
 *
 * WI-37757: the uncast version of this statement could not PREPARE at all
 * ('could not determine data type of parameter $N'), which meant this function's
 * entire self-silencing design — documented at length in the header comment above —
 * had never once worked in production. The unit tests mock `sql`, so a statement that
 * fails at PREPARE time is invisible to them BY CONSTRUCTION; only a real-Postgres
 * test can see it. That is the whole justification for this seam.
 */
export async function pauseUnregisteredRoutine(
  sql: ReturnType<typeof getOrgPg>['sql'],
  r: { workspaceId: string; installSlug: string; routineName: string },
): Promise<Array<{ name: string }>> {
  return await sql<Array<{ name: string }>>`
    UPDATE harness_shared.routines
       SET active = false,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'pause', jsonb_build_object(
               'reason', 'auto-deactivated: install_slug targets an unregistered harness (routine-validation recurrence guard, EI-18678269428596559)',
               'pausedBy', 'routine-validation:enforce',
               -- WI-37757 — THE ::bigint CAST IS LOAD-BEARING, do not remove it.
               -- jsonb_build_object takes "any" arguments, so Postgres cannot infer a
               -- type for a bare parameter here; uncast, the statement fails to PREPARE
               -- and takes the whole UPDATE down with it. Measured live 2026-08-10:
               -- 3 routine rows still active, never paused since the guard shipped,
               -- re-logging FATAL on every boot of every worker.
               'pausedAtMs', ${Date.now()}::bigint
             )
           ),
           updated_at = now()
     WHERE workspace_id = ${r.workspaceId} AND install_slug = ${r.installSlug}
       AND name = ${r.routineName} AND active = true
    RETURNING name
  `;
}

/**
 * How long one boot WAVE is considered to last, for coalescing the ~15 worker processes that
 * each boot independently and each call this. See `claimRoutineValidationWave`.
 */
export const ROUTINE_VALIDATION_WAVE_MS = 60_000;

/** Stable identity of an offending routine row, used as the episode key. */
export function routineEpisodeKey(r: { installSlug: string; routineName: string }): string {
  return `${r.installSlug}/${r.routineName}`;
}

/**
 * Read every episode mark currently persisted for one FATAL class in this workspace.
 *
 * Deliberately reads ALL marked rows, not just the current offenders: the rows that are
 * marked but NO LONGER offending are what tells us the offender set SHRANK, which is half of
 * the transition test (see `routine-validation-episode.ts`).
 */
export async function readRoutineValidationMarks(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  cls: RoutineValidationFatalClass,
): Promise<Array<{ key: string; mark: EpisodeMark | null }>> {
  const rows = await sql<Array<{ install_slug: string; name: string; mark: unknown }>>`
    SELECT COALESCE(NULLIF(install_slug, ''), ${EMPTY_INSTALL_SLUG}) AS install_slug,
           name,
           metadata->'validation'->${cls}::text AS mark
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND jsonb_exists(metadata->'validation', ${cls}::text)
  `;
  return rows.map((r) => ({
    key: routineEpisodeKey({ installSlug: r.install_slug, routineName: r.name }),
    mark: parseEpisodeMark(r.mark),
  }));
}

/**
 * THE WAVE GATE. Try to become the one process that reports this class for this boot wave.
 *
 * Every operator worker boots independently and calls `enforceActiveRoutines` independently —
 * there is no shared coordinator, which is why the header's "~15 identical FATAL lines in the
 * same second" complaint exists. The PAUSE path already solves its half with predicate
 * serialization (`WHERE active = true`); this is the same trick for a condition that has no
 * naturally-self-limiting predicate: the winner is whoever commits the first mark whose
 * previous `lastSeenMs` is older than one wave. Under READ COMMITTED every later process
 * re-evaluates against the updated row, matches 0 rows, and stays silent.
 *
 * This also makes `occurrences` mean "distinct boot waves that observed it" rather than
 * "processes that logged it" — a 15x inflation that would make the count worthless.
 *
 * ⚠ THE `::bigint` CASTS ARE LOAD-BEARING — do not remove them (WI-37757). `jsonb_build_object`
 * takes "any" arguments, so Postgres cannot infer a type for a bare parameter and the whole
 * statement fails to PREPARE. Mocked-sql unit tests are blind to that BY CONSTRUCTION; only
 * the sibling integration test can see it.
 *
 * ⚠ The `CASE WHEN … ~ '^[0-9]+$'` guard is also load-bearing. `->>` yields TEXT, and a
 * corrupt or hand-edited mark would abort the statement on the cast — taking the whole guard
 * down, which is the failure this module exists to prevent, one level up. `CASE` evaluates its
 * conditions in order (unlike `WHERE` predicates, which are unordered), so the regex fence
 * genuinely protects the cast here. A non-numeric mark reads as 0 and therefore re-alarms.
 */
export async function claimRoutineValidationWave(
  sql: ReturnType<typeof getOrgPg>['sql'],
  args: {
    workspaceId: string;
    installSlug: string;
    routineName: string;
    cls: RoutineValidationFatalClass;
    mark: EpisodeMark;
    waveCutoffMs: number;
  },
): Promise<boolean> {
  const rows = await sql<Array<{ name: string }>>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'validation',
             COALESCE(metadata->'validation', '{}'::jsonb) || jsonb_build_object(
               ${args.cls}::text,
               jsonb_build_object(
                 'firstSeenMs', ${args.mark.firstSeenMs}::bigint,
                 'lastSeenMs', ${args.mark.lastSeenMs}::bigint,
                 'occurrences', ${args.mark.occurrences}::bigint
               )
             )
           ),
           updated_at = now()
     WHERE workspace_id = ${args.workspaceId}
       AND COALESCE(NULLIF(install_slug, ''), ${EMPTY_INSTALL_SLUG}) = ${args.installSlug}
       AND name = ${args.routineName}
       AND CASE
             WHEN (metadata->'validation'->${args.cls}::text->>'lastSeenMs') ~ '^[0-9]+$'
               THEN (metadata->'validation'->${args.cls}::text->>'lastSeenMs')::bigint
             ELSE 0
           END < ${args.waveCutoffMs}::bigint
    RETURNING name
  `;
  return rows.length > 0;
}

/**
 * Write one offender's mark unconditionally. Only ever called by the process that already WON
 * the wave gate above, so it cannot double-count.
 */
export async function writeRoutineValidationMark(
  sql: ReturnType<typeof getOrgPg>['sql'],
  args: {
    workspaceId: string;
    installSlug: string;
    routineName: string;
    cls: RoutineValidationFatalClass;
    mark: EpisodeMark;
  },
): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'validation',
             COALESCE(metadata->'validation', '{}'::jsonb) || jsonb_build_object(
               ${args.cls}::text,
               jsonb_build_object(
                 'firstSeenMs', ${args.mark.firstSeenMs}::bigint,
                 'lastSeenMs', ${args.mark.lastSeenMs}::bigint,
                 'occurrences', ${args.mark.occurrences}::bigint
               )
             )
           ),
           updated_at = now()
     WHERE workspace_id = ${args.workspaceId}
       AND COALESCE(NULLIF(install_slug, ''), ${EMPTY_INSTALL_SLUG}) = ${args.installSlug}
       AND name = ${args.routineName}
  `;
}

/**
 * Drop marks from rows that are no longer offending. The returned count is what tells the
 * summary that the offender set SHRANK — and it keeps a fixed routine from carrying a stale
 * episode forever, so the mark's lifetime is bounded by the condition it describes.
 *
 * An EMPTY `currentKeys` correctly clears every mark for the class: no offenders means the
 * condition is fully resolved.
 */
export async function clearRoutineValidationMarks(
  sql: ReturnType<typeof getOrgPg>['sql'],
  workspaceId: string,
  cls: RoutineValidationFatalClass,
  currentKeys: readonly string[],
): Promise<number> {
  const rows = await sql<Array<{ name: string }>>`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(
             metadata, '{validation}', (metadata->'validation') - ${cls}::text
           ),
           updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND jsonb_exists(metadata->'validation', ${cls}::text)
       AND (COALESCE(NULLIF(install_slug, ''), ${EMPTY_INSTALL_SLUG}) || '/' || name)
             <> ALL(${currentKeys as string[]}::text[])
    RETURNING name
  `;
  return rows.length;
}

/**
 * Age one FATAL class and return the line to emit, or null when another worker in this same
 * boot wave already owns the report.
 *
 * Emits FATAL only on a TRANSITION (the offender set gained or lost a member) and collapses an
 * identical recurrence to a single chronic line — EI-18685043834332306. Fail-open: any storage
 * fault falls back to emitting the un-aged FATAL, because losing the alarm is strictly worse
 * than losing its recurrence facts.
 */
async function ageFatalClass(
  workspaceId: string,
  cls: RoutineValidationFatalClass,
  offenders: ReadonlyArray<{ installSlug: string; routineName: string }>,
  nowMs: number,
): Promise<{ severity: 'fatal' | 'chronic'; recurrence: string } | null> {
  try {
    const { sql } = getOrgPg();
    const sorted = [...offenders].sort((a, b) =>
      routineEpisodeKey(a) < routineEpisodeKey(b) ? -1 : 1,
    );
    const currentKeys = sorted.map(routineEpisodeKey);

    const persisted = await readRoutineValidationMarks(sql, workspaceId, cls);
    const priorByKey = new Map(persisted.map((p) => [p.key, p.mark]));

    // The wave gate rides on the lexicographically-first offender, so every worker in the
    // wave races the SAME row and exactly one wins.
    const gateRow = sorted[0];
    const gateKey = routineEpisodeKey(gateRow);
    const won = await claimRoutineValidationWave(sql, {
      workspaceId,
      installSlug: gateRow.installSlug,
      routineName: gateRow.routineName,
      cls,
      mark: nextEpisodeMark(priorByKey.get(gateKey) ?? null, nowMs),
      waveCutoffMs: nowMs - ROUTINE_VALIDATION_WAVE_MS,
    });
    if (!won) {
      // 0 rows is AMBIGUOUS and the two readings have opposite correct responses:
      //   (a) a peer in this same wave already marked it  -> stay silent (the report is theirs)
      //   (b) the row never matched at all (identity drift, row deleted mid-boot)
      //                                                   -> the alarm would vanish SILENTLY
      // Distinguish them by re-reading: a peer's win leaves a mark inside the wave window.
      // No fresh mark means nobody is reporting this, so fail OPEN and emit un-aged. Losing
      // the recurrence facts is strictly cheaper than losing the alarm.
      const after = await readRoutineValidationMarks(sql, workspaceId, cls);
      const gateMark = after.find((m) => m.key === gateKey)?.mark ?? null;
      if (gateMark && gateMark.lastSeenMs >= nowMs - ROUTINE_VALIDATION_WAVE_MS) return null;
      return { severity: 'fatal', recurrence: 'recurrence unknown (episode row not matchable)' };
    }

    for (const r of sorted.slice(1)) {
      await writeRoutineValidationMark(sql, {
        workspaceId,
        installSlug: r.installSlug,
        routineName: r.routineName,
        cls,
        mark: nextEpisodeMark(priorByKey.get(routineEpisodeKey(r)) ?? null, nowMs),
      });
    }

    const cleared = await clearRoutineValidationMarks(sql, workspaceId, cls, currentKeys);
    const summary = summarizeEpisode(
      currentKeys.map((key) => ({ key, prior: priorByKey.get(key) ?? null })),
      cleared,
    );
    return { severity: episodeSeverity(summary), recurrence: renderRecurrence(summary, nowMs) };
  } catch (e) {
    console.warn(
      `[routine-validation] recurrence aging unavailable for ${cls} ` +
        `(${e instanceof Error ? e.message : e}) — reporting un-aged`,
    );
    return { severity: 'fatal', recurrence: 'recurrence unknown (aging unavailable)' };
  }
}

export async function enforceActiveRoutines(workspaceId?: string): Promise<EnforceActiveRoutinesResult> {
  const ws = workspaceId ?? activeWorkspaceId();
  const result = await validateActiveRoutines(ws, { silent: true });
  const autoDeactivated: Array<{ installSlug: string; routineName: string }> = [];
  const stillProblematic: Array<{ installSlug: string; routineName: string; workspaceId: string }> = [];

  if (result.problematicRoutines.length > 0) {
    const { sql } = getOrgPg();
    for (const r of result.problematicRoutines) {
      if (!r.installSlug || r.installSlug === '<empty>') {
        stillProblematic.push(r);
        continue;
      }
      let updatedRows: Array<{ name: string }>;
      try {
        updatedRows = await pauseUnregisteredRoutine(sql, r);
      } catch (e) {
        console.error(
          `[routine-validation] auto-deactivate FAILED for ${r.installSlug}/${r.routineName}: ` +
          `${e instanceof Error ? e.message : e}`,
        );
        stillProblematic.push(r);
        continue;
      }
      if (updatedRows.length > 0) {
        autoDeactivated.push({ installSlug: r.installSlug, routineName: r.routineName });
      }
      // 0 rows ⇒ a concurrent process already flipped it (or it's gone) — nothing to log.
    }
  }

  if (autoDeactivated.length > 0) {
    console.error(
      `[routine-validation] AUTO-DEACTIVATED ${autoDeactivated.length} active routine(s) that ` +
      `targeted unregistered harness(es) (${Array.from(result.unregisteredHarnesses).join(', ')}): ` +
      `${JSON.stringify(autoDeactivated)}. Paused, not deleted — reactivate via routines:set once ` +
      `the harness is re-registered (or the slug was a typo). See EI-18678269428596559.`,
    );
  }
  // EI-19367772473246483: this path passes `silent: true`, so the validator's own report is
  // suppressed and must be re-emitted here — otherwise the boot caller (which only logs on
  // `ok`) prints NOTHING and the dead routine stays invisible, which is the bug itself.
  // Deliberately NOT auto-healed: unlike an unregistered harness, there is no DB flip that
  // fixes a missing import, and pausing the row would erase the only evidence.
  // EI-18685043834332306: both of the classes below are aged before emission. They are the two
  // FATALs whose remedy is a human or code change, so neither can resolve its own premise and
  // both otherwise fire identically on their first occurrence and their ten-thousandth. FATAL
  // is now reserved for a TRANSITION (the offender set gained or lost a member); an unchanged
  // set collapses to one chronic line that still carries the full recurrence facts.
  const nowMs = Date.now();
  // WI-39810: three cases, not two. `unregisteredSystemActions` being empty is ambiguous —
  // it means "no offenders" ONLY when the check actually ran (`systemActionCheckApplicable`).
  // On a host that does not dispatch routines the check is skipped, and we must neither
  // report nor clear: clearing there would delete a TRUE mark written by the host that does.
  if (result.systemActionCheckApplicable) {
    if (result.unregisteredSystemActions.length > 0) {
      const aged = await ageFatalClass(ws, 'unregistered-system-action', result.unregisteredSystemActions, nowMs);
      if (aged) {
        const line =
          `${formatUnregisteredSystemActions(result.unregisteredSystemActions, aged.severity)} ` +
          `[${aged.recurrence}]`;
        if (aged.severity === 'fatal') console.error(line);
        else console.warn(line);
      }
    } else {
      // The offender set went EMPTY on a host that CAN see the registry — the routines are
      // healthy here. `ageFatalClass` (which owns the clear) is only reached with a non-empty
      // set, so before this a mark outlived the defect that caused it: a routine whose import
      // was subsequently added stayed rendered as SILENTLY DEAD by `routines:list` forever,
      // with occurrences frozen at whatever it reached. Clear it explicitly. Fail-soft — a
      // boot must never die over a health check.
      try {
        const { sql } = getOrgPg();
        const cleared = await clearRoutineValidationMarks(sql, ws, 'unregistered-system-action', []);
        if (cleared > 0) {
          console.log(
            `[routine-validation] RESOLVED: cleared ${cleared} stale unregistered-system-action ` +
              `mark(s) — every active system:<action> routine now resolves on this host.`,
          );
        }
      } catch (e) {
        console.warn(
          '[routine-validation] could not clear resolved unregistered-system-action marks ' +
            `(non-fatal): ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  // EI-18752496371939475, direction 3. This path passes `silent: true`, so the validator's own
  // report is suppressed and MUST be re-emitted here — the boot caller only logs when `ok`,
  // and `ok` is now false precisely BECAUSE of this finding, so without this the dead action
  // stays invisible at exactly the moment we detected it. That is the same trap direction 1
  // fell into (EI-19367772473246483); do not remove this block to reduce boot noise.
  //
  // Deliberately NOT auto-healed. There is no DB flip that fixes it: seeding a row means
  // choosing a cadence, a scope and an active state, which is the seed script's job and often
  // a human-gated bring-up (`test-webview-reaper` prescribes a --dry-run preview BEFORE going
  // live). Guessing one here could arm a reaper nobody reviewed.
  if (result.unscheduledCheckApplicable) {
    if (result.unscheduledSystemActions.length > 0) {
      const offenders = result.unscheduledSystemActions.map((action) => ({
        // No row exists, so there is no install scope to key the episode by — the ACTION is
        // the identity.
        installSlug: EMPTY_INSTALL_SLUG,
        routineName: action,
      }));
      const aged = await ageFatalClass(ws, 'unscheduled-system-action', offenders, nowMs);
      if (aged) {
        const line =
          `${formatUnscheduledSystemActions(result.unscheduledSystemActions, aged.severity)} ` +
          `[${aged.recurrence}]`;
        if (aged.severity === 'fatal') console.error(line);
        else console.warn(line);
      }
    } else {
      // Offender set went empty on a host that CAN see the registry: someone ran the seed (or
      // declared the action on-demand). Clear the marks, or `routines:list` keeps rendering a
      // now-scheduled action as dead forever — the same stale-mark bug direction 1 hit above.
      try {
        const { sql } = getOrgPg();
        const cleared = await clearRoutineValidationMarks(sql, ws, 'unscheduled-system-action', []);
        if (cleared > 0) {
          console.log(
            `[routine-validation] RESOLVED: cleared ${cleared} stale unscheduled-system-action ` +
              `mark(s) — every standing system action now has a routine row in this workspace.`,
          );
        }
      } catch (e) {
        console.warn(
          '[routine-validation] could not clear resolved unscheduled-system-action marks ' +
            `(non-fatal): ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }
  if (stillProblematic.length > 0) {
    const aged = await ageFatalClass(ws, 'unpauseable-routine', stillProblematic, nowMs);
    if (aged) {
      const line =
        `[routine-validation] ${aged.severity === 'fatal' ? 'FATAL' : 'CHRONIC'}: ` +
        `${stillProblematic.length} active routine(s) target unregistered ` +
        `harness(es) and could NOT be auto-deactivated (a blank install_slug is a data-integrity bug in ` +
        `the row itself, not harness drift — fix the row directly): ${JSON.stringify(stillProblematic)} ` +
        `[${aged.recurrence}]`;
      if (aged.severity === 'fatal') console.error(line);
      else console.warn(line);
    }
  }

  return { ...result, autoDeactivated };
}
