# METR HCAST time-horizon bench — run it via taskhelper.py, not the private Inspect bridge
URL: /internal/docs/agent-insights/metr-hcast-bench-integration

The official inspect-metr-task-bridge (mtb) won't install (6 private METR PyPI deps). Drive the pre-built task images directly with the Task Standard's public taskhelper.py. Plus the human-time-baseline join and the two-arm horizon-lift framing.

The METR HCAST / time-horizon suite (`suite='metr-hcast'`, plan
`benchmark-suite-metr-hcast-2026-06-17`) measures a **50%/80%-task-completion time
horizon** — the human-expert task LENGTH at which an arm succeeds 50%/80% of the time —
and reports the **pot-vs-single-opus horizon LIFT**. Integration lives under
`packages/operator-core/lib/external-bench/metr-hcast-*` + the horizon math in
`libs/generic/bench-metrics/src/horizon.ts`.

## The load-bearing gotcha: the official Inspect bridge won't install

METR's README says to run tasks via the **Inspect Task Bridge** (`inspect-metr-task-bridge`,
the `mtb` package). **It cannot install on a public box** — its `pyproject` pins six
METR-internal packages that are not on public PyPI: `metr-task-artifacts`,
`metr-task-assets`, `metr-task-aux-vm-helpers`, `metr-task-legacy-verifier`,
`metr-task-protected-scoring`, `metr-task-standard`. `pip install` dies on
`metr-task-artifacts`. (`inspect_ai` itself installs fine.)

**Drive the task images directly with the Task Standard's own `drivers/taskhelper.py`** —
the public, dependency-free script the bridge merely wraps (vendored in
`~/.papercusp/bench-harnesses/metr/task-standard`). That is what
`dockerTaskStandardOps` (metr-hcast-live.ts) does.

### The container recipe (validated end-to-end)

Pre-built images: `registry-1.docker.io/metrevals/public-tasks:<family>-<version>`
(\~4 GB, anonymous Docker Hub pull). They ship the `TaskFamily` at `/root/<family>.py` +
the unprivileged `agent` user (uid 1000) but **NOT** `taskhelper.py` — copy it in.

```bash
docker run -d --name c --entrypoint sh "$IMG" -c 'tail -f /dev/null'
docker cp task-standard/drivers/taskhelper.py c:/root/taskhelper.py
docker exec -w /root c python taskhelper.py <FAMILY> <TASK> start    # sets up + chowns /home/agent
docker exec -w /root c python taskhelper.py <FAMILY> <TASK> setup    # → {instructions, ...}
#   ...agent works inside as `agent` user, produces a submission string...
docker exec -w /root c python taskhelper.py <FAMILY> <TASK> score -s "<submission>"   # → float
docker rm -f c
```

Output is the line `SEP_MUfKWkpuVDn9E` then a JSON result (`parseTaskhelperResult`).
`score()` returns a float (binary tasks: `0.0`/`1.0`); `resolved = score >= threshold`
(default `1.0`).

## The human-time baselines: join the open tasks to runs.jsonl

The horizon fit needs a human-time baseline per task. The open `metr/public-tasks` repo
ships **31 runnable tasks (10 families)** but the structured baselines live in
`metr/eval-analysis-public/reports/time-horizon-1-*/data/raw/runs.jsonl` (field
`human_minutes`, keyed by `task_id = <family>/<task>`). Joining the two yields only
**18 horizon-eligible tasks** (16 `baseline` + 2 `estimate`), spanning \~2–95 min — the
other 13 (clone\_game, complex\_payments, cowthello, crossword, several variants) are newer
dangerous-capability families absent from METR's released horizon dataset. The vendoring
step writes `~/.papercusp/bench-results/metr-hcast/tasks.jsonl` with `horizonEligible`.

## The math + the honest framing (don't skip)

`fitHorizon` (bench-metrics) is a faithful port of METR's reference
(`eval-analysis-public/src/horizon`): **weighted logistic regression of success on
`log2(human_minutes)`, horizon = `2^((logit(q) − intercept)/coef)`**, reg `1e-5`,
hierarchical-bootstrap CIs. The golden test reproduces METR's published Claude 3.7 Sonnet
\~50–60 min horizon (we get p50 ≈ 63 min on their data).

**The absolute horizon on \~18 short tasks is illustrative-only — NOT
leaderboard-comparable** (METR's real fit spans seconds→8 h over \~170 tasks). The
**defensible headline is the LIFT**: treatment (pot, `papercusp`) vs baseline
(single-opus, `baseline-a-ablation`) on the SAME tasks cancels much of the subset bias
(plan D-002). `buildMetrHcastReport` emits three mandatory caveats — surface them.

## Running it (host-gated)

```bash
npx tsx packages/operator-core/lib/external-bench/_xbench_metr_hcast.ts \
  --task-set metr-hcast-horizon --arms baseline-a-ablation,papercusp \
  --samples 5 --account <quiet-acct> --concurrency 2 \
  --out ~/.papercusp/bench-results/metr-hcast/run.json
```

**Gateway contention is the operational gotcha.** Each arm routes opus-4.8 through the
gateway; under concurrent benches (tau2 / agentsnet / the fleet) the shared accounts
**429 globally** — every account on both `:8788` and `:8799` returned the same synthetic
`rate_limit_error`. `gatewayModelCall` retries transient 429s and supports
`--account <id>` (the `x-papercusp-account` header) to pin a quiet account, but a clean
multi-sample run still needs a genuinely quiet opus window. The 429→`infra-failed`
fairness path (excluded from the fit, never a capability fail) is the same discipline as
the rest of external-bench.
