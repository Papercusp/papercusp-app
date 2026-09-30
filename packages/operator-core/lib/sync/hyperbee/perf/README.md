# p2p-perf — the hyperbee substrate performance suite

Plan: `p2p-performance-suite-2026-06-07`. Three measurement tiers over the
Model-B sync substrate (per-peer hypercore logs → LWW read-merge → PG
projections), all emitting ONE artifact shape (`artifact.ts`, schema 1) so
curves overlay across tiers.

**The headline metric is D-003**: host event-loop lag p95 < 100ms while sync
runs, measured by the shipped `event-loop-lag-monitor.ts` gauge. Every
artifact carries `loopLag` + `sloPassed`. Throughput numbers are secondary to
"the operator never becomes unusable because of sync" (EI-79 was exactly that
failure).

**Every artifact carries a SECOND, separate verdict: `convergencePassed`.**
`sloPassed` answers *did the host stay responsive*; `convergencePassed` answers
*did replication keep up* — every reader applied all ops inside its catch-up
budget (and, when a scenario sets `convergenceP95LimitMs`, appendToVisible p95
stayed under it). They are deliberately NOT merged, because they diverge: on
2026-08-16 a 64-peer run reported `sloPassed: true` off a healthy 21ms loop lag
while most readers never converged and appendToVisible p95 was 601 SECONDS —
`--gate` and `--slo-only` would both have gone green (EI-20576392705164447).
Never read a green `sloPassed` as evidence the mesh kept up. `null` on either
verdict means NOT MEASURED (no readers declared, no mesh formed, or a
pre-2026-08-16 artifact) — never a pass. Both fail the gated exit paths.

## Running

```bash
# from the repo root
npx tsx packages/operator-core/lib/sync/hyperbee/perf/runner.ts --list
npx tsx …/runner.ts --tier1 --profile smoke      # ~3 min sanity
npx tsx …/runner.ts --tier1 --profile ci          # the nightly matrix (~15 min)
npx tsx …/runner.ts --tier2 --profile smoke       # netem WAN sim (needs userns)
npx tsx …/runner.ts --scenario merge.delta-tick --sizes 1000,1000000
```

Also surfaced as runners on the `p2p-perf` domain in `/admin/testing` (+ the
/adv Tests tab). Artifacts + a generated `report.md` + `summary.json` land in
`test-results/p2p-perf/<runId>/`.

## Tiers

- **Tier 1 (local loopback)** — `scenarios/{merge-cost,replication,churn}.ts`.
  Merge benches run in-process; replication + churn spawn one OS process per
  peer (`peer-child.ts` via `child-driver.ts`) on a local testnet DHT, so the
  loop-lag SLO is judged per peer (worst child wins).
- **Tier 2 (netem WAN sim)** — `scenarios/netem.ts` + `netem-inner.ts`. Builds
  a netns-per-peer topology (unprivileged userns: `unshare -r -n -m`, veth ↔
  bridge, `tc netem` both directions) and replays the Tier-1 mesh through
  impaired links: 50/150/300ms RTT, 0.1–2% loss, jitter, plus the P-009
  loss-curve (UDX/Noise behavior under loss). Skips cleanly where userns is
  restricted.
- **Tier 3 (real frames)** — lives with the deployment layer
  (`lib/deployment/`, see the `tier3` section of the `p2p-perf` testing
  domain): Latitude/Hetzner frames, cred-gated ($0 + skipped without
  `LATITUDE_API_KEY`), destroy-always. On-demand only — never cron (D-004).
  Measures what loopback cannot: NAT/holepunch success, real-WAN DHT
  discovery, cross-region replication.

## Profiles

`--profile smoke|ci|full|deep` sizes the matrices (history sizes × peer
counts). `deep` includes the 1M-op histories used to validate the EI-79
residual (P-013).

## Baselines + regression policy (D-005)

`baselines/tier1.json` is committed; `compare.ts` diffs each run against it
on p95 per metric (+35% relative tolerance, 5ms absolute floor; inverted for
ops/sec). **Advisory only** — like knip. `--gate` exists for a future owner
decision; do not wire it into CI without that decision. Refresh after an
intentional perf change: `--tier1 --profile ci --update-baseline`.

⚠ **`--update-baseline` REWRITES the file from the current run only — it does
not merge.** The committed baseline is the bar every future run is judged
against, so two ordinary mistakes used to destroy it silently: a partial run
(`--scenario x --profile smoke`) collapsed all 17 entries to the one cell it
measured, and a run on a contended box baked shared-box contention in as the
threshold — moving the bar in the direction that HIDES regressions. Both are
now refused (`checkBaselinePromotion`, guarded by
`baseline-promotion-guard.test.ts`), each with its own override so accepting
one risk never silently accepts the other:

- `--allow-baseline-shrink` — accept a promotion that drops covered cells.
- `--allow-contended-baseline` — accept one captured on an oversubscribed host.

A refused promotion exits non-zero and records `baselinePromotion.written:
false` in `summary.json`; the baseline is left untouched. The documented
refresh above trips neither guard — entry keys are seed-deterministic
(`expectedWinnersFor` is pure over `(seed, count)`), so a full `ci` re-run
reproduces the same 17 keys. **A rebaseline should be a full-profile run on a
quiet host**; point anything smaller at a temp `--baseline` path.

## Scheduling (P-014)

`system:p2p-perf-tier1` (nightly 02:30) + `system:p2p-perf-tier2` (weekly Sun
03:30) — handlers in `lib/harness/routines/p2p-perf-actions.ts`, seeded by
`seed-p2p-perf-routines.ts`. Threshold-crossing findings (SLO violations,
regressions, scenario crashes) auto-file to the improvements backlog via
`captureImprovement` (deduped, `dedupScope:'open'` so a resolved-then-regressed
finding re-files).

## CI-locked invariants (cheap, deterministic — run with the unit suite)

- `merge-scaling.test.ts` — idle ticks decode/apply NOTHING; one appended op
  costs exactly one apply (boot-level O(delta)).
- `read-merge-incremental.test.ts` — incremental cursor ≡ full fold winner
  equivalence; per-pass budget defers-never-drops (EI-91); unavailable reads
  never advance the cursor.
- `corpus.test.ts` — corpus determinism (same seed → byte-identical stream).
- `projection-write-cost.integration.test.ts` — corpus rows decode + write
  through every registered projection against the real migrated schema
  (Docker; also the per-projection-writer cost bench).

## Findings ledger

- **EI-79** (pre-suite): 1Hz full-history re-merge on the main thread.
  Locked out by merge-scaling.test.ts + the idle-tick bench.
- **EI-91** (found by churn.cold-join): the 50k per-log read cap had no
  cursor — history beyond 50k NEVER merged. Fixed by the P-013 incremental
  cursor (budget = per-pass chunk).
- **EI-92** (found by netem.sustained): per-op remote block fetch made WAN
  ingest RTT-bound (~6.6 ops/s at 150ms; 29s append→visible p95). Fixed by
  ranged prefetch (`RemoteLog.prefetch` → `core.download` range). Post-fix:
  1.87s p95 under the same profile.
- **P-013 validation** (merge.delta-tick): 1-op tick p95 = 0.13ms at a 1M-op
  history (flat in H); loop-lag p95 29ms — SLO held.
