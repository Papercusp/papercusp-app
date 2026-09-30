/**
 * error-streak-alarm.ts — the Scout cycle ERROR-STREAK pager
 * (scorecard-blender-pipeline-fixes-2026-07-11 P-001 / WI-4274).
 *
 * THE GAP: the autoloop circuit gate BACKS OFF on repeated cycle failures but
 * pages NOBODY — so transport-death streaks run silently until a human happens
 * to look (2026-07-12 morning: 6 consecutive hourly cycles died on "rate-limit
 * pause exceeds maxWait" unnoticed; historically the @singleton Scout produced
 * 0 ideas for 12 days the same silent way). The audit (WI-4250) called this
 * out: "circuit gate exists but pages nobody".
 *
 * THE FIX: after every ERROR tick lands on the ledger, check whether the
 * newest N ATTEMPTED scout cycles for the workspace are ALL errors (default
 * N=3 ≈ 1.5h of dead hourly cycles; minutes under volume firing). On a streak,
 * fire ONE debounced escalation: a durable `@role:mug`-addressed coord message
 * naming the streak + the distinct error messages (the mug-brief-launch slot
 * drains it into every future Mug wake — the fireGradingNudge "reliable half").
 * Debounced per-workspace over `hive_watchdog_fires`
 * (source='scout-error-streak') so a continuing streak pages at most once per
 * window, never per tick.
 *
 * ⚠ THE INVERSION THIS READS ONLY ATTEMPTS TO AVOID (P-010, measured
 * 2026-08-09). The streak window originally spanned EVERY tick, gated ones
 * included — so the circuit gate's own turnaway rows, written to this same
 * ledger, RESET the streak between two failures. The alarm was therefore
 * disarmed by the exact mechanism it exists to report on: the harder the
 * circuit gate worked, the less this could fire. The two are anti-correlated
 * BY CONSTRUCTION, which is why "circuit gate exists but pages nobody" (the
 * gap above) survived the fix aimed at it.
 *
 * Measured over the 2026-08-02→08-09 outage (papercusp-workspace): 63 error
 * ticks, of which 37 were immediately preceded by a GATED tick. The all-ticks
 * rule could fire on only 8 of them, landing in 3 distinct debounce windows —
 * and exactly 3 pages were sent, across a 6-day outage, with a 3.7-day silent
 * gap (08-04T10:10Z → 08-08T02:39Z) covering 43 of the 63 errors. Counting
 * only ATTEMPTS yields 44 trigger points in 12 windows on the same history.
 * (Counting circuit-gated ticks AS failures instead was measured identical —
 * 44/12 — so this narrower, gate-reason-agnostic rule was preferred: a gate
 * added later needs no change here.)
 *
 * Same fail-soft watchdog-family contract as ungraded-filings-watchdog.ts:
 * pure decider split from the PG/coord edge, env-tunable threshold with a
 * `<=0` kill switch, NEVER throws into the tick-record path (the ledger write
 * must never fail because paging hiccuped).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

// ── tunables ──────────────────────────────────────────────────────────────────

/** Consecutive ERROR ticks that constitute a pageable streak. Default 3;
 *  env PAPERCUSP_SCOUT_ERROR_STREAK_THRESHOLD; `<=0` DISABLES the alarm. */
export function scoutErrorStreakThreshold(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_ERROR_STREAK_THRESHOLD ?? 3);
  return Number.isFinite(n) ? n : 3;
}

/** Debounce window: a continuing streak re-pages at most once per this many
 *  hours (default 6). */
export function scoutErrorStreakDebounceHours(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_ERROR_STREAK_DEBOUNCE_HOURS ?? 6);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * The tick statuses that represent an ATTEMPTED cycle — the only ones the streak
 * window may contain. A 'gated' tick is a decision NOT to run a cycle (circuit /
 * min-interval / no-trigger / no-capacity); it is neither a success nor a failure,
 * so it must not break a streak of failures. See the module header's INVERSION note.
 *
 * ONE constant feeds BOTH the SQL predicate and {@link isAttemptTick}, so the
 * window the query returns and the window the decider assumes cannot drift apart.
 */
export const ATTEMPT_STATUSES = ['ran', 'error'] as const;

/** Does this tick represent an attempted cycle (see {@link ATTEMPT_STATUSES})? */
export function isAttemptTick(status: string): boolean {
  return (ATTEMPT_STATUSES as readonly string[]).includes(status);
}

// ── pure decider (unit-tested with no DB) ─────────────────────────────────────

/**
 * PURE: do the newest ticks constitute an error streak? `statusesNewestFirst`
 * is the newest-first status column of the last `threshold` ticks — a streak
 * iff we HAVE `threshold` ticks and every one of them is 'error'. A
 * `threshold <= 0` (kill switch) never streaks.
 */
export function isErrorStreak(statusesNewestFirst: readonly string[], threshold: number): boolean {
  if (threshold <= 0) return false;
  if (statusesNewestFirst.length < threshold) return false;
  return statusesNewestFirst.slice(0, threshold).every((s) => s === 'error');
}

// ── the check-and-fire edge ───────────────────────────────────────────────────

/**
 * Called (fire-and-forget) by recordScoutTick after an ERROR tick lands.
 * Workspace-wide read (the install_slug key drifts — same lesson as
 * signal-accumulator.ts); debounced; never throws.
 */
export async function checkAndFireErrorStreakAlarm(opts: {
  workspaceId?: string;
  installSlug?: string | null;
}): Promise<void> {
  try {
    const threshold = scoutErrorStreakThreshold();
    if (threshold <= 0) return; // kill switch
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    // The window is the newest `threshold` ATTEMPTED cycles — gated ticks are
    // filtered HERE rather than after the fetch, because a LIMIT applied before
    // the filter would return a short window (and silently no-streak) exactly
    // when the circuit gate is busiest. Predicate derived from ATTEMPT_STATUSES
    // so it cannot drift from isAttemptTick.
    const rows = await sql<Array<{ status: string; detail: unknown }>>`
      SELECT status, detail
        FROM harness_shared.scout_ticks
       WHERE workspace_id = ${ws} AND origin = 'scout'
         AND status = ANY(${ATTEMPT_STATUSES as readonly string[]})
       ORDER BY tick_at DESC
       LIMIT ${threshold}`;
    if (!isErrorStreak(rows.map((r) => r.status), threshold)) return;

    // Debounce over hive_watchdog_fires (the watchdog-family dedup surface).
    // EI-16038: cheap non-atomic pre-check first (avoid the transaction round-trip
    // on the common no-streak tick); the atomic claim below (after the reason is
    // computed) is authoritative and backs off geometrically once the same error
    // keeps re-firing unchanged.
    const slug = opts.installSlug ?? '@singleton';
    const { recentWatchdogFires, claimWatchdogFire } = await import('../pot/watchdog');
    const windowHours = scoutErrorStreakDebounceHours();
    if ((await recentWatchdogFires(ws, slug, windowHours, 'scout-error-streak')) > 0) return;

    const errors = [
      ...new Set(
        rows
          .map((r) => {
            const d = r.detail as { error?: unknown } | null;
            return typeof d?.error === 'string' ? d.error.slice(0, 160) : null;
          })
          .filter((e): e is string => e !== null),
      ),
    ];

    // EI-20949117919419640: `opts.installSlug` is the Scout TICK LEDGER's
    // partition key, not necessarily a federating harness/hive-home slug.
    // Under FLAGS.WORKSPACE_COORDINATION (default ON — see
    // `workspaceBrainScopeKey`), `recordScoutTick` writes ticks with
    // `install_slug` set to the WORKSPACE id itself (a sentinel meaning
    // "workspace-wide", not any one hive — scout-cycle-action.ts's own
    // "ctx.installSlug is the workspace SENTINEL — not a hive" comment).
    // `SendOptions.harnessSlug` requires the OPPOSITE contract: a string
    // "names a federating harness/hive-home", verbatim-stamped onto the
    // outgoing coord_event_log row and captured into `substrate_outbox` for
    // drain. A harness that is never booted (the sentinel never is — it is
    // not a registered pot) can never drain its outbox rows, so every
    // workspace-scoped error-streak page piled up as a permanent, growing
    // `outbox-health` SLO breach. Thread the slug through ONLY when it is a
    // real per-hive value (differs from the workspace id); the sentinel
    // degrades to `null` — explicit machine-local, exactly the semantics
    // migration 150 already gives an un-scoped/workspace-wide coord event.
    const nudgeHarnessSlug = opts.installSlug && opts.installSlug !== ws ? opts.installSlug : null;
    const reason = `${threshold}-cycle error streak: ${errors[0] ?? 'no detail'}`;
    // EI-6777/EI-16038: claim the atomic debounce slot (closes the check-then-act race
    // the old recentWatchdogFires+recordFire pattern had, and backs off geometrically
    // once the same error keeps re-firing unchanged) BEFORE paging — only the winner
    // pages.
    const claimed = await claimWatchdogFire({ workspaceId: ws, installSlug: slug, source: 'scout-error-streak', windowHours, reason, wakeAt: null });
    if (!claimed) return;

    const summary =
      `Scout cycle ERROR STREAK: the last ${threshold} ATTEMPTED cycles ALL failed — ideation is down ` +
      `and the circuit gate is only backing off, not fixing it. Distinct errors: ` +
      (errors.length > 0 ? errors.join(' | ') : '(no error detail recorded)') +
      `. Investigate the transport (gateway pool saturation / account limits / ideator timeouts); ` +
      `scout_ticks has per-cycle detail. Signal is NOT lost — the accumulator watermark only ` +
      `advances on a successful cycle — but nothing routes until a cycle lands.`;

    // WI-37625: this used to be a bare `@role:mug` park. That slot is drained by exactly
    // one consumer (pot/mug-brief-launch.ts, which runs at Mug spawn), so with the spawn
    // gate closed (D-018) it had NO reader — and this is a PAGER, so it went silent
    // precisely when Scout was down. Route through the SHARED nudge-recipient ladder
    // instead (reuse, never a second ladder): live su → direct, nobody live → the owner,
    // and the legacy park is preserved when the tier is switched back on for testing.
    const { deliverScoutNudge } = await import('./nudge-recipient');
    const { resolveMugOwner } = await import('../pot/placement-watchdog');
    const mugOwner = await resolveMugOwner(sql, ws, slug).catch(() => null);
    const recipient = await deliverScoutNudge({
      workspaceId: ws,
      mugOwner,
      summary,
      source: 'scout-error-streak-alarm',
      body: summary,
      harnessSlug: nudgeHarnessSlug,
      payload: { kind: 'scout-error-streak', threshold, errors },
      // This alarm is a pager, not a quiet review nudge. The ladder persists the
      // message first, then re-invokes the selected su so the page cannot sit unread.
      wakeSu: true,
    });

    // The ladder picks WHO; urgency picks HOW LOUD (D-038). For the three watchdogs an
    // `unresolved` verdict is correctly a quiet best-effort — a presence hiccup is not
    // evidence that nobody is home, and paging the owner on one would cry wolf. A PAGER
    // inverts that trade: the whole point of this alarm is that ideation is ALREADY down,
    // so failing to determine a recipient must not also silence it. Escalate explicitly.
    if (recipient.kind === 'unresolved') {
      const [{ sendMessage }, { runWithWorkspace }] = await Promise.all([
        import('../agent-tools/coordination/messages'),
        import('../workspace-als'),
      ]);
      await runWithWorkspace(ws, () =>
        sendMessage(
          {
            ownerId: 'scout-error-streak-alarm',
            ownerLabel: 'scout-error-streak-alarm',
            source: 'static-client',
            workspaceId: ws,
            userId: null,
          },
          {
            to: ['human'],
            summary,
            body:
              `${summary}\n\n— The Scout nudge ladder could not determine a recipient ` +
              `(${recipient.why}). Escalated to you directly because this is a PAGER: ` +
              `staying quiet on an undetermined recipient is exactly the failure it exists to prevent.`,
          },
        ),
      );
    }
  } catch (e) {
    console.warn(
      `[scout-error-streak] alarm failed (tick recording unaffected): ${e instanceof Error ? e.message : e}`,
    );
  }
}
