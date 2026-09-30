/**
 * Post-compaction memory re-prime.
 *
 * Plan: memory-delivery-unification-2026-07-12 (P-003b, decisions D-002/D-005).
 *
 * Called by the session-recovery-brief endpoint — the read the
 * SessionStart[source=compact] hook fetches — so it fires EXACTLY ONCE per
 * compaction. That makes it the session's epoch boundary:
 *
 *   1. `bumpSessionEpoch` (P-002): the compaction generation advances, the
 *      per-session surfaced-ledger resets, and the WHOLE memory pool becomes
 *      injectable again — which is exactly what a wiped context needs.
 *   2. The FULL re-prime runs through the launch-profile resolver at rung 0
 *      (held work-item titles are the most-specific statement of what the
 *      session was ACTUALLY doing — better than any launch-time signal) and
 *      the one admission pipeline, stamping the NEW epoch under port
 *      'compact' so the next turn-start delta dedups against it.
 *
 * Best-effort/never-throws: a failure returns null and the carry brief
 * lands without the memory block. The epoch bump deliberately happens FIRST
 * — a compaction happened whether or not recall succeeds.
 */

import { getOrgPg } from '@papercusp/db-org';
import { bumpSessionEpoch } from './session-epoch-ledger';
import { resolveLaunchProfile, buildLaunchMemoryBlock } from './launch-profile';
import { activeWorkspaceId } from '../workspace-registry';
import { getSessionUserOrDefault } from '../auth';

export interface CompactReprimeInput {
  ownerId: string;
  workspaceId?: string;
  /** Held work-item titles + harness slugs (from the carry brief). `id` is
   *  optional for back-compat with older callers; an item without one is
   *  skipped by the P-026 query-handle deriver below (it needs a resolvable
   *  ref) but still participates in the resolver's title-driven queries. */
  heldItems: ReadonlyArray<{ id?: string; title: string | null; harness: string | null }>;
  fleetSlug?: string | null;
  /** P-026 (WI-5001) leg (a): the carry brief's armed awaits ("open threads")
   *  and standing facts (dead-ends are the `dead-end:%`-keyed subset) — used
   *  ONLY to derive deterministic query handles for the retired-recall branch
   *  below, never folded into the resolver's query profile. Omitted callers
   *  simply get an empty handles set (today's null-return behavior for those
   *  classes is preserved). */
  awaits?: ReadonlyArray<{ eventKey: string; note: string | null }>;
  facts?: ReadonlyArray<{ key: string; body: string }>;
}

/** Test seams for the P-026 retirement gate below. */
export interface CompactReprimeDeps {
  /** FLAGS.ENRICHMENT_RETIRE_PROVEN_CLASSES read (default: real flag store). */
  retireFlagFn?: () => Promise<boolean>;
  /** The owner's drill-proven session class, or null (default: the real
   *  su-cold-by-default.carryProvenClassForOwner — live host + drill ledger). */
  provenClassFn?: (ownerId: string) => Promise<string | null>;
}

/** The heading the recovery hook's anchor will carry the block under. */
export const COMPACT_REPRIME_HEADING = 'Memory re-prime (post-compaction, epoch reset)';

/** Real P-026 flag read — lazily imported so tests with a partial flags stub work. */
async function defaultRetireFlag(): Promise<boolean> {
  const { FLAGS } = await import('@papercusp/flags');
  const { getFlag } = await import('@papercusp/flags/server');
  return getFlag(FLAGS.ENRICHMENT_RETIRE_PROVEN_CLASSES, 'system');
}

/** Real proven-class read — the shared P-021/P-026 resolver (drill ledger + live host). */
async function defaultProvenClass(ownerId: string): Promise<string | null> {
  const { carryProvenClassForOwner } = await import('../su-cold-by-default');
  return carryProvenClassForOwner(ownerId);
}

/** Most common non-null harness among the held items — the harness dim. */
export function dominantHarness(
  heldItems: ReadonlyArray<{ harness: string | null }>,
): string | null {
  const counts = new Map<string, number>();
  for (const { harness } of heldItems) {
    if (harness) counts.set(harness, (counts.get(harness) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [slug, n] of counts) {
    if (n > bestN) {
      best = slug;
      bestN = n;
    }
  }
  return best;
}

export async function buildCompactReprimeBlock(
  input: CompactReprimeInput,
  deps: CompactReprimeDeps = {},
): Promise<string | null> {
  if (!input.ownerId) return null;
  try {
    const { sql } = getOrgPg();
    // 1) The epoch boundary — always, even if recall below fails.
    await bumpSessionEpoch(sql, input.ownerId);

    // 1b) deterministic-context-carry P-026 (WI-5001): for a session class whose
    // cold-boot drills prove the deterministic carry SUFFICIENT, the speculative
    // hole-patch re-prime below is RETIRED — a successor that needed a recall fold
    // is a BUILDER gap to fix, and the live evidence (post-compaction recall at
    // 0.023–0.033 cosine) is noise. The epoch bump above deliberately STAYS: it is
    // the ledger boundary, and later turn-start deltas / explicit memory:search
    // pulls (the pull-precise path) still work against the fresh epoch. Fail-soft:
    // any resolution failure keeps the enrichment (today's behavior). Kill-switch:
    // FLAGS.ENRICHMENT_RETIRE_PROVEN_CLASSES off.
    //
    // Leg (a) growth: "retired" no longer means "nothing". Instead of a bare null,
    // emit deterministic, resolvable QUERY HANDLES (carry-brief.ts's
    // deriveCarryQueryHandles) for held work-items / open awaits / dead-ends — a
    // genuinely needed pull is still one lookup away, without folding a single
    // speculative embedding hit. Still fail-soft: a handles-derivation error keeps
    // the enrichment (falls through to the resolver below), same as any other leg.
    try {
      const retireOn = await (deps.retireFlagFn ?? defaultRetireFlag)();
      if (retireOn) {
        const provenClass = await (deps.provenClassFn ?? defaultProvenClass)(input.ownerId);
        if (provenClass) {
          const { deriveCarryQueryHandles, renderCarryQueryHandlesBlock } = await import('../carry-brief');
          const handles = deriveCarryQueryHandles({
            heldItems: input.heldItems.filter(
              (i): i is { id: string; title: string | null; harness: string | null } =>
                typeof i.id === 'string' && i.id.length > 0,
            ),
            awaits: input.awaits ?? [],
            facts: input.facts ?? [],
          });
          return renderCarryQueryHandlesBlock(handles); // null when nothing to point at
        }
      }
    } catch {
      /* fail-soft: keep the enrichment */
    }

    // 2) Rung-0 resolve + re-prime, stamping the NEW epoch.
    const profile = resolveLaunchProfile({
      harnessSlug: dominantHarness(input.heldItems),
      fleetSlug: input.fleetSlug ?? null,
      heldCheckpointTitles: input.heldItems
        .map((i) => i.title)
        .filter((t): t is string => typeof t === 'string' && t.length > 0),
    });
    if (profile.queries.length === 0) return null;

    const user = await getSessionUserOrDefault().catch(() => null);
    return await buildLaunchMemoryBlock({
      profile,
      userId: user?.id ?? null,
      workspaceId: input.workspaceId || activeWorkspaceId(),
      session: { sessionId: input.ownerId, port: 'compact' },
      heading: COMPACT_REPRIME_HEADING,
    });
  } catch {
    return null;
  }
}
