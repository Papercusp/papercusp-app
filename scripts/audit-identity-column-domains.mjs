#!/usr/bin/env node
/**
 * audit-identity-column-domains.mjs — the ATTEST rung under
 * `identity-keyed-state-inventory.test.ts`. (WI-10002452.)
 *
 * THE GAP THIS EXISTS FOR
 * -----------------------
 * The inventory test certifies an identity-keyed column as COVERED when the
 * rebind surface it names exists in rebind-identity.ts. That is a check that a
 * surface is NAMED, not that it can MATCH — and the difference is not academic:
 *
 *   'owner_directives.owner_id': { status: 'covered', surface: 'owner-directives' }
 *
 * named a real surface whose predicate was `WHERE owner_id = <from-session-id>`
 * against a column that holds the HUMAN owner label. Measured over all 203 live
 * rows: 'owner' x181, 'owner' x22 — zero session-shaped values, and `owner_id =
 * recorded_by` false for every row. The UPDATE had never moved a row and could
 * not. So the one guard built to catch stranded identity columns (EI-8999 /
 * WI-3642) was reporting this one as protected, and any later reader auditing
 * "is directive binding rebind-safe?" got a confident yes.
 *
 * WHY THIS IS A SCRIPT AND NOT AN ASSERTION IN THAT TEST
 * -----------------------------------------------------
 * The defect is in the column's VALUE DOMAIN, which only live data reveals.
 * The inventory test is deliberately a PURE TEXT scan with no PG dependency —
 * that is what lets it run in the release green-checkpoint worktree — and an
 * integration test would be worse than useless here: a testcontainers database
 * is EMPTY, so every column would be unmeasurable and the check would pass
 * vacuously while asserting nothing. Per CLAUDE.md's derived-truth ladder this
 * is the ATTEST rung: reconcile against the runtime population on a sweep.
 *
 * THE ORACLE
 * ----------
 * For each COVERED column, count values that appear in the identity universe —
 * `harness_shared.session_briefs.owner_id`, the durable per-session record
 * (14,192 distinct ids live, versus 90 in the live-only coord_presence roster,
 * which would false-red any mostly-historical table).
 *
 * A column with rows but ZERO intersection is not agent identity, so whatever
 * surface claims to re-key it is re-keying nothing. Measured headroom on the
 * real population — every legitimate covered column scores >= 66 intersecting
 * rows, while the known defect scores 0 of 203 — so a >= 1 threshold sits far
 * from every true positive rather than being tuned against them.
 *
 * ⚠ `unmeasurable` (no non-null rows) is reported as SKIPPED, never as a pass:
 * an empty column cannot corroborate anything, and reporting it green is the
 * same false-negative class this script exists to catch. If NOTHING was
 * measurable the run exits 2 — the instrument measured nothing, which is not a
 * clean bill of health.
 *
 * Usage:
 *   node scripts/audit-identity-column-domains.mjs [--json] [--inventory <path>]
 *
 * Exit: 0 clean · 1 at least one inert-domain column · 2 nothing measurable /
 * misuse (never conflate with 0).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_INVENTORY = resolve(
  REPO_ROOT,
  'packages/operator-core/lib/agent-tools/coordination/identity-keyed-state-inventory.test.ts',
);

/** The durable identity population. See the header for why this is
 *  session_briefs and not the live-only coord_presence roster. */
export const IDENTITY_UNIVERSE_SQL =
  'SELECT owner_id FROM harness_shared.session_briefs';

/** Columns whose value domain is legitimately NOT pure agent identity, so a
 *  zero intersection is not evidence of a dead surface. Each needs a reason —
 *  this is an exemption from a measurement, so it earns the same scrutiny as an
 *  `exempt` classification in the inventory itself. */
export const DOMAIN_EXEMPT = new Map([
  [
    'agent_facts.scope_ref',
    "scope_ref is only identity-shaped when paired with scope='owner'; the same column legitimately holds work-item refs (EI-…, WI-…) for other scopes, so a mixed domain is correct here rather than inert.",
  ],
]);

/**
 * Parse the COVERED entries out of the inventory test's ALLOWLIST.
 * Pure + exported so the oracle below is testable without a database.
 * @param {string} inventorySrc
 * @returns {string[]} `table.column` keys classified `covered`
 */
export function extractCoveredColumns(inventorySrc) {
  const start = inventorySrc.indexOf('const ALLOWLIST');
  if (start < 0) throw new Error('ALLOWLIST not found — inventory test shape changed');
  const end = inventorySrc.indexOf('/** Column-name patterns', start);
  const body = inventorySrc.slice(start, end < 0 ? undefined : end);
  const re = /'([a-z0-9_]+\.[a-z0-9_]+)':\s*\{[^}]*?status:\s*'covered'/gs;
  return [...body.matchAll(re)].map((m) => m[1]);
}

/**
 * The oracle. Pure: takes measured counts, returns verdicts.
 * @param {Array<{ key: string, nonnull: number, inUniverse: number, distinct?: number }>} rows
 * @returns {{ verdict: 'clean'|'inert-domain'|'no-measurement',
 *             failures: Array<{ key: string, nonnull: number, distinct: number|undefined, reason: string }>,
 *             unmeasurable: string[], exempted: string[], measured: number }}
 */
export function classifyIdentityColumnDomains(rows) {
  const failures = [];
  const unmeasurable = [];
  const exempted = [];
  let measured = 0;

  for (const row of rows) {
    if (DOMAIN_EXEMPT.has(row.key)) {
      exempted.push(row.key);
      continue;
    }
    // An empty column is UNMEASURABLE, not passing. Nothing about a column with
    // no rows corroborates that its surface can match.
    if (!row.nonnull) {
      unmeasurable.push(row.key);
      continue;
    }
    measured += 1;
    if (row.inUniverse === 0) {
      failures.push({
        key: row.key,
        nonnull: row.nonnull,
        distinct: row.distinct,
        reason:
          `classified 'covered' but ZERO of ${row.nonnull} non-null values appear in the identity ` +
          'universe — the column does not hold agent session ids, so the rebind surface naming it ' +
          'cannot be re-keying anything. Either the surface targets the wrong column (WI-10002452), ' +
          "or the column belongs in the inventory as 'exempt' with a stated reason.",
      });
    }
  }

  // Refuse to report a clean bill when the instrument measured nothing.
  const verdict = failures.length
    ? 'inert-domain'
    : measured === 0
      ? 'no-measurement'
      : 'clean';
  return { verdict, failures, unmeasurable, exempted, measured };
}

/** Build the per-column measurement SQL. Exported for the test. */
export function buildProbeSql(keys) {
  return keys
    .map((key) => {
      const [table, column] = key.split('.');
      return (
        `SELECT '${key}' AS key, count(${column})::int AS nonnull, ` +
        `count(*) FILTER (WHERE ${column} IN (${IDENTITY_UNIVERSE_SQL}))::int AS in_universe, ` +
        `count(DISTINCT ${column})::int AS distinct_vals FROM harness_shared.${table}`
      );
    })
    .join('\nUNION ALL\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const invIdx = argv.indexOf('--inventory');
  const inventoryPath = invIdx >= 0 ? resolve(argv[invIdx + 1]) : DEFAULT_INVENTORY;

  const covered = extractCoveredColumns(readFileSync(inventoryPath, 'utf8'));
  if (covered.length === 0) {
    console.error('AUDIT_IDENTITY_DOMAINS status=no-measurement reason=zero-covered-entries-parsed');
    process.exit(2);
  }

  const [{ default: postgres }, { resolveScriptPgUrl }] = await Promise.all([
    import('postgres'),
    import('./lib/pg-url.mjs'),
  ]);
  const sql = postgres(resolveScriptPgUrl().url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });

  let rows;
  try {
    const probed = await sql.unsafe(buildProbeSql(covered));
    rows = probed.map((r) => ({
      key: r.key,
      nonnull: Number(r.nonnull),
      inUniverse: Number(r.in_universe),
      distinct: Number(r.distinct_vals),
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }

  const result = classifyIdentityColumnDomains(rows);

  if (json) {
    console.log(JSON.stringify({ ...result, rows }, null, 2));
  } else {
    console.log(
      `AUDIT_IDENTITY_DOMAINS status=${result.verdict} covered=${covered.length} ` +
        `measured=${result.measured} unmeasurable=${result.unmeasurable.length} ` +
        `exempt=${result.exempted.length} failures=${result.failures.length}`,
    );
    for (const f of result.failures) {
      console.error(`\n  ✗ ${f.key} (${f.nonnull} non-null, ${f.distinct} distinct)\n    ${f.reason}`);
    }
    if (result.unmeasurable.length) {
      console.log(
        `  ⚠ SKIPPED (no rows — unmeasurable, NOT a pass): ${result.unmeasurable.join(', ')}`,
      );
    }
  }

  process.exit(result.verdict === 'clean' ? 0 : result.verdict === 'inert-domain' ? 1 : 2);
}

// Only run when invoked directly, so the exports above stay importable.
// isCliEntry (not a hand-rolled import.meta.url comparison): every module
// inlined by esbuild inherits the BUNDLE entry's import.meta.url, which would
// make a hand-rolled check true for every imported CLI and fire main() during
// host boot (EI-650).
const { isCliEntry } = await import('@papercusp/operator-core/lib/util/cli-entry');
if (isCliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error('AUDIT_IDENTITY_DOMAINS status=error', err?.message ?? err);
    process.exit(2);
  });
}
