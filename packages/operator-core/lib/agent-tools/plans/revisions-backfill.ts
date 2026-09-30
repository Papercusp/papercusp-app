/**
 * plans:backfill-revisions — seed the revision spine from git history.
 *
 * plan-agent-launch-2026-05-21, Phase 1 (P-005 / D-003 / D-015).
 *
 * The `plan_revisions` spine (P-001…P-004) only captures plan writes
 * made *after* it shipped. But every plan already carries years of
 * git history — the real record of how it evolved. This verb walks
 * `git log --follow` for a plan and inserts one synthetic revision
 * per commit: the content snapshot from `git show`, the commit
 * subject as a weak `rationale`, `session_kind = 'git_backfill'`,
 * `session_id` NULL (a commit has no conversation).
 *
 * One-time + idempotent (D-015): a plan that already has any
 * `plan_revisions` rows is left untouched (`skipped_existing`) — so
 * the backfill never collides with or renumbers live revisions, and
 * re-running it is safe. The check + insert run inside the plan-file
 * lock, serialized against live `recordPlanRevision` writes.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withPlanLock } from './with-plan-lock';
import { listPlanFiles } from './source';
import { hashPlanContent } from './content-hash';
import {
  readPlanHistory,
  readPlanFileAtCommit,
  type GitCommit,
} from './git-history';
import {
  countPlanRevisions,
  insertBackfillRevisionsIfEmpty,
  type BackfillRevisionInput,
} from './revisions';
import type { ResolveIdentityCtx } from '../coordination/identity';

/** `git log --follow` returns at most this many commits per plan —
 *  the helper's hard ceiling. No plan approaches it. */
const BACKFILL_HISTORY_LIMIT = 200;

export interface PlanBackfillResult {
  slug: string;
  status: 'backfilled' | 'skipped_existing' | 'no_history' | 'busy' | 'error';
  revisionsInserted: number;
  message?: string;
}

/**
 * Map one git commit + its file content into a backfill revision
 * input. Pure — exported for unit testing. An empty commit subject
 * becomes a `null` rationale; an unparseable commit date falls back
 * to "now" so a row is never dropped for a bad timestamp.
 */
export function commitToBackfillInput(
  commit: GitCommit,
  content: string,
): BackfillRevisionInput {
  const parsed = Date.parse(commit.date);
  const subject = commit.subject.trim();
  return {
    contentHash: hashPlanContent(content),
    content,
    rationale: subject.length > 0 ? subject : null,
    authorId: commit.author,
    createdAt: Number.isFinite(parsed) ? parsed : Date.now(),
  };
}

/**
 * Backfill one plan. The git walk (up to 200 sequential `git show`
 * subprocesses) runs BEFORE the plan lock is taken — holding the
 * advisory lock across seconds of git reads blocked every live write
 * to the plan and pinned a pool connection (audit P-044). The
 * idempotency check + inserts then run in ONE transaction inside the
 * lock (`insertBackfillRevisionsIfEmpty`), so a live revision landing
 * mid-backfill either skips it or rolls the whole plan back — never a
 * partial spine. Returns a per-plan result; never throws.
 */
export async function backfillPlanRevisionsForSlug(
  ctx: ResolveIdentityCtx,
  slug: string,
): Promise<PlanBackfillResult> {
  try {
    // Phase 1 — read-only, lock-free. The cheap pre-check makes the
    // common re-run (`skipped_existing`) cost one COUNT instead of a
    // git walk; the authoritative check re-runs transactionally below.
    const existing = await countPlanRevisions(slug);
    if (existing > 0) {
      return { slug, status: 'skipped_existing', revisionsInserted: 0 };
    }

    const history = await readPlanHistory(slug, { limit: BACKFILL_HISTORY_LIMIT });
    if (!history.ok) {
      return { slug, status: 'error', revisionsInserted: 0, message: history.message };
    }
    if (history.commits.length === 0) {
      return { slug, status: 'no_history', revisionsInserted: 0 };
    }

    // git log is newest-first; backfill oldest-first so `seq`
    // 1..N runs chronologically.
    const oldestFirst = [...history.commits].reverse();
    const inputs: BackfillRevisionInput[] = [];
    for (const commit of oldestFirst) {
      const at = await readPlanFileAtCommit(slug, commit.hash);
      if (!at.ok) {
        return {
          slug,
          status: 'error',
          revisionsInserted: 0,
          message: `git show ${commit.hash}: ${at.message ?? at.code}`,
        };
      }
      // Empty content = the file did not exist at this commit
      // (pre-creation / pre-rename) — skip it.
      if (at.content.length === 0) continue;
      inputs.push(commitToBackfillInput(commit, at.content));
    }
    if (inputs.length === 0) {
      return { slug, status: 'no_history', revisionsInserted: 0 };
    }

    // Phase 2 — the write. The plan lock serializes against other
    // backfills and plan writes; the check+insert single transaction
    // (D-015 idempotency) is what makes a concurrent live revision
    // safe either way.
    const locked = await withPlanLock<PlanBackfillResult>(
      ctx as never,
      { slug, intent: 'plans:backfill-revisions' },
      async (): Promise<{ newBody: string | null; value: PlanBackfillResult }> => {
        const res = await insertBackfillRevisionsIfEmpty(slug, inputs);
        return {
          newBody: null,
          value: res.skippedExisting
            ? { slug, status: 'skipped_existing', revisionsInserted: 0 }
            : {
                slug,
                status: res.inserted > 0 ? 'backfilled' : 'no_history',
                revisionsInserted: res.inserted,
              },
        };
      },
    );

    if (locked.kind === 'busy') {
      return {
        slug,
        status: 'busy',
        revisionsInserted: 0,
        message: 'plan file is locked by another agent',
      };
    }
    return locked.value;
  } catch (err) {
    return {
      slug,
      status: 'error',
      revisionsInserted: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Backfill every non-archived plan, sequentially (each plan takes its
 * own lock). Archived plans are out of scope for the v1 backfill —
 * the Revisions UI targets active plans.
 */
export async function backfillAllPlanRevisions(
  ctx: ResolveIdentityCtx,
): Promise<PlanBackfillResult[]> {
  const files = await listPlanFiles();
  const results: PlanBackfillResult[] = [];
  for (const file of files) {
    if (file.archived) continue;
    results.push(await backfillPlanRevisionsForSlug(ctx, file.slug));
  }
  return results;
}

function summarize(results: PlanBackfillResult[]): Record<string, number> {
  const summary: Record<string, number> = {
    backfilled: 0,
    skipped_existing: 0,
    no_history: 0,
    busy: 0,
    error: 0,
    revisionsInserted: 0,
  };
  for (const r of results) {
    summary[r.status] = (summary[r.status] ?? 0) + 1;
    summary.revisionsInserted += r.revisionsInserted;
  }
  return summary;
}

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .optional()
    .describe('Backfill just this plan. Omit to backfill every non-archived plan.'),
});

export default defineTool({
  name: 'plans:backfill-revisions',
  description:
    'One-time, idempotent migration: seed the plan_revisions spine from git history — one synthetic revision per past commit (commit subject as a weak rationale, session_kind git_backfill, no session). A plan that already has revisions is skipped, so re-running is safe.',
  guidance: {
    when: 'Once, after the revision spine ships, to give existing plans a history before their first live write — or to seed a single plan whose spine was never populated.',
    notWhen:
      'Routine use. The spine is maintained automatically by every plans:* write verb; this is a migration, not an everyday tool.',
    chaining: 'plans:backfill-revisions → plans:revisions to confirm the chain.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      metadata?: (d: Record<string, unknown>) => void;
    };
    const results = args.slug
      ? [await backfillPlanRevisionsForSlug(ctx as ResolveIdentityCtx, args.slug)]
      : await backfillAllPlanRevisions(ctx as ResolveIdentityCtx);
    const summary = summarize(results);
    ctxAny.metadata?.({
      plansProcessed: results.length,
      revisionsInserted: summary.revisionsInserted,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ results, summary }) }],
    };
  },
});
