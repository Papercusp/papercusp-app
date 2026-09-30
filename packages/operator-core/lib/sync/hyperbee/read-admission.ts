/**
 * read-admission — the read-admission decision (Model B substrate, Stage 3).
 *
 * D-004 (the security core): a peer aggregates another peer's log IFF
 *   (1) the announce `sig` verifies against `device_pubkey`  (→ `sigValid`), AND
 *   (2) `device_pubkey` ↔ `github_login` is a valid channel-2 binding for
 *       ANY real GitHub identity.
 *
 * There is deliberately NO repo-collaborator / permission gate here. GitHub's
 * PR-merge gate is the real authority over what lands; this advisory
 * replication layer is open to any device that proves a real GitHub identity.
 * Revocation is the only blocklist: a `revoked_pubkeys` set.
 *
 * D-002: admission verifies channel-2 ONLY (publicly-readable device-signed
 * contributor file). Channel-1 (OAuth GET /user) is a self-attestation the
 * LOCAL peer runs for publish/self; it is not applicable for remote admission
 * and always fails `oauth_user_id_mismatch` for any different engineer.
 *
 * D-006: `verifyBinding` now returns a 3-state `'verified' | 'pending' | 'fail'`.
 * A `'pending'` outcome (channel-2 file not yet visible on GitHub due to
 * propagation lag) maps to `reason:'pending'` — a RETRYABLE outcome that the
 * boot pending-retry loop handles within a grace window, rather than permanently
 * rejecting a peer whose file just hasn't propagated yet.
 *
 * This module is the PURE decider. The binding check is injected as
 * `verifyBinding(device_pubkey, github_login, github_user_id) => Promise<'verified'|'pending'|'fail'>`;
 * Stage 4 wires it to a thin adapter over `verifyAttestation(...)` — the
 * write-free gist gate (non-collaborator-join-fork-pr): it verifies the
 * announced attestation gist id with no shared-repo read. Do NOT call
 * binding-service.ts here — that's the repo↔harness ownership check and DOES
 * gate on collaborator permission, which is the wrong gate for read-admission
 * (Stage-0 spike correction #2).
 *
 * Decision precedence: revoked → bad_sig → verifyBinding → admit/pending/binding_invalid.
 * Revocation is checked first (a revoked key is denied regardless of sig/binding),
 * and the sig check short-circuits before the (network) binding check.
 */

export interface AdmissionInput {
  /** Raw 32-byte Ed25519 device pubkey, base64 (the announce's device_pubkey). */
  device_pubkey: string;
  github_login: string;
  /** The announce's numeric GitHub user id — the identity the attestation gist
   *  must be owned by. Threaded to `verifyBinding`. */
  github_user_id: number;
  /**
   * The announce's `attestation_gist_id` (write-free join). The binding gate
   * verifies this gist is owned by `github_user_id` and attests `device_pubkey`
   * — so it must be threaded to `verifyBinding`. Carried on the SIGNED announce,
   * so it cannot be substituted in transit.
   */
  attestation_gist_id: string;
  /** Whether the announce signature already verified (verifyAnnounce result). */
  sigValid: boolean;
}

export type AdmissionResult =
  | { admit: true }
  | { admit: false; reason: 'bad_sig' | 'binding_invalid' | 'revoked' | 'pending' | 'out_of_scope' };
// `out_of_scope` is NOT returned by `makeAdmissionDecider` (the D-004 identity
// decider only emits bad_sig/binding_invalid/revoked/pending). It is the
// caller-level (boot.ts onAnnounce) verdict for A-003 (a′) slug-aware admission:
// the announce is identity-valid but its signed `harness_slug` belongs to a
// harness scope THIS handler should not hold (the normal broadcast-filtering
// outcome when one topic carries multiple local harnesses' log announces). It is
// CONCLUSIVE (never retried — distinct from `pending`).

export interface AdmissionDeciderOptions {
  /**
   * Verify that `device_pubkey` ↔ `github_user_id` is a valid binding, proven
   * from the `attestation_gist_id` carried on the announce (write-free join).
   * Stage 4c wires this to `buildVerifyBindingAdapter` over `verifyAttestation`
   * (the gist is public — no repo context). `githubLogin` is passed for parity
   * with the announce shape but the gist check does not need it.
   *
   * Returns:
   *   - `'verified'` : attestation valid → admit the peer.
   *   - `'pending'`  : OUR transient failure (GitHub unreachable) → retryable;
   *                   the boot retry loop re-checks within grace.
   *   - `'fail'`     : conclusive attestation failure (gist gone / owner or
   *                   pubkey mismatch / bad sig) → reject the peer.
   */
  verifyBinding: (
    devicePubkey: string,
    githubLogin: string,
    githubUserId: number,
    attestationGistId: string,
  ) => Promise<'verified' | 'pending' | 'fail'>;
  /** Revoked device pubkeys (base64). A match is denied with reason 'revoked'. */
  revoked?: Set<string>;
}

/**
 * Build the read-admission decider. The returned function applies the D-004
 * decision (sig + binding + revocation; no collaborator gate) to one announce.
 */
export function makeAdmissionDecider(
  opts: AdmissionDeciderOptions,
): (input: AdmissionInput) => Promise<AdmissionResult> {
  const { verifyBinding, revoked } = opts;

  return async (input: AdmissionInput): Promise<AdmissionResult> => {
    if (revoked?.has(input.device_pubkey)) {
      return { admit: false, reason: 'revoked' };
    }
    if (!input.sigValid) {
      return { admit: false, reason: 'bad_sig' };
    }
    const bindingResult = await verifyBinding(
      input.device_pubkey,
      input.github_login,
      input.github_user_id,
      input.attestation_gist_id,
    );
    if (bindingResult === 'verified') return { admit: true };
    if (bindingResult === 'pending') return { admit: false, reason: 'pending' };
    return { admit: false, reason: 'binding_invalid' };
  };
}

export interface TrustedHiveMemberDeviceInput {
  devicePubkey: string;
  sigValid: boolean;
  memberDevices: string[];
  revoked?: Set<string>;
}

/**
 * Offline/durable fast path for already-verified hive members. The signed
 * announce still has to verify, revocation still wins, and the device pubkey
 * must already be present in the local hive_members projection for the claimed
 * GitHub user. This removes live GitHub gist availability from the boot path
 * for known members while preserving the local membership binding.
 */
export function trustedHiveMemberDeviceAdmission(
  input: TrustedHiveMemberDeviceInput,
): boolean {
  if (!input.sigValid) return false;
  if (input.revoked?.has(input.devicePubkey)) return false;
  return input.memberDevices.includes(input.devicePubkey);
}

/**
 * A-003 (a′) — slug-aware admission scope. When one hive topic carries MULTIPLE
 * local harnesses' log announces (dc9db's (a′) swarm.ts broadcasts the hive-home
 * log alongside a member's on the single channel), the D-004 identity decider
 * alone would let any identity-valid frame be admitted by EVERY on-topic handler.
 * Since every harness registers ALL projections, a wrong-scope log would then
 * cross-merge (e.g. the OWNER's hive-home harness applying a member-log's features
 * into the hive-home schema). This predicate decides whether an inbound log's
 * SIGNED origin-slug belongs to THIS harness's scope:
 *   - its OWN slug (the normal same-harness peer log), OR
 *   - the hive-home slug it rebinds — for a JOINER's member harness, which applies
 *     the hive-home log's hive_members/hive_settings under the home (the receive-
 *     side rebind: `joinerPotHomeSlug(self)`). `null`/absent for any other harness.
 * An ABSENT origin-slug (legacy / single-harness peer — the field post-dates the
 * feature) is admitted, so single-harness federation + the existing two-hive
 * integration test are byte-for-byte unchanged (backward-compatible).
 *
 * Pure: no I/O. The caller (boot.ts onAnnounce) applies it AFTER the D-004 identity
 * decision, returning reason `out_of_scope` (conclusive — never retried) on a miss.
 */
export function announceSlugInScope(
  originSlug: string | null | undefined,
  ownSlug: string,
  rebindHomeSlug: string | null | undefined,
): boolean {
  if (originSlug == null) return true; // legacy / absent → admit (backward-compatible)
  return originSlug === ownSlug || (rebindHomeSlug != null && originSlug === rebindHomeSlug);
}
