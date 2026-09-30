/**
 * Two-tier memory (self-learning-frontier-2026-06-12 P-022 / FB-08, D-006):
 * `metadata.tier` on a MemoryEntry marks it 'probationary' (admitted free —
 * D-006: admission is never gated, so the same-turn insight rule is
 * untouched) or 'validated' (promoted by a PASSING student-transfer test in
 * lib/transfer). Entries with no tier metadata — the entire pre-existing
 * corpus, and everything written outside the transfer harness — read as
 * 'validated': legacy facts are grandfathered, never demoted by default.
 *
 * Read path: probationary entries STILL SURFACE (admission free); the
 * injection block marks them `· probationary` only when the
 * papercusp-transfer-harness flag is ON (dark per D-001 ⇒ byte-identical
 * output today). Retention/promotion writes flow through the helpers here so
 * the tier vocabulary stays in one place.
 */
import type { MemoryBackend, MemoryEntry, RememberOptions } from '@papercusp/memory';

/** D-006's two tiers. ('retired' lessons are FORGOTTEN, not tiered.) */
export type MemoryTier = 'probationary' | 'validated';

/** The metadata key carrying the tier (backend-passthrough). */
export const MEMORY_TIER_KEY = 'tier';

/** Tier of an entry; anything but an explicit 'probationary' reads validated
 *  (legacy rows are grandfathered — fail-open on junk metadata). */
export function memoryTierOf(entry: Pick<MemoryEntry, 'metadata'>): MemoryTier {
  return entry.metadata?.[MEMORY_TIER_KEY] === 'probationary' ? 'probationary' : 'validated';
}

/**
 * Admit one lesson into memory at tier 'probationary'. `verbatim` so the
 * backend stores exactly one entry byte-identical (no extractor pass) and the
 * returned id is THE entry. Returns null when the backend declined/merged
 * (no new id to track).
 */
export async function admitProbationaryMemory(
  backend: MemoryBackend,
  input: {
    text: string;
    scope: string;
    kind?: string;
    /** Extra provenance (origin, transfer_lesson_id, source_ref, …). */
    metadata?: Record<string, unknown>;
  },
): Promise<string | null> {
  const opts: RememberOptions = {
    scope: input.scope,
    ...(input.kind ? { kind: input.kind } : {}),
    metadata: { ...(input.metadata ?? {}), [MEMORY_TIER_KEY]: 'probationary' satisfies MemoryTier },
    verbatim: true,
  };
  const { ids } = await backend.remember(input.text, opts);
  return ids[0] ?? null;
}

/**
 * Flip one entry's tier (promotion/demotion) via the backend's metadata
 * merge-patch. Best-effort by contract: mem0's OSS update throws on metadata
 * patches — callers treat a throw as "tier recorded in transfer_lessons but
 * not mirrored", never as a failed test.
 */
export async function setMemoryTier(
  backend: MemoryBackend,
  memoryId: string,
  tier: MemoryTier,
): Promise<void> {
  await backend.update(memoryId, { metadata: { [MEMORY_TIER_KEY]: tier } });
}
