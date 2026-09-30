# Substrate sidecar process seams: why federation bootstrap resolves fail there (and the deterministic fix)
URL: /internal/docs/agent-insights/substrate-sidecar-process-seams-federation-bootstrap

The substrate sidecar is a SEPARATE process where PG-backed default seams and process-local singletons (org-PG, operator-state reads, the live pot-directory instance) can be unconfigured or empty — and every failure is a silently-caught fail-closed null. The owner-bootstrap admit binding (hivePubkey → ownerDevicePubkey) depended on exactly such state, making owner→joiner federation directory-timing LUCK. Fix pattern: thread boot-resolved values into per-frame paths + carry verified bindings in the REGISTRY (the one store that resolves in every process).

## The trap in one sentence

Code under `lib/sync/hyperbee/**` runs in the **substrate sidecar — a separate
process** — where the operator's PG-backed default seams and process-local
singletons may be unconfigured or empty, and because every consumer wraps them
in `catch(() => null)` / `catch(() => [])`, a missing dependency looks exactly
like "no data": **fail-closed, silent, and unreproducible in-process.**

## How it manifested (2026-07-01, Brief-3 live rig — a full day of INCOMPLETEs)

The joiner's **owner-bootstrap admit** must resolve
`(hivePubkey → ownerDevicePubkey)` before it will admit the pot OWNER's log
(`resolveJoinedHiveOwnerDevice` in `boot.ts`; `loadHiveOwnerDevicePubkey` in
`pot-membership-store.ts`). Until that resolves, the joiner **rejects every
owner announce** (`[A-003] owner-admit …: ownerDevice=<null> match=false`) — no
roster, no content, nothing federates.

The binding's two legs were BOTH process-local state:

1. **The live in-process pot directory** (`getHiveDirectory().listDiscoveredHives`)
   — a per-process singleton. The OPERATOR process's directory heard the owner's
   announce (and wrote the PG cache row); the SIDECAR's instance had not.
2. **The PG offline cache** (`readOperatorState('hive_directory_cache', ws)`) —
   worked only when the row for exactly that workspace existed at read time; the
   descriptor arrived on the joiner \~18 minutes after publish (directory
   propagation), long after every scenario poll window expired.

So whether owner→joiner federation worked at all was **directory-timing luck**:
Brief 4 won the race and passed; Brief 3 lost it four consecutive runs. The
in-process matrix could never catch this — in one process, the directory
singleton is shared, so the binding always resolves.

The same trap, second face: the fire-and-forget `admitAnnouncedPeerAsOwner`
call re-resolved the harness's pot-home **per inbound announce** through
registry+PG defaults. In the sidecar/test contexts those defaults threw
(`getOrgPg().sql` undefined → "reading 'unsafe'"; `readOperatorState` → "sql is
not a function"), and the catch turned every announce into a silent admit skip
(live) or a `console.error` that failed the whole cross-peer suite 9/9 (tests).

## The fix pattern (two halves, both landed 2026-07-02)

1. **Thread boot-resolved values; never re-resolve per frame.** The boot already
   knows its pot-home (`hiveHomeProjectionSlug ?? ownHiveHomeSlug`, kept
   current across rekey rebinds). `boot.ts` now passes it into
   `admitAnnouncedPeerAsOwner` via `deps.hiveHomeSlugForHarness` — deterministic,
   free, and independent of any process-local seam.
2. **Carry verified bindings in the REGISTRY** — the one store that demonstrably
   resolves in every process (the sidecar's `joinerHiveHomeSlug` registry read
   works live; that is the existence proof). `joinHiveAsView` now stamps the
   verified `(hive_pubkey, owner_device_pubkey)` from the discovery descriptor
   onto the `remote_hive` view entry at JOIN time (idempotent re-join backfills
   pre-stamp views), and `loadHiveOwnerDeviceBindings` reads that as its first,
   deterministic leg. Both values trace to `verifyHiveAnnounce`-gated sources,
   so trust is unchanged — only availability widened.

## Rules for the next agent

* **Anything imported under `sync/hyperbee/**` must assume: no org-PG, no
  operator-state PG, no live directory, no operator singletons.** If it needs
  one, either take it as a dep threaded from boot opts, or read the registry.
* **A `catch(() => null)` around a cross-process dependency is a silent
  fail-closed** — when debugging "X never happens" in the sidecar, suspect the
  seam before the logic. `PAPERCUSP_A003_TRACE=1` prints the admit/resolve
  decisions to `serve.log` and is the fastest live discriminator.
* **In-process green ≠ live green, specifically BECAUSE of process seams**: the
  in-process matrix shares every singleton; only the 2-VM rig (or the sidecar
  repro tests) exercises the process boundary.
* Debug flow that worked: run the rig scenario with `--keep-up` + the trace env
  → `grep -a 'A-003' /home/pcusp/serve.log` on the failing side → psql the
  frame's PG directly to compare what each PROCESS believes → mutate the state
  live (inject a row, restart one sidecar) to discriminate hypotheses.
