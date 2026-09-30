/**
 * db:migrations — read the APPLIED migration ledger
 * (`harness_shared.schema_migrations`), plan sql-escape-tool-routing-2026-08-12
 * P-003.
 *
 * 64 agents / 153 hand-written `dev:pg_query` calls read this table, with a
 * near-uniform corpus signature. The shapes actually observed (14-day corpus,
 * `harness_shared.tool_invocations`):
 *
 *   1. "did NNN apply?"        WHERE filename LIKE '727%' | '795-%' | ILIKE '%797%'
 *   2. "the recent ones"       ORDER BY filename DESC LIMIT 8
 *                              ORDER BY applied_at DESC LIMIT 20
 *   3. "a number range"        WHERE filename >= '750' AND filename < '760'
 *   4. "a time window"         WHERE applied_at BETWEEN '…' AND '…'
 *   5. "how many / newest"     count(*), max(applied_at)
 *
 * WHY A TOOL AND NOT THE SQL: shape 1 dominates, and it is the one the raw
 * query answers WRONG. Zero rows is ambiguous three ways — not applied yet,
 * authored-but-not-armed (`NNN-*.sql.DRAFT`), or a wrong guess at the number —
 * and the SQL renders all three as an identical empty result. An agent reading
 * "no rows" as "not applied" then waits for a migration that will never run,
 * or re-writes one that already exists. So when `like` matches nothing, this
 * tool checks the sql dir on disk and returns a VERDICT distinguishing them.
 *
 * The corpus also contains `SELECT version, applied_at ... WHERE version IN
 * ('761','762')` — there is no `version` column (filename, applied_at, sha256),
 * so that agent got an error where a typed arg would have just worked.
 *
 * SCOPE — this reads the APPLIED ledger only. The drift/pending question
 * (which files are on disk but unapplied, content-drifted, or extra) is
 * `db:check_drift`'s, and is NOT duplicated here; the `pending` verdict below
 * chains there rather than recomputing it.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveSqlDir, resolveCanonicalStagingSqlDir } from '../../migration-drift';
import { toIso } from '../_pg-timestamp';

const DEFAULT_LIMIT = 20;

// NOT `d.toISOString()`: `applied_at` is timestamptz, which reads back as a STRING on
// this client, so the old spelling threw on every row. See _pg-timestamp.
const iso = toIso;

/**
 * Corpus forms are `'727%'`, `'795-%'`, `'774%'` and `ILIKE '%797%'` — i.e. a
 * migration NUMBER, sometimes already wildcarded. A caller passing `'795'`
 * means "migration 795", not "a filename that is exactly 795", so a pattern
 * with no wildcard of its own becomes a PREFIX match. One that already carries
 * `%`/`_` is honoured verbatim.
 */
export function toFilenamePattern(like: string): string {
  return /[%_]/.test(like) ? like : `${like}%`;
}

/**
 * Files whose name starts with the same leading digits as the requested
 * pattern. Deliberately a cheap prefix scan and not a glob engine: this runs
 * only on the zero-applied-rows path, to explain an empty result.
 */
function onDiskMatches(dirs: string[], like: string): string[] {
  const stem = (like.match(/^[0-9]+/)?.[0] ?? like.replace(/[%_].*$/, '')).trim();
  if (!stem) return [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) if (f.startsWith(stem)) seen.add(f);
  }
  return [...seen].sort();
}

/**
 * Explain an empty `like` result. Distinguishing these three is the whole
 * reason this tool exists — see the header.
 *
 * `unknown` is a real outcome, not a failure to try: when no sql dir resolves
 * (a packaged install, CI, a tree with no migrations dir) we cannot tell
 * "pending" from "no such migration", and saying so is required. Claiming
 * `no-such-migration` there would be the same false-negative class that
 * `resolveDeployedSqlDir`'s callers are warned about.
 */
export function classifyMissing(
  matches: string[],
  sqlDirsResolved: boolean,
): { verdict: 'pending' | 'draft-not-armed' | 'no-such-migration' | 'unknown'; note: string } {
  if (!sqlDirsResolved)
    return {
      verdict: 'unknown',
      note: 'No migrations sql dir resolved on this host, so "not applied" cannot be told apart from "no such migration". Not a claim that the migration is absent.',
    };
  if (matches.length === 0)
    return {
      verdict: 'no-such-migration',
      note: 'No applied row AND no file with that number in the sql dir — the number is probably wrong. Check the number you meant, or db:next-migration to allocate one.',
    };
  // A `.DRAFT` / `.PENDING-CODE-DEPLOY` suffix is a DELIBERATE hold: the runner
  // only ever applies `*.sql`, so these will never self-apply and waiting on
  // them is waiting forever. Distinct from an armed-but-unapplied migration.
  const armed = matches.filter((f) => f.endsWith('.sql'));
  if (armed.length === 0)
    return {
      verdict: 'draft-not-armed',
      note: `Authored but NOT armed (${matches.join(', ')}). The runner only applies files matching *.sql, so this will never apply on its own — arm it by renaming off the .DRAFT/.PENDING-CODE-DEPLOY suffix.`,
    };
  return {
    verdict: 'pending',
    note: `On disk (${armed.join(', ')}) but not in the applied ledger — it has not run yet. Migrations auto-apply on operator boot and :3070 has no hot-reload, so this is normal for a migration added since the last restart. db:check_drift is the full drift picture.`,
  };
}

export default defineTool({
  name: 'db:migrations',
  description:
    'Read the APPLIED migration ledger (harness_shared.schema_migrations): which migrations ran, when, and their sha. `like` takes a migration number ("795", "72", or an explicit LIKE pattern) — a bare number is a PREFIX match. When `like` matches no applied row the result carries a VERDICT explaining why (pending / draft-not-armed / no-such-migration / unknown), because an empty SQL result cannot tell those apart. Read-only.',
  capability: 'operator:read',
  guidance: {
    when: 'Check whether migration NNN applied, list the most recent migrations, or read what applied in a time window — instead of hand-writing SELECT over harness_shared.schema_migrations.',
    notWhen:
      'To find files on disk that have NOT applied (drift, content-drift, extras) use db:check_drift — that is the pending side and this tool does not recompute it. To APPLY a migration use db:migrate (or restart the operator; boot auto-applies). To allocate a NEW migration number use db:next-migration. The ledger is CLUSTER-global — there is no harness/workspace scope, so `harness` is rejected, not ignored.',
    chaining:
      'A `pending` verdict → db:check_drift for the full drift picture, then db:migrate or an operator restart. A `no-such-migration` verdict → db:next-migration if you meant to create one.',
    // Response documentation lives HERE: `description`/`when` are
    // prompt-weight budgeted and this text would push the tool over the cap
    // (the same guard that refused the P-002 edit on routines:list).
    returns: [
      '{ count, total, truncatedByLimit, newest, migrations, lookup } — `migrations` rows are { filename, appliedAt, sha256 }, ordered by `order` DESC (filename = migration-number order, applied_at = run order).',
      '`count` = rows returned; `total` = rows MATCHING the filter, independent of `limit`; `truncatedByLimit` says whether the two differ — so a capped list is never read as a total.',
      '`newest` = max(applied_at) over the matched set.',
      '`lookup` is present ONLY when `like` matched zero applied rows, and is the point of this tool: { verdict, note, onDisk, sqlDirs }. verdict `pending` = on disk, not yet run. `draft-not-armed` = a .DRAFT/.PENDING-CODE-DEPLOY file the runner will NEVER apply. `no-such-migration` = no file either, so the number is likely wrong. `unknown` = no sql dir on this host, so it could not be classified — NOT a claim the migration is absent.',
    ].join(' '),
    seeAlso: [
      'db:check_drift (files on disk not yet applied — the pending/drift side)',
      'db:migrate (apply a pending migration)',
      'db:next-migration (allocate the next migration number)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    like: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Migration number or filename pattern. A bare value ("795", "795-agent-facts") is a PREFIX match; a value containing %/_ is used as a LIKE pattern verbatim. Case-insensitive.',
      ),
    since: z
      .string()
      .max(64)
      .optional()
      .describe('Only migrations applied at/after this timestamp (ISO-8601, e.g. 2026-08-02T01:00:00Z).'),
    until: z
      .string()
      .max(64)
      .optional()
      .describe('Only migrations applied at/before this timestamp (ISO-8601).'),
    order: z
      .enum(['filename', 'applied_at'])
      .optional()
      .describe(
        'Sort key, always DESC. "filename" (default) = migration-number order; "applied_at" = the order they actually ran.',
      ),
    limit: z.number().int().min(1).max(200).optional().describe(`Max rows (default ${DEFAULT_LIMIT}).`),
  }),
  result: z
    .object({
      count: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      truncatedByLimit: z.boolean(),
      newest: z.string().nullable(),
      migrations: z.array(z.unknown()),
      lookup: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args: {
    like?: string;
    since?: string;
    until?: string;
    order?: 'filename' | 'applied_at';
    limit?: number;
  }) {
    const { sql } = getOrgPg();
    const limit = args.limit ?? DEFAULT_LIMIT;
    const pattern = args.like ? toFilenamePattern(args.like) : null;
    const since = args.since ?? null;
    const until = args.until ?? null;
    const byApplied = args.order === 'applied_at';

    // One statement for both the page and the unbounded aggregates: a count
    // computed over the LIMITed page would restate `limit` as if it were a
    // total, which is the bounded-measurement-as-verdict failure.
    const rows = await sql<
      Array<{
        filename: string;
        applied_at: string | Date;
        sha256: string;
        total: string;
        newest: Date | null;
      }>
    >`
      WITH matched AS (
        SELECT filename, applied_at, sha256
          FROM harness_shared.schema_migrations
         WHERE (${pattern}::text IS NULL OR filename ILIKE ${pattern})
           AND (${since}::timestamptz IS NULL OR applied_at >= ${since}::timestamptz)
           AND (${until}::timestamptz IS NULL OR applied_at <= ${until}::timestamptz)
      )
      SELECT m.filename,
             m.applied_at,
             m.sha256,
             (SELECT count(*) FROM matched)::text AS total,
             (SELECT max(applied_at) FROM matched) AS newest
        FROM matched m
       ORDER BY ${byApplied ? sql`m.applied_at` : sql`m.filename`} DESC
       LIMIT ${limit}`;

    const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
    const migrations = rows.map((r) => ({
      filename: r.filename,
      appliedAt: iso(r.applied_at),
      sha256: r.sha256,
    }));

    const payload: Record<string, unknown> = {
      count: migrations.length,
      total,
      truncatedByLimit: total > migrations.length,
      newest: rows.length > 0 ? iso(rows[0]!.newest) : null,
      migrations,
    };

    // The disambiguation that justifies the tool. Only on the zero-row `like`
    // path — an empty result is exactly where the raw SQL misleads.
    if (args.like && migrations.length === 0) {
      // BOTH trees, per the lesson db:check_drift already learned
      // (EI-18757486483124756): the tree serving this call is often the
      // release checkout, which LAGS the staging tree agents author in — so a
      // migration written minutes ago is invisible to a serving-tree-only scan
      // and would be reported as "no such migration".
      const dirs = [...new Set([resolveSqlDir(), resolveCanonicalStagingSqlDir()].filter(Boolean))] as string[];
      const matches = onDiskMatches(dirs, args.like);
      payload.lookup = {
        like: args.like,
        ...classifyMissing(matches, dirs.length > 0),
        onDisk: matches,
        sqlDirs: dirs,
      };
    }

    // {data} envelope so the payload-tier shaper applies.
    return { data: payload };
  },
});
