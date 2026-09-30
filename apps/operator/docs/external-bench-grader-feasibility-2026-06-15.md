# External-bench grader adapter — feasibility spike (BRIEF 1 / P-001)

> **Status:** feasibility findings + integration design + grader-interface spec.
> Research only, no code. Owner: su-dc09a (2026-06-14).
> Plan: `impartial-benchmark-suite-2026-06-15` (P-001). Consumed by BRIEF 3 (P-005,
> adapter), BRIEF 2 (P-019, `external-bench` blueprint), BRIEF 7/8 (P-011/P-010,
> run-result schema), BRIEF 12 (P-016, methodology doc). Gates P-014 (Harness-Bench).

## TL;DR (decisions for the wave)

1. **There are two grader MODALITIES, and the adapter must support both — they have
   fundamentally different shapes.** Pick the right one per benchmark family:
   - **(M1) Offline diff-batch grader** — *SWE-bench Pro*, classic SWE-bench, SWE-rebench,
     SWE-bench-Live. The arm produces a unified diff per task; grading is a **separate,
     arm-agnostic Docker batch** over a predictions JSON. **This is the clean, fair,
     and easiest path — start here.** Our existing plan ("spin a coding harness, extract
     the final diff") maps onto it directly.
   - **(M2) Online in-container grader** — *Terminal-Bench 2.0 / Harbor*,
     *Harness-Bench / clawbench_v2*. There is **no diff**: the agent mutates a
     benchmark-provided sandbox/container, and grading runs *in that same sandbox* after
     the agent finishes. The harness must attach to an externally-owned environment and
     route its tools into it. Bigger lift; do it second.
2. **SWE-bench Pro is GO on our infra.** Docker 29.4.0 is up on the box; the grader is a
   batch CLI (`swe_bench_pro_eval.py`) over per-instance prebuilt images
   (`jefzda/sweap-images:{dockerhub_tag}`). Main constraint is **disk** for image pulls,
   not feasibility. Generation is decoupled and runs on our normal coding-harness infra.
3. **Terminal-Bench 2.0 / Harbor is GO** — Harbor ships a first-class **custom-agent
   adapter SDK** (`BaseAgent` / `BaseInstalledAgent`, `--agent-import-path`). The
   **external `BaseAgent`** style fits Papercusp: our coding harness stays on our infra
   and routes file/bash ops into the container via `environment.exec()`.
4. **Harness-Bench is a CONDITIONAL GO** (gates P-014, see §6). The adapter interface is
   clean (`clawbench_v2` adapter class + registry + a YAML model entry + a wrapper
   command), and the local-sandbox model is light — **plugging Papercusp in is tractable.**
   BUT only **28 of the paper's 106 tasks are publicly released** and the repo has **no
   committed license** yet. → Build the adapter + **cite the methodology now** as air
   cover (no run needed); **defer a full 106-task headline run** until Scale/Qihoo
   publish the complete set + a license.

---

## 1. The normalized grader interface (the contract BRIEF 3 builds to)

The adapter (P-005) should target one internal interface with two concrete backends, so
every arm (Papercusp + Baselines A/B/C) is graded by identical machinery. Shape (TS-ish,
illustrative — BRIEF 3 owns the final types):

```ts
/** One benchmark task, normalized across families. */
interface BenchTask {
  benchmark: 'swe-bench-pro' | 'terminal-bench' | 'harness-bench' | string;
  instanceId: string;          // e.g. "instance_astropy__astropy-12345"
  repo?: string;               // M1 only: owner/name
  baseCommit?: string;         // M1 only: clone @ this SHA
  problemStatement: string;    // the work_item brief fed to the harness
  language?: string;           // multi-language (Pro is polyglot)
  // opaque grader inputs carried through to the backend:
  graderMeta: Record<string, unknown>; // dockerhub_tag, FAIL_TO_PASS, PASS_TO_PASS, test cmds…
}

/** What an arm produces. For M1 it's a diff; for M2 it's a finished sandbox handle. */
type ArmSubmission =
  | { modality: 'diff'; instanceId: string; patch: string }        // M1
  | { modality: 'in-container'; instanceId: string; envRef: string }; // M2 (env left mutated)

/** The grader-interface BRIEF 3 implements two backends for. */
interface OfficialGrader {
  family: string;
  modality: 'diff' | 'in-container';
  /** Grade a batch (M1) or a single finished env (M2). Pure w.r.t. the arm. */
  grade(submissions: ArmSubmission[]): Promise<GradeResult[]>;
}

/** Normalized grader output → feeds the shared run-result schema (see §5). */
interface GradeResult {
  instanceId: string;
  resolved: boolean;             // the headline pass/fail
  failToPass?: { test: string; passed: boolean }[];  // M1 (SWE-bench semantics)
  passToPass?: { test: string; passed: boolean }[];
  rawGraderOutput: unknown;      // the benchmark's own report JSON, stored verbatim
  graderVersion: string;         // image tag / harbor version / clawbench commit
  error?: string;                // infra failure (distinct from "not resolved")
}
```

**Why this shape:** the **generation** half is arm-specific (Papercusp spine vs single
worker vs Claude Code vs best-of-N); the **grading** half must be byte-for-byte identical
across arms or the comparison is unfair (D-004/D-005). Normalizing to `ArmSubmission` →
`OfficialGrader.grade` → `GradeResult` enforces that: BRIEF 5 (native Claude Code) and
BRIEF 6 (best-of-N) emit the **same `{modality:'diff', instanceId, patch}`** record as
Papercusp, hand it to the same `OfficialGrader`, and get a comparable `resolved`.

---

## 2. SWE-bench Pro — Modality 1 (offline diff-batch). **GO.**

**Source of truth:** repo `scaleapi/SWE-bench_Pro-os`; dataset `ScaleAI/SWE-bench_Pro`
(`split='test'`); prebuilt images `jefzda/sweap-images`; public + commercial leaderboards
(`scale.com/leaderboard/swe_bench_pro_public`, `labs.scale.com/.../swe_bench_pro_private`).

### Task format (from the HF dataset)
Per instance: `instance_id`, `repo`, `base_commit`, `problem_statement`, gold `patch`
(do not feed to the arm), `test_patch`, `FAIL_TO_PASS` / `PASS_TO_PASS` test lists,
`dockerhub_tag` (the per-instance image tag), and `language` (polyglot). BRIEF 3 must
confirm exact column names against the live dataset card — they track SWE-bench's schema.

### Generation (our side — arm-specific)
For each task: clone `repo` @ `base_commit` → instantiate a throwaway `coding` harness
(BRIEF 2's `external-bench` blueprint) → feed `problem_statement` as the work_item brief →
run to DONE under the iso-budget cap (BRIEF 7) → **extract the final unified diff**
(`git diff` of the harness worktree against `base_commit`, excluding test files the
grader supplies). Emit `{ instance_id, patch, prefix }`.

### Submission format (verbatim)
A JSON **array** of objects:
```json
[ { "instance_id": "instance_...", "patch": "diff --git ...", "prefix": "sample1" } ]
```
`prefix` distinguishes samples/seeds (use it for the ≥3-seed pass@1 protocol — one prefix
per seed). The helper `helper_code/gather_patches.py --directory <preds> --prefix <model>
--output <out>.json` assembles `.pred` files into this array; BRIEF 3 can emit the array
directly and skip the helper.

### Grading (the official harness — arm-agnostic batch)
```bash
python swe_bench_pro_eval.py \
    --raw_sample_path=swe_bench_pro_full.csv \
    --patch_path=<patches>.json \
    --output_dir=<out> \
    --scripts_dir=run_scripts \
    --num_workers=100 \
    --dockerhub_username=jefzda
```
Per instance it pulls `jefzda/sweap-images:{dockerhub_tag}`, applies the patch (git apply
→ git apply --reject → patch fallbacks, classic SWE-bench), runs the repo's tests via
`run_scripts/`, and reports **resolved** on the inherited SWE-bench rule: **all
`FAIL_TO_PASS` tests pass AND all `PASS_TO_PASS` tests still pass.** ⚠ Image note: "Bash
runs by default in our images; do not manually invoke bash." → drive grading **only**
through `swe_bench_pro_eval.py`, never by `docker exec bash` into a sweap image.

### Infra / cost on our box
- **Docker:** present (29.4.0). ✅
- **Disk is the real constraint:** per-instance images are GB-scale; a 50-task pilot ×
  (no need to re-pull per seed — grading is per *unique* `instance_id`+`patch`) pulls ~50
  images. Recommend: a scratch volume, `--num_workers` tuned to the box, and prune images
  between families. Do **grading on a dedicated host/volume**, not inline with the fleet
  dev box, to avoid evicting the shared checkout's disk.
- **Generation cost** = `tasks × seeds × arms × per-task token budget` — counted by
  BRIEF 7; grading itself is ~free (CPU/disk, no model calls).
- **Decoupling win:** grading is a pure function of the predictions JSON, so it can run
  long after generation, be re-run, and is identical for every arm.

---

## 3. Terminal-Bench 2.0 / Harbor — Modality 2 (online in-container). **GO.**

**Source of truth:** framework `harbor-framework/harbor` (`uv`-based), dataset
`harborframework/terminal-bench-2.0` (89 hand-audited Docker tasks), docs at
`harborframework.com/docs/agents` + `/docs/datasets/adapters`; concrete custom-agent
example `badlogic/pi-terminal-bench`.

### Task format
Each task = an instruction + a **Dockerfile/image** + a set of tests + an oracle solution
+ a time limit. There is **no diff** — the agent works inside the container; the verifier
runs the tests in-container afterward.

### Adapter interface (verbatim from the docs)
Two styles; **for Papercusp use the external `BaseAgent`:**
- `BaseAgent` (external): `name() -> str`, `version() -> str | None`,
  `setup(environment: BaseEnvironment) -> None`,
  `run(instruction: str, environment: BaseEnvironment, context: AgentContext) -> None`.
  The agent runs **outside** the container and drives it through `BaseEnvironment`
  (bash via `environment.exec(...)`; file transfer via docker cp / upload helpers).
- `BaseInstalledAgent` (installed): `install(environment)` (using `exec_as_root` /
  `exec_as_agent`), a `@with_prompt_template`-decorated `run(...)`, and
  `populate_context_post_run(context)` (parses trajectory files). The agent is installed
  **into** the container and run headless.

Register + run a custom agent without forking Harbor:
```bash
harbor run -d "terminal-bench@2.0" --agent-import-path papercusp_harbor:PapercuspAgent
# sanity check the harness end-to-end first:
uv run harbor run --dataset terminal-bench@2.0 --agent oracle --n-concurrent 4
```

### Papercusp integration design (the lift)
Implement `PapercuspAgent(BaseAgent)`. `run(instruction, environment, context)`:
1. Start a throwaway `coding` harness (BRIEF 2 blueprint) with `instruction` as the
   work_item brief, **but** swap the harness's worker tool implementations
   (read/edit/bash/test-exec) for **shims that proxy to `environment.exec(...)`** so all
   filesystem/command effects land in the Harbor container, not our box. (This is the one
   genuinely new piece for M2 — a tool-routing seam in the coding harness.)
2. Run to DONE under iso-budget.
3. Populate `context` with token/cost/turns/trajectory → Harbor records it; the verifier
   then grades the container. The `pi-terminal-bench` example confirms this external,
   `environment.exec`/docker-cp-routed pattern with in-container test grading and
   Harbor-recorded cost/trajectory.

`GradeResult.resolved` = Harbor's pass/fail; `rawGraderOutput` = the Harbor result JSON;
`graderVersion` = `terminal-bench@2.0` + harbor version. No `FAIL_TO_PASS`/`PASS_TO_PASS`
split (it's all-or-nothing per task).

### Note for the baselines
Harbor **already ships adapters for Claude Code, Codex CLI, OpenHands, Mini-SWE-Agent,
Terminus 2.** → **Baseline B (native Claude Code, BRIEF 5) on Terminal-Bench is nearly
free**: use Harbor's built-in `--agent claude-code`. This is a strong reason to make
Terminal-Bench the second family after SWE-bench Pro.

---

## 4. Harness-Bench / clawbench_v2 — Modality 2-ish (local sandbox). **CONDITIONAL GO** (see §6)

**Source of truth:** repo `Qihoo360/harness-bench`, internal package `clawbench_v2`.

### Adapter interface (verbatim from the README)
> To add a new framework: (1) implement a new adapter class in
> `src/clawbench_v2/adapters/`; (2) export it in `src/clawbench_v2/adapters/__init__.py`;
> (3) register it in `src/clawbench_v2/registry.py`; (4) add a model entry to
> `config/models.example.yaml`; (5) provide any wrapper scripts or local config files.

A model entry has `adapter`, `command`, `user_config`, `session_prefix`, `timeout_sec`
(+ adapter-specific fields). Run:
```bash
PYTHONPATH=src python3 -m clawbench_v2.cli run-task --task 01-file --model papercusp --mode <mode>
```
Execution: fresh **local sandbox** under `work_root` → fixtures copied → prompts rendered
→ hooks → **adapter invoked** → per-task `oracle_grade.py` grades the workspace artifacts
→ usage tracked → process rubric applied. **No Docker required** — lighter than M1/Harbor.

### Papercusp integration design
The `command`-style adapter is a **clean fit**: provide a wrapper script that boots a
throwaway `coding` harness pointed at the sandbox `work_root` (its bash/edit tools operate
directly on that dir — no container routing needed, unlike Harbor). `oracle_grade.py`
yields `resolved`; `rawGraderOutput` = the grader's output + the process rubric.

### The blocker (→ §6 go/no-go)
- **Partial release:** README ships **28 tasks** in `tasks/`; the paper claims **106
  across 8 categories**. The public set is a subset.
- **No license:** README literally says *"Add your preferred license and release policy
  here before external publication."* We cannot redistribute results/cite a "full
  Harness-Bench run" as impartial third-party air cover under those terms yet.

---

## 5. What the official graders contribute to the shared run-result schema (for BRIEF 7/8)

Handing these fields to P-011 (4ac61) + P-010 (66ad9) as the **grader-emitted slice** of
the per-task run-result row. Everything else (tokens in/out, $, wall-clock, turns, seed,
arm id, trajectory ref) is theirs; these come from the grader:

| field | source | notes |
|---|---|---|
| `resolved: boolean` | all graders | the headline. M1: FAIL_TO_PASS∧PASS_TO_PASS rule; M2: verifier pass/fail |
| `failToPass[] / passToPass[]` | M1 (SWE-bench Pro) | per-test; null for M2 |
| `rawGraderOutput` | all graders | the benchmark's own report JSON, **stored verbatim** (reproducibility — Rollout Cards) |
| `graderFamily` + `graderVersion` | all graders | image tag / `terminal-bench@2.0`+harbor ver / clawbench commit — pin exactly (pre-registration, P-010) |
| `graderError` | all graders | infra failure (image pull fail, timeout) — **distinct from "not resolved"**; excluded from accuracy, surfaced in reproducibility records |
| `submission` | M1: the `patch` diff | store the exact diff graded, per seed (`prefix`) |

**Fairness invariant to encode:** the same `OfficialGrader` instance + `graderVersion`
grades all arms for a given task/seed. BRIEF 7's iso-budget cap belongs on the
*generation* side; grading is uncapped and identical.

---

## 6. Go/no-go: Harness-Bench run-through (gates P-014)

**Verdict: CONDITIONAL GO — build the adapter, cite the methodology now, defer the full
headline run.**

- ✅ **Tractable.** The `clawbench_v2` adapter contract is clean and the local-sandbox
  (no-Docker) model is the *lightest* of the three. The `command`/wrapper-script adapter
  shape is the **same integration pattern** as our SWE-bench-Pro generation arm and the
  Harbor `BaseAgent`, so the work amortizes.
- ⚠️ **Not yet citable as a *full* impartial result.** 28/106 tasks public + no license =
  we cannot claim "we ran Harness-Bench" as third-party air cover today.
- **Recommendation (for the owner / BRIEF 12 methodology doc):**
  1. **Cite Harness-Bench's *methodology + findings* immediately** as air cover for our
     whole approach (this needs no run — the plan already calls for it, D-003/§suite).
  2. **Build the `clawbench_v2` Papercusp adapter** opportunistically (low marginal cost;
     validates the shared command-style integration seam).
  3. **Run the released 28-task subset** as an internal methodology cross-check, clearly
     labeled **partial / unaudited license**.
  4. **Defer the full 106-task headline run (P-014)** until Qihoo/Scale publish the
     complete set + a redistribution license. Re-evaluate then.
- **Net:** P-014 stays `blocked`/scoped-down — un-gate it for the 28-task cross-check, but
  the *headline* third-party run waits on upstream release. SWE-bench Pro (§2) +
  Terminal-Bench (§3) carry the pilot (P-009); Harness-Bench is methodology citation now.

---

## 7. Recommended build order for the wave

1. **SWE-bench Pro (M1)** — clean diff-batch, fully released, fairest comparison, all four
   arms reduce to the same predictions JSON. **This is the pilot's backbone (P-009).**
2. **Terminal-Bench 2.0 / Harbor (M2)** — Harbor's adapter SDK + built-in Claude Code
   adapter make Baseline B nearly free; needs the tool-routing seam in the coding harness.
3. **Harness-Bench (M2-local)** — adapter is cheap; gated to a 28-task cross-check + a
   methodology citation (§6).

**Hand-offs:** BRIEF 3 (P-005) builds the §1 `OfficialGrader` with the §2 backend first.
BRIEF 2 (P-019) blueprint feeds tasks as work_items per §2/§3 generation. BRIEF 5/6
(Baselines B/C) emit the §1 `{modality:'diff', instanceId, patch}` record. BRIEF 7/8 take
the §5 grader fields into the run-result schema.

## References
- `scaleapi/SWE-bench_Pro-os`; `ScaleAI/SWE-bench_Pro` (HF, `split='test'`);
  `jefzda/sweap-images`; leaderboards public/private (scale.com).
- `harbor-framework/harbor`; `harborframework.com/docs/agents`,`/docs/datasets/adapters`;
  `harborframework/terminal-bench-2.0` (HF); example `badlogic/pi-terminal-bench`.
- `Qihoo360/harness-bench` (`clawbench_v2`); arXiv 2605.27922; harness-bench.ai (106 tasks
  / 8 categories; 28 released, license TBD).
- SWE-bench grading semantics (FAIL_TO_PASS / PASS_TO_PASS): swebench.com harness reference.
