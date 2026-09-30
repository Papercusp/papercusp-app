/**
 * Fleet EKG backtest — replay the drift detector over the HISTORICAL
 * agent_activity stream, day by day (self-learning-frontier-2026-06-12
 * P-030 / FB-10's evidence leg).
 *
 * For each day D with data: window = sessions that ENDED on D; baseline =
 * sessions ended in the preceding `--baseline-days` (default 7). Detection +
 * attribution run exactly as the live tick would (same features.ts/drift.ts
 * cores, same change-ledger read), but NOTHING alarms and (without
 * --persist) nothing writes — a pure read-and-report pass.
 *
 *   tsx lib/fleet-ekg/backtest-cli.ts                 # dry report
 *   tsx lib/fleet-ekg/backtest-cli.ts --persist       # also backfill fleet_ekg_sessions
 *   tsx lib/fleet-ekg/backtest-cli.ts --min-baseline 20
 *
 * Operational CLI (seed-script idiom), not a test — the unit/integration
 * suites live next to the modules they cover.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { readRecentChanges } from '../change-ledger/change-ledger';
import { embedSession, type SessionVector } from './features';
import { attributeFindings, detectDrift, ATTRIBUTION_LOOKBACK_MS } from './drift';
import { persistSessionVectors, readSessionEvents } from './scan';

const DAY_MS = 86_400_000;

function argNum(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function main(): Promise<void> {
  const persist = process.argv.includes('--persist');
  const baselineDays = argNum('--baseline-days', 7);
  const minBaseline = argNum('--min-baseline', 30);
  const lookbackDays = argNum('--lookback-days', 60);
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();

  const sessions = await readSessionEvents(sql, ws, Date.now() - lookbackDays * DAY_MS);
  const vectors: SessionVector[] = [];
  let skipped = 0;
  for (const s of sessions) {
    const v = embedSession(s);
    if (v) vectors.push(v);
    else skipped += 1;
  }
  if (vectors.length === 0) {
    console.log('[ekg-backtest] no embeddable sessions in range — nothing to report');
    await sql.end({ timeout: 5 });
    return;
  }
  if (persist) {
    await persistSessionVectors(sql, ws, vectors);
    console.log(`[ekg-backtest] persisted ${vectors.length} session vectors (backfill)`);
  }

  const firstDay = Math.floor(Math.min(...vectors.map((v) => v.endedAtMs)) / DAY_MS);
  const lastDay = Math.floor(Math.max(...vectors.map((v) => v.endedAtMs)) / DAY_MS);
  const ledger = await readRecentChanges(ws, { sinceMs: firstDay * DAY_MS - ATTRIBUTION_LOOKBACK_MS, limit: 1000 });

  console.log(
    `[ekg-backtest] ${vectors.length} sessions embedded (${skipped} too small), ` +
      `${new Date(firstDay * DAY_MS).toISOString().slice(0, 10)} … ${new Date(lastDay * DAY_MS).toISOString().slice(0, 10)}, ` +
      `${ledger.length} change-ledger rows in range`,
  );

  for (let day = firstDay; day <= lastDay; day++) {
    const windowStart = day * DAY_MS;
    const windowEnd = windowStart + DAY_MS;
    const date = new Date(windowStart).toISOString().slice(0, 10);
    const window = vectors.filter((v) => v.endedAtMs >= windowStart && v.endedAtMs < windowEnd);
    const baseline = vectors.filter(
      (v) => v.endedAtMs >= windowStart - baselineDays * DAY_MS && v.endedAtMs < windowStart,
    );
    const result = detectDrift(baseline, window, { minBaselineSessions: minBaseline });
    if (result.status !== 'ok') {
      console.log(`${date}  ${String(result.windowSessions).padStart(4)}w/${String(result.baselineSessions).padStart(4)}b  (${result.status})`);
      continue;
    }
    const findings = attributeFindings(result.findings, ledger, windowEnd);
    const summary =
      findings.length === 0
        ? 'steady'
        : findings
            .map((f) => {
              const move =
                f.kind === 'numeric' && f.baselineSummary != null && f.windowSummary != null
                  ? ` ${f.baselineSummary.toPrecision(3)}→${f.windowSummary.toPrecision(3)}`
                  : '';
              return `${f.feature}[${f.severity} ${f.score.toFixed(2)}${move}${f.attributed ? '' : ' UNATTRIB'}]`;
            })
            .join(' ');
    console.log(`${date}  ${String(result.windowSessions).padStart(4)}w/${String(result.baselineSessions).padStart(4)}b  ${summary}`);
  }
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[ekg-backtest] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
