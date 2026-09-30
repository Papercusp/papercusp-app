/**
 * sha-token-registry — the lock authority's per-(coordinationDomain, path)
 * sha-token state for the G-0 handoff protocol (Phase 7 P-033,
 * cross-machine-coord-parity-and-trust-2026-07-01; D-011 hole 1).
 *
 * THE PROTOCOL (intent-plane keystone): a hive-scoped file-lock RELEASE
 * publishes-then-releases — the holder commits, pushes its own hive-git
 * namespace, then hands the authority the published head sha
 * (`locks:release { published_sha }`). The authority remembers that sha per
 * (domain, path) and stamps the NEXT grant with it as `requiredSha`: the new
 * holder builds on the prior holder's work once `requiredSha` is an ancestor
 * of its local staging (acquirer-side check —
 * sync/hive-git/handoff-token.ts `classifyRequiredSha`/`gradeShaTokenGrant`,
 * which also downgrade grants into PARKED heads loudly, G-0b). When the prior
 * grant EXPIRED without a release (the holder died / lost its session before
 * publishing), the next grant instead carries `unsyncedRisk: true` — the
 * acquirer is warned the prior work may exist only on the dead holder's
 * machine.
 *
 * SCOPE: intent-plane, advisory, in-memory on the authority — the same
 * durability class as the authority role itself (deterministic re-election,
 * D-005). Fail-open by design: an empty registry (fresh authority / restart)
 * yields `{ requiredSha: null, unsyncedRisk: false }`, which is exactly the
 * pre-protocol behavior; git remains the data-safety backstop (D-004). For
 * failover continuity the release LockEvent (P-015 stream) carries
 * `publishedSha`, so a NEW authority can rebuild this state from the stream —
 * that reconstruction is a follow-up, not wired here.
 *
 * Pure + injectable-clock (callers pass `nowMs`), module-singleton like the
 * other authority registries, bounded (LRU eviction — WI-1548) so a
 * pathological path-cardinality can't grow it unbounded without silently
 * dropping still-hot entries.
 */

/** The sha-token stamp attached to a file-lock grant (G-0). */
export interface ShaTokenGrant {
  /** The last sha a releasing holder published for these paths (null = none known). */
  requiredSha: string | null;
  /** True when the prior grant expired WITHOUT a release — the expiry-reclaim
   *  case: the prior holder's work may never have synced. */
  unsyncedRisk: boolean;
}

interface PathTokenState {
  /** Last published sha for this path + when it was handed to the authority. */
  lastPublished?: { sha: string; ts: number };
  /** The currently-outstanding grant (cleared by a release). */
  active?: { owner: string; expiresAtMs: number };
}

/** Bound on tracked (domain, path) entries — LRU-evicted beyond this (WI-1548). */
const MAX_ENTRIES = 8192;

/**
 * A git commit sha: hex-only, 40 (SHA-1) or 64 (SHA-256) chars. Mirrors the
 * `locks:release` MCP tool's `published_sha` zod validation
 * (agent-tools/locks/release.ts) — but that regex guards only ONE entry
 * point. `noteShaTokenRelease` is also reached from the cross-machine
 * authority RPC surface (file-lock-authority-ops.ts `lock.release`, driven by
 * a REMOTE peer's payload over PeerRpcTransport → POST /api/authority/rpc),
 * which did NOT re-validate — so a peer (or a future third caller) could
 * stamp arbitrary text as `requiredSha` on the NEXT grant, later fed
 * unsanitized into `git merge-base --is-ancestor <requiredSha> …` in
 * classifyRequiredSha (sync/hive-git/handoff-token.ts). `spawn` (no shell) rules
 * out shell injection, but a value that happens to start with `-` could still
 * be parsed as a git OPTION rather than a positional sha (argument injection)
 * — WI-1551. Validating here, at the single choke point both callers
 * converge on, closes the gap regardless of which entry point a value arrives
 * through.
 */
const SHA_RE = /^[0-9a-f]{40,64}$/;

const state = new Map<string, PathTokenState>();

/** `\0` can appear in neither a repo realpath nor a lock path. */
function key(domain: string, path: string): string {
  return `${domain}\0${path}`;
}

/**
 * Bump `k` to the most-recently-used position. A JS `Map` iterates in
 * insertion order, so delete+re-set moves the key to the END without
 * touching any other entry's relative order — the standard Map-as-LRU trick.
 * Called on every touch (grant, release, AND lookup via
 * {@link shaTokenForGrant}) so a path that's merely read stays protected from
 * eviction, not just one that's written.
 */
function touch(k: string, e: PathTokenState): void {
  state.delete(k);
  state.set(k, e);
}

function entry(domain: string, path: string): PathTokenState {
  const k = key(domain, path);
  const existing = state.get(k);
  if (existing) {
    touch(k, existing);
    return existing;
  }
  const e: PathTokenState = {};
  if (state.size >= MAX_ENTRIES) {
    // Was: `state.keys().next().value` — the oldest-BY-INSERTION key, which
    // is exactly WI-1548: a hot path inserted early but still actively
    // granted/released kept getting evicted ahead of genuinely-cold, newer
    // entries. `touch()` on every access keeps the map ordered
    // least-recently-used-first, so the true head is the right thing to
    // evict here.
    const lru = state.keys().next().value;
    if (lru !== undefined) state.delete(lru);
  }
  state.set(k, e);
  return e;
}

/**
 * Compute the sha-token stamp for a grant over `paths` — call BEFORE
 * {@link noteShaTokenGrant} for the same grant. `requiredSha` is the most
 * recently published sha across the paths (one repo domain ⇒ one lineage);
 * `unsyncedRisk` is true when ANY path's outstanding grant expired without a
 * release AND the new acquirer (`newOwner`) differs from the expired grant's
 * owner.
 *
 * `newOwner` (WI-1549): pass the identity that is ABOUT to receive this
 * grant, when known. Without it, an expired-without-release grant always
 * reads as unsynced risk — the original, conservative behavior. WITH it, a
 * holder re-acquiring its OWN expired-but-unreleased path (its session
 * merely stalled past the ttl and reconnected before anyone else touched the
 * path) is correctly NOT flagged: the work never left that holder's machine,
 * so there is nothing that could be unsynced. A different owner picking up
 * the same expired grant still sees the risk.
 */
export function shaTokenForGrant(
  domain: string,
  paths: readonly string[],
  nowMs: number,
  newOwner?: string,
): ShaTokenGrant {
  let latest: { sha: string; ts: number } | null = null;
  let unsyncedRisk = false;
  for (const p of paths) {
    const k = key(domain, p);
    const e = state.get(k);
    if (!e) continue;
    touch(k, e); // a lookup counts as "hot" too — not just writes (WI-1548).
    if (e.lastPublished && (!latest || e.lastPublished.ts > latest.ts)) latest = e.lastPublished;
    if (e.active && nowMs > e.active.expiresAtMs && e.active.owner !== newOwner) unsyncedRisk = true;
  }
  return { requiredSha: latest?.sha ?? null, unsyncedRisk };
}

/** Record a grant (successful acquire) over `paths`. */
export function noteShaTokenGrant(
  domain: string,
  paths: readonly string[],
  owner: string,
  expiresAtMs: number,
): void {
  for (const p of paths) {
    entry(domain, p).active = { owner, expiresAtMs };
  }
}

/**
 * Record a release over `paths`. `publishedSha` is the head the holder
 * published before releasing (G-0 publish-then-release); null = the holder
 * released without publishing (nothing to carry — the prior published sha, if
 * any, stands, and there is no unsynced risk because the release was clean).
 *
 * WI-1551: a `publishedSha` that isn't a well-formed hex sha is treated
 * EXACTLY like `null` (not recorded) — the same fail-open, advisory posture
 * this registry already documents for an unsynced-risk grant, just applied to
 * malformed input instead of absent input. This is the validation choke
 * point for BOTH callers (the `locks:release` MCP tool, which also validates
 * at its own zod boundary, and the cross-machine authority RPC path, which
 * previously did not) — see SHA_RE's doc comment.
 */
export function noteShaTokenRelease(
  domain: string,
  paths: readonly string[],
  publishedSha: string | null,
  nowMs: number,
): void {
  const sha = publishedSha && SHA_RE.test(publishedSha) ? publishedSha : null;
  for (const p of paths) {
    const e = entry(domain, p);
    delete e.active;
    if (sha) e.lastPublished = { sha, ts: nowMs };
  }
}

/** Test seam. */
export const _shaTokenTesting = {
  reset: () => state.clear(),
  size: () => state.size,
  maxEntries: MAX_ENTRIES,
};
