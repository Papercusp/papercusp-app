# τ²-bench (and any LiteLLM harness) through the gateway: the four traps beyond CC-framing
URL: /internal/docs/agent-insights/tau2-bench-litellm-through-the-gateway

Vendoring Sierra's tau2-bench onto opus via the inference-gateway needs LiteLLM's anthropic/ provider (NOT openai — the gateway is an Anthropic /v1/messages passthrough), and four fixes the CC-framing insights don't cover: route the harness's INTERNAL judge LLMs too (they hardcode gpt-4.1 → OpenAI auth error), drop `temperature` (opus-4-8 rejects it), add real exponential backoff for 529 Overloaded waves, and default empty tool-args to {}. opus-4-8 tolerates dropped thinking blocks, so reasoning_effort works in a multi-turn tool harness with no extra patch.

## What this saves you

You are vendoring **τ²-bench** (`benchmark-suite-tau2-bench-2026-06-17`) — or any external
**LiteLLM-based** benchmark/agent harness — and routing it onto **opus** through Papercusp's
inference-gateway. The CC-framing trap is already documented in
[gaia-suite-byo-agent-and-the-max-oauth-429](/internal/docs/agent-insights/gaia-suite-byo-agent-and-the-max-oauth-429)
and [vendoring-a-langchain-benchmark-through-the-gateway](/internal/docs/agent-insights/vendoring-a-langchain-benchmark-through-the-gateway).
This page is the **delta for a LiteLLM harness with an internal LLM judge** (the tau2 shape). Five
things break a naive integration; only the first overlaps the existing insights.

## The gateway is an Anthropic passthrough — use LiteLLM's `anthropic/` provider

`packages/operator-core/lib/inference-gateway/gateway.ts` is a transparent **`/v1/messages`**
reverse-proxy to `api.anthropic.com` with Max-OAuth injection. It is **NOT OpenAI-compatible** (a
plan that says "OpenAI-compatible base\_url" is wrong). So in LiteLLM:

```
model      = "anthropic/claude-opus-4-8"          # forces the anthropic provider → POSTs {api_base}/v1/messages
api_base   = "http://127.0.0.1:8799"               # the QUIET gateway (account ownerhandle6); :8788 is the busy fleet
api_key    = "anything"                             # gateway strips x-api-key/authorization, injects the real Bearer
```

Pointing LiteLLM's *openai* provider at the gateway fails (it POSTs `/v1/chat/completions`, which
the gateway forwards to a non-existent Anthropic route).

## The five fixes (all env-gated in the vendored copy so stock behavior is unchanged)

1. **CC-framing** — first `system` block must be exactly `You are Claude Code, Anthropic's official
   CLI for Claude.` or you get a strict-bucket **429** that looks like a rate-limit but is a framing
   reject. (See the GAIA insight. tau2: prepend it in `utils/llm_utils.generate()`.)

2. **Route the harness's INTERNAL judge/secondary LLMs too.** This is the trap unique to a grader
   harness: tau2's **NL-assertion grader**, env-interface, and eval-user-sim default to a hardcoded
   `gpt-4.1` (`config.py` `DEFAULT_LLM_NL_ASSERTIONS` etc.). Even with `--agent-llm`/`--user-llm`
   pointed at opus, grading fires `gpt-4.1` → LiteLLM **OpenAI** provider → `AuthenticationError: …
   OPENAI_API_KEY` (this deployment has no OpenAI key) → the whole task is scored
   `infrastructure_error`. Fix: override those config constants to the gateway model + api\_base too.
   **General lesson: grep the harness for EVERY default model id, not just the agent/user ones.**

3. **Drop `temperature`.** `claude-opus-4-8` returns `invalid_request_error: \`temperature\` is
   deprecated for this model`. Set `litellm.drop\_params = True`(and/or strip`temperature\` for
   opus models). The model uses its own default sampling.

4. **Real exponential backoff for 529 `overloaded_error`.** api.anthropic.com intermittently throws
   **529 Overloaded** in bursts. LiteLLM `num_retries` retries too fast/short to ride out a
   multi-minute overload window, so a turn fails and the task is `infrastructure_error`. Wrap the
   `completion()` call in a backoff loop (\~8 attempts, base 4s, cap 90s) and set `num_retries=0` so
   your loop is the sole authority. (tau2's own `get_metrics_df` filters `infrastructure_error` out
   of pass^k — so a few that still fail are excluded, not scored as capability fails.)

5. **Default empty tool-args to `{}`.** opus-4-8 (esp. with extended thinking) sometimes returns
   `""` for a no-arg tool call; `json.loads("")` → `Expecting value: line 1 column 1` fails the
   task. Use `json.loads(args or "{}")`.

## Extended thinking ("@ xhigh") works with NO extra patch

`reasoning_effort="high"` is accepted by opus-4-8 and round-trips through a **multi-turn tool**
conversation even though tau2 reconstructs assistant messages from `content`+`tool_calls` and
**drops the thinking blocks** — opus-4-8 *tolerates* missing prior thinking blocks mid-tool-use (it
does not 400 "thinking blocks required" the way some setups do). So you can run the agent at high
reasoning without patching message reconstruction. Bump `max_tokens` (≥16k) to leave room for the
thinking budget. Apply reasoning to the **agent only** (the system-under-test); leave the
user-simulator at default (it's the environment).

## Telltales

| Symptom                                                            | Cause                            | Fix    |
| ------------------------------------------------------------------ | -------------------------------- | ------ |
| `infrastructure_error`, turns=0, OpenAI `OPENAI_API_KEY` error     | internal judge → OpenAI provider | fix #2 |
| `invalid_request_error: temperature is deprecated`                 | opus-4-8 rejects temperature     | fix #3 |
| bursts of `InternalServerError … overloaded_error` then task retry | 529 wave, retries too short      | fix #4 |
| `Expecting value: line 1 column 1 (char 0)`                        | empty tool-call args             | fix #5 |
| strict-bucket 429 with a tiny body                                 | CC-framing missing               | fix #1 |

Vendored copy + runner: `~/.papercusp/bench-harnesses/tau2-bench` (`pc_run.sh`, `pc_suite.sh`,
`pc_metrics.py`; all patches tagged `papercusp patch (benchmark-suite-tau2-bench-2026-06-17)`).
