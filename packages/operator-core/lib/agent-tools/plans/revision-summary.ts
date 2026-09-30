/**
 * plans:summarize-revision — fallback rationale auto-summary.
 *
 * plan-agent-launch-2026-05-21, Phase 2 (P-007 / D-009 / D-021).
 *
 * A plan write verb takes an optional `rationale` — the "why", supplied
 * by the writer at write time. When a write that *had* a conversation
 * (a `plan_run` session) recorded no rationale, this verb fills the gap
 * best-effort: it reads the run transcript up to that revision and
 * summarises it, on the cheap haiku model, into a one-to-two-sentence
 * rationale cached back onto the `plan_revisions` row.
 *
 * It is on-demand (D-021) — invoked by an agent or the Revisions UI,
 * not auto-run on any hot path: a launched agent is already told to
 * supply its own rationale, so the gap is small, and an LLM call on
 * the launch / list path would stall it. Idempotent: a revision that
 * already has a rationale (authored or previously summarised) is a
 * no-op. Best-effort: any failure leaves the rationale null.
 *
 * Only `plan_run` revisions can be summarised — they are the only
 * ones with a retrievable transcript (D-020). A direct editor save or
 * a git-backfill revision has no conversation; this verb reports
 * `no_session` for them.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { runHaiku } from '../../haiku';
import { getPlanRevisionById, setPlanRevisionRationale } from './revisions';
import { readPlanRunTranscript, TRANSCRIPT_MAX_LIMIT } from './runs';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { resolvePlanScope } from './source';

/** Longest a stored rationale may be — a one-line digest entry, not a
 *  paragraph. */
export const MAX_RATIONALE_LEN = 400;

/** How many trailing transcript turns feed the summary prompt — the
 *  turns nearest the write carry its reasoning. */
const SUMMARY_TURN_WINDOW = 12;

/** Per-turn content cap in the prompt — keeps the haiku prompt bounded. */
const SUMMARY_TURN_CHARS = 600;

/**
 * Build the haiku prompt that turns a run transcript into a one-line
 * rationale. Pure + exported for unit test.
 */
export function buildRationaleSummaryPrompt(
  planSlug: string,
  turns: ReadonlyArray<{ role: string; content: string }>,
): string {
  const formatted = turns
    .slice(-SUMMARY_TURN_WINDOW)
    .map(
      (t) =>
        `${t.role === 'user' ? 'User' : 'Assistant'}: ` +
        t.content.slice(0, SUMMARY_TURN_CHARS),
    )
    .join('\n\n');
  return (
    `An agent working on the plan "${planSlug}" edited it. Below is the ` +
    `conversation that led to the edit. In one or two sentences, state ` +
    `WHY the edit was made — the reasoning behind it, not a description ` +
    `of the diff. Plain text, no quotes, no preamble.\n\n` +
    `${formatted}\n\nWhy:`
  );
}

/**
 * Normalise a raw haiku reply into a stored rationale: drop an echoed
 * "Why:" label and wrapping quotes, collapse whitespace to a single
 * line, and cap the length. Pure + exported for unit test.
 */
export function sanitizeRationaleSummary(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^why:\s*/i, '');
  if (s.length >= 2 && /^(["']).*\1$/s.test(s)) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_RATIONALE_LEN) {
    s = s.slice(0, MAX_RATIONALE_LEN - 1).trimEnd() + '…';
  }
  return s;
}

/** Why a summary was not produced (when `summarized` is false). */
export type SummarizeRevisionReason =
  | 'already_present'
  | 'no_session'
  | 'no_transcript'
  | 'llm_unavailable'
  | 'generated';

export interface SummarizeRevisionResult {
  revisionId: number;
  /** true only when this call generated *and* stored a new rationale. */
  summarized: boolean;
  /** the rationale now on the row — pre-existing, newly generated, or
   *  null when none could be produced. */
  rationale: string | null;
  reason: SummarizeRevisionReason;
}

/**
 * Best-effort: summarise the transcript behind a revision into its
 * `rationale`. Returns `null` only when the revision does not exist;
 * every other outcome (already had a rationale, no transcript, LLM
 * unavailable, …) is a `SummarizeRevisionResult`. Never throws past a
 * DB failure in the initial revision lookup.
 */
export async function summarizeRevisionRationale(
  revisionId: number,
  opts: { workspaceId: string },
): Promise<SummarizeRevisionResult | null> {
  const rev = await getPlanRevisionById(revisionId, opts);
  if (!rev) return null;

  if (rev.rationale && rev.rationale.trim().length > 0) {
    return {
      revisionId,
      summarized: false,
      rationale: rev.rationale,
      reason: 'already_present',
    };
  }
  if (rev.sessionKind !== 'plan_run' || !rev.sessionId) {
    return {
      revisionId,
      summarized: false,
      rationale: null,
      reason: 'no_session',
    };
  }

  try {
    // Scope to the conversation up to this revision (a run can produce
    // several) — `beforeTs` upper-bounds, the prompt window focuses.
    const page = await readPlanRunTranscript(rev.sessionId, {
      limit: TRANSCRIPT_MAX_LIMIT,
      beforeTs: rev.createdAt,
    });
    if (page.turns.length === 0) {
      return {
        revisionId,
        summarized: false,
        rationale: null,
        reason: 'no_transcript',
      };
    }
    const raw = await runHaiku(
      buildRationaleSummaryPrompt(rev.planSlug, page.turns),
    );
    const rationale = raw ? sanitizeRationaleSummary(raw) : '';
    if (!rationale) {
      return {
        revisionId,
        summarized: false,
        rationale: null,
        reason: 'llm_unavailable',
      };
    }
    // The `rationale IS NULL` guard inside means a rationale authored
    // concurrently is never clobbered — we still report ours.
    await setPlanRevisionRationale(revisionId, rationale, opts);
    return { revisionId, summarized: true, rationale, reason: 'generated' };
  } catch (err) {
    console.warn(
      `[plans:summarize-revision] best-effort summary failed for ` +
        `revision ${revisionId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return {
      revisionId,
      summarized: false,
      rationale: null,
      reason: 'llm_unavailable',
    };
  }
}

const argsSchema = z.object({
  revisionId: z
    .number()
    .int()
    .positive()
    .describe('Global plan_revisions id (from plans:revisions rows).'),
  harness: harnessArg,
});

export default defineTool({
  name: 'plans:summarize-revision',
  description:
    "Fill in a revision's missing rationale by summarising the conversation behind it on the haiku model. Best-effort and idempotent — a revision that already has a rationale, or has no plan-run transcript, is reported back unchanged.",
  guidance: {
    when: 'A revision from a plan-run session has no rationale and you want the "why" filled in — for the Revisions panel or a richer launch-context digest.',
    notWhen:
      'The revision already has a rationale. The revision is a direct editor save or a git backfill (no conversation to summarise).',
    chaining:
      'plans:revisions (spot a rationale-less row) → plans:summarize-revision { revisionId }.',
    seeAlso: [
      'plans:revisions (spot rationale-less rows)',
      'plans:revision-transcript (the source transcript)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  timeoutSec: 30,
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    try {
      // Revision rows are RLS-isolated per workspace (mig 218 / WI-148 mig 295);
      // resolve the workspace from the harness arg so the by-global-id lookup
      // targets the plan's own workspace — not a silent 'default' (which after the
      // cutover is empty → every summarise 404s). workspace-data-isolation P-001.
      const harnessSlug = resolveCtxHarnessSlug(harnessScopedCtx(args.harness, ctx));
      const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
      const result = await summarizeRevisionRationale(args.revisionId, {
        workspaceId: scope.workspaceId,
      });
      if (result === null) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'not_found',
                revisionId: args.revisionId,
              }),
            },
          ],
        };
      }
      ctxAny.metadata?.({
        revisionId: args.revisionId,
        summarized: result.summarized,
        reason: result.reason,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result) },
        ],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'summary_unavailable',
              message: message.slice(0, 400),
              revisionId: args.revisionId,
            }),
          },
        ],
      };
    }
  },
});
