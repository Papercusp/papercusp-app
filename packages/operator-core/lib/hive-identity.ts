/**
 * hive-identity — get-or-mint orchestration for the first-class Hive entity
 * (shared-hive-federation-2026-06-08 P-002/P-003).
 *
 * Bridges the two halves of Phase 0:
 *   - identity/hive-keypair.ts — mint/load the per-Hive Ed25519 keypair (secret in
 *     the OS keychain; the owning Swarm only).
 *   - hive-store.ts — persist + read the PUBLIC identity row in PG.
 *
 * `ensureHiveIdentity` is the single entry point both `pot:create` (fresh) and
 * `resolveHive` (lazy-backfill of a pre-existing hive) call: it mints-or-loads the
 * keypair and get-or-creates the hives row, returning the Hive's public identity.
 */
import {
  loadOrGenerateHiveKeypair,
  loadHivePubkey,
  HIVE_KEYPAIR_SERVICE,
  RemoteHiveViewMintRefusedError,
} from './identity/hive-keypair';
import { keychainLoad } from './identity/keychain';
import { deriveHiveFederationTopic } from './sync/hyperbee/derive-swarm-topic';
import { getHiveBySlug, insertHiveIfAbsent, type HiveRecord } from './hive-store';
import { trackDetached } from './detached-imports';

export interface EnsureHiveIdentityResult {
  record: HiveRecord;
  /** True when the hives row was inserted now; false when it already existed. */
  created: boolean;
}

/**
 * Get-or-mint a Hive's identity. MUST run on the Hive's OWNING Swarm (the one that
 * holds, or will mint, the secret) — a peer Swarm that only has the pubkey must not
 * call this (it would mint a conflicting key; hive-keypair.ts guards the intent).
 * Today every `kind:'hive'` project in the local registry is locally owned, so this
 * is always safe; Phase 1 gates it on real ownership once peer Swarms exist.
 *
 * Idempotent: the keypair is stable (hive-keypair load-or-gen) and the row is
 * get-or-created (never clobbered). `meta` (title/description) applies only on the
 * first insert.
 */
export async function ensureHiveIdentity(
  workspaceId: string,
  homeSlug: string,
  meta?: { title?: string | null; description?: string | null },
): Promise<EnsureHiveIdentityResult> {
  // A slug rename must NOT orphan the hive's key. The hives row's `keychain_id` is
  // AUTHORITATIVE: if the row already exists and THIS Swarm holds the key stored under
  // that id, return the row as-is — do NOT recompute the id from the (possibly renamed)
  // slug via loadOrGenerateHiveKeypair, whose miss-path would MINT a fresh divergent key
  // under the new slug id. That recompute-and-mint is exactly what orphaned canonical
  // 76dee8ea (stored under the legacy `papercup-hive` keychain id) and minted the
  // divergent ef77075a under the new `papercusp` id on the 2026-06-19 rebrand rename —
  // so the owner then announced the WRONG (empty) hive (the ef77075a divergence,
  // 2026-07-01). Only owned (non-`remote:`) rows we actually hold short-circuit here;
  // a fresh hive (no row) or a peer/orphaned key falls through to the mint-or-load path
  // unchanged.
  const existing = await getHiveBySlug(workspaceId, homeSlug);
  if (existing?.keychainId && !existing.keychainId.startsWith('remote:')) {
    const held = await keychainLoad(existing.keychainId, HIVE_KEYPAIR_SERVICE).catch(
      () => ({ kind: 'error' as const }),
    );
    if (held.kind === 'ok') return { record: existing, created: false };
  }
  // WI-1981 (the Phase-1 ownership gate, now real): a joined `remote_hive`
  // registry VIEW must NEVER reach the mint — that is a PEER's hive. The old
  // "today every kind:'hive' row is locally owned" assumption died when
  // joinHiveAsView started materializing view rows; the lazy-backfill below
  // then MINTED a second conflicting author identity on the joiner (wrong
  // epoch secrets → poison origin=local wraps → permanent mutual
  // epoch_decrypt_fail — proven live tower↔VM 2026-07-03). If the view carries
  // the verified announced pubkey (stamped by joinHiveAsView), heal the missing
  // hives row from IT (keychainId `remote:<pubkey>`, the existing non-owned
  // convention); with no stamped pubkey, refuse loudly rather than mint.
  const view = await remoteHiveView(workspaceId, homeSlug);
  if (view) {
    if (view.hive_pubkey) {
      return insertHiveIfAbsent({
        workspaceId,
        homeSlug,
        pubkeyBase64: view.hive_pubkey,
        keychainId: `remote:${view.hive_pubkey}`,
        title: meta?.title ?? null,
        description: meta?.description ?? null,
      });
    }
    const { RemoteHiveViewMintRefusedError } = await import('./identity/hive-keypair');
    throw new RemoteHiveViewMintRefusedError(workspaceId, homeSlug);
  }
  const kp = await loadOrGenerateHiveKeypair(workspaceId, homeSlug);
  return insertHiveIfAbsent({
    workspaceId,
    homeSlug,
    pubkeyBase64: kp.pubkeyBase64,
    keychainId: kp.keychainId,
    title: meta?.title ?? null,
    description: meta?.description ?? null,
  });
}

/** WI-1981: the harness_registry view row for a JOINED remote hive, or null.
 *  Best-effort (an unreadable registry reads as "no view" — the keypair-level
 *  guard in loadOrGenerateHiveKeypair is the authoritative backstop). */
async function remoteHiveView(
  workspaceId: string,
  slug: string,
): Promise<{ hive_pubkey?: string } | null> {
  try {
    const { loadHarnessRegistry } = await import('./harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    const entry = reg.projects?.find((p) => p.slug === slug);
    return entry?.remote_hive === true ? entry : null;
  } catch {
    return null;
  }
}

/**
 * EI-18688308662198558 (2026-07-26): a joined `remote_hive` VIEW's mint refusal
 * (RemoteHiveViewMintRefusedError) is a STRUCTURAL, permanent fact about a given
 * (workspaceId, homeSlug) pair — this box is a peer, not the owner, for that
 * hive, and that does not change from one call to the next. Left uncached, any
 * caller that invokes resolveHivePubkey on a cadence (a periodic pot-list /
 * dashboard refresh, a routine tick) re-runs the full registry lookup + mint
 * attempt AND re-logs the identical warning on every single call, for as long
 * as the caller keeps polling — observed live: a wall of the identical
 * "backfill failed" line for a full hour inside the gym's hermetic ephemeral
 * instance (gym-loop-ws), with the gym cycle itself never progressing past
 * boot. This module-scoped cache remembers the refusal so a repeat caller for
 * the SAME pair gets an immediate `undefined` with zero registry I/O and zero
 * repeat logging — a genuinely different (workspaceId, homeSlug) pair, or a
 * TRANSIENT failure (PG/network blip), is never affected: only this specific,
 * permanent refusal is cached, and `getHiveBySlug` is still checked first on
 * every call so a hives row that later appears (the view gets healed) is
 * picked up immediately, bypassing the cache entirely.
 */
const remoteViewRefusalCache = new Set<string>();

/**
 * The Hive's public identity for the read path: the stored pubkey, or — for a
 * pre-existing hive that predates the entity — a best-effort lazy-backfill (mint +
 * persist on this owning Swarm). Returns `undefined` only if backfill genuinely
 * fails (e.g. the keychain is unavailable); a resolve must never throw because of
 * it (the hive stays usable by slug). Cheap in steady state: one PG read once the
 * row exists.
 */
export async function resolveHivePubkey(
  workspaceId: string,
  homeSlug: string,
): Promise<string | undefined> {
  const existing = await getHiveBySlug(workspaceId, homeSlug);
  if (existing) return existing.pubkeyBase64;
  const cacheKey = `${workspaceId}/${homeSlug}`;
  if (remoteViewRefusalCache.has(cacheKey)) return undefined;
  try {
    const { record } = await ensureHiveIdentity(workspaceId, homeSlug);
    return record.pubkeyBase64;
  } catch (e) {
    if (e instanceof RemoteHiveViewMintRefusedError) {
      remoteViewRefusalCache.add(cacheKey);
      console.warn(
        `[hive-identity] backfill permanently refused for ${workspaceId}/${homeSlug} ` +
          `(joined remote_hive view with no stamped pubkey) — caching; will not retry ` +
          `this pair again this process. ${e.message}`,
      );
    } else {
      console.warn(
        `[hive-identity] backfill failed for ${workspaceId}/${homeSlug}: ${e instanceof Error ? e.message : e}`,
      );
    }
    return undefined;
  }
}

/**
 * WI-1981 wake-#5515 follow-up (the epoch-poison pivot): is THIS box the hive's
 * CANONICAL owner — i.e. does it hold a private key whose pubkey MATCHES the
 * hive's canonical identity? `loadHivePubkey != null` ("do I hold ANY key") is
 * NOT ownership: a stale/divergent local key — e.g. one that survived a partial
 * keychain delete in the encrypted-FILE tier (keychainDelete unlinks only the
 * primary identity dir while fileLoad also reads the legacy
 * ~/.papercusp/identity dir; a headless box with no libsecret stores EVERYTHING
 * in the file tier) — made a JOINER box resolve `isOwner=true` in the epoch-key
 * resolver and MINT fresh-random epoch keys instead of unwrapping the true
 * owner's wrapped rows → permanent mutual epoch_decrypt_fail with NO re-mint at
 * all (proven live tower↔VM 2026-07-03: hives row correct, keychain-delete
 * done, poison continued — the WI-1981 counter-evidence).
 *
 * Canonical identity, in precedence order: the hives row pubkey, then the
 * joined view's verified `hive_pubkey` (stamped by joinHiveAsView). A joined
 * `remote_hive` view is NEVER owned here. With a held key but NO readable
 * canonical record, fall back to the legacy held-key heuristic (fail-open for
 * a true owner's cold start / transient PG failure — WI-755 posture).
 *
 * On a detected MISMATCH this fires the deduped divergent-key health signal
 * (best-effort) — the recurrence guard for this class — and reports NOT-owner
 * so no authority gate treats the divergent key as ownership.
 */
export async function isCanonicalHiveOwner(
  workspaceId: string,
  homeSlug: string,
): Promise<boolean> {
  const held = await loadHivePubkey(workspaceId, homeSlug).catch(() => null);
  if (held === null) return false;
  let canonical: string | null = null;
  try {
    const row = await getHiveBySlug(workspaceId, homeSlug);
    if (row?.pubkeyBase64) canonical = row.pubkeyBase64;
  } catch {
    /* PG unreadable — try the registry view next */
  }
  if (canonical === null) {
    const view = await remoteHiveView(workspaceId, homeSlug);
    if (view) {
      if (!view.hive_pubkey) return false; // a joined view is a PEER — never owner
      canonical = view.hive_pubkey;
    }
  }
  if (canonical === null) return true; // held key + no canonical record → legacy heuristic
  if (canonical === held) {
    // Held key matches canonical — clear any outstanding DIVERGENT-key alert
    // (WI-5714: the sibling recovery edge signalHiveKeyDivergent never had).
    // No-op when this hive was never flagged divergent (Set.delete's return
    // value gates the broadcast inside clearHiveKeyDivergence itself).
    void trackDetached(import('./hive-owner-key-health'))
      .then((m) => m.clearHiveKeyDivergence({ workspaceId, potSlug: homeSlug }))
      .catch(() => {});
    return true;
  }
  // Divergent local identity — the epoch-poison class. Signal loudly (deduped,
  // best-effort) and report NOT-owner.
  const canonicalPk = canonical;
  void trackDetached(import('./hive-owner-key-health'))
    .then((m) =>
      m.signalHiveKeyDivergent({
        workspaceId,
        potSlug: homeSlug,
        context: 'isCanonicalHiveOwner',
        heldPubkey: held,
        canonicalPubkey: canonicalPk,
      }),
    )
    .catch(() => {});
  return false;
}

/** Hex-rendered federation topic for a Hive pubkey — surfaced in pot:get + logs.
 *  The actual swarm-join call-site swap is the Phase-1 boundary (P-004). */
export function hiveFederationTopicHex(pubkeyBase64: string): string {
  return deriveHiveFederationTopic(pubkeyBase64).toString('hex');
}
