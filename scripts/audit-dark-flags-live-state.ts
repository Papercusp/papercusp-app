#!/usr/bin/env -S npx tsx
/**
 * audit-dark-flags-live-state.ts — cross-references every DARK_FLAGS entry's
 * declared `case`/`reason` (libs/flags/src/types.ts) against its ACTUAL live
 * resolution: every workspace's PG override row (harness_shared.
 * operator_flag_overrides) plus this process's PAPERCUSP_FLAG_* env vars.
 *
 * WHY THIS EXISTS (WI-37354): the periodic DARK_FLAGS_REVIEW_BY re-review
 * (see the "HYGIENE BOUNDS" block above DARK_FLAGS_REVIEW_BY in types.ts) has
 * always been a TEXT-ONLY read of each entry's case + reason. That method is
 * structurally blind to a flag that is already running live — and it missed
 * exactly that on 2026-08-09: the same review cycle that concluded
 * "CODEX_GATEWAY_OAUTH_PROXY: owner-attended canary not yet run, stays dark"
 * never noticed the flag was resolving `enabled: true` on this box via a
 * runtime override the whole time (confirmed: WI-3596 flipped it via
 * `flags:set`, and no evidence the canary was owner-attended — see that
 * work-item for the open question, which this script does not resolve).
 *
 * This script is the "probe flags:get, not just the entry prose" step the
 * work-item asks every future review to perform. Run it as part of every
 * DARK_FLAGS_REVIEW_BY re-review (see the pointer added next to that
 * constant), and reach for it whenever a live `flags:get` surprises you.
 *
 * WHAT COUNTS AS A FINDING:
 *   - case:'incomplete' or 'parked' live-true ANYWHERE -> CRITICAL. Neither
 *     case has a sanctioned path to be live: 'incomplete' means unverified or
 *     unsafe, 'parked' means a deliberate owner-directed scope cut. A runtime
 *     override flipping either on is exactly the "shipped dark, flipped live,
 *     default never followed" half-finish CLAUDE.md's Feature-flags section
 *     warns against — or worse, an unverified/unsafe surface actually running.
 *   - case:'owner-authority' or 'cutover' live-true anywhere -> INFORMATIONAL.
 *     The runtime override IS the sanctioned per-install ratification path for
 *     these two cases (an owner personally flipped it via /admin/features or
 *     /res) — expected, not a defect. Reported so a reviewer sees the current
 *     shape rather than having to re-derive it by hand.
 *
 * SCOPE: reads every row of harness_shared.operator_flag_overrides (not just
 * the box's active workspace) — a dark flag can be live in ANY workspace even
 * if the active one looks clean. Does NOT evaluate PostHog (a network call,
 * opt-in on this box) — a PostHog-side override would be invisible here
 * exactly as it is invisible to a hand-read of types.ts; the report says so
 * rather than claiming completeness it doesn't have.
 *
 * Usage:  npx tsx scripts/audit-dark-flags-live-state.ts [--json]
 * Exit code: 1 iff at least one CRITICAL finding; 0 otherwise (including when
 * only INFORMATIONAL owner-authority/cutover findings exist).
 */
import { getOrgPg } from '@papercusp/db-org';
import { DARK_FLAGS, type DarkCase } from '@papercusp/flags';

type OverrideRow = { workspace_id: string; payload: Record<string, boolean> | null };

/** Mirrors flag-override-store's env-override key derivation (same formula, read-only here). */
function envOverride(flagKey: string): boolean | null {
  const envKey = `PAPERCUSP_FLAG_${flagKey.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[envKey];
  if (raw === undefined) return null;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const SANCTIONED_LIVE_CASES: ReadonlySet<DarkCase> = new Set<DarkCase>(['owner-authority', 'cutover']);

type Finding = {
  key: string;
  case: DarkCase;
  workspace: string;
  via: 'override' | 'env';
  severity: 'critical' | 'info';
};

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT workspace_id, payload FROM harness_shared.operator_flag_overrides
  `) as unknown as OverrideRow[];

  const darkEntries = [...DARK_FLAGS.entries()];
  const findings: Finding[] = [];

  for (const [key, { case: darkCase }] of darkEntries) {
    const severity: Finding['severity'] = SANCTIONED_LIVE_CASES.has(darkCase) ? 'info' : 'critical';

    if (envOverride(key) === true) {
      findings.push({ key, case: darkCase, workspace: '(env, this process)', via: 'env', severity });
    }
    for (const row of rows) {
      if (row.payload?.[key] === true) {
        findings.push({ key, case: darkCase, workspace: row.workspace_id, via: 'override', severity });
      }
    }
  }

  const critical = findings.filter((f) => f.severity === 'critical');
  const info = findings.filter((f) => f.severity === 'info');

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: critical.length === 0,
          critical,
          info,
          scannedWorkspaces: rows.map((r) => r.workspace_id),
          darkFlagCount: darkEntries.length,
          caveats: ["PostHog-side overrides are not probed (network, opt-in) — this is PG override + env only."],
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Scanned ${darkEntries.length} DARK_FLAGS entries across ${rows.length} workspace override row(s) + this process's env.\n`,
    );
    if (critical.length > 0) {
      console.log(
        `🚨 ${critical.length} CRITICAL — an 'incomplete'/'parked' dark flag resolves live-true (no sanctioned path for this):`,
      );
      for (const f of critical) console.log(`   ${f.key}  (case: ${f.case})  via ${f.via} in ${f.workspace}`);
    } else {
      console.log("✓ No 'incomplete'/'parked' dark flag resolves live-true anywhere scanned.");
    }
    console.log('');
    if (info.length > 0) {
      console.log(
        `ℹ ${info.length} 'owner-authority'/'cutover' flag(s) live-true (expected — the runtime override IS their sanctioned per-install ratification path):`,
      );
      for (const f of info) console.log(`   ${f.key}  (case: ${f.case})  via ${f.via} in ${f.workspace}`);
      console.log('');
    }
    console.log(
      "NOTE: this scans PG overrides + this process's env only — a PostHog-side override is invisible here " +
        '(network, opt-in). See DARK_FLAGS in libs/flags/src/types.ts for the reason behind each case.',
    );
  }

  process.exitCode = critical.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[audit-dark-flags-live-state] FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
