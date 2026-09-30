# A stale dev-source tree runs old code against a newer-migrated DB — and silently kills federation
URL: /internal/docs/agent-insights/dev-source-staleness-kills-federation

Why the packaged desktop app can boot week-old operator code against a shared Postgres the newer bundle already migrated (hives→pots, mig-557), producing nothing but scattered \"relation does not exist\" errors and a dead p2p/federation plane — how to detect it, and the two guards that now prevent it.

## TL;DR

The "all-5-buttons" dogfood desktop bundle ships the runnable monorepo as
`sidecar/source.tar.zst` and extracts it **once** to
`<shared_state_dir>/dev-source` on first boot. `extractDevSourceTree()` used to
**reuse that tree forever** — an already-populated target was never
re-extracted. So when the app updated (a newer bundle with newer `db-sql` +
newer code), the extracted tree stayed frozen at the version of whatever bundle
first ran, while the **shared Postgres kept getting migrated forward** by the
newer bundle's boot runner.

On the LIVE-1 rig VM this produced the WI-4070 wedge: the VM operator ran a
**Jul-9 dev-source tree** (still had `lib/sync/hive-git/`, still queried
`harness_shared.hives`) against a DB migrated **past mig-557** — the
`hives → pots` rename. Every hive-registry / membership / dial-resolution read
failed with:

```
ERROR: relation "harness_shared.hives" does not exist
ERROR: relation "harness_shared.hive_settings" does not exist
ERROR: relation "harness_shared.hive_directory_cache" does not exist
```

Nothing crashed. The operator booted, served its UI, took turns — but the
federation plane was dead: no hive could be resolved, no peer dialed, **zero
`origin='remote'` rows landed on the tower for days** and every rig probe
(`bin/vm-rig/probe-fwd.sh` / `probe-rev.sh`) failed. It reads exactly like a
network/DHT wedge (which is where WI-4070 spent most of its life — "conntrack
empty, swarm link never established"), but the network was fine; the **code was
stale against the schema**.

## Why it's so hard to spot

* **No crash, no loud error at the federation layer.** The failure surfaces as
  ordinary PG `relation does not exist` lines buried in `serve.log`, one per
  read attempt — not as "federation is down".
* **`migration-drift` didn't catch it.** The existing drift check flags
  migrations **on disk but not applied** (`missing`) — the code-ahead-of-DB
  direction. The dev-source rot is the **inverse**: DB ahead of code. Those
  applied-but-not-on-this-disk rows were bucketed as `extra` and treated as
  *benign squashed-history noise* (correctly, for the normal case of a release
  checkout lagging canonical — but it masked this).
* **`dogfood_substrate_status` reported `healthy`.** The harness booted; the
  substrate health verdict doesn't know the code is behind the schema.
* **The identity/keypair red herring.** WI-4070 chased an oscillating
  `coord_event_log.author_pubkey` across boots (`ef7a8160` / `660eb73a` /
  `b58a40fe`) as the suspected cause. It wasn't — only `ef7a8160` ever landed a
  real row; the "phantom" ids never wrote anything. The author\_pubkey angle was
  a distraction from the schema mismatch.

## How to diagnose it (fast)

1. **Tail the peer's `serve.log`** for `relation "harness_shared.<x>" does not
   exist`. Any hit ⇒ stale code vs migrated DB. On macOS the log is
   `~/.papercusp/logs/serve.log`.
2. **Compare the code's migration cap to the DB's.**
   * Code (dev-source tree): `ls .../dev-source/... db-sql | tail` **or** the
     bundle's `sidecar/db-sql/ | sort -n | tail`.
   * DB: `db:migrations { limit: 1 }` — it sorts by migration number DESC by
     default, so the single row it returns IS the DB cap.
   * Code cap **\<** DB cap ⇒ this operator is stale.
3. **Check the extracted tree's age** vs the installed bundle. A `dev-source`
   whose `packages/operator-core/lib/sync/` still contains `hive-git/` (renamed
   to `pot-git/` after 2026-07-09) is pre-rename.

## The fix (two guards, both landed 2026-07-16)

### 1. dev-source re-extracts when the bundle changes (WI-5066)

`extractDevSourceTree()` now writes an **archive stamp**
(`.papercusp-source-archive.json`, size + mtime of `source.tar.zst`) into the
extracted tree root. On boot it reuses the tree **only when the stamp matches
the shipped archive**; a mismatch (app updated) or a missing stamp (legacy
pre-stamp tree) triggers a **re-extract** — move the stale tree aside, extract
fresh, then drop the old one. A failed upgrade **restores** the previous tree
(degraded-but-working) with a LOUD log rather than leaving `no-source-tree`.
Same-bundle reinstall still reuses (WI-3244 no-wipe holds).

### 2. Boot-time schema-ahead-of-code alarm (WI-5050)

`migration-drift.ts` gained `computeSchemaAhead(onDisk, applied)` + a
`schemaAhead` field: applied migrations whose numeric prefix is **higher** than
the max numbered migration this code tree ships. `db-boot-migrate.ts` checks it
after the boot apply and, when non-empty, emits a **loud `console.error` + an
ambient `service-health` coord broadcast**: *"schema AHEAD of code … stale
operator (WI-4070 class), update/redeploy."* The operator still boots (a stale
tree may serve read paths fine; refusing would take the whole box down), but the
silent-death class now announces itself.

## Recovery runbook (when you hit a stale peer)

1. `rsync` the current staging source into the peer's dev-source dir
   (`<shared_state_dir>/.shared/dev-source` on the rig VM), **or** ship it a
   fresh bundle.
2. Relaunch the operator so it boots the fresh code. On the rig VM the app is a
   **GUI LaunchAgent** (`~/Library/LaunchAgents/Papercusp Server.plist`,
   `RunAtLoad`, gui domain) — it only runs inside a logged-in Aqua session, so
   `launchctl kickstart`/`open -a`/`launchctl bootstrap` over SSH all fail with
   *"Domain does not support specified action"* (you cannot reach another
   session's `gui/<uid>` domain from an SSH session). **Getting a fresh Aqua
   session is the hard part and is not reliably scriptable over SSH on Sonoma:**
   a reboot does NOT always re-fire auto-login even with FileVault off +
   `autoLoginUser` set + a valid `/etc/kcpassword`, and `sudo killall
   loginwindow` does NOT re-trigger it either (macOS evaluates auto-login only at
   the first `loginwindow` launch of a boot, and a killed `loginwindow` relaunches
   straight back to the login screen). If a reboot lands at the login window, the
   **owner must unlock the GUI once** at the console (`spice://127.0.0.1:5930` per
   `boot-sonoma-durable.sh`) — treat this as an owner-gated step, not an agent-
   resolvable one. Because the fresh source is already `rsync`'d into the tree
   (step 1), that one manual login is all it takes: the LaunchAgent then boots the
   corrected code automatically.
3. Re-run `bin/vm-rig/deploy.sh` (the VM's `/tmp` driver is wiped on reboot),
   then `probe-fwd.sh` / `probe-rev.sh`. Confirm `serve.log` has **no**
   `relation does not exist` lines and the tower sees fresh `origin='remote'`
   rows.

## The general lesson

Any "extract/cache once, reuse forever" provisioning step is a **latent
staleness trap** the moment the thing it provisions can be updated
independently of a shared, versioned dependency (here: the shared DB schema).
Stamp what you extract with the identity of its source, and re-provision when
the source changes — and add a boot-time assertion that the running code is not
**behind** a shared migrated resource, because that failure mode is silent by
construction.
