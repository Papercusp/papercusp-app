/**
 * context-estimate-verify — the compaction-boundary refresh for the PG-cached
 * context estimate (WI-4154).
 *
 * Render paths no longer read the point-in-time token cache at all — they derive
 * from the transcript's current state per call (compaction-usage.ts anchored
 * reads, the "right the first time" redesign), so no verification layer exists
 * anymore. What remains here is the write-side counterpart: coord_presence.
 * context_tokens is still the canonical value roster/presence READERS see, and
 * its watchdog writer only sweeps every ~2 min — so the moment a psu /compact
 * completes, the emit-session-compacted bridge CLI calls this to re-derive and
 * write the post-boundary number through immediately. (Native auto-compactions
 * have no completion event; their correctness is carried by the per-render
 * anchored reads, and the PG row catches up on the next sweep.)
 */

import { currentContextTokensForOwner } from '../compaction-usage';

export interface ContextRefreshDeps {
  estimate?: (ownerId: string) => Promise<number | null>;
  writePgEstimate?: (ownerId: string, tokens: number) => Promise<void>;
  /** Native session id the host just spawned. When supplied, the refresh must
   *  prove the owner resolver has reached this successor before estimating. */
  expectedSessionId?: string | null;
  resolveSessionId?: (ownerId: string) => Promise<string | null>;
}

/** Dynamic import keeps this off the presence/db-org graph until a write happens. */
async function defaultWritePgEstimate(ownerId: string, tokens: number): Promise<void> {
  const { setContextEstimate } = await import('../agent-tools/coordination/presence');
  await setContextEstimate(ownerId, tokens);
}

async function defaultResolveSessionId(ownerId: string): Promise<string | null> {
  const { resolveSelfSession } = await import('../search/self-session');
  return (await resolveSelfSession(ownerId))?.sessionId ?? null;
}

/**
 * Re-derive the owner's context tokens from the transcript (forced full rescan —
 * the boundary just moved the compaction marker) and write the fresh value
 * through to coord_presence. Best-effort; never throws; null when the transcript
 * can't be resolved (OMP/Codex, rotated session).
 */
export async function refreshContextEstimateAtBoundary(
  ownerId: string,
  deps: ContextRefreshDeps = {},
): Promise<number | null> {
  try {
    // EI-21567375926533125: the detached compaction bridge races the
    // session-respawned re-anchor. A forced reseed against the OLD mapping is
    // still a perfectly successful read — of the predecessor transcript — and
    // can overwrite the PG NULL written by the confirmed respawn boundary with
    // the same stale critical value. Prove the mapping names the exact native
    // successor the host spawned before deriving anything. On a race, leave the
    // PG estimate unknown; the watchdog fills it from the successor later.
    if (deps.expectedSessionId) {
      const resolved = await (deps.resolveSessionId ?? defaultResolveSessionId)(ownerId);
      if (resolved !== deps.expectedSessionId) return null;
    }
    const fresh = await (deps.estimate ??
      ((o: string) => currentContextTokensForOwner(o, { reseed: true })))(ownerId);
    if (fresh == null) return null;
    try {
      await (deps.writePgEstimate ?? defaultWritePgEstimate)(ownerId, fresh);
    } catch {
      /* best-effort */
    }
    return fresh;
  } catch {
    return null;
  }
}
