/**
 * unservable-critical-watchdog (EI-19919820196426791 half 2) — alarm on an issue
 * that is simultaneously the HIGHEST-severity thing in the system and invisible
 * to every claim path.
 *
 * THE CLASS THIS ANSWERS. An item sitting behind a STRUCTURAL claim floor is
 * unclaimable no matter who wants it: `lane='observation'` never enters the work
 * queue by design, a non-`open` state is not claimable, a `claim-hold` is a durable
 * park, and admission gating holds a row out of the pool entirely. Each of those is
 * correct behaviour on its own. What is NOT correct is that a `critical` item can sit
 * behind one of them forever with nothing anywhere reporting the contradiction. The
 * filed instance: cup:spawn was 100% broken for 19 days while BOTH records of it sat
 * in unservable lanes, and three Mug incarnations re-placed cups that died in seconds
 * because severity and feature_order — the only steering levers — cannot move an item
 * out of a lane the claim layer does not serve.
 *
 * THE FLOOR SET IS DERIVED, NOT LISTED HERE (WI-2141964). This file used to hard-code
 * exactly two floors — observation-lane and needs-human — in a union type and in its
 * own SQL, which made it the THIRD hand-rolled copy of the structural-floor rule and
 * left it blind to 26 aged `critical` rows that were genuinely stranded behind the
 * floors it did not watch (mostly `claim-hold` and `not-claimable-status`). The set
 * now comes from `STRUCTURAL_CLAIM_FLOORS` in `../claim-floor-classification`, pinned
 * by a totality guard against the claim oracle's own vocabulary, so a floor added to
 * the claim path can never again be silently unwatched.
 *
 * WHY THE WRITE-TIME GUARD IS NOT ENOUGH (this file's whole reason to exist).
 * `work_items:set_priority` and `work_items:update` already return a
 * `claimabilityWarning` when someone raises priority/severity on such a row
 * (structuralClaimabilityWarning, driven by the same `explainIssueClaimFloors`
 * oracle the real claim path uses). That closes the STEERING case — you are told at
 * the moment your steer is a no-op. It cannot close the case that actually caused
 * the 19-day hide: the original item was FILED into the observation lane as a nit
 * and NOBODY EVER WROTE TO IT AGAIN. No write, no warning. A guard that only fires
 * on a write cannot see an item nobody touches, so the residual hole is exactly the
 * never-touched mis-file — and only a periodic sweep closes it.
 *
 * CRITICAL-ONLY, AND THAT THRESHOLD IS MEASURED, NOT GUESSED. The filed proposal
 * said "severity critical/major and an age over N days". Measured against the live
 * backlog before building (2026-08-19, harness papercusp, non-terminal):
 *
 *     needs-human   critical     6   (4 older than 7d)
 *     needs-human   major       41  (38 older than 7d)
 *     observation   critical     4   (1 older than 7d)
 *     observation   major      118  (14 older than 7d)
 *
 * Including `major` makes this fire 57 times on its first tick. An alarm that opens
 * 57 escalations is a backlog listing, and the next one is ignored — which is the
 * failure mode this watchdog exists to prevent, re-created by the watchdog itself.
 * `critical` alone yields 5. So the severity set is deliberately NOT the filed one;
 * widening it is a decision to be made against a fresh measurement, not a tweak.
 *
 * THE SAME MEASUREMENT DISCIPLINE KILLED THE NAIVE FIX (WI-2141964, 2026-09-02).
 * Widening the floor set alone — the obvious repair for the blindness described above
 * — takes first-tick volume from 24 to 55 on this workspace, which re-creates the very
 * backlog-listing failure the paragraph above rejects. It is the widened floor set
 * TOGETHER WITH the last-write age basis that works: 34 alerts, while covering the 26
 * stranded rows the two-floor predicate could not see. Measured on papercusp-workspace,
 * non-terminal `critical`: creation basis 55 (24 already seen + 31 blind), last-write
 * basis 34 (17 + 17). Re-measure before changing either knob; neither is safe alone.
 *
 * Shape follows the watchdog family (carry-drill-drop, goal-liveness):
 *  - `managedSetInterval`, never a bare setInterval, so it is visible in
 *    `schedule:inventory`.
 *  - Runtime gate FLAGS.UNSERVABLE_CRITICAL_WATCHDOG (default ON), per tick.
 *  - Dedup delegated to openEscalation's (dedupKind, subjectSignature) PG dedup,
 *    keyed on the item id — one open escalation per stranded item, no new state.
 *  - The classifier is a PURE function over rows so its thresholds are testable
 *    without a database.
 */
import type { Sql } from 'postgres';

import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { isStructurallyUnclaimable } from '../claim-floor-classification';

export const UNSERVABLE_CRITICAL_SWEEP_INTERVAL_MS = 30 * 60_000;

/** How long a stranded critical item may go WITHOUT ANYONE WRITING TO IT before it is
 *  reported. Long enough that a deliberate short park (triage in progress, a mis-file
 *  being corrected) never alarms; short enough that nothing repeats the 19-day hide.
 *
 *  ⚠ THE BASIS IS LAST-WRITE, NOT CREATION (WI-2141964). It used to be `created_at`,
 *  which measures the wrong thing in both directions: an item created 8 days ago and
 *  actively worked today alarms (a false positive that someone is already handling),
 *  while the basis says nothing about whether the item is actually abandoned. Last-write
 *  is this watchdog's OWN stated signal — its header describes the filed instance as an
 *  item that "NOBODY EVER WROTE TO IT AGAIN" — so the predicate now matches the rationale
 *  it always claimed. Measured 2026-09-02 on papercusp-workspace, non-terminal criticals:
 *  the creation basis matched 55 rows, the last-write basis 34, while ALSO covering the
 *  26 genuinely-stranded rows the old two-floor predicate could not see at all. */
export const UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS = 7 * 24 * 60 * 60_000;

/** Severities this watchdog reports. See the header: `major` is EXCLUDED on
 *  measurement, not on taste — it turns 5 alerts into 57. */
export const UNSERVABLE_REPORTED_SEVERITIES: readonly string[] = ['critical'];

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'unservable-critical-watchdog',
  ownerLabel: 'system · unservable critical items',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Which structural floor makes the row unclaimable — a `refusedBy` label straight from
 *  the claim oracle (`explainIssueClaimFloors`), so the escalation names the same bucket
 *  every other claimability surface does.
 *
 *  ⚠ This used to be the two-member union `'observation-lane' | 'needs-human'`, hard-coded
 *  here and in this file's SQL. That was a THIRD hand-rolled copy of the structural-floor
 *  rule (WI-2141964) and it was blind to 26 aged `critical` items on this workspace that
 *  were genuinely structurally stranded — mostly `claim-hold` (a durable park) and
 *  `not-claimable-status` (state='blocked'). The set now comes from
 *  `STRUCTURAL_CLAIM_FLOORS`, which a totality guard pins against the oracle's own
 *  vocabulary, so a floor added to the claim path can never again be silently unwatched. */
export type UnservableFloor = string;

export interface UnservableItemRow {
  itemId: string;
  workspaceId: string;
  harnessSlug: string;
  title: string;
  severity: string;
  floor: UnservableFloor;
  createdAtMs: number;
  /** When anyone last WROTE to this row (max of updated_at / last_progress_at). This —
   *  not `createdAtMs` — is what the age floor is measured against; see
   *  {@link UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS}. */
  lastWriteAtMs: number;
}

export interface UnservableAlert {
  itemId: string;
  workspaceId: string;
  harnessSlug: string;
  title: string;
  severity: string;
  floor: UnservableFloor;
  /** How long the row has gone untouched — the stranding signal, and what the threshold
   *  is applied to. */
  untouchedMs: number;
  /** How long the row has EXISTED. Reported for context only; deliberately not a filter,
   *  because an old item somebody is actively working is not stranded. */
  itemAgeMs: number;
}

/**
 * Pure classifier: which rows are stranded-critical right now.
 *
 * Exported and dependency-free so the two thresholds that decide this
 * watchdog's entire alert volume — the severity set and the age floor — can be
 * tested directly. A row is reported only when BOTH hold; either alone is
 * ordinary and must stay silent.
 */
export function scanUnservableCritical(
  rows: readonly UnservableItemRow[],
  nowMs: number,
  opts: { minUntouchedMs?: number; severities?: readonly string[] } = {},
): UnservableAlert[] {
  const minUntouchedMs = opts.minUntouchedMs ?? UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS;
  const severities = opts.severities ?? UNSERVABLE_REPORTED_SEVERITIES;
  const alerts: UnservableAlert[] = [];
  for (const row of rows) {
    if (!severities.includes(row.severity)) continue;
    // The floor set is NOT re-derived here: `readRows` has already kept only rows the
    // claim oracle refuses on a STRUCTURAL floor. Re-testing it here would be a fourth
    // copy of the very rule this change consolidated.
    const untouchedMs = nowMs - row.lastWriteAtMs;
    if (untouchedMs < minUntouchedMs) continue;
    alerts.push({
      itemId: row.itemId,
      workspaceId: row.workspaceId,
      harnessSlug: row.harnessSlug,
      title: row.title,
      severity: row.severity,
      floor: row.floor,
      untouchedMs,
      itemAgeMs: nowMs - row.createdAtMs,
    });
  }
  // Longest-untouched first: the most-abandoned item is the one most likely to be a real
  // hidden blocker rather than an in-flight triage.
  return alerts.sort((a, b) => b.untouchedMs - a.untouchedMs);
}

export interface UnservableSweepDeps {
  readRows: () => Promise<UnservableItemRow[]>;
  escalate: (alert: UnservableAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.UNSERVABLE_CRITICAL_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

/**
 * ⚠ Reads the `harness_shared.engineer_issues` VIEW, not the underlying
 * `work_items` TABLE, and that is load-bearing: severity is a real column on the
 * view, while on the table it lives at `payload->'_ei'->>'severity'`. Query the
 * view, read the COLUMN — which is what the SQL below does.
 *
 * ⚠ CORRECTED 2026-09-02. This comment used to add that the view "SUBTRACTS the
 * `_ei` blob ... so the payload path resolves to NULL for every row". That was
 * true when written and is now false: migration 1096 (P-003 of plan
 * silent-wrong-answers-2026-08-01) stopped the subtraction, and the two
 * accessors now agree on 166,795 of 166,802 rows. The code here was always
 * correct — it reads the column — so only the rationale was wrong. It is
 * corrected rather than deleted because the column remains the right accessor:
 * it COALESCEs to 'minor', so it is defined for the 7 rows carrying a NULL
 * payload, where the nested path yields NULL and would drop them from
 * `severity = ANY (...)` entirely.
 */
function makeReadRows(sql: Sql): UnservableSweepDeps['readRows'] {
  return async () => {
    // Deliberately NO floor predicate here. The SQL selects the whole candidate
    // population (non-terminal + reported severity — ~55 rows on this workspace) and the
    // CLAIM ORACLE decides which are stranded. That is the entire point of WI-2141964:
    // the previous `AND (lane='observation' OR state='needs-human')` was this file's own
    // private theory of unclaimability, and it was wrong by 26 items.
    //
    // The age threshold is deliberately NOT applied here either — `scanUnservableCritical`
    // owns it, so the constant lives in exactly one place. The candidate set is small
    // enough that filtering it in SQL would buy nothing but a second copy of a threshold.
    const rows = await sql<
      {
        issue_id: string;
        workspace_id: string;
        harness_slug: string | null;
        title: string | null;
        severity: string;
        created_ms: string;
        last_write_ms: string;
      }[]
    >`
      SELECT issue_id,
             workspace_id,
             replace(scope, 'harness:', '') AS harness_slug,
             title,
             severity,
             (extract(epoch FROM created_at) * 1000)::bigint AS created_ms,
             (extract(epoch FROM greatest(updated_at, coalesce(last_progress_at, updated_at)))
               * 1000)::bigint AS last_write_ms
        FROM harness_shared.engineer_issues
       WHERE state NOT IN ('done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped')
         AND severity = ANY (${UNSERVABLE_REPORTED_SEVERITIES as string[]})`;
    if (rows.length === 0) return [];

    const { explainIssueClaimFloors } = await import('../work-items');

    // The oracle is per-harness, so ask it once per harness rather than once per row.
    // The bucket type is a PLAIN ARRAY of row elements, not `typeof rows`: the latter is
    // postgres.js's `RowList<T[]>`, which carries `count`/`command` alongside the array, so
    // the `[r]` literal below is not assignable to it (TS2345) even though every element type
    // matches. Indexing to the element type keeps the rows exactly as strongly typed.
    const byHarness = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      const harness = r.harness_slug ?? '';
      if (!harness) continue; // no harness scope ⇒ the oracle cannot rule on it
      const bucket = byHarness.get(harness);
      if (bucket) bucket.push(r);
      else byHarness.set(harness, [r]);
    }

    const stranded: UnservableItemRow[] = [];
    for (const [harness, harnessRows] of byHarness) {
      let verdicts;
      try {
        verdicts = await explainIssueClaimFloors(
          harness,
          harnessRows.map((r) => r.issue_id),
        );
      } catch (e) {
        // One harness failing to resolve must not silence the whole sweep. Log and skip:
        // under-reporting THIS tick is recoverable (the next one retries), whereas an
        // exception here would take every other harness's stranded items down with it.
        console.warn(
          `[unservable-critical-watchdog] floor lookup failed for harness ${harness} (skipped this tick): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        continue;
      }
      const floorById = new Map(verdicts.map((v) => [v.id, v.refusedBy]));
      for (const r of harnessRows) {
        const refusedBy = floorById.get(r.issue_id) ?? null;
        // `null` here means ADMISSIBLE — a claimable-but-unclaimed critical item is a
        // prioritisation problem, not a structural strand, and must stay silent. (5 of
        // this workspace's aged criticals were exactly that when measured.)
        if (!isStructurallyUnclaimable(refusedBy)) continue;
        stranded.push({
          itemId: r.issue_id,
          workspaceId: r.workspace_id,
          harnessSlug: harness,
          title: r.title ?? '(untitled)',
          severity: r.severity,
          floor: refusedBy as string,
          createdAtMs: Number(r.created_ms),
          lastWriteAtMs: Number(r.last_write_ms),
        });
      }
    }
    return stranded;
  };
}

function describeDays(ageMs: number): string {
  return `${Math.floor(ageMs / (24 * 60 * 60_000))}d`;
}

/** Remedy per structural floor. The floor names are the claim oracle's own `refusedBy`
 *  labels, so this switch cannot drift from what every other claimability surface reports.
 *  The default deliberately does NOT guess: it points at the oracle, which explains any
 *  floor authoritatively — better than a plausible-sounding remedy for the wrong one. */
function remedyFor(alert: UnservableAlert): string {
  switch (alert.floor) {
    case 'needs-owner-action':
      return `work_items:update { id: '${alert.itemId}', needsHuman: false } if it should actually be worked`;
    case 'observation-lane':
      return `re-file/relocate it out of the observation lane (it was captured via improvements:capture { lane:'observation' }, which by design never enters the work queue)`;
    case 'not-claimable-status':
      return `its state is outside the claimable set (ISSUE_FAMILY_CLAIMABLE_STATES=['open']) — work_items:set_state { id: '${alert.itemId}', state:'open' } if it should be worked, or close it if it should not`;
    case 'claim-hold':
      return `it is on a durable claim hold — work_items:release { id: '${alert.itemId}', claimHold: true } to lift it, or record why the park should outlive this alert`;
    default:
      return `run work_items:observe { ids: ['${alert.itemId}'] } for the authoritative floor detail and its remedy`;
  }
}

async function defaultEscalate(alert: UnservableAlert): Promise<void> {
  const remedy = remedyFor(alert);
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary:
      `${alert.severity.toUpperCase()} item ${alert.itemId} is structurally UNCLAIMABLE and untouched for ${describeDays(alert.untouchedMs)} ` +
      `(${alert.floor}) — no claim path can serve it`,
    body:
      `${alert.itemId} (${alert.harnessSlug}) is severity ${alert.severity}, sits behind the ` +
      `${alert.floor} claim floor, and NOBODY HAS WRITTEN TO IT for ${describeDays(alert.untouchedMs)} ` +
      `(the item itself is ${describeDays(alert.itemAgeMs)} old): "${alert.title}"\n\n` +
      `Those two facts are in conflict and nothing else reports it. The item is invisible to ` +
      `scheduler:get_next, work_items:claim_next and work_items:claimable, so raising its severity ` +
      `or setting a feature_order does NOT make it workable — those writes report ok:true and change ` +
      `nothing about claimability.\n\n` +
      `This is either a MIS-FILE (severity or lane is wrong) or a GENUINELY STRANDED BLOCKER. Both ` +
      `want a human or a Mug to look. It is filed as advisory rather than actioned automatically ` +
      `because deciding which of those two it is requires reading the item.\n\n` +
      `Remedy: ${remedy}.\n\n` +
      `Why a periodic sweep and not the write-time guard: set_priority/update already warn when ` +
      `SOMEONE WRITES to such a row, but the filed instance (EI-19919820196426791) was an item ` +
      `nobody ever wrote to after filing it — cup:spawn was 100% broken for 19 days behind exactly ` +
      `this shape.`,
    meta: {
      dedupKind: 'unservable-critical',
      subjectSignature: alert.itemId,
      itemId: alert.itemId,
      itemWorkspaceId: alert.workspaceId,
      harnessSlug: alert.harnessSlug,
      floor: alert.floor,
      severity: alert.severity,
      untouchedMs: alert.untouchedMs,
      itemAgeMs: alert.itemAgeMs,
    },
  });
}

function sweepDeps(sql: Sql, overrides: Partial<UnservableSweepDeps>): UnservableSweepDeps {
  return {
    readRows: makeReadRows(sql),
    escalate: defaultEscalate,
    flagEnabled: defaultFlagEnabled,
    now: Date.now,
    ...overrides,
  };
}

/**
 * One sweep: find stranded-critical items and escalate each. Exported for tests.
 *
 * A failed escalate does NOT abort the batch — unlike the carry-drill sibling,
 * there is no watermark to protect here (the query is a full current-state read,
 * not an incremental ledger tail), so the right behaviour is to report the rest
 * and let the next tick retry the failure. The (dedupKind, subjectSignature)
 * dedup makes that retry idempotent.
 */
export async function runUnservableCriticalSweepOnce(
  sql: Sql,
  overrides: Partial<UnservableSweepDeps> = {},
): Promise<{ scanned: number; escalated: number; failed: number; skipped: boolean }> {
  const deps = sweepDeps(sql, overrides);
  if (!(await deps.flagEnabled())) {
    return { scanned: 0, escalated: 0, failed: 0, skipped: true };
  }
  const rows = await deps.readRows();
  const alerts = scanUnservableCritical(rows, deps.now());
  let escalated = 0;
  let failed = 0;
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
      escalated += 1;
    } catch (e) {
      failed += 1;
      console.warn(
        `[unservable-critical-watchdog] escalate failed for ${alert.itemId} (retried next tick): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return { scanned: rows.length, escalated, failed, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the unservable-critical watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.UNSERVABLE_CRITICAL_WATCHDOG (checked per tick).
 */
export function startUnservableCriticalWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  const intervalMs = opts.intervalMs ?? UNSERVABLE_CRITICAL_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'unservable-critical-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runUnservableCriticalSweepOnce(sql)
        .catch((e) => {
          console.warn(
            `[unservable-critical-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // The trigger is ELAPSED TIME with no state change — an item going quiet in an
    // unservable lane emits nothing, and absence-over-a-deadline has no publisher
    // to subscribe to.
    { category: 'watchdog', classification: 'timeout-reaper' },
  );
}
