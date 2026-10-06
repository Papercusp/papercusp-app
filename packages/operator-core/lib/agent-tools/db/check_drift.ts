/**
 * db:check_drift — report migration drift (plan fleet-coordination-painpoints,
 * P-005). DETECTION ONLY: which `libs/papercusp/libs/db/sql/*.sql` files are
 * not yet recorded in `harness_shared.schema_migrations` on the live DB.
 *
 * Migrations auto-apply on operator boot, but the :3070 host has no hot-reload,
 * so a migration added since the last restart shows here as `missing` until
 * the operator restarts (or `db:migrate` applies it). `extra` (applied but the
 * file is gone) is unusual — investigate.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { checkMigrationDrift } from '../../migration-drift';

export default defineTool({
  name: 'db:check_drift',
  description:
    'Report DB migration drift — sql/*.sql files not yet applied (per harness_shared.schema_migrations). Operator-global: call with `{}`; do not pass `harness` or another scope key. Detection only. Checks BOTH the tree serving this call AND the canonical staging tree agents author migrations in (EI-18757486483124756) — `in_sync` is false if EITHER lags. `missing`/`missing_canonical` = added since the last operator boot; restart the operator (boot auto-applies) or use db:migrate. `extra` = applied but file gone (investigate). `content_drift` = applied migrations whose bytes CHANGED after they ran (EI-19365742982915607) — the edit never executed and no restart will run it; repair with a NEW migration. `schema_ahead` = the DB was migrated by a newer tree than this one.',
  guidance: {
    when:
      'After adding a migration, or when a runtime "missing column/relation" error suggests the live DB lags the sql/ dir. This is operator-global: call with `{}` and do not pass `harness`.',
    notWhen: 'Applying a migration — that is the boot auto-apply (restart) or db:migrate for a one-off.',
    chaining:
      'missing/missing_canonical non-empty → restart the operator (or db:migrate that file). `sql_dir` is the tree ' +
      'that SERVED this call (often the release checkout); `canonical_sql_dir` is the staging tree agents author in — ' +
      'so a migration you just wrote is caught by `missing_canonical` even when `sql_dir` reads clean ' +
      '(EI-18757486483124756).',
    seeAlso: [
      'db:migrate (apply a pending migration)',
      'db:next-migration (scaffold the next migration file)',
    ],
    // EI-21845887728688371 / EI-21204271205240672 / EI-21720758362170049 /
    // EI-22030961127733262 — four independent filings, one shape: a caller forwards a
    // scope key (`harness`, `workspace`) to a tool that declares NONE. The description
    // and `when` BOTH already say "Operator-global: call with `{}`; do not pass
    // `harness`", and callers pass it anyway — which is the point: prose in the catalog
    // is not on the failure path, and the failure path is the only moment the caller is
    // holding the rejected key. Same borrowed-scope family as `workspace` on
    // routines:list (EI-20206183390542424) and `harness` on coord:presence.
    //
    // The OBJECT (corrective-call) form is REQUIRED here, not a style preference: this
    // tool declares zero keys, so `unknownArgHint` early-returns '' on
    // `keys.length === 0` and a `declaredKey — explanation` string (D-004's normal form)
    // could never render at all — there is no declared key to name. The object form
    // routes through buildCorrectedCall/correctedCallHint, which has no such floor, and
    // the self-referential `{ tool: 'db:check_drift', args: {} }` renders the genuinely
    // correct corrective call: the same tool, with the key gone.
    argRedirects: {
      harness: {
        tool: 'db:check_drift',
        args: {},
        note:
          'migration drift is OPERATOR-GLOBAL: one live DB and one sql/ dir serve every harness, so there is nothing for a harness to select and this tool declares no arg at all. DROP the key and call it with `{}`. To narrow the ANSWER, read `missing_canonical` (the staging tree you author in) rather than `missing` (whichever tree served the call)',
      },
      workspace: {
        tool: 'db:check_drift',
        args: {},
        note:
          'this tool takes NO scope key — schema_migrations is per-DATABASE, not per-workspace, so a workspace cannot narrow it. DROP the key and call it with `{}`. If you meant "did MY migration land", that is `missing`/`missing_canonical` in the result, not an argument',
      },
    },
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({}),
  async handler() {
    // classifyContent: this is the diagnostic surface where an agent is asking
    // the question, so it pays the git-history walk that separates a real
    // half-landed migration from a benign comment-only edit. Boot /
    // system-health / the watchdog deliberately do not (EI-19408574209859155).
    const d = await checkMigrationDrift({ classifyContent: true });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            in_sync: d.inSync,
            missing: d.missing,
            extra: d.extra,
            on_disk_count: d.onDisk.length,
            applied_count: d.applied.length,
            sql_dir: d.sqlDir,
            // EI-18757486483124756: independent of `sql_dir` — the canonical
            // tree every agent authors migrations in, so `in_sync` can no
            // longer read true while a just-authored migration sits
            // unapplied there, regardless of which tree served this call.
            canonical_sql_dir: d.canonicalStagingSqlDir,
            missing_canonical: d.missingCanonical,
            // EI-19365742982915607: applied migrations edited AFTER they ran.
            // Never self-heals — no restart re-runs a recorded migration — so
            // the file on disk silently misdescribes the live schema until a
            // NEW migration re-applies it. Deliberately does not gate
            // `in_sync` (see MigrationDrift.contentDrift).
            //
            // EI-19408574209859155: each entry carries a `classification` —
            // `executable` (a real half-landed migration), `comments-only`
            // (provably benign, e.g. the `-- FORWARD-COMPAT:` escape hatch
            // that lint:migration-forward-compat's own remedy writes into an
            // applied file), or `unclassified` (undecidable, counted as
            // hazardous). READ `content_drift_executable`, not the raw list:
            // that is the actionable subset, the same way `missing_deployed`
            // rather than `missing` is what the watchdog fires on.
            content_drift: d.contentDrift,
            content_drift_executable: d.contentDriftExecutable,
            // WI-10004651: the executable subset minus the ACKNOWLEDGED set
            // (migration-content-drift-acknowledged.ts) — drift nobody has
            // repaired or proven benign yet. The watchdog files a bug per entry.
            content_drift_new: d.contentDriftNew,
            content_drift_sql_dir: d.contentDriftSqlDir,
            // WI-5050: applied migrations numbered beyond this tree's max —
            // the shared DB was migrated by a NEWER tree, so this tree's
            // queries can hit "relation does not exist". Computed since
            // WI-5050 but never surfaced until now.
            schema_ahead: d.schemaAhead,
          }),
        },
      ],
    };
  },
});
