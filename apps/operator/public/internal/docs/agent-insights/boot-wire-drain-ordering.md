# peer_connected ✓ but federation dead: the boot→wire-drain ordering trap (EI-521)
URL: /internal/docs/agent-insights/boot-wire-drain-ordering

Why a joined member's writes never federate even though the swarm connected — bootSingleHarness cached the handle before wiring the outbox drain, a swallowed wiring failure + the already-booted short-circuit left it drainless forever, and every test masked it by draining manually.

## Symptom

Cross-machine pot federation **merge** is dead: a joined member's local write
(feature / issue / coord) is captured into `harness_shared.substrate_outbox` but
**never drains** to the replicated log, so the peer never receives it — while
`[swarm] peer_connected` fires normally. The tell on a live frame:

* `substrate_outbox` has the undrained row (`drained_at IS NULL`),
* `peer_connected ✓` (the swarm joined),
* **0 drain loops** running for that harness.

Connection ≠ federation. The swarm join and the outbox drain are wired
**independently**; the swarm can be up while the drain never started.

## Root cause — cache-before-wire + the already-booted short-circuit

In `bootSingleHarness` (`packages/operator-core/lib/sync/hyperbee/boot-all.ts`)
the handle was cached **before** the send-side was wired:

```
handles.set(k, handle);          // ← cached FIRST
try { await wireOutboxForHarness(handle, sql); } catch { /* swallowed + logged */ }
```

So if wiring ever throws (a `getOrgPg()` hiccup on a fresh-VM boot is enough),
the handle is cached **without a drain loop**. And because it's now cached, every
later `bootSingleHarness` hits the `if (handles.has(k)) return 'already-booted'`
short-circuit and **never re-wires**. Federation for that harness is dead until
the process restarts. This is the parsimonious explanation for "peer\_connected ✓
but 0 drain loops" — better than the slug / workspace-id mismatch hypotheses
(both code-refuted: the mig-102 capture trigger stamps `NEW.harness_slug` and the
join boots under that same slug + workspace).

Note what is **not** the cause, to save you the dead ends:

* **Not** `boot-all`'s path-liveness filter (the `existsSync(path)` skip). A
  `join-link` member registers a real clone `path`, and the confirmed repro runs
  **with no restart**, so `boot-all` isn't even on the path.
* **Not** a boot timeout from a slow DHT: `joinHarnessSwarm` does
  `void discovery.flushed()` (fire-and-forget), so swarm connectivity never
  blocks the boot promise.

## Fix — wiring must be idempotent + retryable, attempted on the already-booted path

`ensureSendSideWired(handle)` brings the outbox drain + presence announce online,
marking each step wired **only on success**, coalescing concurrent calls, and
running on **both** the fresh-boot and the `already-booted` paths. A transient
failure then self-heals on the next boot pass (the periodic boot-all reconcile /
`rebootHarness`) instead of staying dead until restart. Wired-state is cleared on
close/reset so a reboot re-wires from scratch.

## Why the tests didn't catch it (the blind spot to avoid repeating)

Three things were each proven in isolation, but the **seam between them was not**:

* `outbox-drain.integration.test.ts` drives `startOutboxDrain` **directly**.
* `feature-content-federation.integration.test.ts` proves the full A↔B round-trip
  but calls `drainOutboxOnce` **manually**, and boots via `bootHarnessSubstrate`
  directly.
* `join-default-boot-wiring.test.ts` proves the join orchestrator **calls**
  `bootSingleHarness` — but **mocks** it.

So nothing proved the *live* `bootSingleHarness → wireOutboxForHarness →
startOutboxDrain` loop actually comes online. A federation test that **drains by
hand** can never catch a drain loop that never started. The regression guard is
`wire-outbox-drain-online.integration.test.ts`: write a row *after*
`wireOutboxForHarness` and assert it is **auto-drained by the loop** (no manual
`drainOutboxOnce`), plus a negative control for `(workspace, harness)` scoping.

## When you see this again

Reach for `wireOutboxForHarness` / `ensureSendSideWired` and ask: did the drain
loop actually start, or did a swallowed wiring failure leave a cached-but-drainless
handle? On a live joined member, `SELECT id, table_name, harness_slug,
workspace_id, drained_at FROM harness_shared.substrate_outbox` + whether a drain
loop is counted pins it. Cross-machine confirmation needs `deb-hetzner-federation.sh`
(the pot flow + `fed_hive_merge_probe`), not a single-box run.
