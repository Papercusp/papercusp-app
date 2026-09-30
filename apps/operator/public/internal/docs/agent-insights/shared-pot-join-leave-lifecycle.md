# Shared-pot join/leave lifecycle — what self-heals, what to call, what ages out
URL: /internal/docs/agent-insights/shared-pot-join-leave-lifecycle

A joiner LEAVES via pot:leave (the inverse of joinHiveAsView). A phase_0_pending join needs NO re-drive when registered — boot-all re-federates it; only an unregistered clone is a ghost. Leave publishes a presence tombstone; TTL is the fallback.

## TL;DR

Three lifecycle facts that aren't obvious from the code (shared-pot-hardening-2026-06-13 P-012/P-013/P-014):

1. **Leaving a joined pot = `pot:leave`** (the inverse of `joinHiveAsView`). `pot:dissolve` is the OWNER teardown of a LOCAL pot — it does **nothing** for a joiner (no de-federation, no routine/presence/registry cleanup). Don't reach for dissolve to leave.
2. **A `phase_0_pending` join self-heals on the next boot — if its clone got registered.** Do not build a re-drive for that; `bootAllHarnessesForActiveWorkspace` re-joins the swarm. The only ghost is a clone that landed on disk but whose registry write *also* failed.
3. **A leaver's presence on OTHER peers gets a best-effort tombstone; TTL is the fallback.** Locally it's deleted immediately. Leave publishes a `del` while swarms are still live, but peers that miss the bounded drain still age out by TTL.

## pot:leave — the joiner's inverse of joinHiveAsView

`joinHiveAsView` (`harness/join-hive.ts`) builds four things per member: a swarm-joined federation handle, a `system:git-sync` routine row, `shared_presence` rows, and registry entries (the `remote_hive` view + members with `hive_slug`). `pot:leave` (`harness/leave-hive.ts` + `agent-tools/pot/leave.ts` — the agent-tool wrapper moved from `hive/` to `pot/` in the cup-lexicon-full-rename-2026-07-09 rename; the underlying `leaveHive()` implementation file has not been renamed yet) tears down exactly those, in the safe order (stop the moving parts before removing the coords they read):

1. **Stop federating** — `closeBootedHarness(ws, member)` per member: `SwarmHandle.close()` leaves the topic, the presence-announce loop's close-hook stops, the corestore closes.
2. **Delete git-sync routines** — `removeGitSyncRoutine(sql, member)` (a row delete, not `setActive(false)` — the member is being deregistered).
3. **Drop presence** — delete the member's local `shared_presence` rows.
4. **Deregister** — one atomic `mutateHarnessRegistry` removing the view + all members. Clone dirs are KEPT by default (re-joinable, data-safe); `deleteClones:true` also `rm -rf`s them.

Root-only + `confirm:true` (mirrors dissolve), idempotent + best-effort: every leg tolerates already-done, so a partial leave is fully re-runnable.

**Membership teardown (G27): leave also deletes the leaver's own `hive_members` admission row.** Beyond presence, `leaveHive` resolves the leaver's `github_user_id` (`resolveLocalGithubIdentity`, skipped when gh-unauthed) and deletes their `hive_members` row for the pot via `removeHiveMember` — which fires the mig-189 capture trigger → a federated `del` membership tombstone, so peers' read-merge drops the *departed member*, not just their presence row. It runs in `PASS 1.5` (after the presence tombstones, **before** the EI-469 drain below), so the SAME bounded drain window flushes the membership `del` alongside the presence ones. Best-effort + identity-gated: gh-unauthed → skipped (the owner's revoke / TTL is the backstop), `0` rows when not a member / already gone (idempotent). The `LeaveHiveResult` reports `leaverGithubUserId` + `membershipRowsDropped`. (`pot:dissolve` has the owner-side analogue — `removeAllHiveMembers` for *every* member, G24.)

**Presence tombstone (EI-469): leave publishes a `del`, but cross-machine delivery is gated.** `pot:leave` now calls `publishPresenceTombstoneForHarness` (`wire-presence.ts`) per member **before** `closeBootedHarness` — it appends a presence `del` op (`buildPresenceTombstoneOp`, key `<github_user_id>/<machine_label>`) to the own log while the swarm is still live, so a connected peer's projection deletes the leaver's row at once (the projection's `ts`-guarded `deleteFromPg`) instead of waiting out the \~90s staleness window. Two deliberate boundaries: (1) it is published on **leave only**, NOT graceful shutdown — going offline is transient (you'll reappear next boot; the TTL models that), a tombstone means "I left". (2) `leaveHive` does **tombstone-all → one bounded DRAIN window (`DEFAULT_LEAVE_DRAIN_MS`=3s, `opts.drainMs`, skipped when nothing tombstoned) → teardown-all** — keeping the swarms live so connected peers' pull-based read-merge fetches the dels before the store closes. The federation-delete is **proven end-to-end in-process** (`leave-hive-tombstone-federation.integration.test.ts`: two real Swarms, A's tombstone deletes A's row from B's `shared_presence` over the real Hyperswarm path). The ONE residual is **D-003 real-hardware**: tuning that drain window under real network latency/NAT — replication is pull-based with no delivery ack, so it's inherently best-effort and a peer that hasn't pulled in time falls back to the \~90s TTL (safe).

## phase\_0\_pending is (almost always) cosmetic — boot-all is the heal

A join soft-fails `boot_federate` / `await_admission_merge` to `phase_0_pending` (`join-shared-harness.ts`) when no peer is reachable within the timeout. This is **not** a stuck state:

* The clone is registered (the join-link route registers it pre-boot AND post-join), so **`bootAllHarnessesForActiveWorkspace` re-boots it next session** → `defaultResolveSwarmBinding` re-joins the swarm → federation re-establishes. `await_admission_merge`'s phase\_0 just means "no peer yet"; the read-merge admit loop picks one up when it comes online — even in the same session.
* The `~/.papercusp/join-state/<slug>.json` record is **cosmetic** once the clone is registered — nothing reads it except the join orchestrator's own idempotent resume.

So **don't build a re-drive for the registered case** — it isn't broken. The one residual boot-all can't heal: a join where the registry write *also* failed → a clone on disk, pending, absent from the registry → boot-all never visits it. `harness/join-state-reconcile.ts` (`ensureJoinStatesReconciledOnce`, a boot hook beside `git-sync-reconcile`) closes exactly that: re-register any join-state slug whose clone dir exists but is missing from the registry; report (don't silently drop) the rest.

> Gotcha that bit me: this boot sweep reads the **real** `~/.papercusp/join-state` FS + writes the registry, so it must NOT run in unrelated booting unit tests (which partially-mock `harness-registry`). It's `process.env.VITEST`-guarded when no seams are injected — same idiom as join-shared-harness's EI-339 live-write guard. The sweep logic is unit-tested directly with seams.

## P-014: the reconcile blind-spot alarm

`git-sync-reconcile` only ever visited `hive_slug` members, so a NEW registered checkout that isn't a pot member and isn't seeded at creation would silently never sync. The reconcile now also **detects** (does not auto-seed — a non-member isn't assumed wanted-synced) any non-member, git-sync-eligible checkout with no routine row and surfaces it as `unseeded` (logged `⚠ eligible-but-UNSEEDED=[…]`). `papercup` (hand-tuned row) and anything with a routine are excluded.
