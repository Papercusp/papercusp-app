/**
 * hive-revoke-contributor — OWNER revocation of a Hive contributor
 * (shared-hive-federation-2026-06-08 P-006, D-004). The Hive-scope generalization
 * of substrate:revoke_contributor.
 *
 * Like the per-harness revoke (sync/hyperbee/revoke-contributor.ts), revocation is
 * the only blocklist: the owner adds the TARGET's device pubkeys to the OWNER's OWN
 * hive_members row's revoked_pubkeys (single-writer), and the admission union
 * (loadRevokedHivePubkeys) denies the target on every peer's next admission pass.
 *
 * AUTHORITY — Hive-native, not gh-repo-admin. A Hive is keypair-identified (D-002)
 * and may be repo-less (pots default repo-less), so the harness model's gh-repo-admin
 * gate doesn't fit. The Hive owner is the Swarm that HOLDS the Hive private key
 * (identity/hive-keypair.ts) — `loadHivePubkey` returns non-null only there. That is
 * the natural owner gate and reuses the Phase-0 keypair.
 *
 * FEDERATION — the PG write (addRevokedHivePubkeys) is the LOCAL effect; replicating
 * the owner's row over the Hive peer-log is the substrate's job (P-004). The
 * `publishRevocation` seam is where the P-004 wiring adds the peer-log publish; the
 * default does the PG write so the local admission union is correct immediately.
 *
 * All collaborators-with-PG seams are injectable for hermetic unit tests.
 */

import { loadHiveKeyStatus, type HiveKeyStatus } from './identity/hive-keypair';
import { loadHiveMemberDevicePubkeys, addRevokedHivePubkeys } from './hive-membership-store';
import { resolveFederatedPotScope, type FederatedPotScope } from './federated-pot-scope';
import {
  advanceEpochOnHiveBoundary,
  isHiveRekeyEnabled,
  type BoundaryRekeyResult,
} from './sync/hyperbee/hive-epoch-boundary-wiring';

export type RevokeHiveContributorResult =
  | {
      ok: true;
      /** The target device pubkeys added to the Hive's revoked set. */
      revokedPubkeys: string[];
      /** True when a booted Hive handle applied the revoke live; false when only
       *  the PG row write happened (effective on the next admission union load). */
      live: boolean;
      /** WI-6043: the epoch the boundary advanced TO, when live:true. Propagated purely so
       *  the rekey_boundary_applied boot event (below) can name it — callers that don't care
       *  about the boot-event trail can ignore this field. */
      newEpoch?: number;
      /** WI-6043: # of remaining members the new epoch key was wrapped + persisted to. */
      distributed?: number;
      /** WI-6044: remaining-member device pubkeys the boundary SKIPPED because
       *  wrapKeyToMember threw (malformed rows) — a PARTIAL success, still live:true but
       *  those specific devices hold no key for newEpoch. Absent on the fully-healthy path. */
      skippedDevicePubkeys?: string[];
      /** WI-6043 diagnostic: WHY the boundary did not advance, when live:false. The boundary
       *  already computes this ('flag-disabled' | 'no-fresh-members' | 'no-author' | 'no-gap' |
       *  'all-members-unwrappable') — it was previously dropped here, so a live:false revoke
       *  could not name which of the five fired and every FAIL run had to be re-diagnosed by
       *  hand. Absent on the applied path (live:true). */
      reason?: BoundaryRekeyResult['reason'];
    }
  | {
      ok: false;
      /** `owner_key_unreadable` (WI-37195): the Hive key IS present but could not be read/decrypted.
       *  Deliberately DISTINCT from `not_owner` — collapsing the two is what let a C-001 breach
       *  through. See the owner gate below. */
      code:
        | 'bad_target'
        | 'not_owner'
        | 'owner_key_unreadable'
        | 'no_owner_identity'
        | 'no_target'
        | 'no_owner_row'
        | 'revoke_failed'
        /** WI-10006415: `devicePubkey` is not one of the target member's attested devices. */
        | 'not_member_device'
        /** WI-10006415: the revoke would cut off THIS Swarm's own device (or it could not be
         *  ruled out) — a self-lockout of the Hive owner, refused. */
        | 'self_device';
      detail?: string;
    };

export interface RevokeHiveContributorInput {
  workspaceId: string;
  /** The Hive's home_slug (its hives PK handle). */
  potHomeSlug: string;
  /** Numeric GitHub user id of the contributor to revoke. Positive integer. */
  githubUserId: number;
  /**
   * WI-10006415: revoke ONLY this one device (base64 pubkey) instead of every device the
   * member has attested. It must be one of that member's attested devices. This is how a
   * departed test peer or a lost machine that borrowed the OWNER's own GitHub identity is cut
   * off: a whole-member revoke of the owner's id would also revoke the owner's own device.
   */
  devicePubkey?: string;
}

export interface RevokeHiveContributorSeams {
  /** This Swarm's Hive-key status — TRI-STATE by design (WI-37195), never a boolean.
   *  Default: `loadHiveKeyStatus`. It MUST stay tri-state: `loadHivePubkey` flattens
   *  "no key held" and "key held but unreadable" into one `null`, and this is precisely the
   *  "security-relevant ownership guard" that `hive-keypair.ts` documents that flattening as
   *  wrong for. Collapsing it back to a boolean re-opens the C-001 breach. */
  loadOwnerKeyStatus?: (workspaceId: string, potHomeSlug: string) => Promise<HiveKeyStatus>;
  /** The local owner's numeric GitHub id (whose row holds the revoked set). */
  resolveOwnerGithubUserId?: () => Promise<number | null>;
  /** WI-10006415: THIS Swarm's own device pubkey (base64), or null when it cannot be
   *  resolved. Read ONLY when the target is the owner's own GitHub identity — the one case
   *  where the revoked set can contain this device. Default: the keychain-verified announce
   *  identity cache, the same no-network self that git-sync uses. */
  resolveSelfDevicePubkey?: () => Promise<string | null>;
  /** The target member's device pubkeys (the things to revoke).
   *  ⚠ SCOPE (WI-6312): receives the FEDERATED scope, resolved once by the caller. */
  loadTargetPubkeys?: (
    workspaceId: string,
    potHomeSlug: FederatedPotScope,
    githubUserId: number,
  ) => Promise<string[]>;
  /** Add `pubkeys` to the owner's own row + (P-004) federate. Throws if the owner has no row.
   *  ⚠ SCOPE (WI-6312): receives the FEDERATED scope — the SAME one loadTargetPubkeys got.
   *  Attestations and revocations are columns of ONE row, so a mismatch between these two
   *  is how a revoked device passes an admission check. */
  publishRevocation?: (
    workspaceId: string,
    potHomeSlug: FederatedPotScope,
    ownerGithubUserId: number,
    pubkeys: string[],
  ) => Promise<{
    live: boolean;
    newEpoch?: number;
    distributed?: number;
    skippedDevicePubkeys?: string[];
    reason?: BoundaryRekeyResult['reason'];
  }>;
}

/**
 * WI-280 loud-signal (mirrors rekey_grant_skipped for the grant path): a revoke whose boundary
 * epoch-advance is SKIPPED — an early-return (no_target / not_owner / ...) so
 * advanceEpochOnHiveBoundary is never reached, OR the advance itself no-op'd (live:false) — records
 * a queryable `rekey_boundary_skipped` boot event naming WHY. So a K2 revoke that doesn't advance
 * NAMES itself instead of a silent 0→0 (the witness's K2 no_target cost a manual trace to :98).
 *
 * WI-6043 (2026-07-26 reopen): the SUCCESS path (live:true) was the one case that recorded NO
 * event at all — indistinguishable, from any banked serve.log, from advanceEpochOnHiveBoundary
 * never having been reached in the first place. Records the symmetric `rekey_boundary_applied`
 * event naming the resulting newEpoch/distributed count so that ambiguity can't recur.
 *
 * Best-effort: the boot-event write must NEVER change the revoke result.
 */
export async function revokeHiveContributor(
  input: RevokeHiveContributorInput,
  seams: RevokeHiveContributorSeams = {},
): Promise<RevokeHiveContributorResult> {
  const result = await revokeHiveContributorInner(input, seams);
  try {
    const { recordBootEvent } = await import('./sync/hyperbee/boot-history');
    if (!result.ok) {
      recordBootEvent(
        input.workspaceId,
        input.potHomeSlug,
        'rekey_boundary_skipped',
        `revoke boundary advance skipped for gh=${input.githubUserId}: ${result.code}` +
          (result.detail ? ` (${result.detail})` : ''),
      );
    } else if (!result.live) {
      recordBootEvent(
        input.workspaceId,
        input.potHomeSlug,
        'rekey_boundary_skipped',
        // WI-6043: name the ACTUAL cause. This was the hardcoded placeholder
        // 'advance-not-applied', which told a FAIL-run investigator nothing beyond what
        // live:false already said — the boundary knew which of the five early-returns fired
        // and the answer was discarded one frame below.
        `revoke boundary advance skipped for gh=${input.githubUserId}: ` +
          `advance-not-applied reason=${result.reason ?? 'unreported'}`,
      );
    } else {
      const skipped = result.skippedDevicePubkeys;
      recordBootEvent(
        input.workspaceId,
        input.potHomeSlug,
        'rekey_boundary_applied',
        `revoke boundary advanced for gh=${input.githubUserId}: newEpoch=${result.newEpoch ?? '?'} distributed=${result.distributed ?? '?'}` +
          (skipped && skipped.length > 0 ? ` skippedDevices=${skipped.length} (WI-6044)` : ''),
      );
    }
  } catch {
    /* boot-history unavailable — never fail the revoke on the diagnostic */
  }
  return result;
}

async function revokeHiveContributorInner(
  input: RevokeHiveContributorInput,
  seams: RevokeHiveContributorSeams = {},
): Promise<RevokeHiveContributorResult> {
  if (!Number.isInteger(input.githubUserId) || input.githubUserId <= 0) {
    return { ok: false, code: 'bad_target', detail: 'githubUserId must be a positive integer' };
  }

  const {
    loadOwnerKeyStatus = loadHiveKeyStatus,
    resolveOwnerGithubUserId = realResolveOwnerGithubUserId,
    loadTargetPubkeys = loadHiveMemberDevicePubkeys,
    publishRevocation = realPublishRevocation,
    resolveSelfDevicePubkey = realResolveSelfDevicePubkey,
  } = seams;
  if (input.devicePubkey !== undefined && input.devicePubkey.trim() === '') {
    return { ok: false, code: 'bad_target', detail: 'devicePubkey, when given, must be a non-empty base64 pubkey' };
  }

  // 1. Owner gate: only the Swarm that holds the Hive secret may revoke.
  //
  // ⚠ TRI-STATE, and it must stay that way (WI-37195 — a live C-001 breach). This gate used to be
  // `loadHivePubkey(...) !== null`, which FLATTENS two very different states into one `null`:
  // "I hold no key for this Hive" and "a key IS here but I could not read/decrypt it". Both then
  // returned `not_owner`, and `not_owner` makes the revoke return BEFORE the epoch advance — so a
  // transient keychain read failure SILENTLY skipped the re-key and left the revoked contributor
  // holding a valid key, still reading post-revoke content. A security control that failed OPEN
  // and QUIET. `hive-keypair.ts:139-153` had already called out that flattening as "wrong for a
  // security-relevant ownership guard" and shipped `loadHiveKeyStatus` for it; this call site had
  // simply never been migrated.
  //
  // So: `not_found` is a genuine non-owner (a correct, quiet no-op — most Swarms are not the
  // owner). `error` is NOT an answer to "am I the owner?" — it is a failure to determine it, and
  // it FAILS THE REVOKE LOUDLY rather than pretending the revoke succeeded. Refusing is safe
  // (the caller can retry); silently skipping the re-key is not.
  const ownerKey = await loadOwnerKeyStatus(input.workspaceId, input.potHomeSlug);
  if (ownerKey.kind === 'error') {
    return {
      ok: false,
      code: 'owner_key_unreadable',
      detail: `Hive key present but unreadable (${ownerKey.reason}) — cannot determine ownership, so the revoke is REFUSED rather than silently skipping the re-key (WI-37195). Retry once the keychain is readable.`,
    };
  }
  if (ownerKey.kind !== 'ok') {
    return { ok: false, code: 'not_owner' };
  }

  // 2. Resolve the local owner identity (whose row carries the revoked set).
  const ownerGithubUserId = await resolveOwnerGithubUserId();
  if (ownerGithubUserId == null) return { ok: false, code: 'no_owner_identity' };

  // ⚠ SCOPE (WI-6312): resolved ONCE, here, and threaded to BOTH pot_members touches below.
  // This is not a stylistic preference: attestations (step 3) and revocations (step 4) are
  // columns of the SAME row, so reading one under the local handle and writing the other
  // under the federated scope is precisely how a revoked device keeps passing admission.
  // Resolving per-call would make that divergence expressible again.
  const potScope = await resolveFederatedPotScope(input.workspaceId, input.potHomeSlug);

  // 3. Resolve the target's device pubkeys.
  let pubkeys: string[];
  try {
    pubkeys = await loadTargetPubkeys(input.workspaceId, potScope, input.githubUserId);
  } catch (err: unknown) {
    return { ok: false, code: 'revoke_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (pubkeys.length === 0) return { ok: false, code: 'no_target' };

  // 3b. WI-10006415: narrow to ONE device when asked. The device must be one the target
  // member actually attested, so a typo or another member's key can never be revoked here.
  if (input.devicePubkey !== undefined) {
    if (!pubkeys.includes(input.devicePubkey)) {
      return {
        ok: false,
        code: 'not_member_device',
        detail: `device ${input.devicePubkey.slice(0, 8)}… is not one of gh=${input.githubUserId}'s ${pubkeys.length} attested device(s) in this Hive`,
      };
    }
    pubkeys = [input.devicePubkey];
  }

  // 3c. WI-10006415: never revoke THIS Swarm's own device. Only the owner's own identity can
  // carry it (a test peer or second machine that borrowed the owner's GitHub login), so the
  // self device is read only then. If it cannot be read, the revoke is refused rather than
  // risking an owner that locks itself out of its own Hive.
  if (input.githubUserId === ownerGithubUserId) {
    const self = await resolveSelfDevicePubkey().catch(() => null);
    if (self == null) {
      return {
        ok: false,
        code: 'self_device',
        detail:
          "target is the owner's own GitHub identity and this Swarm's own device pubkey could not be resolved, so the revoke cannot rule out revoking this device",
      };
    }
    if (pubkeys.includes(self)) {
      return {
        ok: false,
        code: 'self_device',
        detail:
          `the revoked set includes this Swarm's own device ${self.slice(0, 8)}…` +
          (input.devicePubkey === undefined ? ' — pass devicePubkey to revoke one other device of this identity' : ''),
      };
    }
  }

  // 4. Publish: add to the owner's own row (federates via the Hive peer-log, P-004).
  try {
    const { live, newEpoch, distributed, skippedDevicePubkeys, reason } = await publishRevocation(
      input.workspaceId,
      potScope,
      ownerGithubUserId,
      pubkeys,
    );
    return {
      ok: true,
      revokedPubkeys: pubkeys,
      live,
      newEpoch,
      distributed,
      skippedDevicePubkeys,
      reason,
    };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/no.*row/i.test(detail)) return { ok: false, code: 'no_owner_row', detail };
    return { ok: false, code: 'revoke_failed', detail };
  }
}

// ─── real default seams ───────────────────────────────────────────────────────

async function realResolveOwnerGithubUserId(): Promise<number | null> {
  const { resolveLocalGithubIdentity } = await import('./identity/resolve-local-github-identity');
  const identity = await resolveLocalGithubIdentity();
  return identity.kind === 'ok' ? identity.githubUserId : null;
}

async function realResolveSelfDevicePubkey(): Promise<string | null> {
  const { loadCachedLocalAnnounceIdentity } = await import('./sync/hyperbee/local-announce-identity');
  return (await loadCachedLocalAnnounceIdentity())?.devicePubkeyBase64 ?? null;
}

async function realPublishRevocation(
  workspaceId: string,
  potHomeSlug: FederatedPotScope,
  ownerGithubUserId: number,
  pubkeys: string[],
): Promise<{
  live: boolean;
  newEpoch?: number;
  distributed?: number;
  skippedDevicePubkeys?: string[];
  reason?: BoundaryRekeyResult['reason'];
}> {
  const row = await addRevokedHivePubkeys(workspaceId, potHomeSlug, ownerGithubUserId, pubkeys);
  if (!row) {
    throw new Error('owner has no hive_members row — join the Hive before revoking');
  }
  // P-004 (shared-hive-rekey-2026-06-19): the substrate re-key — the peer-log publish the
  // K-1 gap was waiting on. Advance the epoch + distribute the new key to the REMAINING
  // members (cutOff = the just-revoked device pubkeys). The `hive_epoch_keys` rows federate
  // (mig 316 capture → hive-epoch-keys projection over the A-003 hive-home seam), so the
  // revoked member replicates post-boundary ciphertext it can never decrypt = the C-001
  // READ cut. Flag-gated (papercusp-hive-rekey): OFF ⇒ no-op, today's PG-only behavior →
  // `live:false`. ON ⇒ the removal is a live read-cut → `live:true`.
  // ⚠ WI-6043: DO NOT pass an `sql` transaction handle into this call without also fixing
  // the epoch cache. It looks like a pure atomicity improvement and it is not.
  //
  // The drain's encrypt capability caches the current epoch for EPOCH_CACHE_TTL_MS = 5s
  // (hive-epoch-op-gate.ts:160-175). Its immediate-invalidation signal is a process-local
  // generation counter that setHiveEpoch bumps at CALL time (hive-epoch-state.ts:86-87),
  // while `getCurrentEpoch` re-reads on a SEPARATE pooled connection (hive-epoch-boot-deps.ts:200,
  // no sql). Today that is safe ONLY because this call passes no sql, so the boundary's
  // setHiveEpoch autocommits and the bump and the new value become visible together.
  //
  // Wrap this in a transaction and that stops being true: the generation bumps while the
  // epoch write is still uncommitted, so the very next encryptOp misses the cache, re-reads
  // the OLD epoch on its own connection, and re-caches it under the NEW generation — pinning
  // the OUTGOING epoch for the full 5s TTL with no remaining invalidation signal. Every
  // content op drained in that window federates under the epoch the just-revoked member still
  // holds a key for: a post-ban read leak, load-dependent and intermittent.
  //
  // If atomicity here is ever genuinely needed, invalidate AFTER commit (or have the encrypt
  // capability read through the same transaction) rather than bumping mid-transaction.
  const { applied, newEpoch, distributed, skippedDevicePubkeys, reason } =
    await advanceEpochOnHiveBoundary({
      workspaceId,
      potHomeSlug,
      enabled: await isHiveRekeyEnabled(),
      cutOffPubkeys: pubkeys,
    });
  // WI-6043: `reason` names WHICH early-return fired when the advance did not apply. Dropping
  // it here is what made a live:false revoke unattributable — the leak run could not say
  // whether the cut failed on the flag, on no-author, on no-fresh-members, ...
  return { live: applied, newEpoch, distributed, skippedDevicePubkeys, reason };
}
