# Agent capacity benchmark

How many Papercusp agents one machine holds, what that costs, and how to measure it again.
Plan: `agent-capacity-and-cost-gcp-2026-09-30`. Every number below comes from a plan Decision
(D-NNN), and each script header names the decision it produced.

**Read the results:** [`SIZE-GUIDE.md`](SIZE-GUIDE.md), the generated size guide. Agents per machine
and workload, the cheapest own VM for a workspace, the Server's cost per workspace, the hosted
default, and the cost inputs for pricing.

## The pipeline

Each step's output feeds the next one. All commands run from the repo root.

1. **Record a workload corpus** (P-002). Real `claude` and `codex` sessions on pinned tasks
   (`corpus/tasks.json`), recorded through a reverse proxy so they can be replayed without model
   calls:
   `npx tsx scripts/agent-capacity/record-session.ts --cli claude|codex --tasks all|<id,id> ...`
   (`record-proxy.ts` is the proxy; `corpus/summarize.py` writes `corpus/SUMMARY.md`.)
2. **Replay it at load** (P-003). `replay-server.ts` serves the recorded model turns, and
   `load-driver.ts` runs N real CLIs at once against it, each in its own copy of the pinned repo:
   `npx tsx scripts/agent-capacity/replay-server.ts --corpus <dir> [--port 18700] [--speed 1]`
   `npx tsx scripts/agent-capacity/load-driver.ts --agents 8 ...`
   `host-admission.ts` decides where a run may start its sessions. `session-process.ts` is the
   process accounting both drivers share.
3. **Ramp on real GCP VMs** (P-004, P-005, P-529). Scripts in `vm/` run ON the VM:
   - `vm/stage-driver.sh <vm> <project> <zone>` (from the tower) copies the driver to the VM, then
     `vm/bootstrap-agent-vm.sh` prepares it.
   - `vm/p005-ramp.sh <label> <select|all> "<N steps>" [durationSec]` runs one ramp.
     `vm/p005-ramps-all.sh` runs the full set on one VM.
   - `vm/p529-admission.sh <K> "<N steps>" [durationSec] [repo]` runs the heavy-job admission A/B
     (`vm/heavy-shim.sh`, installed by `vm/install-heavy-shim.sh`).
   - `vm/reclaim-drill.sh` with `vm/reclaim-vm-hooks.sh` and `vm/reclaim-claude-run.sh` is the
     spot-reclaim drill (P-007, D-026).
   - `vm/install-server.sh`, `vm/time-restart.sh` and `vm/sample-footprint.py` measure the
     Papercusp Server itself (S7). `footprint-summary.ts <capture.jsonl>` summarizes a capture.
   - `vm/sidecar-idle-soak.sh` runs the embed-sidecar idle-exit soak (P-532, D-052) on several
     tenant Servers, with `vm/sidecar-idle-probe.sh` (census, ports, env-switcher operators),
     `vm/embed-trace-fetch.cjs` and `vm/host-sampler.sh`.
     `python3 vm/sidecar-idle-analyze.py <run.log>` turns its log into PASS / FAIL / NOT_OBSERVED
     verdicts and the `--p532-saved-gib` figure for the cost model.
   - `vm/p2p-join-soak.sh` is the p2p join soak (S6, P-525): a cold GCP joiner against the tower.
     `python3 vm/backfill-split.py <fp.jsonl> <serve.log> [from_epoch]` splits its footprint
     samples by whether an embed-backfill drain overlapped them.
   - `vm/gce-resize.sh` times a GCE machine-type resize (D-053).
4. **Build the capacity table** from the pulled-back ramp results:
   `npx tsx scripts/agent-capacity/capacity-table.ts <root> [--disk-gb 120] [--json]`
5. **Cost model** (P-012). Cost per workspace of N agents for each lever combination, against the
   10x target:
   `npx tsx scripts/agent-capacity/cost-model.ts [--agents 50] [--p532-saved-gib <GiB>] [--json]`
6. **Size guide** (P-013). Derived from the cost model:
   `npx tsx scripts/agent-capacity/size-guide.ts [--json]`, and `--write` to regenerate
   `SIZE-GUIDE.md`.

## After a new measurement

1. Put the measured figure in the matching `CAPACITY` row (or `SERVER`, `DUTY`) in
   `cost-model.ts`, naming the decision it came from. Never edit `SIZE-GUIDE.md` by hand.
2. Regenerate: `npx tsx scripts/agent-capacity/size-guide.ts --write`.
3. Run the tests: `testing:run` on `scripts/agent-capacity/cost-model.test.ts` and
   `scripts/agent-capacity/size-guide.test.ts`. The size-guide test fails while `SIZE-GUIDE.md` is
   out of date, and when the hosted default (`GCP_FIRST_WORKSPACE_DEFAULTS` in
   `packages/operator-core/lib/auth/hosted/first-workspace.ts`) is a shape with no capacity run.
4. Prices live in `gcp-rails.ts` (`PRICES_2026_09_30`, `SPOT_PRICES_2026_10_01`). A price update
   there re-prices every row.

## Spending money safely

Every VM goes through `gcp-rails.ts`. It runs in the dedicated project `pc-agent-capacity-0930`,
under the $200 programme cap (D-002), with plan/run/cost labels, a GCP-enforced self-delete
deadline, a worst-case-cost admission check, and a teardown that only counts as done once a
re-read of the project shows no instance and no orphaned disk. Its header explains each rail. Check
`gcloud compute instances list --project=pc-agent-capacity-0930` after every run.

## Not in the repo yet

These runs produced plan decisions but their drivers still live only in the gitignored
`.papercusp/scratch/`, so nobody else can re-run them. Moving them here, with tests, is tracked as
WI-10006497.

- P-011 multi-tenant Server packing (D-045): `run-p011-ab.sh`, `run-p011-replicate.sh`, `p011/`.
- p2p field test S1, the one-shot cold join (P-522): `s1join/`.
