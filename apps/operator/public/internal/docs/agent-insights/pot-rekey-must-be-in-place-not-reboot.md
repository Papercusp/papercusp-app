# Re-keying a hyperbee harness onto a new swarm topic must be IN PLACE, never via reboot
URL: /internal/docs/agent-insights/pot-rekey-must-be-in-place-not-reboot

A harness that goes shared (joins or publishes a pot after boot) must switch from its gh-repo topic to the pot-pubkey topic. Doing that with rebootHarness (close + re-boot the Corestore-backed substrate) silently breaks the OWNER's corestore replication-SERVING of its own log core — the re-keyed owner admits + connects to the joiner and knows its log length, but fires ZERO upload events, so the joiner downloads zero blocks (contig=0) and the feature never crosses. Re-key IN PLACE instead with handle.rekey / rekeyHarness — leave the old topic + join the new one while keeping the store, open cores, and replication streams ALIVE. The symptom is asymmetric — the joiner serves its log to the owner fine; only the owner-to-joiner direction is dead.

When a harness "goes shared" at runtime — an owner **publishes** a pot, or a
peer **joins** one — its substrate booted earlier (at host-bootstrap) on the
`gh:<repo_id>` topic, before the pot identity existed. It must **re-key** onto
the pot-pubkey topic so owner + joiner share a topic. The obvious primitive is
`rebootHarness` (close the handle, boot fresh, re-resolve the binding). **That is
wrong, and the failure is silent + asymmetric.**

## The symptom

The feature written on the owner (A) never lands in the joiner (B), even though
every earlier step passes: same pot topic, `peer_connected` both ways,
`announce_admitted` both ways with the **correct** log keys (`A.ownLog ==
B.admitted` and vice-versa). The packaged
`two-instance-pot-from-repo-smoke.sh` shows `post-join-merge=FAIL` with
everything else green.

Instrument the replicas (`core.peers`, `core.contiguousLength`, and the
`upload`/`download` events) and the asymmetry is stark:

* **B → A works:** B's own log fires `upload` for blocks 0..N; A's replica of
  B's log reaches `contig=N`. The joiner serves its log fine.
* **A → B is dead:** B's replica of A's log has `peers=1` and knows the length,
  but `contig=0` — it downloads **nothing**. And **A fires ZERO `upload`
  events for its own log core.** The owner never serves.

So it is not a missing session, a wrong topic, a bad key, or admission — it is
that **the re-keyed OWNER does not upload its own writable log core to the
joiner.**

## Why reboot breaks it

A↔B share ONE Hyperswarm socket (Hyperswarm dedupes per peer-pair), carrying ONE
Protomux muxer that the **directory** swarm creates first (gossip) and the
harness `corestore.replicate(socket)` then rides
(`socket.userData`). When `rebootHarness` tears the Corestore-backed substrate
down and re-creates it, the owner's writable log core is re-opened against a
session whose serving side never gets re-attached to that pre-existing external
muxer. The owner can still *download* (it pulls B's log) but never *uploads* its
own. `keepStore` (keeping the Corestore cached across the reboot) is **not**
enough — re-creating the handle/swarm/streams still drops the serving side.

## The fix — re-key in place

Never reboot to re-key. Leave the old topic and join the new one on the **same
live handle**, keeping the store + open cores + replication streams + merge loop
untouched:

* `boot.ts` exposes `handle.rekey(binding)` — closes the current `SwarmHandle`
  (leave old topic), then `joinForBinding(newBinding)` (join the new topic) with
  the SAME `store` / `ownLog` / `onAnnounce`. `swarm` is a live getter, not a
  boot-time snapshot.
* `boot-all.ts` exposes `rekeyHarness(workspaceId, slug)` — re-resolves the
  binding via `defaultResolveSwarmBinding` (which calls `resolveHiveSwarmBinding`
  first, so a shared pot resolves the pot-pubkey topic) and calls
  `handle.rekey`. Falls back to `bootSingleHarness` when not yet booted.
* The two "go shared" call sites use it: `join-hive.ts` step 2c (joiner) and
  `hive-publish-from-repo.ts` step 7 (owner) — both files are still internally
  named `hive-*`; only the tool/UX-facing vocabulary re-keyed to "Pot".

Because the streams are never torn down, the owner keeps serving its log core,
and the new joiner's block requests are answered immediately. `post-join-merge`
flips to PASS (verified stable across repeated runs of the from-repo smoke).

## The general lesson

For any Corestore/Hypercore peer multiplexed over a **shared, externally-created
muxer**, a topic change must be a swarm-level leave+join — **never** a teardown

* re-create of the data layer. Tearing down the store drops the serving side of
  replication for cores that were open before the tear-down, and a fresh store
  cannot re-attach to the surviving muxer. Verify with `upload`/`download` core
  events + `contiguousLength`, not just `peers` and `length` — a peer can be
  connected, know the remote length, and still download zero blocks.
