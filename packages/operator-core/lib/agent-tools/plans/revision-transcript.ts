/**
 * plans:revision-transcript — the conversation behind a revision.
 *
 * plan-agent-launch-2026-05-21, Phase 2 (P-008 / D-002).
 *
 * A revision records *what* changed and (often) a one-line rationale.
 * This verb retrieves the *conversation* that produced it — the raw
 * back-and-forth. It is deliberately **scoped**: paginated by `cursor`
 * and narrowable by `query`, never a whole-transcript dump (D-002) —
 * a launched agent that pulled an entire transcript would blow its
 * own context window.
 *
 * Routing by the revision's `session_kind`:
 *   - `plan_run`     → the `plan_run_turns` store.
 *   - `claude` / `omp` / `codex` → the canonical session-turn index with
 *                      permanent archive fallback (ordinary SU/agent writes).
 *   - `null`         → a direct `/admin/plans` editor save — no
 *                      conversation; `available: false`.
 *   - `git_backfill` → a revision reconstructed from a git commit —
 *                      no conversation; `available: false`.
 *   - `operator_chat` / `agent_chat` → no writer/reader bridge yet;
 *                      `available:false` with session_kind_unsupported.
 *
 * `available: false` is a normal result, not an error — the UI
 * (P-019) shows a "direct edit" tag for it. Only a missing revision
 * or a DB failure is an error.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { getPlanRevisionById } from './revisions';
import { readPlanRunTranscript } from './runs';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  isIndexedAgentSessionKind,
  readAgentSessionTranscript,
} from './revision-session-transcript';

const argsSchema = z.object({
  // z.coerce on the numerics so the same schema accepts numeric MCP
  // args and string query-params from the /api/admin/plans route.
  revisionId: z.coerce
    .number()
    .int()
    .positive()
    .describe('Global plan_revisions id (from plans:revisions rows).'),
  harness: harnessArg,
  query: z
    .string()
    .optional()
    .describe('Case-insensitive literal substring filter over turn content.'),
  cursor: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Return turns after this seq — pass back the prior nextCursor.'),
  limit: z.coerce
    .number()
    .int()
    .optional()
    .describe('Page size (default 20, max 100).'),
});

type TranscriptArgs = z.infer<typeof argsSchema>;

/** Why a revision has no plan-run transcript. */
type UnavailableReason =
  | 'no_session'
  | 'git_backfill'
  | 'session_kind_unsupported';

export default defineTool({
  name: 'plans:revision-transcript',
  description:
    'The conversation behind a plan revision — scoped: paginated by cursor, narrowable by query, never a whole-transcript dump. Reads plan-run and ordinary Claude/OMP/Codex agent transcripts; direct editor saves and git backfills report available:false.',
  guidance: {
    when: 'You need the reasoning behind a specific revision — the raw conversation, drilled into around a decision via query/cursor.',
    notWhen:
      'You want the revision list with rationales — plans:revisions. You want the plan body — plans:get. Never pull a whole transcript unscoped.',
    chaining:
      'plans:revisions → plans:revision-transcript { revisionId, query } → page with cursor.',
    seeAlso: [
      'plans:revisions (list revisions)',
      'plans:revision-diff (the code patch)',
      'plans:summarize-revision (distill the transcript to a rationale)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args: TranscriptArgs, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    try {
      // Workspace scope: revision rows are RLS-isolated per workspace
      // (audit P-008 / mig 218); resolve it from the harness arg.
      const harnessSlug = resolveCtxHarnessSlug(harnessScopedCtx(args.harness, ctx));
      const scope = await resolvePlanScope(harnessSlug ? { harnessSlug } : {});
      const revision = await getPlanRevisionById(args.revisionId, { workspaceId: scope.workspaceId });
      if (!revision) {
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

      const base = {
        revisionId: revision.id,
        planSlug: revision.planSlug,
        seq: revision.seq,
        sessionId: revision.sessionId,
        sessionKind: revision.sessionKind,
      };

      // Routing — plan-run and ordinary SU/agent transcripts share one page
      // envelope even though they live in different existing stores.
      let unavailable: UnavailableReason | null = null;
      if (revision.sessionKind === 'git_backfill') {
        unavailable = 'git_backfill';
      } else if (
        revision.sessionKind === 'operator_chat' ||
        revision.sessionKind === 'agent_chat'
      ) {
        unavailable = 'session_kind_unsupported';
      } else if (!revision.sessionId) {
        // null session_kind (direct edit) — or a typed kind with no session id,
        // which should not happen.
        unavailable = 'no_session';
      } else if (
        revision.sessionKind !== 'plan_run'
        && !isIndexedAgentSessionKind(revision.sessionKind)
      ) {
        unavailable = 'session_kind_unsupported';
      }

      if (unavailable) {
        ctxAny.metadata?.({ revisionId: revision.id, available: false });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ...base,
                available: false,
                reason: unavailable,
                turns: [],
                nextCursor: null,
              }),
            },
          ],
        };
      }

      const transcriptOpts = {
        query: args.query,
        cursor: args.cursor,
        limit: args.limit,
      };
      const page = revision.sessionKind === 'plan_run'
        ? await readPlanRunTranscript(revision.sessionId!, transcriptOpts)
        : await readAgentSessionTranscript(
            scope.workspaceId,
            revision.sessionKind as 'claude' | 'omp' | 'codex',
            revision.sessionId!,
            transcriptOpts,
            // D-006: the caller sees its own restricted turns, nobody else's.
            // An unresolvable caller owns nothing (fail closed), it is not an error.
            [(() => {
              try {
                return resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
              } catch {
                return null;
              }
            })()],
          );
      const withheld = 'withheld' in page ? page.withheld : undefined;
      ctxAny.metadata?.({
        revisionId: revision.id,
        available: true,
        turnCount: page.turns.length,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...base,
              available: true,
              query: args.query ?? null,
              turns: page.turns,
              nextCursor: page.nextCursor,
              ...(withheld ? { withheld } : {}),
            }),
          },
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
              error: 'transcript_unavailable',
              message: message.slice(0, 400),
              revisionId: args.revisionId,
            }),
          },
        ],
      };
    }
  },
});
