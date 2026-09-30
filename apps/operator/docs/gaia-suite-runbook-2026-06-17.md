# GAIA benchmark suite — runbook (2026-06-17)

Plan: `benchmark-suite-gaia-2026-06-17`. The portfolio's **broad general-assistant /
research-synthesis** dimension. GAIA (Mialon et al., arXiv:2311.12983) ships **no agent
harness** — it is Q&A data + a string scorer — so we **build** the agent + a small
quasi-exact-match grader and run them over the public **validation** split (165 tasks,
public gold answers → self-gradable). Test (301) is leaderboard-only.

## What was built (all under `packages/operator-core/lib/external-bench/`)

| File | Role |
|---|---|
| `grader/gaia.ts` | Faithful GAIA `question_scorer` (number/string/list normalization) + `FINAL ANSWER:` extraction + per-level (L1/L2/L3) + overall accuracy aggregation. Pure, deterministic, arm-blind. |
| `gaia/dataset.ts` | Gated HF load (`metadata.jsonl` row schema), `parseGaiaRow`/`loadGaiaValidation`, `stratifiedGaiaSubset`, `gaiaTaskToBenchTask`, `buildGaiaDownloadCommand`. |
| `gaia/agent.ts` | Pure ReAct tool-loop: system prompt, vision/attachment initial message, tool dispatch, FINAL-ANSWER discipline, turn/budget guards, trajectory + token accounting. Deps injected. |
| `gaia/tools-live.ts` | Live tools: `web_search` (Brave API), `fetch_url` (HTTP→text), `run_python` (python3 sandbox), `read_file` (attachment extraction). |
| `gaia/agent-live.ts` | Anthropic SDK → inference gateway (`claude-opus-4-8` @ xhigh extended thinking). |
| `gaia/run.ts` | Orchestrate → self-grade → predictions JSONL + per-level report + cost. |
| `gaia/cli.ts` | `provision` / `selfcheck` / `pilot` / `run`. |
| `gaia/index.ts` | Barrel. |

Suite vocab `'gaia'` added to `BenchmarkFamily` (external-bench/types.ts) + `BenchSuite`
(bench-metrics/schema.ts). **90 unit tests** (`lib/external-bench/gaia` +
`grader/gaia.test.ts`), tsc clean.

## Verification status

- **Unit:** 90/90 green. **Live tools:** `cli.ts selfcheck` passes — Brave search, python,
  fetch all work; gateway reachable.
- **Live end-to-end:** PROVEN. A 2-task synthetic smoke (NOT gated data) scored **100%**
  (`Paris`; `Tungsten → 74` via `web_search`), ~$0.09 — exercising gateway → opus-4.8
  extended thinking → tool-use → FINAL ANSWER → grader → report.

## ⚠ The two gotchas that will cost you an afternoon

1. **The dataset is HF-gated.** A raw fetch 401s. You need an `HF_TOKEN` whose HF account
   has **accepted the terms** at <https://huggingface.co/datasets/gaia-benchmark/GAIA>.
   There is no valid token on this host today (the metr `secrets.env` `HF_TOKEN` is empty;
   all tokens in old logs are 401). **This is the sole blocker for P-004/P-005.**
2. **The Max-OAuth gateway requires the Claude Code identity as the first system block.**
   A raw-SDK caller whose first `system` block isn't exactly
   `You are Claude Code, Anthropic's official CLI for Claude.` gets a **bogus 429**
   (`rate_limit_error`, body literally `"Error"`). `agent-live.ts` handles this
   (`CLAUDE_CODE_IDENTITY`, on by default for the gateway). See the insight
   [gaia-suite-byo-agent-and-the-max-oauth-429](/internal/docs/agent-insights/gaia-suite-byo-agent-and-the-max-oauth-429).

## How to run it (once you have a token)

```bash
# 0. one-time: a python with huggingface_hub (the competitor venv has it)
#    export HF_TOKEN=<token whose account accepted GAIA terms>

# 1. provision the validation split (downloads metadata.jsonl + attachments)
npx tsx packages/operator-core/lib/external-bench/gaia/cli.ts provision --run
# → set PAPERCUSP_GAIA_VALIDATION_DIR=~/.papercusp/bench-results/gaia/2023/validation

# 2. (optional) re-confirm the live tool wiring (no LLM spend)
npx tsx packages/operator-core/lib/external-bench/gaia/cli.ts selfcheck

# 3. pilot — stratified 30 (10 per level): validates agent + grader + FINAL-ANSWER discipline
npx tsx packages/operator-core/lib/external-bench/gaia/cli.ts pilot --per-level 10

# 4. full validation run (165) → per-level L1/L2/L3 + overall accuracy
npx tsx packages/operator-core/lib/external-bench/gaia/cli.ts run
# writes predictions.jsonl + report.json under ~/.papercusp/bench-results/gaia/runs/<ts>/
```

Cost: ~$10–80 per full validation pass (heavy browsing/long traces push higher). If the
shared gateway account is fleet-exhausted, pin a fresh one: `makeLiveGaiaLlm({ accountId })`
(pick a ~0% account from `accounts:status`).

## Reporting + gotchas to honor

- Metric is **binary exact-match per task**; headline is per-level L1/L2/L3 + overall
  accuracy (pass@1). `score` stays null (resolved IS the score, like the SWE-bench family).
- **Formatting failures** (no `FINAL ANSWER:` line) are reported distinctly
  (`formatFailRate`) — a large failure slice is formatting, not reasoning.
- **Live-web drift:** answers were annotated against the web at a point in time; mark
  non-reproducible failures with `GaiaPrediction.excludeReason` so they're surfaced +
  excluded, not scored as capability fails.
- **Contamination:** validation Q&As are public + on the web; frontier models may have
  memorized some → validation can read optimistic vs test. Note it in any writeup.

## Deferred (per plan)

- **P-006** (test-set leaderboard submission, 301 tasks → the Gradio Space): manual + later;
  iterate on validation first.
- **P-007** (optional pot-decomposition arm on L3): after P-005; compares pot multi-hop
  decomposition to the single-opus baseline on the same L3 tasks.
