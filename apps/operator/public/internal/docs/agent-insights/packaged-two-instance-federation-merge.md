# Packaged two-instance federation merge — the write-free unlock + the same-box DHT ceiling
URL: /internal/docs/agent-insights/packaged-two-instance-federation-merge

How to prove a real federation MERGE between two SEPARATELY-PACKAGED desktop instances on one box: write-free join lets a synthetic repo id publish a binding (A3), but same-box public-DHT discovery fails (NAT hairpinning) and silent swarm-join failures hid it. The PAPERCUSP_DHT_BOOTSTRAP override + [swarm] logs + the merge smoke.

import { Aside } from '@astrojs/starlight/components';

The in-process [`p079-live-federation.live.test.ts`](/internal/docs/testing/p079-bidirectional-federation)
proves the write-free admission *logic* with two real identities over a testnet
DHT. The remaining acceptance was the **packaged** version: two separately-built
`.deb` desktop processes on one box federating a real write. **This is now
PROVEN GREEN (2026-06-03)** — see "Proven" below. Here's what's true, how it was
unblocked, and the harness.

## What write-free join unlocked (verified in the packaged app)

The old `papercusp-desktop/bin/two-instance-federation-smoke.sh` header says the
MERGE is *"admission-gated on real GitHub bindings; a synthetic repo id can't
publish a binding → no merge."* **That ceiling is gone.** After the write-free
join (`non-collaborator-join-fork-pr-2026-06-02`, "A3"), admission proves the
`device_pubkey ↔ github_user_id` binding from the announced **attestation gist**

* signed announce — not a contributor file written to the shared repo. So the
  `github_repository_id` is just a **swarm-topic seed**; each peer self-publishes
  its own gist.

Verified live: two packaged instances (distinct identities `papercupai` +
`ownerhandle` via per-instance `GH_TOKEN`), each `POST /api/harness/:slug/share/finalize`
with the SAME **synthetic** repo id, both return `bindingPublished: true` and
`swarm: { state: "booted" }`. The federating write itself works too: a direct
`INSERT … origin='local'` into `harness_shared.harness_features_consolidated`
fires the migration-102 capture trigger → `substrate_outbox`.

## Why a same-box merge still doesn't "just work"

Two failure modes, both **packaged-runtime / infra — not the federation logic**:

1. **Same-box discovery over the public DHT fails (NAT hairpinning).** Two
   Hyperswarm instances on one machine must holepunch to their own public IP,
   which most routers/clouds drop. This is *exactly* why the in-process p079 test
   uses `hyperdht/testnet` instead of the public DHT.
2. **Silent swarm-join failures were invisible.** `bootHarnessSubstrate`'s
   swarm-join `try/catch` recorded `swarm_join_failed` only to **in-memory**
   boot-history (no stdout, and `GET /api/admin/dogfood-substrate-boot-history`
   is trust-gated) — so an identity/keychain/announce failure left the harness
   silently local-only with zero observable signal.

A harness that "booted" (`state:"booted"`, `bindingPublished:true`) is **not**
necessarily swarm-joined. The reboot boots PG state; the actual Hyperswarm join
can still fail-closed silently. Always check the `[swarm]` log lines (below).

## The fix: `PAPERCUSP_DHT_BOOTSTRAP` + `[swarm]` logs

Both added to `packages/operator-core/lib/sync/hyperbee/`:

* **`PAPERCUSP_DHT_BOOTSTRAP`** (`swarm.ts`, `swarmConstructorOpts` /
  `parseDhtBootstrap`) — a comma-separated `host:port` list. When set, every peer
  sharing the value joins the **same isolated DHT** (a local `hyperdht/testnet`),
  so two same-box instances discover each other over loopback. Unset → the public
  DHT (default, unchanged). Unit-tested in `swarm.test.ts`.
* **`[swarm]` stdout diagnostics** (`boot.ts`) — always-on: `[swarm] joined topic
  …`, `[swarm] peer_connected …`, and crucially `[swarm] join FAILED … staying
  local-only: <error>` (the previously-silent catch — a real production
  regression signal, not just test scaffolding).

## Running the packaged merge proof

`papercusp-desktop/bin/two-instance-merge-smoke.sh` spins a local testnet DHT,
launches two `.deb` instances pointed at it with distinct identities, registers a
harness + shares write-free on both, waits for `[swarm] peer_connected`, then
INSERTs a feature on A and asserts it lands in B's PG with `origin='remote'` (and
the reverse). **It requires a `.deb` rebuilt from a tree that includes the
`swarm.ts` + `boot.ts` changes above** — an older `.deb` ignores
`PAPERCUSP_DHT_BOOTSTRAP` and uses the public DHT.

**Rebuild with the build steps, NOT `bin/release-local.sh`.** `release-local.sh`
*also* bumps the version, commits + tags, **pushes to origin, and publishes a
GitHub Release** — outward-facing actions you don't want for a local smoke. To
get just the `.deb`, run the two build steps it wraps, under the
`desktop-sidecar` exclusive lock (drains peers; guards the recurring 0-byte
clobber):

```bash
cd papercusp-desktop
bash bin/build-desktop-sidecar.sh                                   # vite SPA + esbuild host → src-tauri/sidecar/
npx --yes -p @tauri-apps/cli@latest tauri build                    # cargo (incremental) + bundle the .deb
```

The cargo step is near-incremental (\~1 min — only a re-link for the new sidecar
resource, since the swarm enablers are TS bundled as a Tauri *resource*, not
compiled Rust); the long pole is the 0.7 GB `.deb` bundle + an RPM you don't
need (kill the `tauri build` subtree once `…/bundle/deb/*.deb` is written).
Verify the override actually made it in:
`dpkg-deb --fsys-tarfile <deb> | tar -xO usr/lib/Papercusp/sidecar/host.mjs | grep -c PAPERCUSP_DHT_BOOTSTRAP` → `1`.

## Proven (2026-06-03)

Rebuilt the `.deb` from papercup `a56e6510a` per the steps above (verified the
packaged `host.mjs` carries `PAPERCUSP_DHT_BOOTSTRAP` + `[swarm] join FAILED`),
then ran `bin/two-instance-merge-smoke.sh` → **GREEN**:

```
A: papercupai  B: ownerhandle   (isolated PG/sidecar ports, Xvfb :148, testnet DHT 127.0.0.1:497xx)
A/B share write-free on a SYNTHETIC repo → state:"booted"  bindingPublished:true
✓ peers discovered each other            ([swarm] peer_connected)
✓ A→B MERGE: F-A2B federated into B as origin=remote
✓ B→A MERGE: F-B2A federated into A as origin=remote
OVERALL: PASS — write-free packaged merge proven
```

So the in-process p079 proof now has a matching **packaged-runtime** proof: two
separately-packaged desktop processes, distinct real identities, write-free join
on a synthetic repo, bidirectional federation over a local testnet DHT. Both
same-box failure modes from the section above are closed — discovery works
(testnet DHT) and is observable (`[swarm]` logs). Discovery + both merges landed
on the first poll (\~sub-second each), not the \~90 s ceiling.

Launch teardown must be **scoped** — `pkill -f "$WORK"` (the run's mktemp dir),
NEVER `pkill -f papercusp-desktop` (that kills peers' dev desktops + e2e Xvfb).
Use a dedicated `Xvfb` display, not the shared `:99`/`:100`.
