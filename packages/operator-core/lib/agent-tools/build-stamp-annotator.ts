/**
 * build-stamp-annotator — tell an agent WHICH BUILD served its tool call (EI-23755915994199376).
 *
 * THE FAILURE: an agent reads source at staging/HEAD, observes a defect still reproducing, and
 * concludes "the fix is broken". But MCP tool calls execute on a host (`:3070`, the release
 * checkout) that routinely lags staging by hours, and nothing in a tool RESULT says which build
 * ran — so the agent has no cue that the source it read is not the code that executed. It fails
 * toward a confident wrong conclusion ("your fix does not work"), the most expensive peer report.
 *
 * WHY NOT STAMP EVERY RESULT: this runs on the dispatch hot path of every call, and results are
 * capped (~1,500 tokens). A line on every call would be pure noise after the first one. The build a
 * session talks to changes rarely, so the signal is stamped ONCE per (owner, build) and again after
 * a quiet interval — the re-stamp is what makes it survive a carry-respawn / compaction, which
 * keeps the owner id but drops the earlier line from the agent's context.
 *
 * Reuses existing seams, no new system: `readServerVintage()` (already wired to
 * `getBuildInfo().sha` + `process.uptime()` by server-vintage-wiring.ts) is the source of truth
 * for the build, and `ResultAnnotator` is the single result-time hook. Because tooldef keeps ONE
 * annotator (last registration wins), this is COMPOSED with the context gauge in
 * context-gauge-wiring.ts via {@link composeResultAnnotators}, never registered separately.
 */
import { readServerVintage, type ResultAnnotator } from '@papercusp/agent-mcp';
import type { ServerVintage } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type ResolveIdentityCtx } from './coordination/identity';

/** Re-stamp an owner this long after its last stamp even when the build is unchanged. */
export const BUILD_STAMP_REFRESH_MS = 30 * 60_000;
/** Bound on distinct owners tracked — oldest evicted first (Map preserves insertion order). */
export const BUILD_STAMP_MAX_OWNERS = 2048;

type AnnotatedResult = Parameters<ResultAnnotator>[0];

const STAMP_RE = /served by build [0-9a-zA-Z._-]+/;

function carriesStamp(result: AnnotatedResult): boolean {
  return result.content?.some((c) => c.type === 'text' && STAMP_RE.test(c.text)) ?? false;
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export interface BuildStampDeps {
  /** Epoch ms — injectable so the refresh interval is testable without sleeping. */
  now?: () => number;
  /** The host's own vintage — defaults to the registered server-vintage resolver. */
  vintage?: () => ServerVintage | null;
}

/**
 * Build a stamping annotator with its own per-owner state. Pure of I/O: the vintage resolver is
 * cached/synchronous by contract (see server-vintage.ts), so this is safe on the hot path.
 */
export function createBuildStampAnnotator(deps: BuildStampDeps = {}): ResultAnnotator {
  const now = deps.now ?? Date.now;
  const vintageOf = deps.vintage ?? readServerVintage;
  const lastStamp = new Map<string, { buildId: string; atMs: number }>();

  return (result, ctx) => {
    const vintage = vintageOf();
    const buildId = vintage?.buildId ?? null;
    if (!vintage || !buildId) return result; // host cannot name its build — say nothing, never guess
    let ownerId: string;
    try {
      ownerId = resolveAgentIdentity(ctx as unknown as ResolveIdentityCtx).ownerId;
    } catch {
      return result; // unattributable ctx (system / in-process call) — no stamp
    }
    const at = now();
    const prior = lastStamp.get(ownerId);
    if (prior && prior.buildId === buildId && at - prior.atMs < BUILD_STAMP_REFRESH_MS) return result;
    if (carriesStamp(result)) return result; // a tool that already reports its build — don't double-render

    // Re-insert so the Map stays ordered by recency, then bound it.
    lastStamp.delete(ownerId);
    lastStamp.set(ownerId, { buildId, atMs: at });
    if (lastStamp.size > BUILD_STAMP_MAX_OWNERS) {
      const oldest = lastStamp.keys().next().value;
      if (oldest !== undefined) lastStamp.delete(oldest);
    }

    const line =
      `ℹ served by build ${buildId} (up ${formatAge(vintage.bootedAgoMs)}) — this host runs the code it booted with; ` +
      `source you read at HEAD/staging may be NEWER than the build that executed this call, so a defect still ` +
      `reproducing is not evidence its fix is broken until dev:pipeline_position confirms this build contains it.`;
    return {
      ...result,
      _meta: { ...(result._meta ?? {}), _buildStamp: { buildId, bootedAgoMs: Math.round(vintage.bootedAgoMs) } },
      content: [...result.content, { type: 'text' as const, text: line }],
    };
  };
}

/**
 * Run annotators in order, each seeing the previous one's output. A throwing annotator is skipped
 * (the seam's own contract: a broken annotator must never fail the tool call it only decorates).
 */
export function composeResultAnnotators(...annotators: ResultAnnotator[]): ResultAnnotator {
  return (result, ctx) =>
    annotators.reduce<AnnotatedResult>((acc, annotate) => {
      try {
        return annotate(acc, ctx);
      } catch {
        return acc;
      }
    }, result);
}

/** The process-wide instance registered by context-gauge-wiring.ts. */
export const buildStampAnnotator: ResultAnnotator = createBuildStampAnnotator();
