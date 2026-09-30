# Live-witnessing shared-pot federation (the green-rig/red-binary trap + the two-instance smoke gotchas)
URL: /internal/docs/agent-insights/shared-pot-live-federation-witnessing

Shared-pot federation bugs pass the hermetic suite but fail the real binary, because the integration tests mock/inject the substrate. Only the live two-instance smokes catch them. This is how to run those witnesses, the harness gotchas that will eat hours if you don't know them, and the federation model (slug-binding) you need to read the results.

## The trap: green rig, red binary

The hermetic/integration suite (1090+ hyperbee backbone) **mocks or injects the substrate federation** (`bootHarnessSubstrate` rigs, direct apply-path injection). It validates the merge/projection LOGIC but **not** the live two-instance peer `announce → admit → apply` over a real swarm/DHT on the packaged binary. Bugs it structurally cannot catch: **boot-timing admit races (A-003), from-repo-vs-discovery-join binding differences (WI-259), packaging/minification stripped-seam regressions.** All three shipped green hermetically and were RED only on the binary, caught only by live witnessing. If a federation behavior matters for release, **you must witness it live** — a green suite is necessary, not sufficient.

The live witnesses are `papercusp-desktop/bin/two-instance-*-smoke.sh` (directory / content-matrix / from-repo). `live-federation-gate.sh` (WI-261) wraps them in a CPU/memory-pressure-admitted scheduled gate that files an EI on RED, to catch the class automatically.

## Running a witness — the gotchas (each cost hours to find)

1. **Admission is based on CPU/memory pressure, not raw host load.** The witness itself is CPU- and memory-intensive, but host loadavg is a shared-box, nice-blind aggregate: it counts runnable work across every tenant and does not say whether the witness frames are stalled. On cgroup-v2 hosts `live-federation-gate.sh` admits only when CPU PSI `some avg60` is at or below `PRESSURE_GATE` (default `30`) and memory PSI `full avg10` is below `MEMORY_PRESSURE_GATE` (default `5`). `LOAD_GATE` survives only as the no-PSI fallback, with default `max(15, 85% of nproc)` (`108` on a 128-core host). A separate `STORM_GATE` (default `nproc*0.9`, 115 on a 128-core host) can still downgrade a would-be RED at verdict time, but frame-local lag evidence outranks that shared-box proxy. Never copy a historic `load1<=77` preflight into a managed witness: invoke the canonical gate or reproduce its CPU PSI + memory PSI admission checks, fresh lock/output paths, and exact artifact attestations.
2. **`DISCOVERY_RETRIES`** — the smokes poll discovery 40×3s=120s by default, too short under any load. Set `DISCOVERY_RETRIES=100` (300s). Made env-configurable on both smokes.
3. **The re-key witness block is gated on `WITNESS_PROBE=1`** (in the from-repo smoke). Without it the run silently skips the AK + K0–K3 block and does only the federation smoke — you'll think the re-key passed when it never ran.
4. **`mcp_call` (MCP-over-HTTP) needs three things** or it 406s/parse-errors: `-H 'accept: application/json, text/event-stream'`, `-H "Authorization: Bearer <$HOME/.papercusp/superuser-token>"`, and a full JSON-RPC envelope `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{...}}`.
5. **The re-key flag does NOT engage via the `PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY=1` env alone** — verified: the owner ends with 0 `hive_epoch_keys`. Flip it at runtime via `POST /api/flags/set {key:'papercusp-pot-rekey',enabled:true}` (persists a pg-override `getFlag` reads) BEFORE the pot is created.
6. **Stale build = silent re-key no-op.** A `.deb`/`serve.mjs` built before a grant *call* seam landed carries the function but never calls it (e.g. the `grantEpochKeysToMembers` export exists but its call site in `upsertHiveMember`/`hive-membership-store.ts` isn't wired). Rebuild the sidecar (`bin/build-desktop-sidecar.sh`) and gate on a **minification-surviving code string** — an exported function/identifier name (`grantEpochKeysToMembers`) or an emitted event name (`rekey_grant_skipped`), never a comment (esbuild strips comments) and never a one-off log string, which drifts as the call site moves (as it has since this doc was first written).
7. **content-matrix needs a `.deb`; from-repo supports `HIVE_SMOKE_MODE=sidecar`** (no .deb). To test current HEAD on the content-matrix, rebuild the sidecar then `dpkg-deb -R` a base .deb, swap the fresh sidecar in, `dpkg-deb -b`.
8. **`live-federation-gate.sh` runs an assert-core self-test (WI-754) BEFORE the pressure admission gate** — proves `federation-asserts.sh` port self-discovery logic against synthetic listeners (\~2s, no .deb, no extra load). A broken assert core makes every smoke an unexplained RED; catching it first gives a clear error message. Runs on every invocation regardless of fleet load. Override with `GATE_SKIP_SELFTEST=1`.

## The federation model you need to read results (the D-021 slug guard)

:::caution\[WI-259 is CLOSED — superseded by a membership-aware guard, not a slug remap]
This section originally described WI-259 as an OPEN bug: a joiner-side content
projection silently guard-dropping a peer member's ops because their harness slugs
differ. As of `shared-hive-member-content-federation-2026-06-20` (D-001), **WI-259 was
closed as a duplicate of WI-971**, and the actual fix landed is NOT the slug-rebind
this section originally proposed — see below for what actually shipped, and what is
still genuinely open (WI-971).
:::

A pot's per-table PG projections are keyed by `harness_slug`. On a JOINER, the merge's
`scopedApply` rebind (`register-all.ts`'s `hiveScoped` opts, threaded from boot's
`hiveHomeSlug`/`potHomeSlug`) remaps a **growing hive-home-grained set** — `hive_members`,
`hive_settings`, `hive_policy`, `hive_reports`, `hive_pending_joins`, `hive_epoch_keys`,
agent facts, p2p memories, gym QD elites, bee claim specs, gate verdicts, and the P2P
peer-grants/receipts/fleet-directory/work-offers/leader-leases families — to the
**hive-home slug**. This set has grown well past the original "just two projections"
(A-003 shipped only `hive_members`+`hive_settings`; every later plan bullet above added
more). **The CONTENT projections stay member-slug bound by design** — feature
claims/queue/working-set, `harness_features_consolidated`, `harness_plans`, issues,
`engineer_issues`, plan-parts, and the coord (conversation/message/thread/thread-post)

* plan-item-assignment projections all keep `opts.harnessSlug` (D-001 EXPLICITLY chose
  this over a hive-home remap for content — a remap needed an unforgeable
  `author_pubkey` discriminator the system doesn't have, and would have re-keyed every
  member's content under one slug, risking clobber).

So a cross-member content op (owner's `harness_features` op reaching a joiner whose
member-harness slug differs) is **not slug-remapped and not silently dropped either** —
it goes through `decideMemberContentOp` / `shouldApplyMemberContentOp`
(`member-content-guard.ts`, WI-259 P-002): apply iff the op's VERIFIED
**source-log device pubkey** (`op.sourceLogDevicePubkey` — cryptographically vouched at
admission, never the caller-supplied `author_pubkey`) is in the hive's **current member
device set** (`resolveHiveMemberDeviceSet`, re-checked live, not a stale
admission-time flag). Three outcomes, not two: `apply` (own slug, or a verified current
member), `drop` (no hive-home at all, or no verified source-log identity — fail-closed,
never deferrable), or `defer` (author IS identified but not yet in the member set — the
P-004 content-before-membership race: their `hive_members` row hasn't federated to this
peer yet, so the op is buffered — `PendingMembershipContent` — and re-applied once it
does, instead of being lost). `PAPERCUSP_A003_TRACE=1` logs every drop/defer decision
with its exact reason (`no-hiveHome` / `no-srcDevice` / `not-in-member-set(size=N)`).

**What is still genuinely open:** the **from-repo** live leg REDs by design on **WI-971**
(the outbox drain was never wired for a joined/created hive harness) — `SKIP_FROMREPO`'s
own comment in `live-federation-gate.sh` says so explicitly, and expects that from-repo RED
until WI-971 lands; the discovery-join rig doesn't hit it. So the practical advice survives
in spirit even though the ROOT CAUSE moved: on the **from-repo** rig, content crossing A→B
can still legitimately fail — but now diagnose it as an outbox-drain gap (WI-971), not a
slug-guard drop (the guard itself is membership-aware and correct). On the discovery-join
rig, both the crypto cut and content federation are provable clean.

**Practical:** if `hive_settings` (or any hive-home-grained family) crosses A→B but
`harness_features` (member-slug-bound content) does not, first check
`PAPERCUSP_A003_TRACE=1` for a `drop`/`defer` from the member-content guard — a genuine
membership gap now names itself (`no-srcDevice` / `not-in-member-set`) instead of
silently vanishing. On the **from-repo** rig specifically, also suspect the WI-971
outbox-drain gap before assuming a guard bug.

## Re-key (C-001) cut witness — the K-stage chain

The cut = member-remove → epoch advance → removed member can't decrypt new content. Live legs (from-repo smoke, `WITNESS_PROBE=1`, flag on): **K0** joiner receives wrapped `hive_epoch_keys` (origin=remote) → **K1** reads pre-revoke F-CTRL (decrypts) → **K2** owner revokes (`substrate:revoke_contributor` → epoch advances) → **K3** owner writes F-CUT under the new epoch → removed member **cannot** read it. The grant that makes K0 pass fires on the **substrate auto-admit**, NOT on `membership_decide` (open-mode public pots have no pending-join to approve). As of the pot→hive rename the grant call itself lives inside `upsertHiveMember` (`packages/operator-core/lib/hive-membership-store.ts`), dynamically imported from `hive-epoch-boundary-wiring.ts`; `boot.ts`'s owner admit seam (`admitAnnouncedPeerAsOwner → ownerAdmitOrPend → upsertHiveMember`) is what reaches it — `boot.ts` no longer contains the grant call directly. `hive_epoch_keys` is itself hive-home-grained (remapped, like `hive_settings`), so K0 crosses A→B cleanly on both rigs; WI-259 (which used to gate this) is closed — the remaining from-repo-only gap is WI-971 (outbox drain), which does not block the crypto legs.

### Make the cut witness CONTENT-FREE (the device-filtered reframe)

The original K1/K3 read content (`F-CTRL`/`F-CUT` via `fed_hive_merge_probe` → `harness_features_consolidated`), which conflates the crypto cut with WI-259's content-federation stall → a false-RED. The cut is provable from `hive_epoch_keys` ALONE (pot-home-grained, A-003-proven to cross), so make it **device-filtered + content-free** (⇒ WI-259-orthogonal): **B\_DEV** (the cut-off device) = `A's member_device_pubkey at epoch=CUR EXCEPT at epoch=NEW` (A stays a member ⇒ excluded; the diff = the removed device). Then K1 = B has a CUR-epoch row for B\_DEV (origin=remote); K3 CUT = B has NO NEW-epoch row for B\_DEV **while** B DID receive the remaining members' NEW-epoch rows (teeth #2 — proves "B excluded", not "NEW epoch never federated"). Capture `CUR_EPOCH` BEFORE the revoke or the EXCEPT collapses to empty.

### Re-key engagement — the membership dependency (WI-280, the 3rd green-rig/red-binary bug)

Before expecting ANY meaningful K-stage, confirm the owner actually minted epoch keys: `drv_psql a "SELECT count(*),max(epoch) FROM harness_shared.hive_epoch_keys WHERE harness_slug='$POT'"`. If A has **0 keys / epoch=-1** the re-key never engaged (WI-280) — a re-key bug, NOT a witness bug. Why it happens live:

* The epoch is minted ONLY on a **boundary** — `advanceEpochOnHiveBoundary` is called only from revoke (`hive-revoke-contributor.ts` — renamed from `pot-revoke-contributor`) + go-private (`hive-set-listing.ts` — renamed from `pot-set-listing`), **never on create**. A fresh pot has no epoch key (content is plaintext until the first boundary).
* The boundary + the join-grant wrap the new key to `loadAllHiveMemberDevicePubkeys()` — the **`hive_members` device set**. In the live open-mode from-repo flow `hive_members` is EMPTY: `upsertHiveMember` fires only via `approvePendingJoin` (open-mode auto-admits at the substrate, no pending-join), and nothing self-registers the owner at create. Wrap-set = `[]` → 0 keys, and even a revoke can't advance (nobody to wrap to).
* The hermetic re-key tests **seed `hive_members`**, so they're green while the live binary mints 0 keys — exactly A-003/WI-259's pattern. The fix is to populate `hive_members` live (owner self-row at create + open-mode joiner at the owner's admit seam), not anything in the witness.

**WI-887 self-heal:** If `hive_members` is still empty when the witness runs — or a member missed epoch keys because `papercusp-pot-rekey` was dark during their admit — `reconcileOwnedHiveEpochKeys` (in `hive-epoch-boundary-wiring.ts` — renamed from `pot-epoch-boundary-wiring.ts`) provides a GAP-AWARE sweep: for each pot, it checks whether any live (non-revoked) device is missing the current epoch key and calls `reconcileEpochKeysForCurrentMembers` only then (no crypto on the steady state). Owner-only, C-001-safe, idempotent. `BoundaryRekeyResult.reason` (`'flag-disabled'` | `'no-fresh-members'` | `'no-author'` | `'no-gap'` | `'all-members-unwrappable'`) names which silent early-return fired when the grant ran but produced 0 keys — the queryable signal a stuck pot needs.

**BUG B reconnect re-grant (D-028, layer 3):** `reconcileEpochKeysForCurrentMembers` now accepts two extra params: `refederate?: boolean` (re-stamp existing rows so the mig-411 AFTER INSERT OR UPDATE capture trigger re-federates them — vs the default write-once gap-fill) and `onlyDevices?: readonly string[]` (restrict the re-grant to a specific device set rather than the whole pot). These power the reconnect path wired into `ownerAdmitOrPend`'s `already_member` branch (`hive-membership-admission.ts` — renamed from `pot-membership-admission.ts`): when a member reconnects, the owner auto-calls `reconcileEpochKeysForCurrentMembers({ refederate: true, onlyDevices: <this member's devices> })` so a member that MISSED the original federated grant (joined-after-grant, forward-only cursor, or re-session) has its keys re-sent without manual healer intervention. `grantEpochKeysToMembers` gained the same `refederate?` param (threaded down from the reconnect call). C-001 preserved (revoked devices excluded by the revoked-union filter inside `reconcileEpochKeysForCurrentMembers`).

## Self-kill footgun (cleanup)

Don't `pgrep -f '<pattern>'` for a string your own kill command contains — in a backgrounded command it matches and kills its own process tree before the work runs. Read PIDs into a var first, exclude `$$`, and prefer specific keys (an exact Xvfb display, a data-dir path) over broad name patterns. Never kill all `postgres -D /tmp/*` — peers run test PGs there too.
