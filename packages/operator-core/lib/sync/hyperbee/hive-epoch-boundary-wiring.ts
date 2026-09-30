/**
 * hive-epoch-boundary-wiring — the P-004 boundary TRIGGER wiring for the read-plane
 * re-key (shared-hive-rekey-2026-06-19, K's lane). Turns a real membership/visibility
 * boundary (member-remove via revokeHiveContributor / go-private via setHiveListing)
 * into a read cut-off:
 *
 *   resolve the flag-gated crypto → compute the REMAINING members (all hive_members
 *   device pubkeys minus the cut-off set) → advanceEpochAndWrap (the pure P2 core) →
 *   putWrappedKeys (P-005 store; the mig-316 capture trigger federates them via the
 *   hive-epoch-keys projection).
 *
 * The cut-off member is simply absent from `remaining`, so it gets no wrapped row → it
 * replicates future ciphertext it can never unwrap = the C-001 read cut.
 *
 * Gated by `papercusp-hive-rekey`: enabled=false ⇒ no-op (PG-only revoke, no read cut).
 * STATUS (2026-07-10): this flag is DEFAULT-ON (not in DARK_FLAGS) and confirmed LIVE
 * in production (flags:get → true) — the C-001 read-cut is active today, not dark. See
 * shared-pot-release-testing/RELEASE-READINESS.md row #2/#11. The gate stays in the code
 * as a kill-switch (owner can flip off if the re-key misbehaves), not as a staged-dark flag.
 * Every PG/crypto seam is injectable for hermetic unit tests (no PG, no real crypto).
 */
import type { Sql } from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import type { HiveEpochCrypto } from './hive-epoch-crypto';
import { advanceEpochAndWrap, type WrappedEpochKeyRow } from './hive-epoch-boundary';
import { resolveHiveEpochCrypto } from './hive-epoch-serving';
import { putWrappedKeys } from './hive-epoch-keys-store';
import { getHiveEpoch } from './hive-epoch-state';
import type { HiveMemberRecord } from '../../hive-membership-store';
// EI-18777176681958978: the membership/revocation reads here are reached BOTH from the
// hive-scoped rekey path (already the owner-authored scope) AND from
// `reconcileOwnedHiveEpochKeys`, which enumerates `harness_shared.pots.pot_home_slug` — the
// LOCAL handle. Resolving is idempotent on an already-federated scope, so the
// *ForLocalPot wrappers are correct for both entry points; passing a local handle straight
// through would read an empty roster (no devices wrapped) and an empty revocation set (a
// revoked device silently re-granted the current epoch key, the C-001 failure).
//
// WI-6311 completes that: the MEMBERSHIP half above was resolved, but the EPOCH-KEY reads on
// the same lines were not — and `pot_epoch_keys` is a hiveScoped projection, i.e. written under
// the federated scope too. Because both reconcile paths COMPARE the member set against the
// epoch-key set, the half-fix was worse than either extreme: on a divergent joiner the members
// resolve (populated) while the epoch reads do not (empty), so the "does every live device
// already hold the current key" perf guard can never be satisfied and the O(E·M) crypto it
// exists to prevent runs on every apply, forever, for a hive that is already correct.
// Both reconcile paths now resolve for the epoch reads while keeping the LOCAL handle for the
// *ForLocalPot member readers, which want it. `grantEpochKeysToMembers` deliberately does NOT
// resolve — see the note at its getCurrentEpoch call.
import {
  listHiveMembersForLocalPot,
  loadRevokedHivePubkeysForLocalPot,
  resolveFederatedPotScope,
} from '../../federated-pot-scope';
import { loadHivePubkey } from '../../identity/hive-keypair';

/**
 * Is the read-plane re-key (papercusp-hive-rekey) on? The SHARED flag resolver for the
 * boundary trigger (produce side, here) AND the apply-side decrypt-gate (`rekeyOn`).
 * Default flag = true (DEFAULT-ON, not in DARK_FLAGS) — live in production as of
 * 2026-07-10; kept as a runtime kill-switch, not a staged-dark cutover gate.
 */
export async function isHiveRekeyEnabled(): Promise<boolean> {
  return getFlag(FLAGS.POT_REKEY, 'system');
}

export interface BoundaryRekeyResult {
  /** True when the re-key actually ran (flag on) — the boundary became a live read-cut. */
  applied: boolean;
  /** The advanced epoch (when applied). */
  newEpoch?: number;
  /** # of remaining members the new epoch key was wrapped + persisted to (when applied). */
  distributed?: number;
  /**
   * When NOT applied, WHICH silent early-return fired (WI-280 diagnostic, ee7e9's gap):
   * 'flag-disabled' (re-key resolved off in this context), 'no-fresh-members'
   * (newMemberPubkeys empty after dedup/filter), or 'no-author' (loadHivePubkey null — not
   * the owner box). The grant returns 0 keys with NO throw in all three, so 328af's
   * throw-only rekey_grant_failed event never sees them; the admit call-site reads this to
   * emit a queryable rekey_grant_skipped event so a 0-keys run NAMES the cause.
   * 'all-members-unwrappable' (WI-3927): every candidate device's wrapKeyToMember threw
   * (malformed pubkeys — e.g. leaked test-fixture rows) so nothing was granted.
   */
  reason?: 'flag-disabled' | 'no-fresh-members' | 'no-author' | 'no-gap' | 'all-members-unwrappable';
  /**
   * WI-6044: device pubkeys the BOUNDARY skipped because wrapKeyToMember threw (malformed rows).
   * Absent on the healthy path. This is a PARTIAL success — applied is still true and the epoch
   * DID advance — so without surfacing it the skip is invisible: those devices silently hold no
   * key for the new epoch and simply stop being able to read, which is indistinguishable from an
   * intentional revocation. Same reasoning as `reason` above (WI-280): a boundary that quietly
   * does less than asked is exactly what made WI-6043 cost hours of parallel diagnosis.
   */
  skippedDevicePubkeys?: string[];
}

export interface BoundaryRekeySeams {
  resolveCrypto?: (enabled: boolean) => HiveEpochCrypto | Promise<HiveEpochCrypto>;
  loadAllMemberPubkeys?: (ws: string, slug: string, sql?: Sql) => Promise<string[]>;
  /** The UNION of every member row's revoked_pubkeys blocklist (C-001 historical exclusion —
   *  WI-566 audit fix). Default: hive-membership-store's loadRevokedHivePubkeys. */
  loadRevokedPubkeys?: (ws: string, slug: string, sql?: Sql) => Promise<Set<string>>;
  resolveAuthorPubkey?: (ws: string, slug: string) => Promise<string | null>;
  persistWrappedKeys?: (
    ws: string,
    slug: string,
    epoch: number,
    rows: readonly WrappedEpochKeyRow[],
    author: string | null,
    sql?: Sql,
    opts?: { refederate?: boolean },
  ) => Promise<number>;
  advanceAndWrap?: typeof advanceEpochAndWrap;
}

/** Every device pubkey currently bound to the hive (deduped across every member). */
export async function loadAllHiveMemberDevicePubkeys(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<string[]> {
  const members = await listHiveMembersForLocalPot(workspaceId, potHomeSlug, sql);
  const out = new Set<string>();
  for (const m of members) {
    for (const a of m.deviceAttestations ?? []) {
      if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
        out.add(a.device_pubkey);
      }
    }
  }
  return [...out];
}

/**
 * Advance the hive epoch on a boundary + distribute the new key to the REMAINING members.
 *
 * @param enabled the `papercusp-hive-rekey` flag, resolved at the call site
 *   (isHiveRekeyEnabled). false ⇒ no-op, returns { applied: false }.
 * @param cutOffPubkeys device pubkeys to EXCLUDE from the new epoch (the removed member /
 *   go-private exclusions). They get no wrapped row → cannot decrypt post-boundary content.
 *
 * potId for deriveEpochKey / the OpAAD is the hive HOME slug — the federated hive
 * identity every peer agrees on (a joiner resolves it via the A-003 hiveHomeProjectionSlug
 * binding), so mint here ↔ encrypt/decrypt on any peer use an identical key id.
 *
 * WI-566 audit fix (K-CUT invariant): the remaining-member set excludes BOTH the fresh
 * `cutOffPubkeys` (this call's own revoke/go-private) AND the ACCUMULATED
 * `loadRevokedHivePubkeys` union (every prior revocation recorded across any member's
 * `revoked_pubkeys` blocklist). Before this fix, only `cutOffPubkeys` was excluded — a
 * revoked member's device stays in `device_attestations` forever (revocation is a
 * blocklist, not a deletion), so EVERY SUBSEQUENT boundary event (a second ban, or any
 * go-private) re-derived `remaining` from every device pubkey and RE-WRAPPED the new
 * epoch key to that already-revoked device, silently un-cutting it. Only the single
 * member revoked in a given call was ever actually cut off; every previously-revoked
 * member was re-granted on the next epoch advance. `reconcileEpochKeysForCurrentMembers`
 * already unions revoked_pubkeys correctly (self-heal path) — this brings the boundary
 * TRIGGER path (revoke / go-private) in line with it.
 */
export async function advanceEpochOnHiveBoundary(
  opts: {
    workspaceId: string;
    potHomeSlug: string;
    enabled: boolean;
    cutOffPubkeys?: readonly string[];
    sql?: Sql;
  },
  seams: BoundaryRekeySeams = {},
): Promise<BoundaryRekeyResult> {
  if (!opts.enabled) return { applied: false };
  const {
    resolveCrypto = resolveHiveEpochCrypto,
    loadAllMemberPubkeys = loadAllHiveMemberDevicePubkeys,
    loadRevokedPubkeys = loadRevokedHivePubkeysForLocalPot,
    resolveAuthorPubkey = loadHivePubkey,
    persistWrappedKeys = putWrappedKeys,
    advanceAndWrap = advanceEpochAndWrap,
  } = seams;

  const crypto = await resolveCrypto(true);
  const all = await loadAllMemberPubkeys(opts.workspaceId, opts.potHomeSlug, opts.sql);
  const cut = new Set(opts.cutOffPubkeys ?? []);
  // C-001: exclude every PRIOR revocation too, not just this call's own cut-off set —
  // otherwise a previously-revoked device is silently re-granted on the next boundary.
  const revoked = await loadRevokedPubkeys(opts.workspaceId, opts.potHomeSlug, opts.sql);
  const remaining = all.filter((pk) => pk && !cut.has(pk) && !revoked.has(pk));

  const { newEpoch, wrapped, skippedDevicePubkeys } = await advanceAndWrap(
    crypto,
    { workspaceId: opts.workspaceId, potHomeSlug: opts.potHomeSlug, potId: opts.potHomeSlug },
    remaining,
    opts.sql,
  );

  const author = await resolveAuthorPubkey(opts.workspaceId, opts.potHomeSlug);
  const distributed = await persistWrappedKeys(
    opts.workspaceId,
    opts.potHomeSlug,
    newEpoch,
    wrapped,
    author,
    opts.sql,
  );
  return {
    applied: true,
    newEpoch,
    distributed,
    // WI-6044: propagate a PARTIAL boundary so the revoke call-site can record it alongside its
    // existing rekey_boundary_skipped signal, instead of the skip vanishing behind applied:true.
    ...(skippedDevicePubkeys && skippedDevicePubkeys.length > 0 ? { skippedDevicePubkeys } : {}),
  };
}

/**
 * Member-ADD key distribution (shared-hive-rekey-2026-06-19, su-ee7e9) — the complement of
 * the boundary trigger that closes the join-time gap. When the OWNER recognizes a NEW
 * member, wrap EVERY epoch key [0..current] to that member's device(s) so they can decrypt
 * ALL existing hive content (the project: features/plans/etc.), WITHOUT advancing the epoch
 * (adding a member cuts no one off).
 *
 * Why [0..current], not current-only (c2a63's v1 CORRECTNESS call, 2026-06-19): content is
 * encrypted ONCE at write under the then-current epoch + is NEVER re-encrypted on advance,
 * so a current-epoch-only joiner holds the ciphertext for all history but can decrypt ZERO
 * pre-join content. The shared-hive is a COLLABORATION substrate — a new member joins to
 * read the EXISTING project. C-001 is unaffected (removal still advances + withholds the NEW
 * key, cutting FUTURE reads); barring a member from history = a future forward-secrecy
 * policy (ed300 + owner). Owner-only (`deriveEpochKey` needs the hive key). Flag-gated;
 * idempotent per (epoch, member). Cost bounded — epochs advance only on a membership change.
 */
export async function grantEpochKeysToMembers(
  opts: {
    workspaceId: string;
    potHomeSlug: string;
    enabled: boolean;
    /** the new member's device pubkeys (base64) to grant the current epoch key. */
    newMemberPubkeys: readonly string[];
    /**
     * BUG B (D-028, layer 3): re-SEND keys a member already has a row for. Threads
     * refederate=true into persistWrappedKeys so an existing wrapped_key row is
     * re-stamped (origin='local', fed_ts/fed_hlc cleared) and the AFTER INSERT OR
     * UPDATE capture trigger (mig 411) re-federates it. Default false = write-once.
     */
    refederate?: boolean;
    sql?: Sql;
  },
  seams: Pick<BoundaryRekeySeams, 'resolveCrypto' | 'resolveAuthorPubkey' | 'persistWrappedKeys'> & {
    getCurrentEpoch?: (ws: string, slug: string, sql?: Sql) => Promise<number>;
  } = {},
): Promise<BoundaryRekeyResult> {
  if (!opts.enabled) return { applied: false, reason: 'flag-disabled' };
  const fresh = [...new Set(opts.newMemberPubkeys.filter((pk) => pk))];
  if (fresh.length === 0) return { applied: false, reason: 'no-fresh-members' };
  const {
    resolveCrypto = resolveHiveEpochCrypto,
    resolveAuthorPubkey = loadHivePubkey,
    persistWrappedKeys = putWrappedKeys,
    getCurrentEpoch = getHiveEpoch,
  } = seams;

  // Owner-only SELF-GATE: only the box holding the hive key can derive epoch keys.
  // resolveAuthorPubkey (loadHivePubkey) is null/empty on a non-owner box, so the helper
  // no-ops there — safe to call from the admit path on EVERY peer (328af's DUAL hook:
  // upsertHiveMember owner-side + the open-mode admittedIdentities.set, which fires on every
  // box) without the caller re-checking owner-ness.
  const author = await resolveAuthorPubkey(opts.workspaceId, opts.potHomeSlug);
  if (!author) return { applied: false, reason: 'no-author' };

  const crypto = await resolveCrypto(true);
  // ⚠ SCOPE (WI-6311): deliberately NOT resolved, unlike the two reconcile paths below. The
  // owner self-gate above already returned `no-author` on every box that is not the Pot owner,
  // and on the OWNER canonical == local by construction — so this line is unreachable with a
  // divergent handle. Do not "fix" it: a resolve here is a guaranteed no-op that adds a
  // registry read to the hot per-member grant path.
  const current = await getCurrentEpoch(opts.workspaceId, opts.potHomeSlug, opts.sql);

  // Grant EVERY epoch key [0..current] — content is encrypted-once per epoch + never
  // re-encrypted on advance, so a joiner needs all prior keys to read existing content
  // (c2a63's v1 correctness call). Owner derives each; the member unwraps to read history.
  let distributed = 0;
  // WI-3927 guard: pubkeys whose wrap THREW — skipped for the remaining epochs too.
  const skipped = new Set<string>();
  for (let epoch = 0; epoch <= current; epoch++) {
    const key = await crypto.deriveEpochKey(opts.potHomeSlug, epoch);
    const wrapped: WrappedEpochKeyRow[] = [];
    for (const pk of fresh) {
      if (skipped.has(pk)) continue;
      try {
        wrapped.push({ memberDevicePubkey: pk, wrappedKey: await crypto.wrapKeyToMember(key, pk) });
      } catch (e) {
        // WI-3927 (2026-07-10): one MALFORMED device pubkey (e.g. a leaked test-fixture row
        // like 'pk-creator' — 10 chars, not the 43/44-char base64 of a 32-byte key) made
        // wrapKeyToMember THROW here, aborting the WHOLE grant pass — and every caller
        // funnels through this function (member-add, boundary rekey, the WI-887 reconcile
        // sweep), so one bad row starved every well-formed member hive-wide (epoch-key
        // reconciled=0 + outbox-drain PASS TIMEOUT). Skip + log the bad device; keep
        // granting to the rest.
        skipped.add(pk);
        console.warn(
          `[pot-epoch-boundary] wrapKeyToMember threw for member device pubkey ${JSON.stringify(
            pk.length > 20 ? `${pk.slice(0, 17)}…` : pk,
          )} (len ${pk.length}) — device skipped, grant continues (WI-3927): ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    distributed += await persistWrappedKeys(opts.workspaceId, opts.potHomeSlug, epoch, wrapped, author, opts.sql, {
      refederate: opts.refederate,
    });
  }
  if (skipped.size === fresh.length) {
    // Every candidate device failed to wrap — nothing was granted; surface it as a distinct,
    // queryable reason instead of a hollow applied:true/distributed:0.
    return { applied: false, reason: 'all-members-unwrappable', distributed };
  }
  return { applied: true, newEpoch: current, distributed };
}

/**
 * Default reader for the device pubkeys that already hold a given epoch's wrapped key.
 * Extracted (was inline in reconcileOwnedHiveEpochKeys) so the onMemberApplied gap-guard in
 * reconcileEpochKeysForCurrentMembers and the gap-aware sweep share ONE implementation.
 */
async function defaultLoadEpochKeyDevices(
  ws: string,
  slug: string,
  epoch: number,
  sql?: Sql,
): Promise<string[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const client = sql ?? getOrgPg().sql;
  const rows = (await client`
    SELECT member_device_pubkey FROM harness_shared.pot_epoch_keys
     WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND epoch = ${epoch}
  `) as unknown as Array<{ member_device_pubkey: string }>;
  return rows.map((r) => r.member_device_pubkey);
}

/**
 * WI-887 self-heal — ensure EVERY current member holds every epoch key [0..current].
 *
 * The complement to grantEpochKeysToMembers (one NEW member at join) + advanceEpochOnHiveBoundary
 * (one boundary's REMAINING set): a RECONCILE over the FULL current member set. A member who
 * federated in AFTER an epoch advanced — or was missed while papercusp-hive-rekey was dark — is
 * otherwise never backfilled (the per-member grant fires only on that member's own upsert, and the
 * boundary wrap fired before the member was known on the owner), so it permanently lacks the current
 * epoch key and DROPS all current-epoch content at the decrypt gate (reproduced live: plan
 * shared-hive-member-content-federation-2026-06-20 D-018 — a joiner held only epoch 0). Calling this
 * on the onMemberApplied hook (any membership change) self-heals the whole hive.
 *
 * Owner-only (delegates to grantEpochKeysToMembers, which self-gates: loadHivePubkey is null on a
 * non-owner box → no-op), flag-gated, idempotent per (epoch, member). C-001 SAFE: keys off the LIVE
 * member set and EXCLUDES every revoked device pubkey (the union of all members' revoked_pubkeys
 * blocklists), so a removed/cut member is never re-granted the new key.
 */
export async function reconcileEpochKeysForCurrentMembers(
  opts: {
    workspaceId: string;
    potHomeSlug: string;
    enabled: boolean;
    /**
     * BUG B (D-028, layer 3): re-SEND keys, not just fill gaps. Threaded to
     * grantEpochKeysToMembers → persistWrappedKeys so existing rows are re-stamped and
     * re-federated (mig 411). Default false = write-once (the onMemberApplied/sweep heal).
     */
    refederate?: boolean;
    /**
     * BUG B (D-028, layer 3): when set, restrict the re-grant to THIS device set (the
     * reconnecting member's devices) instead of the whole hive — the C-001 revoked
     * exclusion still applies (the intersection of live-non-revoked ∩ onlyDevices). Omit
     * for the whole-hive self-heal (onMemberApplied hook / the gap-aware sweep).
     */
    onlyDevices?: readonly string[];
    sql?: Sql;
  },
  seams: Pick<BoundaryRekeySeams, 'resolveCrypto' | 'resolveAuthorPubkey' | 'persistWrappedKeys'> & {
    getCurrentEpoch?: (ws: string, slug: string, sql?: Sql) => Promise<number>;
    loadMembers?: (ws: string, slug: string, sql?: Sql) => Promise<HiveMemberRecord[]>;
    loadEpochKeyDevices?: (ws: string, slug: string, epoch: number, sql?: Sql) => Promise<string[]>;
  } = {},
): Promise<BoundaryRekeyResult> {
  if (!opts.enabled) return { applied: false, reason: 'flag-disabled' };
  const loadMembers = seams.loadMembers ?? listHiveMembersForLocalPot;
  const members = await loadMembers(opts.workspaceId, opts.potHomeSlug, opts.sql);
  // C-001: a revoked device must NEVER be re-granted the current key — exclude the UNION of every
  // member row's revoked_pubkeys blocklist (a revocation written on one member's row applies hive-wide).
  const revoked = new Set<string>();
  for (const m of members) for (const pk of m.revokedPubkeys ?? []) revoked.add(pk);
  // Optional device targeting (BUG B reconnect re-grant): intersect with onlyDevices so a single
  // member's reconnect re-sends ONLY its own keys, never re-federating the whole hive. C-001 holds
  // (revoked still excluded) regardless of the target set.
  const only = opts.onlyDevices ? new Set(opts.onlyDevices) : null;
  const pubkeys: string[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    for (const a of m.deviceAttestations ?? []) {
      const pk = a?.device_pubkey;
      if (
        typeof pk === 'string' &&
        pk.length > 0 &&
        !revoked.has(pk) &&
        !seen.has(pk) &&
        (!only || only.has(pk))
      ) {
        seen.add(pk);
        pubkeys.push(pk);
      }
    }
  }
  // Perf guard (plan shared-hive-cross-machine-scale-10k P-020): the onMemberApplied projection
  // hook calls this on EVERY membership apply. Without a gap-check the delegate below re-wraps
  // [0..current] to every device every time → O(E·M) per apply, O(E·M²) per onboarding wave (the
  // owner-box serial-crypto wall). Mirror reconcileOwnedHiveEpochKeys' guard: when every live
  // device already holds the CURRENT epoch key there is nothing to grant — skip the crypto.
  // SKIP for the reconnect re-grant (refederate/onlyDevices), which intentionally re-sends.
  if (!opts.refederate && !opts.onlyDevices && pubkeys.length > 0) {
    const getCurrentEpoch = seams.getCurrentEpoch ?? getHiveEpoch;
    const loadEpochKeyDevices = seams.loadEpochKeyDevices ?? defaultLoadEpochKeyDevices;
    // ⚠ SCOPE (WI-6311): `pubkeys` came from loadMembers = listHiveMembersForLocalPot, which
    // RESOLVES the federated scope internally. The epoch reads below do not — and the guard
    // COMPARES the two. On a divergent joiner that mismatch is not a no-op: `have` reads empty
    // while `pubkeys` is populated, so `every` is false, the guard never fires, and the O(E·M)
    // crypto it exists to prevent runs on EVERY apply, forever, for a hive that is actually fine.
    // Resolve for the epoch-keyed reads; keep opts.potHomeSlug (local) for the member reader.
    const potScope = await resolveFederatedPotScope(opts.workspaceId, opts.potHomeSlug, {
      sql: opts.sql,
    });
    const currentEpoch = await getCurrentEpoch(opts.workspaceId, potScope, opts.sql);
    const have = new Set(
      await loadEpochKeyDevices(opts.workspaceId, potScope, currentEpoch, opts.sql),
    );
    if (pubkeys.every((pk) => have.has(pk))) {
      return { applied: false, reason: 'no-gap' };
    }
  }
  // Delegate to the tested per-member grant with the resolved set: it re-reads the CURRENT epoch
  // and wraps [0..current] idempotently. 'no-fresh-members' when no live device matched.
  return grantEpochKeysToMembers(
    {
      workspaceId: opts.workspaceId,
      potHomeSlug: opts.potHomeSlug,
      enabled: opts.enabled,
      newMemberPubkeys: pubkeys,
      refederate: opts.refederate,
      sql: opts.sql,
    },
    seams,
  );
}

/** A hive this box knows about (its workspace + home slug). */
export interface OwnedHiveRef {
  workspaceId: string;
  potHomeSlug: string;
}

export interface ReconcileOwnedHivesSeams
  extends Pick<BoundaryRekeySeams, 'resolveCrypto' | 'resolveAuthorPubkey' | 'persistWrappedKeys'> {
  getCurrentEpoch?: (ws: string, slug: string, sql?: Sql) => Promise<number>;
  loadMembers?: (ws: string, slug: string, sql?: Sql) => Promise<HiveMemberRecord[]>;
  /** Enumerate every hive this box knows (reconcile self-gates to the OWNED subset). */
  listHives?: (sql?: Sql) => Promise<OwnedHiveRef[]>;
  /** Device pubkeys that ALREADY hold the (hive, epoch) key — the gap-check read. */
  loadEpochKeyDevices?: (ws: string, slug: string, epoch: number, sql?: Sql) => Promise<string[]>;
}

/**
 * WI-887 self-heal SWEEP — owner-side, idempotent, GAP-AWARE. For each hive this box knows, checks
 * whether any LIVE (non-revoked) member device is missing the CURRENT epoch key; only then runs
 * reconcileEpochKeysForCurrentMembers. The onMemberApplied hook heals the moment a membership op
 * applies, but a member that went stuck while papercusp-hive-rekey was dark (or across an advance
 * that omitted it) needs a trigger that does NOT depend on a fresh membership op — this sweep is it
 * (host it on the in-process periodic checks / call once at owner boot). GAP-AWARE so it does NO
 * crypto on the steady state (the perf-anti-pattern guard: never re-derive+re-wrap an intact hive),
 * only on a hive with a real gap. Self-gates per hive (reconcile no-ops where loadHivePubkey is null
 * — a non-owner box), flag-gated, C-001-safe (revoked devices excluded by reconcileEpochKeysForCurrentMembers).
 */
export async function reconcileOwnedHiveEpochKeys(
  opts: { enabled: boolean; sql?: Sql },
  seams: ReconcileOwnedHivesSeams = {},
): Promise<{ scanned: number; reconciled: number }> {
  if (!opts.enabled) return { scanned: 0, reconciled: 0 };
  const getCurrentEpoch = seams.getCurrentEpoch ?? getHiveEpoch;
  const loadMembers = seams.loadMembers ?? listHiveMembersForLocalPot;
  const listHives =
    seams.listHives ??
    (async (sql?: Sql) => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const client = sql ?? getOrgPg().sql;
      const rows = (await client`
        SELECT DISTINCT workspace_id, pot_home_slug FROM harness_shared.pots
      `) as unknown as Array<{ workspace_id: string; pot_home_slug: string }>;
      return rows.map((r) => ({ workspaceId: r.workspace_id, potHomeSlug: r.pot_home_slug }));
    });
  const loadEpochKeyDevices = seams.loadEpochKeyDevices ?? defaultLoadEpochKeyDevices;

  const hives = await listHives(opts.sql);
  let reconciled = 0;
  let gapsFound = 0;
  for (const { workspaceId, potHomeSlug } of hives) {
    try {
      // ⚠ SCOPE (WI-6311): the enumeration above selects `pots.pot_home_slug` — the LOCAL
      // handle. `loadMembers` (listHiveMembersForLocalPot) WANTS that and resolves internally,
      // but pot_epoch_keys is a hiveScoped projection written under the FEDERATED scope, so the
      // epoch reads need the resolved value. Keeping both, named apart, because this loop
      // compares one against the other (see the gap check below).
      //
      // Deliberately resolved per row rather than COALESCE(canonical_pot_home_slug, …) in the
      // SQL: the column is only the SECOND source of truth. resolveFederatedPotScope consults
      // canonicalHiveHomeSlug FIRST — the same function the WRITE side resolves through — so it
      // agrees with the writers by construction, even mid-reconcile.
      const potScope = await resolveFederatedPotScope(workspaceId, potHomeSlug, { sql: opts.sql });
      const current = await getCurrentEpoch(workspaceId, potScope, opts.sql);
      const members = await loadMembers(workspaceId, potHomeSlug, opts.sql);
      const revoked = new Set<string>();
      for (const m of members) for (const pk of m.revokedPubkeys ?? []) revoked.add(pk);
      const liveDevices: string[] = [];
      for (const m of members) {
        for (const a of m.deviceAttestations ?? []) {
          const pk = a?.device_pubkey;
          if (typeof pk === 'string' && pk.length > 0 && !revoked.has(pk)) liveDevices.push(pk);
        }
      }
      if (liveDevices.length === 0) continue;
      const have = new Set(await loadEpochKeyDevices(workspaceId, potScope, current, opts.sql));
      const hasGap = liveDevices.some((pk) => !have.has(pk));
      if (!hasGap) continue; // steady state — NO crypto (perf guard)
      gapsFound += 1;
      const r = await reconcileEpochKeysForCurrentMembers(
        { workspaceId, potHomeSlug, enabled: true, sql: opts.sql },
        seams,
      );
      if (r.applied) {
        reconciled += 1;
         
        console.info(
          `[pot-epoch-key-reconcile] backfilled ${potHomeSlug} epoch[0..${current}] for ${liveDevices.length} member device(s) (${r.distributed} key rows)`,
        );
      } else {
        // A gap was found but the grant did NOT run — name the cause (no-author = not the owner
        // box; flag-disabled; no-fresh-members). This is the queryable signal a stuck hive needs.
         
        console.info(
          `[pot-epoch-key-reconcile] gap in ${potHomeSlug} epoch=${current} NOT healed: ${r.reason ?? 'unknown'}`,
        );
      }
    } catch (e) {
      // best-effort per hive — one hive's failure must not abort the sweep
       
      console.info(
        `[pot-epoch-key-reconcile] ${potHomeSlug} threw (skipped): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Only log when there was real work (a gap found / healed) — steady-state sweeps stay silent.
  if (gapsFound > 0) {
     
    console.info(
      `[pot-epoch-key-reconcile] sweep: scanned=${hives.length} gaps=${gapsFound} reconciled=${reconciled}`,
    );
  }
  return { scanned: hives.length, reconciled };
}
