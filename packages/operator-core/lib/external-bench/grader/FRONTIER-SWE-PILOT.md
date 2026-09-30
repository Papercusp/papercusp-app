# FrontierSWE grader — pilot runbook (plan benchmark-suite-frontier-swe-2026-06-18)

Operational "how to actually run it + what it costs" for the **FrontierSWE** suite
(`frontier-swe.ts` + `frontier-swe-live.ts` + the `task-sets.ts` loaders). Methodology
narrative: `apps/operator-docs/.../benchmarks/frontier-swe.mdx`. **Confirmed against the
real vendored repo `Proximal-Labs/frontier-swe` on 2026-06-18.**

> ⚠ The full ≥5-trial / 17-task / multi-topology run is **owner-gated** (compute + `$` +
> wall-clock: 4–20 h agent/trial). This runbook makes it one-command-ready and documents a
> bounded one-task smoke; the headline run stays a deliberate owner action (D-004).

## What was confirmed against the real harness

Every task is a self-contained Docker env with a uniform contract:

- `tasks/<task>/task.toml` — `[metadata]` (category, difficulty, tags), `[agent].timeout_sec`
  (4–20 h), `[verifier].timeout_sec`, `[environment]` (`docker_image` = `ghcr.io/proximal-labs/
  frontier-swe/<task>:vN`, cpus/memory_mb/storage_mb, **gpus + gpu_types**, allow_internet).
- `tasks/<task>/instruction.md` — the agent brief (workspace layout + build/test commands).
- `tasks/<task>/tests/test.sh` — the **verifier entrypoint**; runs `compute_reward.py` →
  writes **`/logs/verifier/reward.txt`** (the bare `[0,1]` scalar — the uniform primary) +
  **`/logs/verifier/reward.json`** (structured per-task breakdown). `HARBOR_ORACLE_MODE=1`
  skips anti-cheat (the gold/oracle path).
- `tasks/<task>/solution/solve.sh` — the **gold** reference (the C9 positive control). **6
  tasks ship no solution** (`frogsgame-rl`, `lua-native-compiler`, `modular-stack-wan21`,
  `notebook-compression`, `postgres-sqlite-wire-adapter`, `pyright-type-checking-optimization`).
- `tasks/<task>/oracle.yaml` / `job.yaml` — the Harbor run configs (the `job.yaml` `agents:`
  list IS the public competitor pool: opus-4-6, gpt-5.4, gemini-3.1-pro, qwen, kimi, glm-5).

Our TS grader reads **`reward.txt`** (falls back to `reward.json` `reward`/`score`). A
present-and-numeric reward (incl. `0`) is SCORED; an absent reward is a `graderError`.

## Prerequisites (provision on a dedicated grading volume, NOT the shared dev box)

1. **Docker** (daemon up). 5 tasks additionally need a **datacenter GPU** (see the table).
2. **The vendored repo** — `git clone --depth 1 https://github.com/Proximal-Labs/frontier-swe
   ~/.papercusp/bench-harnesses/frontier-swe` (~1.3 GB; **no LICENSE** → research/eval only,
   D-005). Set `PAPERCUSP_FRONTIER_SWE_DIR` to it.
3. **ghcr access** to pull `ghcr.io/proximal-labs/frontier-swe/<task>:vN` (GB-scale images).
4. **The corpus JSONL** (the ingest below).

## Ingest the corpus (P-001) — reproducible

Builds `~/.papercusp/bench-results/frontier-swe/tasks.jsonl` (17 rows) from the vendored
`task.toml` + `instruction.md`. Re-run after re-vendoring:

```bash
python3 - <<'PY'
import tomllib, json, os, pathlib, collections
root = pathlib.Path(os.path.expanduser("~/.papercusp/bench-harnesses/frontier-swe/tasks"))
out = pathlib.Path(os.path.expanduser("~/.papercusp/bench-results/frontier-swe")); out.mkdir(parents=True, exist_ok=True)
def bucket(c,tags):
    c=(c or "").lower(); t=" ".join(tags or []).lower()
    if c in ("ml-research","rl-post-training"): return "research"
    if any(x in c for x in ("optim","simd","performance")) or c=="systems-research" or any(x in t for x in ("performance","optimization","compression")): return "performance"
    return "implementation"
rows=[]
for d in sorted(root.iterdir()):
    if not (d/"task.toml").exists(): continue
    cfg=tomllib.loads((d/"task.toml").read_text())
    md=cfg.get("metadata",{}); env=cfg.get("environment",{}); ag=cfg.get("agent",{}); vf=cfg.get("verifier",{})
    prompt=(d/"instruction.md").read_text() if (d/"instruction.md").exists() else ""
    rows.append({"instanceId":d.name,"category":md.get("category"),"tier":bucket(md.get("category"),md.get("tags")),
      "difficulty":md.get("difficulty"),"tags":md.get("tags",[]),"prompt":prompt,"dockerImage":env.get("docker_image"),
      "agentTimeoutSec":ag.get("timeout_sec"),"verifierTimeoutSec":vf.get("timeout_sec"),"cpus":env.get("cpus"),
      "memoryMb":env.get("memory_mb"),"storageMb":env.get("storage_mb"),"gpus":env.get("gpus",0),"gpuTypes":env.get("gpu_types",[]),
      "allowInternet":env.get("allow_internet",False),"verifierCmd":"bash /tests/test.sh","rewardPath":"/logs/verifier/reward.txt",
      "rewardJsonPath":"/logs/verifier/reward.json","solutionCmd":"bash /solution/solve.sh" if (d/"solution"/"solve.sh").exists() else None,
      "hasOracle":(d/"oracle.yaml").exists()})
(out/"tasks.jsonl").write_text("".join(json.dumps(r)+"\n" for r in rows))
print("wrote",len(rows),"rows; tiers:",dict(collections.Counter(r["tier"] for r in rows)))
PY
```

## Preflight (no spend)

```ts
import { preflightFrontierSwe, describeFrontierSweRun } from './grader/frontier-swe-live';
const pf = await preflightFrontierSwe({ repoDir: process.env.PAPERCUSP_FRONTIER_SWE_DIR });
// → { ready, docker, repo, corpus, issues[] }  (never pulls an image / runs a task)
console.log(describeFrontierSweRun('<container>'));
```

## Bounded smoke — the gold/empty controls (P-003)

> ✅ **VALIDATED 2026-06-18 on `libexpat-to-x86asm`** (no LLM): gold (oracle solution) → `reward.txt = 0.98511`
> (correctness 1.0 + performance 0.9702, weights 0.5/0.5); empty (unsolved) → `0.0` ("No .so found"). This
> confirms ghcr access, the seam clone→grade path, the `reward.txt`→[0,1] read-back, the `reward.json`
> schema, and the perf-task formula. **The seam stages `tests/` (and `solution/` in oracle mode) into the
> container at GRADE time from `PAPERCUSP_FRONTIER_SWE_DIR`** — the image bakes only `/app`, so that env MUST
> be set for a live run.

Run ONE cheap CPU task end-to-end before any batch. Pick from `frontier-swe-cpu`.

```bash
img=ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6
cid=$(docker run -d "$img" sleep infinity)
# (1) GOLD / positive control — run the reference solution then the verifier in oracle mode:
docker exec -e HARBOR_ORACLE_MODE=1 "$cid" bash -lc 'bash /solution/solve.sh && bash /tests/test.sh'
docker exec "$cid" cat /logs/verifier/reward.txt    # expect a HIGH reward (~1.0)
# (2) EMPTY / negative control — fresh container, verifier only, no agent work:
cid2=$(docker run -d "$img" sleep infinity)
docker exec "$cid2" bash -lc 'bash /tests/test.sh'
docker exec "$cid2" cat /logs/verifier/reward.txt   # expect ~0
docker rm -f "$cid" "$cid2"
```

The TS path: `buildLiveFrontierSweGrader().grade([{modality:'in-container', instanceId, envRef: cid, prefix:'seed-0'}], tasks)`
→ runs `test.sh` → reads `reward.txt` → `GradeResult{ score }` → the run-result row.

## Per-task envelope (from the corpus)

| task | bucket | gpu | agent h | mem GB | gold? |
|---|---|---|---|---|---|
| cranelift-codegen-opt | performance | — | 20 | 128 | ✅ |
| dart-style-haskell | implementation | — | 20 | 8 | ✅ |
| dependent-type-checker | implementation | — | 20 | 32 | ✅ |
| ffmpeg-swscale-rewrite | performance | — | 8 | 64 | ✅ |
| frogsgame-rl | research | — (Tinker API) | 8 | 64 | — |
| git-to-zig | implementation | — | 20 | 16 | ✅ |
| granite-mamba2-inference-optimization | performance | **B200** | 20 | 64 | ✅ |
| inference-system-optimization | performance | **B200** | 4 | 128 | ✅ |
| libexpat-to-x86asm | implementation | — | 20 | 8 | ✅ |
| lua-native-compiler | implementation | — | 8 | 32 | — |
| modular-stack-wan21 | implementation | **H100** | 4 | 128 | — |
| notebook-compression | performance | — | 8 | 32 | — |
| optimizer-design | research | **H100** | 20 | 128 | ✅ |
| pcqm4mv2-autoresearch | research | **H100** | 20 | 128 | ✅ |
| postgres-sqlite-wire-adapter | implementation | — | 8 | 32 | — |
| pyright-type-checking-optimization | performance | — | 20 | 32 | — |
| revideo-perf-opt | performance | — | 20 | 32 | ✅ |

`frontier-swe-cpu` = the 12 GPU-free tasks. The 5 GPU tasks need B200/H100.

## Env vars

- `PAPERCUSP_FRONTIER_SWE_VERSION` — the grader version pin (repo commit / image-set tag). **Required.**
- `PAPERCUSP_FRONTIER_SWE_DIR` — the vendored checkout (preflight + gold control + ingest).
- `PAPERCUSP_BENCH_FRONTIER_SWE_JSONL` — override the corpus path.
- `TINKER_API_KEY` — only for `frogsgame-rl`.

## Running the topology arms (code path)

Once a dedicated volume + ghcr auth + compute are available, the arms run through the shared topology driver —
no bespoke launcher. Wire the FrontierSWE in-container runAgent (drives opus inside the task container) + the
self-healing resume:

```ts
import { makeFrontierSweRunAgent } from '../frontier-swe-runagent';   // adapts metr-hcast singleOpusDriveArm
import { runFrontierSweResilient } from '../frontier-swe-arm';
import { resolveCoordinationSpec } from '../coordination-topology';
// live bindings (metr-hcast-live.ts): the :8788-gateway model call + docker exec
const runAgent = makeFrontierSweRunAgent({ modelCall: liveGatewayModelCall, exec: liveDockerExec });

await runFrontierSweResilient({
  spec: resolveCoordinationSpec(blueprint),  // su-independent (no-coord) | pot (central) | dist-broadcast/-peer-review/-blackboard (distributed) | (ensemble/pair)
  taskSetId: 'frontier-swe-cpu',             // 12 GPU-free tasks; the 5 GPU tasks need B200/H100
  k: 5,                                      // 5 trials → mean@5 / best@5
  resultsPath: '<dedicated-volume>/frontier-swe/runs/<arm>.jsonl',  // durable; re-invoke to resume only missing (task,seed)
  runAgent,
  budget: { maxModelCalls: N, maxWallMs: M },  // iso-budget — wall-clock is load-bearing (4–20h/task)
  rowMeta: { version, modelId: 'claude-opus-4-8', harnessVersion, preregHash, rolloutId },
});
// rows → buildFrontierSweSuiteData(rows) (mean@5/best@5/avgRank/dominance) + buildFairnessAudit (the C1–C10 table).
```

Run ≥2 arms (e.g. `su-independent` vs `pot`) over the same tasks + same iso-budget for the topology lift (D-002).
Interrupted? Re-run the same call — only missing trials re-execute.

**Workspace isolation (mandatory — plan benchmark-workspace-isolation-2026-06-18):** the launcher MUST resolve any
run/telemetry workspace via `resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID)` (`bench-workspace.ts`) —
default `'benchmarks'`, NEVER the production `'papercusp-workspace'` (the guard throws on prod). FrontierSWE's
in-container agents are sandboxed (bash+submit only) so they don't reach host memory/coord/work-items, but the
launcher must still isolate the run-store/telemetry workspace as defense-in-depth.

## Discipline

- **Two-port model** — the bench routes `PAPERCUSP_OPERATOR_BASE=:3170` (staging) + the
  `:8788` gateway; **never probe `:3070`** (green release).
- **Fairness** — every number ships with the **C1–C10 audit** (`buildFairnessAudit`); see
  `benchmarks/fairness-criteria`. Iso-budget includes **wall-clock** here.
- **Reliability** — long big-repo trials are the worst case for slow-but-alive
  heartbeat-reclaim; the liveness fix shipped (F-FIX-038 / EI-1293). If cups stall at `$0`,
  check `harness_shared.agent_rate_budget` for a far-future `paused_until` (governor
  false-pause runbook: `agent-insights/rate-limit-is-usually-account-routing-not-capacity`).
- **License (D-005)** — no redistribution of derived data without owner sign-off.
