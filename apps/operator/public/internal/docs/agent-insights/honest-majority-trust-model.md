# The honest-majority trust model (shared-pot owner enforcement)
URL: /internal/docs/agent-insights/honest-majority-trust-model

What an owner's signed pot policy DOES and DOES NOT guarantee in a P2P federated pot. Grounded in policy-admission.ts + pot-policy.ts + the C-001 re-key. Stated to MATCH the behavior — no over-claim.

## What

This is the canonical statement of the trust boundary the shared-pot
owner-enforcement layer (`shared-pot-owner-enforcement-2026-06-19`, Phase EN-4)
provides. A claimed owner can publish an **owner-signed policy** (rate limits,
membership mode, ban/takedown list, content rules, contribution rules) that
federates to every member; **honest peers enforce it at op-admission**. The model
is *honest-majority*, and like the directory-honesty work it is stated to MATCH
the behavior — the NOT-guarantees below are the real, observed limits, not
disclaimers around a stronger claim.

This is NOT a server-authoritative app. Each peer runs its own substrate and can
run *modified* code on its own machine. "Enforcement" therefore is three
mechanisms working together, never a single server check:

1. **Owner-SIGNED policy, federated as authoritative state**
   (`pot-policy.ts`). The policy is Ed25519-signed by the owner's pot key and
   federates as a `hive_policy` record (the `hive_settings` pattern). The apply
   path VERIFIES the signature (`verifyHivePolicy`) AND that the signing key is
   the pot's actual owner key before honoring it.
2. **Admission-time enforcement on every honest peer**
   (`policy-admission.ts`, wired into `applyOpVia`'s single op-merge seam). Each
   honest peer drops a policy-violating inbound op (rate over cap / banned author
   / membership-excluded / oversize / banned-pattern) BEFORE merging it, so the
   violation never becomes canonical pot state.
3. **Revocation-backed teeth** (the C-001 re-key). A persistent abuser the owner
   revokes loses write/discovery immediately and read at the next epoch re-key —
   removed from the trust set, not merely rate-limited.

## What an owner policy DOES guarantee

* **Honest peers DROP a violating op.** A member that floods past its rate cap,
  writes oversize/banned content, or posts after being banned has those ops
  dropped by *every* honest peer — so the flood/abuse never becomes canonical
  pot state and never reaches honest members' PG. (Teeth:
  `policy-admission.apply.test.ts` — over-cap remote ops are dropped at
  `applyOpVia` before `writeToPg`; `policy-admission.test.ts` — the per-rule S0
  battery.)
* **A forged or replayed policy is REJECTED.** A policy not signed by the owner's
  pot key fails `verifyHivePolicy` and is never applied; a tampered field (slug,
  version, or any rule) breaks the signature; a replayed *older* write loses the
  PG-level LWW guard, ordered by `harness_shared.fed_order_key(fed_hlc, fed_ts)`
  (an op's real HLC when it has one, else a wall-clock-derived HLC that mirrors
  the in-process merge fold exactly — the transitivity fix from EI-1698; see
  `lww-comparator-non-transitive-under-mixed-hlc`). (Teeth: `pot-policy.test.ts`.)
* **Author attribution is unforgeable.** Enforcement keys off the
  receiver-stamped `sourceLogKeyHex` (the source log core key), NOT the
  self-declared `writerPubkey` a remote peer controls. An op whose author cannot
  be resolved under an author-dependent rule fails CLOSED — a bad peer cannot
  dodge the ban/rate/membership gate by stripping its attribution.
* **A persistent abuser is cut off.** `substrate:revoke_contributor` + the C-001
  re-key advance the epoch; the revoked device loses write+discovery now and read
  at the re-key. Combined with an `allowlist`/ban entry, the same identity cannot
  rejoin.
* **Contribution rules gate the fork→PR boundary.** An `editablePaths` allowlist
  REJECTS opening a fork-PR whose changed files fall outside it; `requireReview`
  / `restrictAutoMerge` / `requiredStatusChecks` mark a PR's auto-merge as
  blocked. (`contrib-policy.ts`, wired in `fork-pr-on-feature-pass.ts`.)

## What an owner policy DOES NOT guarantee (the honest limits)

* **It cannot force a malicious peer to enforce the policy on its OWN machine.**
  A peer running modified code can ignore its own admission gate. The guarantee is
  one-directional: it cannot make *honest* peers accept its violating ops, and it
  cannot author the owner's signed policy. A colluding clique of malicious peers
  CAN maintain a divergent fork *among themselves* — but they are cut from the
  owner's canonical pot (revocation + the re-key) and from the canonical repo
  (the owner's GitHub PR-merge gate). This is true of any P2P system; it is not a
  regression introduced here.
* **Revocation does not retroactively un-read already-replicated content.** Per
  the C-001 finding, a revoked member (or anyone who held the pot link while it
  was public) keeps reading content already served until the re-key epoch
  advances; revocation cuts write+discovery first, and the *read* cut requires the
  re-key (or pot dissolve). The ban-list in the policy is the *admission-plane*
  teeth (honest peers drop the banned member's future ops); it composes with — it
  does not replace — the re-key's read cut-off.
* **`requireReview` / `restrictAutoMerge` are recorded, not yet auto-enforced.**
  There is no in-system auto-merge path today (the owner merges the fork-PR on
  GitHub, where branch protection is the real gate). The contribution policy
  produces an `autoMergeAllowed` verdict on the opened PR; a *future* in-system
  auto-merge step must honor it. The `editablePaths` rule, by contrast, IS
  enforced now (it blocks opening an out-of-bounds PR).
* **Enforcement is honest-peer admission, not a central merge authority.** v1
  deliberately does NOT require the owner's pot-home to be online as the sole
  merge point (that would centralize + need the owner always online). The trade:
  enforcement converges as honest peers apply it, rather than being instantaneous
  and global.
* **No policy ⇒ no enforcement.** A pot with no owner policy enforces nothing —
  this is the default, so existing pots are unaffected. An *unclaimed* pot
  cannot author an enforceable policy at all (authority is gated on
  `claim_status='claimed'`).
* **Rate limits are enforced over op TIME, so a client forging op timestamps can
  pace under the per-window cap.** EN-2's per-member limiter counts an author's ops
  in deterministic tumbling windows keyed on each op's own write-time — and that is
  exactly what makes the drop decision CONVERGE identically across honest peers
  (each reads a member's single log in the same order). A normal flood (a client
  stamps truthful, clustered timestamps) is fully caught; a client RECOMPILED to
  spread forged timestamps across windows can stay under the per-window cap. This is
  an inherent limit of any *convergent* (op-time) limiter — perfect convergence AND
  perfect evasion-resistance from self-declared timestamps is impossible without a
  trusted external clock. Memory stays bounded regardless (a flood cannot OOM an
  honest peer; only `cap` ops/window are retained). A non-convergent
  receiver-wall-clock burst guard is the documented fast-follow. See
  `findings-EN-2.md`.

## Why

Stating the boundary honestly is itself a security property: an owner who believes
"banned = they can never read my pot again" would be wrong about the read plane
until the re-key, and an owner who believes `requireReview` blocks every merge
would be wrong until the in-system auto-merge path exists. The model is strong
where it claims to be (honest peers drop violations; forged policy is rejected;
abusers are revoked) and explicit about where it isn't. See the plan
`shared-pot-owner-enforcement-2026-06-19` and the modules `pot-policy.ts`,
`policy-admission.ts`, `contrib-policy.ts`.
