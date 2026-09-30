# SWE-bench Pro grader — pilot runbook (P-009)

Operational detail for the **M1 SWE-bench Pro** grader (`swe-bench-pro.ts` + `swe-bench-pro-live.ts`).
The methodology/reproducer narrative is P-016 (`apps/operator-docs/.../benchmarks/`); this is the
grader-binding "how to actually run it + what it costs" — **confirmed against the real harness on 2026-06-15.**

> ⚠ The full ≥3-seed / ~50-task run is **owner-gated** (disk + budget). This runbook gets it
> one-command-ready and documents a bounded smoke; the headline run stays a deliberate owner action.

## What was confirmed against the real harness (`scaleapi/SWE-bench_Pro-os`)

A bounded live smoke (Docker 29.4.0, `--use_local_docker`, gold patch, 1 task) validated the whole path:
deps install → invoke → **Docker Hub image pull (`jefzda/sweap-images:<tag>`, ~2 GB)** → container test
run (~20–60 s/task) → verdict file → our TS grader parse. Two **bugs in the initial P-005 grader were
found + fixed** by this confirmation:

1. **Output is `<output_dir>/eval_results.json` = `{ "<instance_id>": resolvedBool }`** — a single
   aggregate map, **not** a `report.json`. (`resolved` = `(FAIL_TO_PASS ∪ PASS_TO_PASS) ⊆ passed_tests`,
   computed by the harness from the CSV.) The grader now reads `eval_results.json`.
2. **Local grading needs `--use_local_docker`** — the eval defaults to **Modal (cloud)**. Without the
   flag it targets Modal and never touches local Docker. The grader passes it by default
   (`SweBenchProGraderConfig.useLocalDocker`, default `true`).

## Prerequisites (the pilot host provisions these — a dedicated volume, NOT the fleet dev box)

1. **Docker** (29.4.0 present on the box; daemon up).
2. **The eval harness checkout** — `git clone https://github.com/scaleapi/SWE-bench_Pro-os` (MIT). Has
   `swe_bench_pro_eval.py` + `run_scripts/<instance_id>/` (1000 instances) + `helper_code/`.
3. **Python deps** — `pandas tqdm datasets modal docker huggingface_hub` (`requirements.txt`). Install
   with `uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt`. (`modal` is
   imported at module load even for local Docker.)
4. **The raw sample CSV** — `swe_bench_pro_full.csv` (the `ScaleAI/SWE-bench_Pro` `split='test'` export).
   **Use the canonical CSV** — see the F2P/P2P encoding gotcha below; do NOT hand-build the sample.

## The exact command (what `makeSweBenchProGrader` runs)

```bash
cd <SWE-bench_Pro-os checkout>
python swe_bench_pro_eval.py \
  --raw_sample_path=swe_bench_pro_full.csv \
  --patch_path=<predictions>.json \
  --output_dir=<out> \
  --scripts_dir=run_scripts \
  --num_workers=<N> \
  --dockerhub_username=jefzda \
  --use_local_docker
# verdict → <out>/eval_results.json   { "<instance_id>": resolvedBool }
```

- **Predictions JSON** (confirmed): `[{ "instance_id": "...", "patch": "diff…", "prefix": "seed-<n>" }]`
  — exactly what the grader writes from `ArmSubmission`s.
- **One eval run per seed/prefix.** `eval_results.json` is keyed by `instance_id` only, so a multi-seed
  batch in one invocation would have the last prefix overwrite. Run the ≥3 seeds as separate
  invocations (separate `--output_dir`), one predictions file per seed.

## Live binding + preflight (code)

- `buildLiveSweBenchProGrader(cfg?)` — the live `OfficialGrader` (shell-free `execFile` + real fs). `cfg`
  defaults to `resolveSweBenchProConfigFromEnv()`, reading:
  `PAPERCUSP_SWEBENCH_EVAL_DIR` · `PAPERCUSP_SWEBENCH_CSV` · `PAPERCUSP_SWEBENCH_VERSION` (pin: image-set
  tag / repo commit) · `PAPERCUSP_SWEBENCH_DOCKERHUB_USER` (def `jefzda`) · `PAPERCUSP_SWEBENCH_NUM_WORKERS`.
- `preflightSweBenchPro(cfg)` — checks Docker reachable + the checkout + the CSV **without pulling any
  image**; returns `{ ready, issues[] }`. Run it before a pilot to surface provisioning gaps.

## Disk + cost

- **Per-instance images are ~2 GB** (`jefzda/sweap-images:<repo>-<instance>`). A ~50-task pilot pulls
  ~50 images = **~100 GB**. The box had **~377 GB free** at smoke time — enough, but:
  - Grade on a **dedicated volume**, not inline with the shared `papercup` checkout (disk-eviction risk).
  - **Prune between families** (`docker image prune` / remove `jefzda/sweap-images:*`).
  - `--num_workers` tuned to the host; container test runs are ~20–60 s each (parallelizable).
- Grading itself is ~free (CPU/disk; no model calls). Generation cost is BRIEF 7's number.

## Gotcha — F2P/P2P encoding (why a hand-built sample mis-grades)

The harness does `f2p = set(eval(raw_sample["fail_to_pass"]))` — it expects `fail_to_pass` / `pass_to_pass`
as **string-encoded Python lists** (the canonical CSV form, e.g. `"['t1', 't2']"`), not native JSON
arrays. A hand-built JSONL with native arrays throws `eval() arg 1 must be a string`; and `repr([])` for an
**empty** P2P round-trips through pandas to the bogus set `{'[', ']'}` → a spurious `resolved=false`. The
bounded smoke hit exactly this (the gold-patch test PASSED with an exact name match, but the empty-P2P
encoding poisoned the required set). **→ Use the canonical `swe_bench_pro_full.csv`; don't synthesize the
sample.** Our TS grader is unaffected — it only reads `eval_results.json`.

## Bounded smoke — VALIDATED end-to-end (2026-06-15)

A bounded smoke ran the full per-task pipeline on a live task
(`instance_ansible__ansible-11c1777d…`, 1 seed, `--use_local_docker`, ~2 GB cached image):

| step | result |
|---|---|
| grader — gold patch (positive control) | `resolved=true` ✅ |
| grader — empty patch (negative control) | `resolved=false` ✅ |
| **native arm** (`claude` CLI on the real issue) → diff → grader | **`resolved=true`** ✅ (solved it) |

### Grader control (gold/empty)
```bash
# CSV with str-encoded F2P/P2P (NOT a native-array JSONL — see the gotcha above)
python swe_bench_pro_eval.py --raw_sample_path=sample.csv \
  --patch_path=gold.json --output_dir=out --scripts_dir=run_scripts \
  --num_workers=1 --dockerhub_username=jefzda --use_local_docker
cat out/eval_results.json    # → { "<instance_id>": true }
```

### Native-arm per-task smoke (no GitHub clone — extract the repo from the cached image)
```bash
cid=$(docker create jefzda/sweap-images:<tag>); docker cp "$cid:/app" repo; docker rm "$cid"  # repo @ base_commit
cd repo && claude -p "<problem_statement> — implement under lib/, touch NO test files" --dangerously-skip-permissions
git add -A && git diff --cached <base_commit> -- . ':(exclude)test/*' > arm_patch.diff               # = extractDiff
# → predictions [{instance_id, patch:<arm_patch.diff>, prefix:"seed-0"}] → swe_bench_pro_eval.py → eval_results.json
```

The TS path is `buildLiveSweBenchProGrader().grade([{modality:'diff',instanceId,patch,prefix}], tasks)`
→ reads `eval_results.json` → `GradeResult{ resolved }` → `emitFromAttempt` → run-result row. The grader
applies the model patch then `git checkout <fix_commit> -- <test_file>` to add the hidden F2P test (so the
arm's diff must NOT include test files — `extractDiff` excludes them).
