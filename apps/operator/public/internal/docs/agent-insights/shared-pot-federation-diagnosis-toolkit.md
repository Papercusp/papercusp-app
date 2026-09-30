# Shared-pot federation — the live-diagnosis toolkit + the two admission paths
URL: /internal/docs/agent-insights/shared-pot-federation-diagnosis-toolkit

When a fresh joiner rosters a pot but receives no content, the cause is almost always upstream of the apply-guard: an ADMISSION decision, not a merge bug. This is the toolkit to read a live fed-a/fed-b rig (fed.sh: ports/sql/api/mcp/ssh self-discovering ports) and the model to interpret it — the SIGNED-announce identity decider (revoked → bad_sig → verifyBinding → admit/pending/binding_invalid) feeding the TWO same-pot SCOPE paths (owner-log bootstrap-admit vs member-set admission+buffer), the registry-gated substrate boot that decides which pots a node even swarms, the boot-history event log (dogfood-substrate-boot-history), and what binding_invalid actually means (gist-less owner → conclusive reject, NOT retried).

## When to read this

You are staring at a live two-machine shared-pot rig (fed-a = owner, fed-b =
joiner). Membership/roster federates (fed-b sees the owner in its roster, epoch
keys decrypt), **but content does not cross** — features/plans/issues written on
one member never materialize on the other, "discovers 0". You are about to suspect
the merge loop or the apply-guard.

**Stop. The merge/apply guard is almost never the live cause.** It is unit-green and
re-proven over real testcontainer-PG + real swarm
(`feature-content-federation.integration.test.ts`). On a live rig the failure is
upstream: the peer's log was never **admitted**, or the node never **swarmed** the
pot at all. This doc gives you (1) the toolkit to read the live state, and (2) the
admission model you need to interpret what you read. It is the synthesis the
public-release diagnosis (`shared-pot-public-release-2026-06-22`, D-005…D-010)
converged on after every mechanical apply hypothesis was refuted.

> Sibling docs, each a different slice — read them too:
> [`shared-pot-live-federation-witnessing`](/internal/docs/agent-insights/shared-pot-live-federation-witnessing)
> (the green-rig/red-binary trap + smoke gotchas),
> [`federation-rig-restart-runbook`](/internal/docs/agent-insights/federation-rig-restart-runbook)
> (recovering a wedged rig / missing gh-auth),
> [`owner-side-cross-member-content-apply-gap`](/internal/docs/agent-insights/owner-side-cross-member-content-apply-gap)
> (the one genuine apply-guard asymmetry),
> [`pot-approval-membership-gate-wiring`](/internal/docs/agent-insights/pot-approval-membership-gate-wiring)
> (the owner-admission approval seam).

## The toolkit — `fed.sh`

`papercusp-desktop/scripts/linux-test-vm/fed.sh` is the versioned, reliable way to
drive either VM. Its whole reason to exist: the packaged app picks a **fresh dynamic
operator + PG port on every boot**, old listeners linger, and the app log's "latest
`[serve] listening on`" line is unreliable (EI-3409 / WI-559 burned hours on exactly
this). So `fed.sh` **self-discovers** the live ports on every call by SSHing in and
probing — operator = the loopback port answering `GET /api/desktop/preflight` 2xx
(other listeners 404 it; dead ones refuse); PG = the port that accepts a
`harness_admin` psql to `papercusp`. Discovered ports are cached per-VM under
`~/.papercusp/fed-rig-ports.<vm>` for `FED_PORT_TTL` (default 600s) and auto-rediscovered
when a target port stops answering. It survives app/VM restarts with **no edits**.

| Subcommand                                      | What it does                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `fed.sh <a\|b> ports`                           | Show the discovered `operator=` / `pg=` ports (pass `1` to force a probe).                   |
| `fed.sh <a\|b> rediscover`                      | Clear the port cache and re-probe. Run this FIRST after any restart.                         |
| `fed.sh <a\|b> sql "<SQL>"`                     | `psql` against the VM's embedded PG as `harness_admin` / `papercusp`.                        |
| `fed.sh <a\|b> api <METHOD> <path> [json-body]` | Superuser HTTP route (Bearer from the operator's actual `$HOME/.papercusp/superuser-token`). |
| `fed.sh <a\|b> mcp <tool> [json-args]`          | Superuser MCP tool over `/api/mcp?superuser=1` (returns just the `data:` SSE payload).       |
| `fed.sh <a\|b> ssh <cmd…>`                      | Raw SSH into the VM (e.g. `ssh 'tail papercusp-app.log'`).                                   |

Two footguns the script already handles, but you must know:

* **`$HOME` is workspace-scoped on a VM whose operator runs workspace-scoped**
  (`HOME=/home/tester/.papercusp-workspaces/default`, D-007). The superuser token
  and `gh` auth live under the operator's *actual* HOME, not `/home/tester`. `fed.sh`
  derives the token from `/proc/$(pgrep -f serve.mjs)/environ`; if `pot:membership_decide`
  returns `no_owner_identity`, the operator's HOME is missing `~/.config/gh` — symlink it.
* **EI-3409 superuser-MCP workspace mismatch.** Superuser MCP resolves
  `ctx.workspaceId='*'` while HTTP routes/queue use `'default'`, so a pot created via
  `mcp` lands in the wrong workspace and routes then return `not_owner_swarm`. For a
  workspace-scoped WRITE tool, set `FED_MCP_WS=default` so `fed.sh` injects
  `workspace:"default"` (OPT-IN — blanket injection breaks READ tools that reject an
  unknown `workspace` key).
  * **WI-892 (FIXED 2026-06-26, su-549e0214): the `'*'` papercup was LEAKING into
    `harness_shared.hive_members` WRITES.** The pot-membership write tools resolved
    `args.workspace ?? ctx.workspaceId ?? … ?? activeWorkspaceId()` — a truthy `'*'` wins,
    so the `activeWorkspaceId()` fallback never fired and `'*'` was persisted as
    `workspace_id`. A `'*'`-stamped row is **invisible to every concrete-workspace read**
    (the membership guard, epoch-key grant, and cross-member content federation all filter
    `WHERE workspace_id='<concrete>'`), so the operator's member view silently diverged from
    the raw table (live proof on fed-a: 18 `'*'` rows; `b8recv-pot` 1 row total, 0 visible
    under `workspace_id='default'`). MERGED rows are unaffected — `projections/pot-members.ts`
    writes the local concrete `opts.workspaceId`, which is why a federated member can
    "self-heal" to `default` after a re-merge. **Fix:** `resolveConcreteWorkspaceId(...candidates)`
    in `workspace-registry.ts` (skips `'*'`/empty, never returns `'*'`) is now used by every
    pot write tool; `upsertHiveMember`/`addRevokedHivePubkeys`/`remove*` throw on `'*'`/empty;
    migration `406-pot-members-forbid-wildcard-workspace` backfills + adds
    `CHECK (workspace_id <> '*' AND <> '')`. **Use `resolveConcreteWorkspaceId` for ANY write
    that persists a `workspace_id` — `'*'` is a read papercup, never a storable value.** (The
    same leak likely affects the `pots` table itself — `pot:create` under unscoped MCP also
    stamped its pots row `'*'` — a broader-class follow-up; see WI-892.)

## The two-path admission model — the thing you are actually debugging

Content reaches a peer only if that peer **admits the source log**. Admission is two
layers; read them top-to-bottom because the second only runs after the first passes.

### Layer 1 — the SIGNED-announce identity decider (`read-admission.ts`)

Every inbound announce runs `decideAdmission` with fixed precedence:

```
revoked → bad_sig → verifyBinding → admit / pending / binding_invalid
```

`verifyBinding` is 3-state (D-006):

* **`verified`** → channel-2 attestation valid (the announce's `attestation_gist_id`
  is a GitHub gist owned by `github_user_id` containing `device_pubkey`) → **admit**.
* **`pending`** → OUR transient failure (GitHub unreachable / gist-propagation lag) →
  `reason:'pending'`, **RETRYABLE** within the grace window.
* **`fail`** → **`binding_invalid`** — a CONCLUSIVE attestation failure (gist gone,
  owner/pubkey mismatch, bad sig on the binding). **Not retried.**

This is the layer the public-release live witness is stuck on. A **gist-less owner
placeholder** (a pot created without a real GitHub gist, e.g. on a gh-degraded VM)
fails `verifyBinding` → `binding_invalid` → the owner's own log is conclusively
rejected, so nothing it authored can ever be admitted. WI-797 is the structural gap
here: `owner_bootstrap` (Layer 2 below) sits *after* this gist gate, so it cannot
rescue a gist-less owner in the fresh-join window. **`binding_invalid` in the
boot-history means "fix the identity/gist, not the merge."** Distinguish it sharply
from `pending` (transient, will retry) and `revoked` (read-cut, must stay rejected).

### Layer 2 — the same-pot SCOPE widening (`boot.ts` `resolveSameHiveMember`)

Layer 1 admits a peer on *slug* identity. Layer 2 only *widens* scope to cross-member
content within the same pot — it **never bypasses** revocation or the read-cut
(Layer 1 re-checks `revoked` on every retry tick). Inside `resolveSameHiveMember`
there are **two distinct admit paths** — this is "the two-path model":

**Path A — owner-log BOOTSTRAP admit (WI-787 / WI-780, the keystone).** A fresh
joiner's `hive_members` is **empty**, so the owner's own announce would `miss` the
member-set check below and buffer forever — yet the roster that *would* admit the
owner lives **inside the owner's still-un-merged log**. That is a bootstrap deadlock.
It is broken by trusting exactly ONE device: the `owner_device_pubkey` the SIGNED,
gh-verified pot-announce binds to **this joined pot**. The binding is read via
`loadHiveOwnerDevicePubkey(workspaceId, hivePubkey)` — and crucially needs **no new
migration**: it reads the verified `(hivePubkey → ownerDevicePubkey)` binding the P2P
pot-directory offline cache already persists (`hive_directory_cache`, migration 182),
which only records descriptors that passed `verifyHiveAnnounce` (D-010). Admission is
gated on `opts.swarmBinding.hive_pubkey` (the JOINED pot) and matches the **exact**
owner device only — never on `github_user_id` alone, never any other device (that
would hole the WI-259 membership guard). Emits boot event `announce_admitted
owner_bootstrap`.

**Path B — member-set admission (`classifySameHiveMember`).** For every other peer:
admit iff `frame.device_pubkey ∈ loadHiveMembers(hiveHome)` — **D-002 (admit by
AUTHOR IDENTITY)**: the check is purely by device pubkey membership, not by
`github_user_id` (the earlier per-user query via `loadHiveMemberDevicePubkeys` was
replaced by `resolveHiveMemberDeviceSet`, which returns ALL device pubkeys for the
pot without a per-user filter). On `admit` → `announce_admitted same_hive_member`.
On **`miss`** (a plausible same-pot cross-member whose `hive_members` row has not
federated to us yet — the asymmetric A→B stall) the frame is **BUFFERED** for retry,
**not** conclusively dropped: a 5s loop re-runs Layer-1 `admit()` + this check each
tick, admitting the instant membership federates in, or dropping after the 30-min grace.

**Path B's owner-gate exception (D-023 BUG C).** On a membership `miss`,
`resolveSameHiveMember` also asks: is *this* box the pot's owner? If so it must
ADMIT the brand-new joiner immediately instead of buffering (else
`admitAnnouncedPeerAsOwner`, the upsert seam, never runs and open-mode
auto-admission deadlocks) → `announce_admitted owner_admit_joiner origin=…
pot=…`. **As of WI-1981 (wake-#5515, 2026-07)** that owner check is
`isCanonicalHiveOwner` (`packages/operator-core/lib/hive-identity.ts`) — holding
*a* private key is not enough; the held pubkey must MATCH the pot's canonical
record (the `pots` row, or the joined view's verified `hive_pubkey`) — replacing
the earlier mere-key-presence check (`loadHivePubkey != null`). A stale/divergent
local key (e.g. a partial keychain-delete survivor in the encrypted-FILE tier) used
to make a JOINER box wrongly resolve `isOwner=true`, mint fresh-random epoch keys
instead of unwrapping the true owner's wrapped rows, and produce a permanent mutual
`epoch_decrypt_fail` with no re-mint. A detected mismatch now fires a deduped
divergent-key health signal (`pot-owner-key-health.ts`) and reports **not**-owner
instead.

> The merge loop iterates **only `admitted.values()`** (`boot.ts`), and `admitted`
>
> * `admittedIdentities` are populated together from the same announce frame — so for
>   any op that actually merged, the source identity is present. That is why a live
>   "0 rows" is virtually never the apply-guard's `!sourceLogDevicePubkey` drop branch;
>   it is one of the admission outcomes above (binding\_invalid / buffered-miss /
>   never-swarmed), or the genuine owner-home apply asymmetry documented separately in
>   `owner-side-cross-member-content-apply-gap`.

## Registry-gated substrate boot — does the node even swarm this pot?

Before admission can happen at all, the node has to **boot the substrate and join the
pot's swarm topic** for that harness. This is **registry-gated**: `host-bootstrap.ts`
boots substrate only for harnesses returned by `loadHarnessRegistry(workspaceId)`, and
`pot-federation.ts` resolves the swarm binding from that same registry. **A node
swarms only pots it has a local registry entry for — NOT ones it merely rosters.**

This is a real and easily-missed live cause: a joiner can show the pot in its
*roster/directory* yet never have a registry project for it, so it never joins that
pot's topic, never receives the owner's announce, and admission never even gets a
chance to run. When `fed.sh b api GET /api/discovery/pots` shows the pot but content
is 0, check the registry (and the swarm-join log) before touching admission. (See also
[`pot-scoped-federation`](/internal/docs/agent-insights/pot-scoped-federation) and
[`lazy-substrate-boot-and-sidecar`](/internal/docs/agent-insights/lazy-substrate-boot-and-sidecar)
for which harnesses boot substrate and which stay inert.)

## Reading the live state — boot-history is your admission ledger

The admission decisions above all `recordBootEvent` into an in-process ring buffer,
surfaced read-only at:

```
GET /api/admin/dogfood-substrate-boot-history?harness_slug=<slug>&kinds=<csv>&limit=<n>
```

Auth is **verified/trusted admin** (gated per D3; it used to be public). Response:
`{ entries: BootHistoryEntry[], depth }`, each entry `{ ts, workspaceId, harnessSlug,
kind, message }`. Read it through the toolkit:

```bash
fed.sh b api GET '/api/admin/dogfood-substrate-boot-history?harness_slug=<pot-home>&kinds=announce_rejected,announce_pending,announce_admitted&limit=50'
```

The diagnostically-loaded `kind`s (`boot-history.ts` `BootHistoryKind`):

* `announce_admitted` — admission succeeded. The `message` says **which path**:
  `owner_bootstrap …` (Path A), `same_hive_member origin=… pot=…` (Path B),
  `owner_admit_joiner origin=… pot=…` (Path B's owner-gate exception, D-023 BUG C —
  this box is the canonical owner admitting a brand-new joiner instead of buffering it).
* `announce_rejected` — Layer-1 conclusive reject. Look at the reason — **`binding_invalid`**
  (gist/identity, fix that — see WI-797), `revoked` (read-cut, correct), `bad_sig`.
* `announce_pending` — Layer-1 transient (`pending`) OR a Layer-2 membership `miss`
  buffered for retry. Will self-resolve if the cause clears; otherwise it ages out at
  30 min.
* `swarm_join_failed` / `peer_connected` / `peer_rejected` / `peer_rate_limited` /
  `peer_capped` / `peer_revoked` — the **transport** layer. No `peer_connected` for the
  pot topic at all ⇒ a swarm/registry/gh-auth problem, **upstream of admission** — go
  back to the registry-gating and `federation-rig-restart-runbook` (missing gh-auth is
  the #1 silent-local-only cause after a VM reset).
* `peer_unrevoked` — WI-193 "G8": a REFRESH-sourced revocation (the pubkey was
  never named in a live `handle.revoke()` call) dropped out of the freshly-loaded
  published `revoked_pubkeys` set, so `applyRevocationRefresh` reconciled it back
  out of `revoked` — the peer is admissible again on its next announce. See
  `substrate-revocation-model` for the full un-revoke story (still partial: an
  explicit live `revoke()` call is never undone by this path).
* `merge_error`, `rekey_grant_*`, `rekey_boundary_skipped` — apply/re-key layer.
* `epoch_gate_built` — the decrypt gate **IS** installed for this harness (non-null `rekeyDeps`);
  carries `hiveHomeSlug` = the AAD hiveId. Absence means encrypted ops are applied raw, unchecked.
* `epoch_gate_seen` — an encrypted-looking op (epoch-stamped OR `{__rekey}` value) **reached**
  the gate. Distinguishes "content dropped upstream of the gate" (this never fires) from "reached
  the gate but was processed" (fires, with `epoch=NULL` flagging the wire-stamp-lost case).
* `epoch_defer` — op deferred: its epoch key is not yet local on this node. Will be replayed when
  the key arrives via `drainQueuedEpochContent`.
* `epoch_decrypt_fail` — have an epoch key but decrypt failed (wrong key / AAD mismatch — `hiveId`
  must be the LOCAL home slug, not a federated field) → op **dropped**. A persistent stream of
  these means the encrypt AAD and decrypt AAD disagree on the pot identity.
* `epoch_applied` — encrypted op decrypted and applied successfully (the success path).

These six `epoch_*` kinds are WI-808 (content-federation drop diagnosis, 2026-06-25): previously
all four non-success paths were **silent** (`return false`), leaving a federated op that never
landed with no diagnostic signal at all.

> **GOTCHA (as of 2026-07-03) — a `?kinds=` filter can silently eat the exact
> kinds this doc tells you to look for.** The route
> (`dogfood-substrate-boot-history.ts`) filters `?kinds=` against its own
> hand-maintained `VALID_KINDS` array, not the full `BootHistoryKind` union —
> and that array is currently STALE: it is missing `peer_cap_near`,
> `peer_unrevoked`, `announce_clock_skew`, `replication_stalled`,
> `replication_frozen`, and all six `epoch_*` kinds documented above. Passing
> any of those in `kinds=` gets them silently dropped (bogus values are
> filtered, not rejected), so `fed.sh b api GET
> '…&kinds=epoch_gate_seen,epoch_decrypt_fail'` comes back empty even when
> those events fired — indistinguishable from "never happened." **Workaround:
> omit `kinds=` entirely (or pass no filter) when hunting an `epoch_*` /
> `peer_unrevoked` / `replication_*` / `announce_clock_skew` event**, and read
> the `kind` column yourself. This is a genuine code staleness, not intended
> behavior — flagged for a fix that derives `VALID_KINDS` from `BootHistoryKind`
> (or drops the allow-list in favor of the union) so it can't drift again.

## The diagnostic ladder (use this order)

1. **`fed.sh <a|b> rediscover && fed.sh <a|b> ports`** — confirm you're hitting the
   LIVE operator/PG (stale ports masquerade as "broken federation").
2. **Transport** — boot-history `peer_connected` for the pot topic on both VMs? No ⇒
   registry-gated-boot / swarm / gh-auth. Not admission.
3. **Layer 1 (identity)** — `announce_rejected reason=binding_invalid` ⇒ gist/identity
   (gist-less owner = WI-797); `pending` ⇒ wait/retry; `revoked` ⇒ working as intended.
4. **Layer 2 (scope)** — `announce_pending` membership-miss buffered ⇒ the roster hasn't
   federated yet (is the owner-bootstrap Path A admitting the owner's log? look for
   `announce_admitted owner_bootstrap`). Empty `hive_members` on a fresh joiner is
   EXPECTED until Path A merges the owner log.
5. **Apply** — only now suspect the guard, and only the documented owner-home asymmetry
   (`owner-side-cross-member-content-apply-gap`). Verify with the live PG via `fed.sh sql`,
   remembering `fed_ts` is the LWW key (`testing-federation-set-fed-ts`), not `ts`.

## TL;DR

* A live "rosters but no content" is an **admission** or **swarm-registry** problem,
  not a merge bug — the merge/guard is integration-green.
* `fed.sh` (self-discovering ports) is the access tool: `ports`/`rediscover`/`sql`/`api`/`mcp`/`ssh`.
* Admission = **identity decider** (`revoked→bad_sig→verifyBinding→admit/pending/binding_invalid`)
  feeding **two same-pot scope paths**: **owner-log bootstrap-admit** (trusts the one
  directory-cache-bound owner device to break the empty-member-set deadlock) and
  **member-set admission** (device ∈ `hive_members`, else buffer-and-retry).
* **`binding_invalid` = conclusive identity/gist failure, never retried** — a gist-less /
  fresh-join-window owner used to be the live wall (WI-797): owner-bootstrap sat AFTER the
  gist gate, so the owner's own announce was rejected before the bootstrap could rescue it.
  **FIXED 2026-06-25** (su-ed33c735, A2 su-5394073c): the owner-device bootstrap is now
  hoisted into `admitsAsKnownHiveMember` (the IDENTITY stage, BEFORE the gist gate) —
  `boot.ts` \~2290 (line drifts as the file grows; anchor on the function name).
  Live-proven on the fed-a/fed-b rig: `announce_admitted owner_bootstrap`
  fires and roster+epoch federate owner→joiner `origin=remote`. See WI-797 / plan
  `shared-pot-public-release-2026-06-22` D-011.
* **GOTCHA — a stale `kind=topic` harness on the same pot topic INTERCEPTS the owner
  announce.** A bare `/api/harness/join-link` (vs `/api/discovery/join-pot`) binds the
  member as `swarmBinding.kind=topic` (no `hive_pubkey`). If that junk harness boots FIRST
  on the topic it owns the connection's announce channel and rejects the owner frame
  `binding_invalid`, and the proper `kind=pot` handlers never see it (no per-frame A-003
  trace for them). Symptom: only the topic-harness logs the rejection; `is-even`/`<pot>`
  show `boot_ok`+`peer_connected` but no admission event. Fix: remove the junk harness
  (registry `jsonb` filter + clone dir) and relaunch — the owner-bootstrap then fires.
* **The new finish line is the CONTENT layer, not admission.** With WI-797 fixed, the owner
  log merges and control rows (`pot-members`, `pot-epoch-keys` — plaintext per
  `pot-epoch-content-ops.ts`) apply, but **encrypted content ops** (features/work-items/
  plans/issues) can still drop on apply even with the epoch key wrapped for the joiner's
  device — the GATE-2 content-apply layer (`owner-side-cross-member-content-apply-gap`,
  D-003, WI-367 content-before-key ordering-drop + the `drainQueuedEpochContent` replay).
  Isolate lag-vs-drop with a fresh op; if a NEW op also never lands, it's a drop, not lag.
* Substrate boot + swarm join are **registry-gated**: a node swarms only registry pots,
  not merely-rostered ones.
* `dogfood-substrate-boot-history` (verified-admin) is the admission ledger; read its
  `kind`/`message` to place the failure on the ladder before touching code.

## Multi-process split-brain: the corestore-lock race + timeout-zombie ladder (P-059, 2026-07-03)

When tower↔peer replication is dead BOTH directions with healthy transport, suspect the
**tower's own process topology** before any protocol layer. On a dev box, several processes
can host a workspace's substrate (bg-host boot-all, the dev-api cluster primary's
shared-pot layer) and they RACE for the same corestore RocksDB lock — whoever wins decides
which process (and therefore which **DHT config**) federates that pot. Ladder:

1. **Find the corestore holder by fd, not by assumption:**
   `for P in $(ls /proc | grep -E '^[0-9]+$'); do C=$(ls -l /proc/$P/fd 2>/dev/null | grep -c '<ws>/.papercusp/<harness>/hyperbee'); [ "$C" -gt 0 ] && echo "$P ($C)"; done`
   The holder may be a deep descendant (sidecar), not the service MainPID.
2. **Check each candidate host's DHT env** (`PAPERCUSP_DHT_BOOTSTRAP` / `PAPERCUSP_DHT_HOST`
   in `/proc/<pid>/environ`). A holder on the isolated DHT is INVISIBLE to a peer on the
   public DHT and vice versa — the outage flip-flops with every restart race.
   ⚠ `PAPERCUSP_DHT_HOST` pins the UDP socket to one iface AND **leaks into spawned
   shells** from a systemd drop-in — inside a container/other netns it makes the node
   announce an undialable address ("joins succeed, neither ever dials", WI-1910 class).
3. **The timeout-zombie (WI-1892):** `bootSingleHarness` races the boot against a timeout
   (default 30s, env `PAPERCUSP_SUBSTRATE_BOOT_TIMEOUT_MS`). Under a 35-substrate boot storm
   the timeout fires but the DETACHED boot keeps running: corestore locked + topic joined,
   **no registered handle → outbox drain never wired**. Signature: `[hyperbee-substrate]
   (<ws>::<slug>) failed: boot timeout` in the journal while the pid still holds hyperbee
   fds and `[swarm] joined topic` fired; `substrate_outbox` rows pile up `drained_at IS NULL`.
   Since 2026-07-03 a late-completing boot is ADOPTED (registered + wired) — a healthy boot
   logs `late boot ADOPTED` instead of zombifying (regression tests in `boot-all.test.ts`).
4. **Decode `[announce-debug]`** (`PAPERCUSP_ANNOUNCE_DEBUG=1`, swarm.ts): per connection you
   want `mux → defer-open → create → open-request → open → recv/sent`. `create→open-request→
   close` with **no `open`/`pair`** = the announce handshake never paired (zombie endpoint,
   or the peer isn't a real substrate for that topic). `recv topic=… log=…` names the exact
   remote log announced — verify it's the peer you think it is (a local sibling's log looks
   identical at a glance).
5. **A peer's registry decides what re-boots after ITS restart.** A joined-pot harness that
   was never persisted (WI-971 class) silently vanishes on reboot: the peer reconnects, its
   OTHER pots announce, and the one you're probing is simply absent — check the peer's
   boot ring for `boot_start` of the specific (workspace::harness) before debugging admission.
6. **Journal times are LOCAL (EDT here), not UTC** — `journalctl --since "16:45"` when you
   mean 16:45Z silently returns nothing. Use direction-unique probe keys per attempt
   (`p059:v2t:wakeN-<agent>`), never reuse a name in both directions (grep false-positives).
