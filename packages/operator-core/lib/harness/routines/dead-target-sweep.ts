/**
 * dead-target-sweep — the write-side of the dead-target routine reaper
 * (dead-target-routine-reaper-2026-08-30 P-003 + P-004, from EI-19278517916030043).
 *
 * Groups this workspace's ACTIVE routines by install, probes each install ONCE, and — only on
 * a permanent verdict confirmed across two spaced sweeps — parks that install's routines with
 * the evidence stamped where a reader will find it, then files ONE debounced observation.
 *
 * WHAT IT IS FOR: `ei669-repro-su-b621d`, an abandoned pot whose tree became unreadable, kept
 * `system:git-sync` firing every ~3min for 5 DAYS (~2,400 doomed attempts, 646 consecutive
 * error ticks) plus an hourly `green-checkpoint` and a 2-minutely outbox drain. Every attempt
 * was hopeless from the first one. It stopped only because a human noticed and paused the
 * routines by hand — and those 646 ticks drove the fleet-wide deploy panel to crit for 32h
 * (worst-wins), so one dead scratch pot degraded a shared signal for the whole fleet.
 *
 * THE SAFETY POSTURE, in the order the code applies it (D-002/D-003). This sweep DISABLES
 * EXECUTION, so unlike its read-only siblings it fails CLOSED at every step:
 *   1. Both kill switches first, before any I/O — the registered flag
 *      `FLAGS.DEAD_TARGET_REAPER` (default ON, flippable from `/admin/features` without a
 *      restart, and treated as OFF if it cannot be read) AND the process-level emergency
 *      override `PAPERCUSP_DEAD_TARGET_REAPER=0`. Either one closed ⇒ nothing is probed.
 *   2. The home harness is removed from the candidate set BEFORE any probing, compared on
 *      CANONICAL slugs so a retired alias (`papercup` → `papercusp`) is protected too. Parking
 *      the operator's own git-sync and green-checkpoint would take the fleet's pipeline down.
 *   3. Only `root-missing` / `git-corrupt` are permanent; every timeout, EACCES, unreadable
 *      registry, unregistered slug and thrown error decides `unknown` and parks nothing.
 *   4. Even a permanent verdict does not park on first sight: `confirmPermanence` requires the
 *      same state on two sweeps spaced apart, so a lazily-materialized or briefly-unmounted
 *      pot home is seen present on the second look. A non-permanent verdict CLEARS the run,
 *      so a recovered tree cannot be parked by a stale watermark — the bug (EI-6765) that has
 *      twice bitten this subsystem's read-only sibling.
 *
 * WHY THE STAMP IS NOT OPTIONAL. The ei669 rows are, today, indistinguishable from a hand
 * pause: `active = false` with a frozen `last_error` as the only witness to why. An automatic
 * park that left the same trace would be strictly worse, because nobody would even know an
 * automaton did it. So a park always writes `metadata.health.dead_target` — verdict, reason,
 * probed path, confirmation count and timestamps — surfaced by `routines:list`.
 *
 * FAIL-SOFT BY CONTRACT: every write is individually guarded, and the sweep returns a result
 * row per install rather than throwing. It runs as its own durable routine; an observability
 * write that could break the scheduler would be a worse bug than the one it reports.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from '../../workspace-registry';
import { canonicalHarnessSlug, operatorHomeHarnessSlug } from '../operator-home-harness';
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { probeTarget } from './dead-target-probe';
import {
  classifyTargetHealth,
  confirmPermanence,
  isProtectedInstall,
  targetIdentity,
  type PermanenceRecord,
  type TargetHealthState,
} from './dead-target-routine-reaper';

/** The watchdog-ledger source key for this sweep's 24h escalation debounce. */
const WATCHDOG_SOURCE = 'dead-target-reaper' as const;

/**
 * The PRIMARY gate: the registered feature flag (`FLAGS.DEAD_TARGET_REAPER`, default ON).
 *
 * This is the switch an operator reaches for — flippable from `/admin/features` and effective
 * within one tick, with no restart, which matters for a sweep whose job is to DISABLE other
 * people's routines. The repo has one source for feature gates (`libs/flags/src/types.ts`);
 * the env var below is deliberately NOT that source, it is the escape hatch beneath it.
 *
 * A read failure is treated as OFF, matching the sibling reaper (`idle-session-reaper.ts`) and
 * this file's fail-closed posture: if we cannot establish that parking is enabled, we do not
 * park. The cost of that choice is one skipped tick; the cost of the other is disabling a live
 * install because a flag lookup timed out.
 */
async function reaperFlagOn(): Promise<boolean> {
  return await getFlag(FLAGS.DEAD_TARGET_REAPER, 'system').catch(() => false);
}

/**
 * Process-level EMERGENCY OVERRIDE, beneath the flag: `PAPERCUSP_DEAD_TARGET_REAPER=0`.
 *
 * Kept as a second, independent gate (the double-gated pattern `IDLE_SESSION_REAPER_TERMINATE`
 * uses) rather than replaced by the flag, so a host whose flag store is unreachable — the exact
 * condition under which `reaperFlagOn` degrades to OFF and an operator most wants certainty —
 * can still be pinned off without a working database. Both gates must be open to sweep.
 */
export function reaperEnabled(): boolean {
  const raw = process.env.PAPERCUSP_DEAD_TARGET_REAPER;
  if (raw === undefined || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

export type DeadTargetOutcome =
  /** Routines disabled — the terminal outcome, reached only via a confirmed permanent verdict. */
  | 'parked'
  /** Permanent verdict seen, but not yet confirmed by a second spaced sighting. */
  | 'confirming'
  /** The home harness. Never probed, never parked. */
  | 'protected'
  | 'healthy'
  /** Could not establish the tree's state — the fail-closed default. */
  | 'inconclusive'
  /** Parked, but the escalation was already filed inside the debounce window. */
  | 'debounced'
  | 'error';

export interface DeadTargetResult {
  installSlug: string;
  outcome: DeadTargetOutcome;
  state: TargetHealthState | 'not-probed';
  reason: string;
  routinesParked?: number;
}

export interface RoutineRow {
  id: string;
  install_slug: string;
  name: string;
  /** Whatever is sitting at `metadata.health.dead_target` — free-form jsonb until parsed. */
  rec: unknown;
}

/** Epoch ms from either the decider's native number or the stamp's ISO-8601 string. */
function epochMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse the PERSISTED stamp back into the decider's `PermanenceRecord`.
 *
 * These are deliberately different shapes and this is the ONE place they meet. The stamp is
 * written for a HUMAN reading `routines:list`: ISO-8601 timestamps, snake_case keys like the
 * rest of the row. The decider works in epoch ms. Keeping the bridge explicit is what makes
 * the round trip testable — while it was implicit (the SELECT was simply *typed* as a
 * `PermanenceRecord`) writer and reader disagreed silently, `nowMs - undefined` produced NaN,
 * and the confirming sweep threw on `new Date(undefined).toISOString()` — so the reaper could
 * never actually park anything, and every unit test still passed because each handed
 * `priorRecord` a hand-built record rather than one this module had written.
 *
 * It fails CLOSED. Anything unreadable yields null, which restarts the run from a single
 * sighting instead of parking on a record whose age cannot be established — a missed park
 * costs one more tick, a park on a misread record disables a live install.
 */
export function recordFromStamp(raw: unknown): PermanenceRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.confirmations !== 'number' || !Number.isFinite(s.confirmations)) return null;
  // Only the two permanent states are ever persisted (any other verdict CLEARS the record),
  // so a stamp claiming anything else is not a run this sweep may continue.
  if (s.state !== 'root-missing' && s.state !== 'git-corrupt') return null;
  const firstSeenAtMs = epochMs(s.firstSeenAtMs ?? s.first_seen_at);
  const lastSeenAtMs = epochMs(s.lastSeenAtMs ?? s.last_seen_at);
  if (firstSeenAtMs === null || lastSeenAtMs === null) return null;
  return { state: s.state, firstSeenAtMs, lastSeenAtMs, confirmations: s.confirmations };
}

/** Read the prior permanence record for an install. Rows of one install should agree, but if
 *  they disagree (a routine added mid-run) the MOST-confirmed row wins: a newly-seeded routine
 *  carrying no record must not silently reset a run that is one sighting from completing. */
export function priorRecord(rows: readonly RoutineRow[]): PermanenceRecord | null {
  let best: PermanenceRecord | null = null;
  for (const r of rows) {
    const rec = recordFromStamp(r.rec);
    if (!rec) continue;
    if (!best || rec.confirmations > best.confirmations) best = rec;
  }
  return best;
}

/** Merge a patch under `metadata.health.<key>` without disturbing sibling health keys
 *  (`gate_health`, and anything a future detector adds). Fail-soft. */
async function stampHealth(sql: any, routineId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const json = JSON.stringify({ dead_target: patch });
    await sql`
      UPDATE harness_shared.routines
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('health',
                             COALESCE(metadata->'health', '{}'::jsonb) || ${json}::text::jsonb)
       WHERE id = ${routineId}`;
  } catch {
    // Intentionally swallowed: this is an instrument on the fire hot path.
  }
}

/** Clear the marker once an install is healthy again, so a recovered tree leaves no stale
 *  watermark behind for a future sweep to mistake for a live condition. */
async function clearHealth(sql: any, routineId: string): Promise<void> {
  try {
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(metadata, '{health}', (metadata->'health') - 'dead_target')
       WHERE id = ${routineId} AND metadata->'health' ? 'dead_target'`;
  } catch {
    /* fail-soft, as above */
  }
}

/**
 * The sweep. Never throws; returns one row per install describing what it decided and why.
 */
export async function deadTargetReaperSweep(now = Date.now()): Promise<DeadTargetResult[]> {
  const results: DeadTargetResult[] = [];
  // Both gates, cheapest first: the env override needs no I/O, so a host pinned off never
  // pays for a flag read. Neither probes anything, so an OFF sweep is observably inert.
  if (!reaperEnabled()) return results;
  if (!(await reaperFlagOn())) return results;

  let sql: any;
  let workspaceId: string;
  try {
    ({ sql } = getOrgPg());
    workspaceId = activeWorkspaceId();
  } catch (e: any) {
    return [
      {
        installSlug: '(none)',
        outcome: 'error',
        state: 'not-probed',
        reason: `sweep could not start: ${String(e?.message ?? e)}`,
      },
    ];
  }

  // Canonical form, so a routine still installed under a RETIRED alias of the home slug
  // (papercup -> papercusp) is protected by the same guard.
  const homeSlug = canonicalHarnessSlug(operatorHomeHarnessSlug());

  let rows: RoutineRow[];
  try {
    rows = await sql<RoutineRow[]>`
      SELECT id, install_slug, name,
             metadata->'health'->'dead_target' AS rec
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId}
         AND active = true
         AND install_slug IS NOT NULL`;
  } catch (e: any) {
    return [
      {
        installSlug: '(none)',
        outcome: 'error',
        state: 'not-probed',
        reason: `routine read failed: ${String(e?.message ?? e)}`,
      },
    ];
  }

  const byInstall = new Map<string, RoutineRow[]>();
  for (const r of rows) {
    const list = byInstall.get(r.install_slug);
    if (list) list.push(r);
    else byInstall.set(r.install_slug, [r]);
  }

  for (const [installSlug, group] of byInstall) {
    try {
      // (2) The home harness never reaches a probe, let alone a park.
      if (isProtectedInstall(canonicalHarnessSlug(installSlug), homeSlug)) {
        results.push({
          installSlug,
          outcome: 'protected',
          state: 'not-probed',
          reason: `${installSlug} is the operator home harness — excluded from reaping unconditionally`,
        });
        continue;
      }

      const probe = await probeTarget(installSlug, workspaceId);
      const verdict = classifyTargetHealth(probe);
      const decision = confirmPermanence(verdict, priorRecord(group), now);

      if (!decision.record) {
        // Healthy or inconclusive: drop any run in progress so it cannot go stale.
        for (const r of group) await clearHealth(sql, r.id);
        results.push({
          installSlug,
          outcome: verdict.state === 'ok' ? 'healthy' : 'inconclusive',
          state: verdict.state,
          reason: verdict.reason,
        });
        continue;
      }

      const stamp = {
        state: decision.record.state,
        reason: verdict.reason,
        path: probe.resolution.kind === 'resolved' ? probe.resolution.path : null,
        confirmations: decision.record.confirmations,
        first_seen_at: new Date(decision.record.firstSeenAtMs).toISOString(),
        last_seen_at: new Date(decision.record.lastSeenAtMs).toISOString(),
        parked: decision.park,
        parked_at: decision.park ? new Date(now).toISOString() : null,
        parked_by: decision.park ? 'dead-target-reaper sweep' : null,
      };

      if (!decision.park) {
        for (const r of group) await stampHealth(sql, r.id, stamp);
        results.push({ installSlug, outcome: 'confirming', state: verdict.state, reason: decision.reason });
        continue;
      }

      // (4) Confirmed permanent. Stamp FIRST, then disable — so a crash between the two
      // leaves an explained-but-live routine rather than a silently-dead unexplained one.
      let parked = 0;
      for (const r of group) {
        await stampHealth(sql, r.id, stamp);
        try {
          await sql`
            UPDATE harness_shared.routines
               SET active = false, active_changed_at = now()
             WHERE id = ${r.id} AND active = true`;
          parked++;
        } catch {
          /* fail-soft per routine: one failed park must not abandon the rest */
        }
      }

      const escalated = await escalate(
        workspaceId,
        installSlug,
        verdict.reason,
        stamp,
        parked,
        group.map((r) => r.name),
      );
      results.push({
        installSlug,
        outcome: escalated ? 'parked' : 'debounced',
        state: verdict.state,
        reason: `${decision.reason} — parked ${parked}/${group.length} routine(s)`,
        routinesParked: parked,
      });
    } catch (e: any) {
      results.push({ installSlug, outcome: 'error', state: 'not-probed', reason: String(e?.message ?? e) });
    }
  }

  return results;
}

/**
 * File ONE observation per install per 24h (P-004), through the SAME watchdog ledger and
 * improvements pipeline the rest of the system already triages — not a parallel alerting path.
 *
 * `claimWatchdogFire` is the atomic claim, not the cheap `recentWatchdogFires` pre-check:
 * concurrent ticks can all observe "not fired yet" before any records a fire (EI-6777), so the
 * claim is what actually guarantees one filing.
 *
 * Returns true when this call filed the observation.
 */
async function escalate(
  workspaceId: string,
  installSlug: string,
  reason: string,
  stamp: Record<string, unknown>,
  parked: number,
  routineNames: readonly string[],
): Promise<boolean> {
  try {
    if ((await recentWatchdogFires(workspaceId, installSlug, 24, WATCHDOG_SOURCE)) > 0) return false;
    const claimed = await claimWatchdogFire({
      workspaceId,
      installSlug,
      source: WATCHDOG_SOURCE,
      windowHours: 24,
      reason,
      wakeAt: null,
    });
    if (!claimed) return false;

    const who = targetIdentity({ installSlug, workspaceId });
    const { captureImprovement } = await import('../improvements/capture-core');
    await captureImprovement({
      title: `DEAD TARGET: parked ${parked} routine(s) for ${who} — ${String(stamp.state)}`,
      kind: 'bug',
      severity: 'major',
      body:
        `${reason}\n\n` +
        `Probed path: ${String(stamp.path ?? '(unresolved)')}\n` +
        `Confirmed ${String(stamp.confirmations)}× between ${String(stamp.first_seen_at)} and ${String(stamp.last_seen_at)}.\n\n` +
        `These routines were firing against a tree that cannot be read, so every fire was doomed ` +
        `regardless of retry — the condition that burned ~2,400 git-sync attempts over 5 days on ` +
        `ei669-repro-su-b621d (EI-19278517916030043) and drove the fleet deploy panel to crit for 32h.\n\n` +
        `THIS IS REVERSIBLE AND NOTHING WAS DELETED. If the tree is restored and you want the ` +
        `routines back, re-arm them explicitly — routines:set takes ONE routine at a time, so ` +
        `there is a line per parked routine:\n` +
        routineNames
          .map((n) => `    routines:set { name: '${n}', installSlug: '${installSlug}', active: true }`)
          .join('\n') +
        `\n(or routines:group-set to resume a whole group at once).\n` +
        `The reaper does NOT auto-unpark: a flapping mount would otherwise oscillate the routines. ` +
        `If instead the pot is genuinely finished with, leave it parked — that is the intended end state.`,
      scope: `harness:${installSlug}`,
      foundDuring: 'dead-target-reaper sweep (routines tick)',
    });
    return true;
  } catch {
    // A failed escalation must never undo or retry a park: the stamp on the row is the
    // durable record, and the routines are already correctly disabled.
    return false;
  }
}
