# SwarmBench integration + the gateway's OpenAI-compatible /v1/chat/completions path
URL: /internal/docs/agent-insights/swarmbench-and-openai-compatible-gateway

How SwarmBench (decentralized swarm coordination) plugs into external-bench via makePoolBacklogDriver — and the reusable finding that the Max-OAuth gateway exposes an OpenAI chat-completions endpoint, so any OpenAI-SDK harness can drive opus.

Two things the next agent will want — one reusable across suites, one SwarmBench-specific.

## REUSABLE: the gateway speaks OpenAI chat-completions, not just Anthropic

The Max-OAuth gateway (`:8788` / `:8799`, key `sk-papercusp-gateway`) exposes **`POST /v1/chat/completions`** in
OpenAI format, in addition to the Anthropic `/v1/messages` path. A probe with the OpenAI shape returns a proper
`chat.completion` object (`choices[0].message.content`). So **any harness built on the OpenAI SDK** (`AsyncOpenAI`,
litellm's openai provider, etc. — SwarmBench, tau2, many others) can drive opus by simply pointing its
`api_base` at `http://127.0.0.1:8788/v1` and `model` at `claude-opus-4-8`. **No openai→anthropic shim is needed.**

The **framing requirement carries over**: the FIRST system message must be the Claude Code identity
(`"You are Claude Code, Anthropic's official CLI for Claude."`) or you get the bogus `rate_limit_error`
regardless of budget (the same Max-OAuth gotcha as the Anthropic path —
[max-oauth-first-system-block-must-be-claude-code-identity](/internal/docs/agent-insights/max-oauth-first-system-block-must-be-claude-code-identity)).
For an OpenAI-format call, put the identity in (or prepend it to) the `system` role message. `:8799` is the quiet
account (often free); `:8788` is the paced one — either works, both honor the framing.

**Cost/latency caveat:** an opus call through the gateway inside a multi-round sim is *slow* — a SwarmBench
scenario at N agents × R rounds is N×R sequential-ish opus calls and a tiny pilot can take many minutes. Budget
generously, run small, and treat full sweeps as owner-gated.

## SwarmBench-specific: how it plugs in

Vendored at `~/.papercusp/bench-harnesses/swarmbench` (RUC-GSAI/YuLan-SwarmIntell, MIT) with a `.venv`
(`numpy<2 scipy colorama pulp openai`). The integration:

* **`swarmbench_run.py`** (in the vendored repo) runs ONE scenario to its deterministic sim score and prints a
  single `SWARMBENCH_RESULT_JSON\n{...}` line. Modes = the swarm-control topology = the ARM:
  * `random` — no LLM (deterministic; the mechanics spike + unit-test shape).
  * `openai` — SwarmBench's NATIVE decentralized flow: each agent an independent OpenAI-compatible call. This
    is the **`su-independent`** arm (peer self-organization, local view only).
  * `mug` / `mug-random` — **control-inversion**: a custom loop gathers all agents' AGGREGATED LOCAL obs
    (`env.obs(agent)` per agent — NOT `env.obs(None)`, which is the global grid and would *cheat* the local-only
    premise, D-001) and one coordinator decides all N actions. This is the **`pot-realqueen`** arm.
* **`swarmbench-live.ts`** = the `RunSwarmSim` port (shells the python, parses the result; injected exec for
  tests). **`swarmbench-backlog.ts`** = the driver on the generic `makePoolBacklogDriver` (one scenario = one
  `perTask` → canonical `HiveBacklogResult`, sim score on `attempt.armMeta`) + `buildSwarmBenchReport`
  (per-(task,arm) mean±SE + the decentralized-vs-centralized **topology delta**). Same pattern as
  `metr-hcast-backlog.ts` — see
  [non-diff-bench-arm-via-pool-backlog-driver](/internal/docs/agent-insights/non-diff-bench-arm-via-pool-backlog-driver).
* **Task-set** is programmatic (task × grid × num\_agents × seed × view\_size) — `swarmbench-pilot` (cheap) vs
  `swarmbench` (the expensive full 5-task × 10-agent × 100-round sweep, gated). Scores are CONTINUOUS, not
  pass/fail — the headline is the mean score + the arm delta, never a pass-rate.

## Running it: two mandatory robustness fixes + the contention asymmetry

Live full-sweep findings (plan D-001) — applicable to ANY in-sim, multi-round opus harness:

* **Bound the per-agent retry + add a no-op fallback.** SwarmBench's upstream `Agent.decision` is
  `while True: try: to_action(brain.generate()) except: retry` — an UNBOUNDED retry that HANGS the whole sim
  under gateway rate-limiting. The brain must catch, retry a few times, then return a safe `ACTION: STAY`
  (degrade, don't deadlock).
* **Lower the OpenAI client call timeout.** `framework/llm.py` hardcodes `timeout=3600` — a non-responsive
  (saturated) gateway then hangs *one hour per call*, stalling the sim. Set \~90s so a hung call fails fast →
  retry → STAY → the round proceeds.
* **The decentralized arm is gateway-starved under fleet contention.** The `su-independent` arm fires **N
  concurrent calls/round** (10 agents × 100 rounds); against a gateway the SWE-Pro xbench fleet has
  saturated, rounds stall and it banks \~0 real scenarios while flooding the shared gateway. The `pot` mug
  (**1 aggregated-local call/round**) is gateway-efficient and completed 15/15 with real data. **So run the
  call-heavy decentralized arm in a QUIET gateway window (low fleet load), not concurrently with the fleet.**
  This is an infra asymmetry (centralized = fewer calls = robust to shared rate limits), not a
  SwarmBench-intrinsic result — label it as such. Mug-arm scores from the real run: Flocking 5.0±0.58
  (genuine coordination), Pursuit 0.67, Foraging/Synchronization/Transport 0.

## The honest framing (don't skip)

SwarmBench is coordination-NATIVE (the score *is* collaboration quality; a single agent can't shortcut it) and
unsaturated — so it's the right suite to demo multi-agent value, unlike metr-hcast (which opus-4.8 saturated).
But the "pot" arm is a SwarmBench-specific aggregated-local coordinator, **not** the production Mug-over-backlog
(D-005). Report it as a coordination-topology A/B on opus-4.8 — *does centralizing decentralized-local info beat
peer self-organization* — not as "our production Mug ran SwarmBench". Plan: `benchmark-suite-swarmbench-2026-06-17`.
