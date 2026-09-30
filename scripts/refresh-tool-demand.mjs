#!/usr/bin/env node
/**
 * refresh-tool-demand.mjs — THE FROZEN DEMAND SNAPSHOT
 * (deterministic-tool-definition-delivery-2026-09-21 P-002, ruled by D-001 + D-003.)
 *
 * ── WHAT THIS IS, AND WHY IT IS A SEPARATE COMMAND ─────────────────────────
 *
 * Which MCP tools an agent sees advertised up front is about to stop being a
 * hand-maintained seed list and start being DERIVED from measured demand. The
 * measurement lives in `harness_shared.tool_invocations`, which is a live,
 * always-moving table — and a generator that reads it at build time would be
 * wrong in three separate ways at once (D-003):
 *
 *   · it answers differently on every run, so the generated seed is not
 *     reproducible and its diff is not reviewable;
 *   · it cannot run in the green-checkpoint checkout or in CI, which have no
 *     route to the operator database;
 *   · it makes a `--check` drift guard meaningless — "drift" against a moving
 *     input is noise, not a signal.
 *
 * So demand is CAPTURED here, into a committed JSON file, by an explicitly-run
 * command. THIS SCRIPT IS THE ONLY THING IN THE PIPELINE THAT TOUCHES THE DB.
 * The generator and every test are pure functions of the committed snapshot.
 * Refreshing is a reviewable diff that shows exactly which tools moved.
 *
 * ── THE NUMERATOR IS DISTINCT CALLERS, NOT CALL COUNT (D-001) ──────────────
 *
 * "How frequently used" reads like call count, and call count is the wrong
 * operationalisation: it is dominated by loop and heartbeat machinery, not by a
 * model deciding what to reach for next. On a 14-day window:
 *
 *     activity:report   619,136 calls / 2,646 callers  → 234 calls per caller
 *     work_items:get     38,495 calls / 1,027 callers  →  37 calls per caller
 *
 * The first is one loop firing over and over; the second is genuine breadth of
 * need. DISTINCT CALLERS measures how many independent agents ever had to reach
 * for a tool, which is exactly what an up-front advertisement buys. `calls` is
 * captured too, but only as the policy's tiebreak.
 *
 * `coord_owner_id` is the caller identity, and it is stable across a
 * carry-respawn (verified 2026-09-21: an su session's ownerId is byte-identical
 * either side of a respawn), so a long-lived session is counted once rather than
 * once per context boundary.
 *
 * ── THE VACUOUS SNAPSHOT THIS REFUSES TO WRITE ─────────────────────────────
 *
 * An empty or thin result set does not look like a failure — it looks like a
 * tidy snapshot in which almost nothing is in demand. Committed, it would drop
 * the entire advertised seed on the next generator run, and the diff would look
 * deliberate. A pruned table, a wrong `--workspace`, a window that predates the
 * ledger, or a fresh database all produce exactly that shape. So a snapshot
 * whose measurement is implausibly thin is REFUSED rather than written; pass
 * --allow-thin (with your reason in the commit) to override deliberately.
 *
 * Coverage is also recorded rather than assumed: `totals.unattributedCalls`
 * counts rows with no `coord_owner_id`, which contribute to `calls` but to no
 * tool's `callers`. A reviewer can see how much of the ledger the numerator
 * could actually see instead of taking the caller counts as complete.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   npm run refresh:tool-demand                     # write the committed snapshot
 *   npm run refresh:tool-demand -- --dry-run        # measure + report, write nothing
 *   npm run refresh:tool-demand -- --window-days 30
 *   npm run refresh:tool-demand -- --workspace all  # every workspace, not just this one
 *   npm run refresh:tool-demand -- --out /tmp/x.json
 *
 * Exit codes: 0 wrote (or dry-ran) a sound snapshot · 1 refused — the
 * measurement is too thin to be believed · 2 misuse / connection failure.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

import { connectScriptPg, resolveScriptPgUrl, describePgUrlResolution } from './lib/pg-url.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The committed snapshot. Read by the generator and by every test; never by them from the DB. */
export const DEFAULT_OUT = 'packages/operator-core/lib/agent-tools/tool-demand-snapshot.json';

/** The default measurement window. Long enough to cover a slow-cadence tool, short enough to track real drift. */
export const DEFAULT_WINDOW_DAYS = 14;

/**
 * Below these, the measurement is not believable as a picture of fleet demand —
 * it is a misconfigured query. Chosen an order of magnitude under the observed
 * live values (462 tools / 3,176 callers on a 14-day window) so a genuine quiet
 * period never trips it but an empty/pruned/wrong-scope read always does.
 */
export const THIN_SNAPSHOT_FLOOR = { tools: 25, callers: 10 };

/** The demand query. Recorded verbatim in the snapshot so a reviewer can re-run it. */
export const DEMAND_SQL = `SELECT tool_name AS name,
       count(DISTINCT coord_owner_id)::int AS callers,
       count(*)::int AS calls
  FROM harness_shared.tool_invocations
 WHERE invoked_at >= $1 AND invoked_at < $2
   AND ($3::text IS NULL OR workspace_id = $3)
 GROUP BY tool_name
 ORDER BY tool_name`;

/** The totals query. Same absolute bounds, so the two reads cannot disagree. */
export const TOTALS_SQL = `SELECT count(*)::int AS calls,
       count(DISTINCT tool_name)::int AS tools,
       count(DISTINCT coord_owner_id)::int AS callers,
       count(*) FILTER (WHERE coord_owner_id IS NULL)::int AS unattributed_calls
  FROM harness_shared.tool_invocations
 WHERE invoked_at >= $1 AND invoked_at < $2
   AND ($3::text IS NULL OR workspace_id = $3)`;

/**
 * @param {string[]} argv
 * @returns {{ windowDays: number, workspace: string | null, out: string, dryRun: boolean, allowThin: boolean }}
 */
export function parseArgs(argv) {
  const opts = {
    windowDays: DEFAULT_WINDOW_DAYS,
    workspace: /** @type {string | null} */ ('papercusp-workspace'),
    out: DEFAULT_OUT,
    dryRun: false,
    allowThin: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    if (arg === '--window-days') {
      const n = Number(take());
      if (!Number.isInteger(n) || n <= 0) throw new Error('--window-days must be a positive integer');
      opts.windowDays = n;
    } else if (arg === '--workspace') {
      const v = take();
      // `all` is spelled out rather than implied by omitting the flag: a snapshot
      // scoped to one tenant and one scoped to the whole fleet are different
      // measurements, and which one you took must be visible in the file.
      opts.workspace = v === 'all' ? null : v;
    } else if (arg === '--out') {
      opts.out = take();
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--allow-thin') {
      opts.allowThin = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * The snapshot document, assembled from a measurement. Pure — no IO — so the
 * shape is testable without a database.
 *
 * @param {{ capturedAt: string, windowDays: number, windowStart: string, windowEnd: string,
 *           workspace: string | null, totals: { calls: number, tools: number, callers: number, unattributedCalls: number },
 *           rows: Array<{ name: string, callers: number, calls: number }> }} m
 */
export function buildSnapshot(m) {
  return {
    _generatedBy: 'npm run refresh:tool-demand',
    _doNotEdit:
      'Committed measurement, not hand-maintained data. Regenerate with the command above; the diff is the review surface.',
    capturedAt: m.capturedAt,
    windowDays: m.windowDays,
    window: { start: m.windowStart, end: m.windowEnd },
    workspace: m.workspace ?? 'all',
    source: { relation: 'harness_shared.tool_invocations', numerator: 'distinct coord_owner_id (D-001)' },
    sql: DEMAND_SQL,
    sqlParams: [m.windowStart, m.windowEnd, m.workspace],
    totals: m.totals,
    // Sorted by NAME, never by demand: a demand sort reshuffles every row when a
    // single tool moves, which is exactly the diff this file exists to keep readable.
    tools: [...m.rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/**
 * @param {{ tools: number, callers: number }} totals
 * @returns {string | null} the refusal reason, or null when the measurement is believable
 */
export function judgeThinness(totals) {
  if (totals.tools < THIN_SNAPSHOT_FLOOR.tools || totals.callers < THIN_SNAPSHOT_FLOOR.callers) {
    return `measured ${totals.tools} tool(s) / ${totals.callers} caller(s), under the believability floor of ${THIN_SNAPSHOT_FLOOR.tools} tools / ${THIN_SNAPSHOT_FLOOR.callers} callers`;
  }
  return null;
}

const HELP = `refresh-tool-demand — capture MCP tool demand into the committed snapshot

  --window-days <n>   measurement window, default ${DEFAULT_WINDOW_DAYS}
  --workspace <id>    tenant scope, or "all"; default papercusp-workspace
  --out <path>        output path, default ${DEFAULT_OUT}
  --dry-run           measure and report, write nothing
  --allow-thin        write even when the measurement is under the believability floor
`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`refresh-tool-demand: ${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // Absolute bounds, resolved ONCE and passed to both queries. A relative
  // `now() - interval` in each would let a row land between them and make the
  // totals disagree with the rows they are meant to total — and it would leave
  // the recorded SQL un-reproducible, since `now()` means something different
  // to the reviewer who re-runs it.
  const capturedAt = new Date();
  const windowEnd = capturedAt.toISOString();
  const windowStart = new Date(capturedAt.getTime() - opts.windowDays * 86_400_000).toISOString();
  const params = [windowStart, windowEnd, opts.workspace];

  let client;
  try {
    client = await connectScriptPg();
  } catch (err) {
    process.stderr.write(`refresh-tool-demand: could not connect — ${err.message}\n`);
    return 2;
  }

  let rows;
  let totals;
  try {
    const [demand, totalsRes] = await Promise.all([
      client.query(DEMAND_SQL, params),
      client.query(TOTALS_SQL, params),
    ]);
    rows = demand.rows.map((r) => ({ name: r.name, callers: r.callers, calls: r.calls }));
    const t = totalsRes.rows[0] ?? {};
    totals = {
      calls: t.calls ?? 0,
      tools: t.tools ?? 0,
      callers: t.callers ?? 0,
      unattributedCalls: t.unattributed_calls ?? 0,
    };
  } catch (err) {
    process.stderr.write(`refresh-tool-demand: query failed — ${err.message}\n`);
    return 2;
  } finally {
    await client.end().catch(() => {});
  }

  const scope = opts.workspace ?? 'all';
  process.stdout.write(
    `TOOL_DEMAND_MEASURED window=${opts.windowDays}d workspace=${scope} tools=${totals.tools} callers=${totals.callers} calls=${totals.calls} unattributedCalls=${totals.unattributedCalls}\n`,
  );
  process.stdout.write(`  ${describePgUrlResolution(resolveScriptPgUrl())}\n`);

  const thin = judgeThinness(totals);
  if (thin && !opts.allowThin) {
    process.stderr.write(
      `refresh-tool-demand: REFUSED — ${thin}.\n` +
        `  An empty or thin window is indistinguishable from "almost nothing is in demand", and committing\n` +
        `  it would silently drop the advertised seed on the next generator run. Check --workspace and\n` +
        `  --window-days against the live ledger first; pass --allow-thin to write it deliberately.\n`,
    );
    return 1;
  }
  if (thin) process.stdout.write(`TOOL_DEMAND_THIN_OVERRIDE ${thin}\n`);

  const snapshot = buildSnapshot({
    capturedAt: windowEnd,
    windowDays: opts.windowDays,
    windowStart,
    windowEnd,
    workspace: opts.workspace,
    totals,
    rows,
  });

  const top = [...rows].sort((a, b) => b.callers - a.callers || b.calls - a.calls).slice(0, 5);
  for (const t of top) process.stdout.write(`  top ${t.name} callers=${t.callers} calls=${t.calls}\n`);

  if (opts.dryRun) {
    process.stdout.write(`TOOL_DEMAND_DRY_RUN wrote nothing (would write ${opts.out})\n`);
    return 0;
  }

  const outPath = resolve(REPO_ROOT, opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  process.stdout.write(`TOOL_DEMAND_WROTE ${opts.out} tools=${snapshot.tools.length}\n`);
  return 0;
}

// Importable for tests (the pure helpers above) without running the CLI.
// isCliEntry, never a hand-rolled import.meta.url comparison: once esbuild inlines a
// module into the desktop sidecar every inlined module inherits the BUNDLE entry's
// import.meta.url, so the hand-rolled form fires main() during host boot (EI-650).
if (isCliEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`refresh-tool-demand: ${err?.stack ?? err}\n`);
      process.exit(2);
    },
  );
}
