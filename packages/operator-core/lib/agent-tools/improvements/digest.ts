/**
 * improvements:digest — the triage lens over the captured papercusp-improvement
 * backlog (papercusp-self-improvement-loop-2026-06-04, Phase 2).
 *
 * Read-only. Reads every `papercusp-improvement`-tagged work-unit, scores + dedups
 * them, and splits them into the **auto lane** (kind=bug, no protected surface —
 * D-004) vs the **human queue** (the rest). This is "triage only" — nothing is
 * implemented here; it surfaces the backlog for a human (or the later
 * auto-implement loop) to act on. The same read+score path backs the Learning tab's
 * `learning.improvements` sync resolver (operator-learning-tab-2026-06-09) — the
 * backlog is surfaced by PULL there, not pushed to the human inbox.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readImprovementItems, countImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import { readOwnerFullAutonomyGrant } from '../../harness/improvements/full-autonomy-grant';
import { applyHumanQueueRanking } from '../../queue-ranker/human-queue';

/** EI-1715: under fleet-wide PG contention (pg 57014) this read can ride to the
 *  ~55s MCP dispatch cap. A Queen survey turn that calls digest then times out
 *  ABORTS before pot:declare-wake → the 30-min liveness backstop fires → watchdog
 *  spin. Bound it well under the cap and return a fast DEGRADED-but-valid result
 *  so the turn continues + arms its wake. Env-tunable. */
class DigestTimeoutError extends Error {}
function digestTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_DIGEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

/**
 * The corpus total is useful metadata, but it must never hold an already
 * available item window hostage. A topic COUNT can scan a much larger table
 * than the bounded list (and can queue behind a writer), so give that optional
 * leg its own shorter budget. The list + ranking remain governed by the main
 * digest deadline below. Tests may lower this with an env override.
 */
function digestCountTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_DIGEST_COUNT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Math.min(5_000, Math.max(1_000, Math.floor(digestTimeoutMs() / 4)));
}

async function countWithSoftDeadline(
  readOpts: Parameters<typeof countImprovementItems>[0],
): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      countImprovementItems(readOpts).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), digestCountTimeoutMs());
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** EI-5350: a no-`limit` digest can serialize the WHOLE backlog (observed 232KB)
 *  and overflow the agent token cap — the caller then gets an error + a spill file
 *  instead of a usable result, unlike every other house read (the bulk tools cap +
 *  flag). This bounds the SERIALIZED digest the same way: it only bites when the
 *  digest exceeds the byte budget, keeps every rollup/headline, and truncates the
 *  per-item arrays to a top-N with a `truncated` note. Pure + exported for tests.
 *  Verified low-blast: the Queen survey reads the rollups, not these arrays. */
export const DIGEST_MAX_BYTES = 80_000;
const DIGEST_ARRAY_KEYS = ['autoEligible', 'humanQueue', 'likelyDuplicates', 'recurringSignatures'] as const;

export function boundDigestForSerialization(
  digest: unknown,
  opts: { maxBytes?: number; perArrayCap?: number } = {},
): unknown {
  const maxBytes = opts.maxBytes ?? DIGEST_MAX_BYTES;
  const perArrayCap = opts.perArrayCap ?? 100;
  if (!digest || typeof digest !== 'object') return digest;
  const full = JSON.stringify(digest);
  if (full.length <= maxBytes) return digest; // under budget — unchanged
  const src = digest as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  const truncated: Record<string, { kept: number; total: number }> = {};
  for (const k of DIGEST_ARRAY_KEYS) {
    const arr = src[k];
    if (Array.isArray(arr) && arr.length > perArrayCap) {
      truncated[k] = { kept: perArrayCap, total: arr.length };
      out[k] = arr.slice(0, perArrayCap);
    }
  }
  out.truncated = {
    ...truncated,
    originalBytes: full.length,
    note: 'digest exceeded the byte budget — per-item arrays truncated to keep the result under the agent token cap. Pass `limit`, `state:"open"`, or `harnessSlug` to narrow.',
  };
  return out;
}

export default defineTool({
  name: 'improvements:digest',
  profile: 'engineer',
  description:
    'Triage the captured papercusp-improvement backlog: scores + dedups every improvement work-unit and splits it into the auto-eligible lane (kind=bug, no protected surface) vs the human-review queue. Read-only — surfaces the queue, implements nothing. (P-010) Supports per-Hive scope filtering.',
  guidance: {
    when: 'To review the papercusp self-improvement backlog — what is captured, what is auto-eligible vs needs a human, and which items look like duplicates to merge. The human-facing triage view. (P-010) Pass harnessSlug to filter to a specific Pot\'s ideas. `census.total` is the TRUE corpus count (never bounded by `limit`); `window.examined`/`window.windowed` say how much of it you actually got back, and `window.open`/`window.byKind`/`window.bySeverity` are rollups over that bounded read — read `likelyDuplicatesScope` before trusting an empty `likelyDuplicates` at a small `limit` (dedup only scans what was returned).',
    notWhen: 'You want one improvement in full — work_items:get { id }. You want to file one — improvements:capture. You want to browse another area — topics:feed { topic }.',
    chaining: 'improvements:digest → work_items:get / work_items:claim on a queued item → fix it self/inline (or improvements:capture to add more).',
    seeAlso: [
      'work_items:claim (take a queued item to fix)',
      'improvements:watchdog-status (why an item was / was not auto-filed)',
      'improvements:keyless-digest (the un-managed keyless backlog)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    state: z.enum(['open', 'resolved', 'closed']).optional().describe('restrict the read to one lifecycle state (default: all, so rollups + dedup see resolved too)'),
    limit: z.number().int().positive().max(500).optional(),
    harnessSlug: z.string().min(1).max(80).optional().describe('(P-010) restrict to a specific Pot\'s ideas (default: all)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const readOpts = { state: args.state, limit: args.limit, harnessSlug: args.harnessSlug };
          // D2 (EI-18790490225750395): the TRUE corpus total — a real COUNT(*), never
          // bounded by `limit` — read alongside the (possibly windowed) items so
          // `digest.census.total` can stop reporting the window size. Best-effort: a count
          // failure must never sink an otherwise-good digest, so it degrades to
          // `undefined` (buildDigest then falls back to candidates.length, the prior
          // behavior) rather than throwing.
          // Keep the bounded item read independent from the optional full-corpus
          // COUNT. Previously Promise.all made a slow COUNT erase a successful
          // item window and the outer timeout returned buildDigest([]), a
          // false-empty result that looked like an empty queue.
          const [items, corpusTotal] = await Promise.all([
            readImprovementItems(readOpts),
            countWithSoftDeadline(readOpts),
          ]);
          // The OWNER FULL-AUTONOMY grant (Phase 2): keep this review lens consistent with the
          // live dispatch — when ON, protected-surface kind=bugs show in the auto lane.
          const { activeWorkspaceId } = await import('../../workspace-registry');
          const principalWs = ctx?.principal?.workspaceId;
          const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
          const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ws);
          // Human lane ordered by the ONE ranker (frontier P-040; blocking impact is
          // feature #1); same enrichment the Learning tab resolver applies, so the
          // shapes can't drift.
          const digest = await applyHumanQueueRanking(
            buildDigest(items, { nowMs: Date.now(), ownerFullAutonomy, corpusTotal }),
            { candidates: items },
          );
          return { ok: true as const, digest };
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DigestTimeoutError()), digestTimeoutMs());
        }),
      ]);
      // EI-5350: cap the serialized digest so a no-`limit` call can't overflow the
      // agent token cap. Only bites when over budget; keeps rollups, truncates the
      // per-item arrays with a `truncated` note.
      const bounded = { ...result, digest: boundDigestForSerialization(result.digest) };
      return { content: [{ type: 'text' as const, text: JSON.stringify(bounded) }] };
    } catch (e) {
      // EI-1715: a contention-slow read returns a fast DEGRADED-but-valid empty
      // digest (buildDigest([]) — pure, no DB) flagged `degraded`, so a Queen
      // survey turn does NOT abort and still reaches pot:declare-wake. The next
      // survey (post-contention) returns the real backlog.
      if (e instanceof DigestTimeoutError) {
        const digest = buildDigest([], { nowMs: Date.now(), ownerFullAutonomy: false });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, degraded: true, reason: 'digest_timeout', digest }) }],
        };
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
});
