#!/usr/bin/env npx tsx
/**
 * check-plane-ratchet.ts — THE INTERPRETABILITY RATCHET, run against live data
 * (agent-state-plane-verification-2026-07-27 P-003).
 *
 * All judgement lives in `agent-plane-ratchet.ts` and is unit-tested there. This
 * file is the thin live-data half: read the series, resolve which known-gap items
 * have closed, print, exit.
 *
 * ⚠ THIS MUST NOT BE ADDED TO THE CI LINT JOB. It reads
 * `harness_shared.agent_plane_measurements`, and CI's Postgres is freshly
 * migrated and empty — so every metric would judge `no-data`, the gate would exit
 * 0 on every run forever, and it would present as coverage. That is exactly the
 * defect filed as WI-6476 against P-001's producer census; adding a second one
 * would be building the trap twice knowing what it is. Its runner belongs
 * alongside the P-015 sweep, on the live database.
 */
import {
  ratchetPlaneSeries,
  UNJUDGEABLE_WINDOW_RUN,
  type RatchetRow,
} from '../packages/operator-core/lib/agent-plane-ratchet';
import type { PlaneZeroReason } from '../packages/operator-core/lib/agent-plane-measurement';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';

/**
 * Statuses that mean the gap item is CLOSED and its exemption is withdrawn.
 * The unified enum folds the legacy tokens onto done/dropped, but rows written
 * before that fold still carry the originals, so match the whole set — treating a
 * legacy `resolved` as still-open would silently keep the exemption alive forever.
 */
const TERMINAL_STATUSES = new Set(['done', 'dropped', 'resolved', 'closed', 'passed', 'deprecated']);

interface StoredMetric {
  id: string;
  interpretable: boolean;
  fillRate: number | null;
  zeroReason: PlaneZeroReason | null;
  /**
   * WI-6562 — the producer's own output for this window, which
   * `sustainedlyUninterpretable` weights the degradation run by. Persisted on every
   * row (it is one of `MetricCounts`' four required counts) but it was never
   * DECLARED here, so the run test could only count windows. Optional because rows
   * written before the ratchet read it are judged on run length alone.
   */
  eligible?: number | null;
  /**
   * WI-6562 — the evidence weight for an occurrence-eligibility metric, whose
   * `eligible` is the zero being explained rather than a producer's output.
   */
  population?: number | null;
}

async function main() {
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
  const postgres = (await import('postgres')).default;
  const sql = postgres(resolveScriptPgUrl().url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });

  let series: Array<{ measuredAt: string; metrics: StoredMetric[] }> = [];
  let closedGaps = new Set<string>();
  /** Who closed each spent gap, and when — the lever a release-fixer needs (fix #1). */
  const gapClosers = new Map<string, { by: string | null; at: string | null }>();
  try {
    const rows = await sql<Array<{ measured_at: string; metrics: StoredMetric[] }>>`
      SELECT measured_at::text AS measured_at, metrics
        FROM harness_shared.agent_plane_measurements
       WHERE workspace_id = ${workspaceId}
       ORDER BY agent_plane_measurements.measured_at ASC
    `;
    series = rows.map((r) => ({
      measuredAt: r.measured_at,
      metrics: (Array.isArray(r.metrics) ? r.metrics : []) as StoredMetric[],
    }));

    // Which known-gap items have CLOSED. A closed gap withdraws the exemption.
    const refs = [...new Set(Object.values((await import('../packages/operator-core/lib/agent-plane-ratchet')).METRIC_KNOWN_GAPS))].filter(Boolean) as string[];
    if (refs.length > 0) {
      // ⚠ The column is `feature_id`/`status`, NOT `id`/`state` — the work_items
      // TOOL renames both in its result shape, so the obvious query compiles in
      // your head and fails in Postgres. And the table is multi-tenant: an
      // unscoped id filter can match another workspace's row.
      const items = await sql<
        Array<{ feature_id: string; status: string; terminal_owner: string | null; closed_ts: string | null }>
      >`
        SELECT feature_id, status, terminal_owner, closed_ts::text AS closed_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${refs})
      `;
      closedGaps = new Set(items.filter((i) => TERMINAL_STATUSES.has(i.status)).map((i) => i.feature_id));
      for (const i of items) {
        if (!closedGaps.has(i.feature_id)) continue;
        const ms = i.closed_ts ? Number(i.closed_ts) : NaN;
        gapClosers.set(i.feature_id, {
          by: i.terminal_owner,
          at: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
        });
      }
      const unknown = refs.filter((r) => !items.some((i) => i.feature_id === r));
      for (const u of unknown) {
        console.error(`⚠ known-gap ref ${u} matches no work-item — the exemption it grants cannot be verified.`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const report = ratchetPlaneSeries({ series, closedGaps });
  const mark: Record<RatchetRow['verdict'], string> = {
    holding: '✓',
    regressed: '✗',
    incoherent: '✗',
    'never-interpretable': '·',
    'window-unjudgeable': '~',
    'no-data': '?',
  };

  console.log('\nINTERPRETABILITY RATCHET — agent-state plane (P-003)\n');
  if (report.windows === 0) {
    console.log('  NO MEASUREMENTS. The series is empty, so there is no high-water mark to');
    console.log('  ratchet against. This says NOTHING about any producer — it is not a pass.\n');
    // Deliberately not exit 1: an empty series is "we looked at nothing", not a
    // defect. It is also why this script must never gate CI (see the header).
    return;
  }

  console.log(`  ${report.windows} windows · headline ${report.currentCount}/${report.metricCount} interpretable (high-water ${report.highWaterCount})\n`);
  for (const r of report.rows) {
    // P-019: a metric whose declared companion is unavailable is NOT a clean ✓,
    // however healthy its own funnel is. Downgrade the mark so the row cannot be
    // skimmed as a pass — the whole point of the item was that this zero was
    // being read as one.
    const marker = (r.unreadableAlone?.length ?? 0) > 0 ? '⚠' : mark[r.verdict];
    console.log(`  ${marker} ${r.metric.padEnd(36)} ${r.verdict}`);
    if ((r.unreadableAlone?.length ?? 0) > 0) {
      console.log(`      NOT READABLE ALONE — needs ${r.unreadableAlone!.join(', ')}, which ${r.unreadableAlone!.length === 1 ? 'is' : 'are'} not holding.`);
      console.log(`      Its own funnel is fine; the NUMBER has no direction without that companion,`);
      console.log(`      so this is uninterpretable, NOT a clean result. Do not read it as a pass.`);
    }
    if (r.verdict === 'regressed') {
      console.log(`      WORKED until ${r.lastInterpretableAt}, and does not now. A producer that`);
      console.log(`      demonstrably ran has stopped — this is a live regression, not an unbuilt metric.`);
    }
    if (r.verdict === 'incoherent') {
      console.log(`      claims interpretable while its own funnel reports nothing eligible.`);
      console.log(`      A zero was relabelled instead of a producer being built.`);
    }
    if (r.verdict === 'window-unjudgeable') {
      // Name the measured SHAPE, not one shape's story. The row carries the same
      // classification the verdict used, so the reporter cannot invert its cause.
      switch (r.windowUnjudgeableReason) {
        case 'occurrence-absent-liveness-independent':
          console.log(`      no registered-cell citation occurred this window. Citation occurrence is`);
          console.log(`      sender-authored and cannot evidence resolver liveness (last interpretable ${r.lastInterpretableAt}).`);
          console.log(`      Reported, NOT failing. Citation-free windows stay unjudgeable regardless of`);
          console.log(`      unrelated message volume; detected-but-noncomparable windows retain the run test.`);
          break;
        case 'occurrence-absent':
          console.log(`      the scanner ran, but the measured occurrence did not happen — a quiet`);
          console.log(`      window, not a dead producer (last interpretable ${r.lastInterpretableAt}).`);
          break;
        case 'fleet-traffic-absent':
          console.log(`      the fleet made NO calls on this metric's surfaces this window — a starved`);
          console.log(`      window, not a dead producer (last interpretable ${r.lastInterpretableAt}).`);
          break;
        case 'producer-output-no-comparable':
        default:
          console.log(`      the producer WROTE this window, but no unit admitted a verdict — a quiet`);
          console.log(`      window, not a dead producer (last interpretable ${r.lastInterpretableAt}).`);
          break;
      }
      if (r.windowUnjudgeableReason !== 'occurrence-absent-liveness-independent') {
        console.log(`      Reported, NOT failing. ${UNJUDGEABLE_WINDOW_RUN} consecutive uninterpretable windows`);
        console.log(`      carrying this metric's usual volume would still be judged a regression —`);
        console.log(`      but a run of STARVED windows is not evidence of one (WI-6562).`);
      }
    }
    if (r.verdict === 'never-interpretable') {
      const gap = judgeGapLine(r);
      console.log(`      ${gap}`);
    }
  }

  console.log(
    `\n  ${report.rows.filter((r) => r.verdict === 'holding').length} holding · ` +
      `${report.failures.length} FAILING · ${report.exempt.length} filed-gap · ` +
      `${report.rows.filter((r) => r.verdict === 'window-unjudgeable').length} quiet-window · ` +
      `${report.unreadableAlone.length} unreadable-alone · ` +
      `${report.rows.filter((r) => r.verdict === 'no-data').length} no-data\n`,
  );

  if (report.failures.length > 0) {
    console.error('✗ interpretability ratchet: the plane got LESS measurable, or a gap is now unexcused.\n');
    for (const f of report.failures) console.error(`    ${f.metric} — ${f.verdict}${f.gapClosed ? ` (${f.knownGap} is CLOSED)` : ''}`);

    // ── EI-18850142725126359 fix #1 — SAY IT IS NOT ABOUT THE CANDIDATE ──────
    //
    // This leg reads LIVE Postgres, so a `gapClosed` failure is caused by a
    // work-item STATE CHANGE, not by any commit. Every candidate reds identically
    // and no code change can green it — but the release-fixer is dispatched with a
    // SHA and a blueprint framed entirely around "reproduce the failing test
    // locally to classify regression-vs-flake", which does not fit at all. That
    // mismatch cost real diagnosis time on candidate 77e8ade1, and the fixes it
    // invites (quarantine the leg, edit METRIC_KNOWN_GAPS, relabel the metric) are
    // all destructive.
    //
    // So this banner is printed FIRST, before the generic do-not-weaken advice,
    // and it names the actual lever: the item, who closed it, and when. Only for
    // gapClosed failures — a `regressed`/`incoherent` verdict may well be about
    // the code, and telling a fixer to ignore the candidate there would be the
    // same misdirection pointed the other way.
    const candidateIndependent = report.failures.filter((f) => f.gapClosed);
    if (candidateIndependent.length > 0) {
      console.error(
        '\n  ⚠ THIS FAILURE IS INDEPENDENT OF THE CANDIDATE COMMIT. It is live-database state:\n' +
          '    a known-gap work-item CLOSED while its metric is still blind. Every candidate reds\n' +
          '    identically, no code change can green it, and the SHA you were dispatched with is\n' +
          '    causally irrelevant. Do NOT try to reproduce it against the candidate, do not\n' +
          '    bisect, and do not classify it regression-vs-flake — it is neither.\n',
      );
      for (const f of candidateIndependent) {
        const who = gapClosers.get(f.knownGap!);
        console.error(
          `    LEVER: ${f.knownGap} (${f.metric})` +
            `${who?.at ? ` — closed ${who.at}` : ''}${who?.by ? ` by ${who.by}` : ''}`,
        );
      }
      console.error(
        '\n    THE SANCTIONED EXIT IS TO REOPEN THAT ITEM, and that is not gate-weakening:\n' +
          '    the exemption says "this metric is blind and the gap is FILED AND OPEN". Closing it\n' +
          '    asserted the producer was built. If it is not, the assertion — not the gate — is the\n' +
          '    thing that was wrong, and reopening restores a true statement. Ask its closer first;\n' +
          "    they may have a map change in flight that greens this on the next candidate.\n" +
          '    A close now warns the closer at the moment they cause this (work_items:complete /\n' +
          '    set_state pre-flight this leg), so a red reaching you here means the warning was\n' +
          '    overridden, missed, or the close predates the guard — worth saying on the item.\n',
      );
    }

    console.error(
      '\n  Do NOT green this by making a metric report a clean zero — its `vacuousPassWhen`\n' +
        '  says "the metric is unbuilt, not clean", and P-015 refusing to round a zero up to\n' +
        '  a pass is the only reason WI-6465 was ever findable. Build the producer, or\n' +
        '  reopen the gap item.\n',
    );
    process.exitCode = 1;
    return;
  }

  // P-019: never let the closing line read as an all-clear while a metric's
  // declared companion is missing. Printed before both terminal branches below,
  // because the `exempt` branch returns and would otherwise swallow it.
  if (report.unreadableAlone.length > 0) {
    for (const r of report.unreadableAlone) {
      console.log(
        `⚠ ${r.metric} is interpretable but NOT READABLE — its spec requires ` +
          `${r.unreadableAlone!.join(', ')}, which ${r.unreadableAlone!.length === 1 ? 'is' : 'are'} unavailable.`,
      );
    }
    console.log(
      '  Reported, not failed: the fix is the companion\'s producer landing, which is a\n' +
        '  filed gap. Relabelling this metric to look clean is the one "fix" that must never\n' +
        '  happen — that is the zero P-019 exists to keep uninterpretable.\n',
    );
  }

  if (report.exempt.length > 0) {
    console.log(
      `✓ nothing regressed — but ${report.exempt.length} metric${report.exempt.length === 1 ? '' : 's'} ` +
        `${report.exempt.length === 1 ? 'has' : 'have'} never been interpretable and ${report.exempt.length === 1 ? 'is' : 'are'} ` +
        `waiting on a filed gap. The plane is not fully measurable.\n`,
    );
    return;
  }
  if (report.unreadableAlone.length > 0) {
    console.log('✓ nothing regressed — but a metric above is not readable without its companion.\n');
    return;
  }
  console.log('✓ every plane metric is interpretable, and none has regressed.\n');
}

function judgeGapLine(r: RatchetRow): string {
  if (!r.knownGap) {
    return 'never interpretable across the whole series, and NOTHING explains it — file the producer gap.';
  }
  if (r.gapClosed) {
    return `${r.knownGap} is CLOSED but this metric is still blind — the producer fix cannot be done.`;
  }
  return `awaiting ${r.knownGap} (open) — reported, not failing the build.`;
}

main().catch((err) => {
  console.error('interpretability ratchet failed to run:', err?.message ?? err);
  process.exitCode = 1;
});
