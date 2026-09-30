/**
 * db:next-migration — atomically allocate the next migration number
 * (handoff-coordination-dx-followups-2026-06-04 §A1).
 *
 * Agents pick the next `NNN` for a `libs/papercusp/libs/db/sql/<NNN>-*.sql`
 * file by `ls | tail`, so two agents racing both choose the same number — and
 * on the native :5432 box only one of the colliding files applies, so a table
 * goes silently dark (seen this session: two `131-*.sql`, and a live 134 race).
 *
 * This hands out a guaranteed-unique number under a pg advisory lock:
 *   next = GREATEST(max-on-disk, max-reserved-in-ledger, max-applied) + 1
 * recorded atomically in harness_shared.migration_reservations. Folding in the
 * filesystem max means even an UNRESERVED on-disk file (a peer who wrote
 * NNN-*.sql without reserving) is still respected.
 *
 * EI-353: the disk leg scans BOTH the serving checkout and the canonical
 * integration tree — the deployed operator (:3070) runs from the release tree,
 * which lags staging, so a freshly-written staging migration was invisible and
 * 233 got handed out twice. The applied set (schema_migrations) is the third
 * GREATEST input: an applied filename's number is taken by definition, even if
 * its file is absent from every scanned tree and it was never reserved.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveSqlDir, resolveCanonicalStagingSqlDir } from '../../migration-drift';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  ALLOC_ADVISORY_KEY,
  scanMigrationDirs,
} from '../../../../../scripts/lib/migration-allocation.mjs';
// WI-38353 — shared with scripts/next-migration.mjs so the two doors cannot
// diverge on what counts as duplicate work. Both are postgres.js callers, so
// the ledger query itself is shared too, not just the judgement.
import {
  annotateCandidatesWithDisk,
  fetchRedundancyCandidates,
  formatRedundancyMessage,
  judgeRedundantReservation,
} from '../../../../../scripts/lib/migration-slug-dedup.mjs';

// Re-export the canonical binding so the integration test can hold the same
// lock to reproduce the fsMax TOCTOU window (EI-6852).
export { ALLOC_ADVISORY_KEY };

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/**
 * Sql dirs to scan for the filesystem max. The serving checkout's dir alone is
 * not enough (EI-353): on the deployed :3070 host the serving tree is the
 * release checkout, which lags staging, so a migration just written there is
 * invisible to a cwd-relative scan. Include the configured integration tree
 * and the canonical edit tree; `PAPERCUSP_CANONICAL_TREE` takes precedence
 * over `PAPERCUSP_INTEGRATION_ROOT` for that canonical path.
 */
/** Internal test seam for the three migration trees the allocator scans. */
export function candidateSqlDirs(): string[] {
  const dirs = new Set<string>();
  const serving = resolveSqlDir();
  if (serving) dirs.add(serving);
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integrationRoot) {
    const canonical = path.resolve(integrationRoot, 'libs/papercusp/libs/db/sql');
    if (fs.existsSync(canonical)) dirs.add(canonical);
  }
  const canonicalSqlDir = resolveCanonicalStagingSqlDir();
  if (canonicalSqlDir) dirs.add(canonicalSqlDir);
  return [...dirs];
}

function slugify(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || null;
}

export default defineTool({
  name: 'db:next-migration',
  description:
    'Atomically reserve the next migration number for a libs/papercusp/libs/db/sql/<NNN>-*.sql file. Hands out GREATEST(max-on-disk across the serving + canonical staging trees, max-reserved, max-applied)+1 under a pg advisory lock so two agents racing `ls | tail` never collide. Returns the number + a `.DRAFT`-suffixed path to write the file at — the runner only ever applies files matching `*.sql`, so the draft is invisible to auto-apply while you iterate on it; ARM it via the returned `arm_command` once ready and it auto-applies on the next operator restart (A1 boot-apply).',
  guidance: {
    when: 'BEFORE creating a new SQL migration file — reserve the number first instead of `ls | tail`, so a concurrent agent cannot pick the same NNN.',
    notWhen: 'Applying a migration (that is the boot auto-apply / db:migrate) or checking drift (db:check_drift).',
    chaining: 'db:next-migration { name } → write + iterate at the returned `.DRAFT` path (never races auto-apply, even for a deliberate temporary both-ways guard-test mutation) → run `arm_command` once tested → restart the operator (boot auto-applies) or db:migrate.',
    seeAlso: [
      'db:migrate (apply the migration you wrote)',
      'db:check_drift (check drift after applying)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Accepted scope hint for harness-scoped coding sessions. Migration numbers and their reservation ledger are workspace-global, so this does not partition allocation by harness.',
      ),
    name: z
      .string()
      .trim()
      .min(1, 'name is required')
      .refine((value) => slugify(value) !== null, {
        message: 'name must contain at least one letter or digit',
      })
      .describe('Short kebab-case description for the suggested filename, e.g. "add-foo-index".'),
    intent: z
      .string()
      .optional()
      .describe('One line on what the migration does — recorded in the ledger so peers see what this NNN is for.'),
    // EI-20224602696919268: the documented CLI accepts --by. Agents naturally
    // translate that spelling to the namesake MCP tool, where strict schema
    // validation previously rejected it before allocation. Accept the same
    // optional attribution override on both doors; identity remains the default.
    by: z
      .string()
      .max(200)
      .optional()
      .describe('Optional reservation label, matching scripts/next-migration.mjs --by. Defaults to the resolved caller identity.'),
    force: z
      .boolean()
      .optional()
      .describe(
        'Reserve even when a near-identical migration was just reserved or already applied (WI-38353) — matches scripts/next-migration.mjs --force.',
      ),
  }),
  async handler(args, ctx) {
    const slug = slugify(args.name ?? '');
    if (!slug) {
      return json({
        ok: false,
        error: 'invalid_name',
        message:
          'Migration name is required and must contain at least one letter or digit. Pass name before allocating a number.',
      });
    }
    const sqlDirs = candidateSqlDirs();
    if (sqlDirs.length === 0)
      return json({ ok: false, error: 'sql dir (libs/papercusp/libs/db/sql) not found' });

    const { ownerLabel } = resolveAgentIdentity(ctx);
    const reservedBy = args.by?.trim() || ownerLabel;
    const { sql } = getOrgPg();

    const allocated = await sql.begin(async (tx) => {
      // Serialise concurrent allocations — the advisory lock is held for the
      // txn, so the scan-read-compute-insert below is atomic across callers.
      await tx`SELECT pg_advisory_xact_lock(${ALLOC_ADVISORY_KEY})`;
      // EI-6852: scan the filesystem max INSIDE the advisory lock, immediately
      // before the reservation insert — NOT before acquiring the lock. Reading
      // fsMax before `sql.begin` left a TOCTOU window (the whole pooled-
      // connection-acquire + advisory-lock-wait duration, which is seconds
      // under a busy fleet) during which a concurrent agent could write a
      // higher-numbered NNN-*.sql to disk; the stale fsMax then failed to fold
      // it in and the tool handed out an already-used number. maxReserved /
      // maxApplied were already computed under the lock — this closes the last
      // (filesystem) leg so all three GREATEST inputs are read atomically.
      //
      // ONE scan serves both readers: the allocation max, and the per-candidate
      // written/occupied facts the unwritten-reservation rule needs
      // (EI-20300821494280085). Both must be read under this lock for the same
      // TOCTOU reason. Shared with the CLI door so neither can grow its own
      // notion of what the filesystem says.
      const scan = scanMigrationDirs(sqlDirs);
      const fsMax = scan.maxNumber;
      const rows = await tx<{ next: number }[]>`
        SELECT GREATEST(
                 ${fsMax},
                 COALESCE((SELECT MAX(num) FROM harness_shared.migration_reservations), 0),
                 -- An APPLIED migration's number is taken by definition, even when
                 -- its file is in no scanned tree and was never reserved (EI-353).
                 COALESCE((SELECT MAX(substring(filename FROM '^([0-9]+)-')::int)
                             FROM harness_shared.schema_migrations
                            WHERE filename ~ '^[0-9]+-'), 0)
               ) + 1 AS next`;
      const next = Number(rows[0]!.next);
      // The RESERVED filename (ledger + unreservedNumbers checks) stays the
      // eventual armed `.sql` name — only the path we tell the caller to
      // WRITE TO gets the `.DRAFT` suffix (EI-19366138707071397). Reservation
      // and on-disk armed state are deliberately independent.
      const filename = `${String(next).padStart(3, '0')}-${slug}.sql`;
      // WI-38353: the NUMBER is unique, but the WORK may not be — four agents
      // answering one gate red reserved four numbers for one repair in 48s.
      // Read the recent ledger under the SAME advisory lock that serialises
      // allocation; reading it outside would leave the very race this closes.
      const judgement = judgeRedundantReservation({
        slug,
        candidates: annotateCandidatesWithDisk(await fetchRedundancyCandidates(tx), scan),
        nowMs: Date.now(),
      });
      if (judgement.verdict === 'block' && !args.force) {
        return { next, filename, judgement, blocked: true as const };
      }
      await tx`
        INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent)
          VALUES (${next}, ${filename}, ${reservedBy}, ${args.intent ?? null})`;
      return { next, filename, judgement, blocked: false as const };
    });

    if (allocated.blocked) {
      return json({
        ok: false,
        error: 'redundant_migration',
        blocked_number: allocated.next,
        message: formatRedundancyMessage(allocated.judgement, { slug, forceFlag: 'force: true' }),
        matches: allocated.judgement.matches,
        note: `Nothing was reserved — ${String(allocated.next).padStart(3, '0')} is still free. If you already hold one of the numbers above, write your file there. If this is genuinely distinct work, re-call with force: true.`,
      });
    }

    const armPath = path.posix.join('libs/papercusp/libs/db/sql', allocated.filename);
    const draftPath = `${armPath}.DRAFT`;
    return json({
      ok: true,
      number: allocated.next,
      suggested_filename: allocated.filename,
      path: draftPath,
      arm_path: armPath,
      arm_command: `mv ${draftPath} ${armPath}`,
      reserved_by: reservedBy,
      ...(() => {
        const warning = formatRedundancyMessage(allocated.judgement, { slug, forceFlag: 'force: true' });
        return warning ? { redundancy_warning: warning } : {};
      })(),
      ...(args.harness ? { requested_from_harness: args.harness } : {}),
      note: `Reserved. Write + iterate the migration at ${draftPath} (a ".DRAFT" suffix). The runner only ever applies files matching *.sql, so this draft is INVISIBLE to boot auto-apply / db:migrate / the green-checkpoint preflight while you edit it — including any deliberate temporary both-ways guard-test mutation. Once it's ready and tested, ARM it for auto-apply with: ${`mv ${draftPath} ${armPath}`}`,
    });
  },
});
