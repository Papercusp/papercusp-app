# The real-metal full-loop multi-swarm E2E rig (loop-agent)
URL: /internal/docs/agent-insights/full-loop-multiswarm-e2e-rig

How to run/extend the shared-pot autonomous-loop E2E across machines — the loop-agent child, the deterministic joinPeer mesh, and the chaos knobs. Two gotchas that cost a run each.

## What

`shared-pot-loop-e2e-testing-2026-06-10` P-008/P-009/P-011 exercise the WHOLE
autonomous loop — steer → contend → execute → converge → steer — on ≥3 Swarms,
both $0 on loopback and paid across real Hetzner machines. The rig is three files
under `packages/operator-core/lib/deployment/p2p-perf-tier3/`, plus the test:

* **`loop-agent.ts`** — one Swarm as an OS process: the composition of
  `claim-agent.ts` (per-Pot authority election + real HTTP authority RPC +
  fail-open) and `peer-child.ts` (real hyperbee substrate over Hyperswarm,
  re-keyed onto the Pot federation topic). On top it adds the loop pieces the
  hermetic `composition-rig.ts` proved on one box: a scripted Mug turn
  (`mug {epoch,order}` over stdin → `wi-steer` ops), a fake pipeline
  (work → side-effect marker → the D-007 rule-5 heartbeat abort seam →
  federated `wi-done`), and chaos commands (`partition on|off`, a configured
  mid-pipeline `stall`, `revoke <pubkey>` arming the EI-284 caller-standing gate).
* **`loop-launcher.ts`** — `localLoopLauncher` (child processes + a hyperdht
  testnet) and `sshLoopLauncher` (one agent per Hetzner frame); reuses
  `ClaimAgentHandle` and the claim-launcher port-marker pkill discipline.
* **`run-full-loop.ts`** — the transport-agnostic orchestrator + the PURE
  `computeFullLoopVerdict` (exactly-once, steering monotonicity, reconcile
  one-winner, D-007 adoption, EI-284 refusal, convergence lag). Unit-tested in
  `run-full-loop.test.ts`; the orchestration in `swarm-full-loop.integration.test.ts`
  ($0 local legs always run; the real-Hetzner leg is `describe.skipIf(!haveHetzner)`).

The Hetzner creds + leak-audit recipe are the same as the other deployment
E2Es — see the `reference_hetzner_cross_machine_federation_harness` memory.

## Two gotchas, one run each

**1. Concurrent topic joins race the DHT announce → the substrate mesh never
forms.** Announces ride PER-CONNECTION channels (`openAnnounceChannel` on each
socket's muxer — there is no gossip), so full-mesh admission needs a *direct
connection per pair*. When N agents `swarm.join(topic)` concurrently, the DHT
announce/lookup can settle into a partial graph and `handle.admitted` stalls
below `meshSize` forever (symptom: `runFullLoop: Swarm(s) … never reached full
mesh`, \~90s timeout). Fix: each agent emits its hyperswarm noise pubkey
(`swarm.keyPair.publicKey`) on `ready`; the orchestrator collects them and sends
`peers <hex,…>`; each agent `swarm.joinPeer(Buffer.from(hex,'hex'))`s the others
explicitly. Deterministic pairwise mesh, identical on testnet and the public DHT.
(Topic join stays as the discovery fallback.)

**2. `tar` aborts the runtime pack because the shared tree is LIVE.** The dev
checkout is being written by git-sync + build-watches + peer agents while
`packRuntimeTarball` reads it; GNU tar exits 1 ("file shrank/changed as we read
it") and the whole provision fails before a single VM boots. Two-part fix in
`runtime-pack.ts`: exclude the regenerated build output
(`./apps/operator-vite/dist` — its docs mirror is rewritten by the build-watch
mid-pack), and tolerate tar **exit 1** (files-changed; the entry is padded, the
rest is intact, and a frame never imports mid-churn build output) while still
throwing on exit 2 (fatal). This is the deployment analog of the "shared dev
tree is never quiescent" rule — anything that snapshots the tree must tolerate
concurrent mutation.

## The verdict's starvation rule (don't trip on it when extending)

`computeFullLoopVerdict` counts starvation against completion EVIDENCE, not
reporters. A killed authority's `wi-done` records federate before it dies and are
real completions visible in every survivor's converged projection — but the dead
Swarm never reports a `result`. So `starvedItems` unions reported completions
with the Mug's turn-2 `sawDone` projection; only an item with no evidence
anywhere starved. (The residual — a dead-reporter completion racing a survivor's
fail-open re-claim, double-completing invisibly to this verdict — is exactly what
production's P-012 cross-swarm double-completion detector is for.)
