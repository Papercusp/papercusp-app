/**
 * hive-epoch-boundary — the BOUNDARY-TRIGGER CORE for the read-plane re-key (Brief
 * RE-KEY / C-001 / E-001 / Move 2, K's lane: P2). The pure composition that turns a
 * membership/visibility boundary (member-remove / go-private) into a real read cut-off:
 *
 *   advance the epoch (P1) → mint the new epoch key (ed300 deriveEpochKey) →
 *   wrap it to EACH REMAINING member (ed300 wrapKeyToMember).
 *
 * The removed member (or anyone going-private excludes) is simply NOT in
 * `remainingMemberPubkeys`, so it gets no wrapped row → it can replicate future
 * ciphertext but can never unwrap the new epoch key → cut off. That is the C-001 cut.
 *
 * This is PURE + side-effect-light: it advances the epoch (a hive_settings write via P1)
 * and returns the per-member wrapped rows for the CALLER (the wiring) to persist into
 * `hive_epoch_keys` (P3/P-005) + federate. The wiring into `revokeHiveContributor` /
 * `setHiveListing` + the `hive_epoch_keys` capture are the GATED parts (ride d2230's
 * A-003 (a′) federation seam); this core composes my P1 epoch model + ed300's stable
 * crypto, so it is testable end-to-end NOW with zero collision against the in-flight
 * federation work.
 */
import type { Sql } from 'postgres';
import type { HiveEpochCrypto } from './hive-epoch-crypto';
import { getHiveEpoch, setHiveEpoch } from './hive-epoch-state';

/** One per-member wrapped epoch key, to be persisted as a `hive_epoch_keys` row (P-005). */
export interface WrappedEpochKeyRow {
  /** The remaining member's raw Ed25519 device pubkey (base64). */
  memberDevicePubkey: string;
  /** The epoch key sealed to that member's device key — only they can unwrap it. */
  wrappedKey: Uint8Array;
}

export interface AdvanceEpochResult {
  /** The new (advanced) epoch. */
  newEpoch: number;
  /** One wrapped row per UNIQUE remaining member (the removed member is absent). */
  wrapped: WrappedEpochKeyRow[];
  /**
   * WI-6044: device pubkeys whose wrapKeyToMember THREW and were therefore SKIPPED
   * (malformed/legacy rows — see the WI-3927 note on advanceEpochAndWrap). Absent/empty
   * on the healthy path. Non-empty means those devices hold NO key for `newEpoch` and can
   * no longer read — surface it, don't swallow it: an unexpected skip is indistinguishable
   * from an intentional revocation at the read layer.
   */
  skippedDevicePubkeys?: string[];
}

export interface HiveBoundaryCtx {
  workspaceId: string;
  /** The hive's home_slug — the hive_settings / federation scope. */
  potHomeSlug: string;
  /** The hive's crypto identity id (deriveEpochKey / keychain key id). */
  potId: string;
}

/**
 * Advance the hive epoch and wrap the new epoch key to each remaining member.
 *
 * @param remainingMemberPubkeys raw Ed25519 device pubkeys (base64) of the members who
 *   KEEP access — the removed/excluded member(s) must NOT appear here. Deduped.
 * @returns the new epoch + the per-member wrapped rows for the caller to persist + federate.
 */
export async function advanceEpochAndWrap(
  crypto: HiveEpochCrypto,
  ctx: HiveBoundaryCtx,
  remainingMemberPubkeys: readonly string[],
  sql?: Sql,
): Promise<AdvanceEpochResult> {
  // EI-18714731283071702: compute the PROSPECTIVE epoch and do all the wrapping FIRST; the
  // advance is PERSISTED at the bottom, only once we know at least one member device wrapped.
  // This used to call advanceHiveEpoch() right here, which COMMITS immediately (setHiveEpoch ->
  // setHiveSetting is a bare upsert, and `sql` is undefined all the way down from
  // hive-revoke-contributor.ts:197, so there is no caller transaction to abort). The
  // all-unwrappable `throw` below therefore rolled back NOTHING: it left the epoch advanced
  // with zero wrapped keys — precisely the "persist a new epoch that NOBODY holds a key for and
  // lock the entire pot out of its own content" state its own message claims to be refusing,
  // AND it consumed an epoch number, so the next healthy boundary skipped to N+2 leaving a gap
  // epoch nobody ever held a key for. A throw that says "refusing to persist" must not persist.
  const newEpoch = (await getHiveEpoch(ctx.workspaceId, ctx.potHomeSlug, sql)) + 1;
  const key = await crypto.deriveEpochKey(ctx.potId, newEpoch);

  const seen = new Set<string>();
  const wrapped: WrappedEpochKeyRow[] = [];
  // WI-6044 guard (parity with the WI-3927 guard grantEpochKeysToMembers already carries in
  // hive-epoch-boundary-wiring.ts): ONE malformed device pubkey — e.g. the leaked test-fixture
  // row device_pubkey='pk-creator', ~10 chars instead of a 43/44-char base64 32-byte key — used
  // to make wrapKeyToMember THROW and abort this whole pass. That is severe HERE specifically,
  // because this is the REVOCATION/boundary path: aborting it leaves the epoch un-advanced, so a
  // just-revoked member keeps reading post-boundary content under the key it already holds (the
  // WI-6043 leak symptom, reached by an independent cause). So skip the unwrappable device and
  // keep granting to the well-formed ones — one bad row must never starve every good member.
  const skipped: string[] = [];
  for (const pk of remainingMemberPubkeys) {
    if (!pk || seen.has(pk)) continue; // skip empties + dedupe
    seen.add(pk);
    try {
      wrapped.push({ memberDevicePubkey: pk, wrappedKey: await crypto.wrapKeyToMember(key, pk) });
    } catch (e) {
      skipped.push(pk);
      console.warn(
        `[pot-epoch-boundary] wrapKeyToMember threw for member device pubkey ${JSON.stringify(
          pk,
        )} (len ${pk.length}) — device skipped, boundary continues (WI-6044): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  // Deliberately FAIL LOUD when EVERY candidate was unwrappable, rather than mirroring the
  // grant path's soft {applied:false}. Returning an empty wrapped[] would leave a new epoch that
  // NOBODY holds a key for and lock the entire pot out of its own content — strictly worse than
  // the pre-guard behaviour. Throwing is also what happened before this guard existed for this
  // case, so total failure is no more disruptive than today; the improvement is purely that a
  // PARTIAL failure now degrades instead of aborting.
  // EI-18714731283071702: this throw is BEFORE the persist below, so it now genuinely refuses —
  // the hive stays at its current epoch and the number is not consumed.
  if (seen.size > 0 && skipped.length === seen.size) {
    throw new Error(
      `[pot-epoch-boundary] advanceEpochAndWrap: all ${seen.size} remaining member device(s) were unwrappable at epoch ${newEpoch} (WI-6044) — refusing to persist an epoch no member can read; check harness_shared.pot_members.device_attestations for malformed device_pubkey values (expect base64 length 43/44)`,
    );
  }
  // Commit the advance LAST — every failure path above leaves the hive on its current epoch.
  // (An empty `remaining` set still advances, as before: a go-private with no members left is a
  // legitimate boundary, and `seen.size > 0` above deliberately does not catch it.)
  await setHiveEpoch(ctx.workspaceId, ctx.potHomeSlug, newEpoch, sql);
  return { newEpoch, wrapped, ...(skipped.length > 0 ? { skippedDevicePubkeys: skipped } : {}) };
}
