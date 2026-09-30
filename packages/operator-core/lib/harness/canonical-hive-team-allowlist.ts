/**
 * canonical-hive-team-allowlist — the TEAM allowlist for the canonical `papercusp`
 * hive, in a module of its own so it can NEVER reach a client bundle.
 *
 * WHY THIS IS A SEPARATE FILE (WI-38322, split out of canonical-hive-invite.ts 2026-08-12)
 * ---------------------------------------------------------------------------------------
 * It used to live beside CANONICAL_PAPERCUSP_HIVE_INVITE in canonical-hive-invite.ts.
 * That module has TWO consumers with DISJOINT reach:
 *
 *   CANONICAL_PAPERCUSP_HIVE_INVITE  → papercusp-hive-join.ts   → reaches the CLIENT bundle
 *   CANONICAL_HIVE_TEAM_ALLOWLIST    → papercusp-hive-share.ts  → *ALSO* reaches the CLIENT
 *
 * ⚠ CORRECTED 2026-08-12 (WI-38233). This header originally claimed the second row was
 * "SERVER only". THAT WAS FALSE, and splitting this file out on that premise did NOT stop the
 * leak — the 0.0.16-alpha cut's bundle audit then failed on the very handles this split was
 * meant to remove. The real reach is:
 *
 *   papercusp-hive-join → hive-directory-boot → (dynamic import, hive-directory-boot.ts:165)
 *     → bootstrap-papercusp-hive.ts:40 → papercusp-hive-share.ts:47 → THIS MODULE
 *
 * So papercusp-hive-share is client-reachable via bootstrap-papercusp-hive, and the handles
 * were emitted into `bootstrap-papercusp-hive-*.js` — a DIFFERENT chunk from the
 * `papercusp-hive-join-*.js` the original fix was verified against. Grepping that one chunk
 * returned a clean, TRUE, and completely useless answer: code-splitting had moved the literal
 * into a neighbouring chunk the same client still loads. VERIFY BY SCANNING THE WHOLE
 * dist/ + sidecar SPA, never a single chunk you predicted.
 *
 * Bundlers include a module WHOLE. So the client was shipping the real GitHub logins of every
 * team member to anyone who downloaded the app. Measured during the 0.0.16-alpha cut: the
 * emitted chunk literally contained `["<owner-login>","papercupai"]`, and the same bytes were
 * present in the SHIPPED sidecar SPA — not merely in a stale local dist.
 *
 * The leak had no compensating benefit, because this allowlist is NOT a client-side check.
 * Admission is decided server-side in goSharedHive against each peer's device-attestation-
 * bound GitHub identity. A copy in the client authorises nothing; it only discloses.
 *
 * KEEP IT THAT WAY: import this module ONLY from server-side code. If a client-reachable
 * module ever imports it, the handles return to the bundle. That is not left to discipline —
 * the release identity gate now FAILS on these strings (the AUTHORISED_PRODUCT_STRINGS
 * acceptance that used to permit them was retired together with this split), so a
 * reintroduction breaks the release build rather than shipping quietly.
 */

/**
 * GitHub LOGINS that the owner-signed admission policy admits IN ADDITION to the owner
 * (papercusp-hive-share.ts goSharedHive). This is what makes the dogfood a real SHARED
 * hive: every teammate who installs auto-joins and federates content, while repos stay
 * PRIVATE and non-allowlisted installs are refused (dogfood-silent-canonical-hive-join
 * D-001 / P-007).
 *
 * POPULATED (P-007, 2026-06-29) by DERIVING from the live canonical-hive membership — the
 * GitHub identities VERIFIED in the `papercusp` hive (harness_shared.pot_members,
 * binding_status 'verified'). These are the actual team, not guessed. To add a NEW teammate:
 * append their GitHub login here. Empty ⇒ only the owner's own devices auto-merge. Logins are
 * matched against each peer's device-attestation-bound GitHub identity (not spoofable).
 *
 * ⚠ THE OWNER'S OWN LOGIN IS DELIBERATELY *NOT* LISTED HERE (WI-38233, 2026-08-12).
 * It was, until the 0.0.16-alpha cut's bundle audit caught it SHIPPING: this module is reached
 * from the client through bootstrap-papercusp-hive.ts → papercusp-hive-share.ts, so the baked
 * array landed verbatim in the emitted client chunk (and the sidecar SPA) as
 * `["<owner-login>","papercupai"]` — disclosing the owner's real GitHub identity to anyone who
 * downloaded the app.
 *
 * Listing the owner here was ALWAYS REDUNDANT, which is why removing it is behaviour-preserving
 * rather than a policy change. goSharedHive authors the admission policy as
 *     allowlist: Array.from(new Set([state.githubLogin, ...teamAllowlist]))
 * (papercusp-hive-share.ts) — the owner's login is merged in at RUNTIME from the resolved
 * identity and de-duplicated, so on the owner's box (the only box that holds the hive's private
 * key and authors the canonical policy) the resulting allowlist is byte-identical either way.
 * A baked copy authorised nothing; it only disclosed.
 *
 * KNOWN RESIDUAL (follow-up on WI-38322, deliberately not fixed here): a policy authored from a
 * NON-owner teammate's device now carries [thatTeammate, ...this list] and no longer implicitly
 * carries the owner. The correct fix is to source the owner from the RUNTIME hive owner identity
 * (`fetchOwnerHiveIdentity`, already imported by papercusp-hive-share.ts) instead of any baked
 * constant — never by re-adding the login here, which would re-ship it.
 *
 * DO NOT "fix" a future audit hit by re-adding a real login to this array.
 */
export const CANONICAL_HIVE_TEAM_ALLOWLIST: readonly string[] = ['papercupai'];
