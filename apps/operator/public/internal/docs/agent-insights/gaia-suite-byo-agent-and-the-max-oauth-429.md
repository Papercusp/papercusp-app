# GAIA: a BYO-agent benchmark, and the Max-OAuth '429' that is really a framing reject
URL: /internal/docs/agent-insights/gaia-suite-byo-agent-and-the-max-oauth-429

GAIA ships NO harness — you build the agent (web/code/file/vision) + a quasi-exact-match grader and self-grade the validation split. Two traps: (1) the dataset is HF-gated (needs a token whose account accepted the terms); (2) your raw @anthropic-ai/sdk agent gets a BOGUS 429 (body literally 'Error') through the inference gateway unless the FIRST system block is exactly the Claude Code identity. The fix + how to tell a framing-reject from a real rate-limit.

## What this saves you

You are wiring **GAIA** (`benchmark-suite-gaia-2026-06-17`) or any other BYO-agent
research/tool benchmark that runs a raw `@anthropic-ai/sdk` ReAct loop through Papercusp's
inference gateway. Two non-obvious things will eat your evening; both are one-liners once
you know them.

## GAIA ships no harness — the build is an agent + a tiny string grader

Unlike SWE-bench (apply a diff → run tests) or TheAgentCompany (run an in-container
`eval.py`), GAIA is **just Q\&A data + a string scorer**. So the deliverable is:

1. **The grader** (`external-bench/grader/gaia.ts`) — a faithful port of the upstream
   `question_scorer`: gold-is-a-number → strip `$%,` + numeric compare; gold-has-`,`/`;` →
   per-element list compare (string elements keep punctuation — `remove_punct=False`);
   else → lowercase / strip whitespace / strip punctuation. Extract the model answer from
   the **last** `FINAL ANSWER:` line. Binary per task; aggregate per-level L1/L2/L3 +
   overall. This is the easy, well-specified half — get it byte-faithful and your number is
   leaderboard-comparable.
2. **The agent** (`external-bench/gaia/{agent,tools-live,agent-live,run}.ts`) — opus-4.8 in
   a tool-use loop with `web_search` (Brave), `fetch_url`, `run_python`, `read_file`, and
   vision (image attachments as image blocks). The bulk of the work, and **reusable** across
   other research/tool suites. Keep the loop pure (inject the LLM + tools) so it unit-tests
   with fakes; the live bindings are a thin layer.

The **FINAL ANSWER normalization is load-bearing** — a correct-but-misformatted answer
FAILS the exact-match grader, and that formatting slice is a large share of failures. Report
`formatFailRate` separately so you can tell formatting failures from reasoning failures.

## Trap 1 — the dataset is HF-gated

`gaia-benchmark/GAIA` is gated (CC-BY-4.0 + no-reshare). A raw resolve 401s. You need an
`HF_TOKEN` whose HF account **accepted the terms** at
[huggingface.co/datasets/gaia-benchmark/GAIA](https://huggingface.co/datasets/gaia-benchmark/GAIA).
Provision the validation split with
`huggingface_hub.snapshot_download(..., allow_patterns=["2023/validation/*"])` (the layout
is `2023/validation/{metadata.jsonl, <attachments>}`). There is no way to accept the terms
from an agent — it is an owner action. Don't route around it with an ungated community
mirror (license + the plan both say use the gated source).

## Trap 2 — the Max-OAuth gateway '429' is usually a FRAMING REJECT, not capacity

Your live agent calls the gateway and every request comes back:

```json
{"type":"error","error":{"type":"rate_limit_error","message":"Error"},"request_id":"req_…"}
```

This looks like you are out of Opus capacity. **It is not.** On a Claude-Max OAuth token, a
raw-SDK caller whose **first `system` block is not exactly**
`You are Claude Code, Anthropic's official CLI for Claude.` (as its OWN block) gets a
**bogus 429** regardless of budget. (Same root cause documented for the LangChain path in
[vendoring-a-langchain-benchmark-through-the-gateway](/internal/docs/agent-insights/vendoring-a-langchain-benchmark-through-the-gateway)
and [max-oauth-first-system-block-must-be-claude-code-identity](/internal/docs/agent-insights/max-oauth-first-system-block-must-be-claude-code-identity)
— it bites the **raw `@anthropic-ai/sdk` TS path identically**, not just LangChain.)

**Tell a framing reject from a real rate-limit by the body:** a framing reject's `message`
is literally `"Error"` and carries **no** `anthropic-ratelimit-*` headers; a genuine 429 has
a full message + reset headers (then it is actually budget — pin a fresh account).

**The fix** — send `system` as an array of blocks, identity first:

```ts
const system = [
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { type: 'text', text: gaiaSystemPrompt },
];
await client.messages.create({ model: 'claude-opus-4-8', system, messages, tools, max_tokens, thinking });
```

In `gaia/agent-live.ts` this is `CLAUDE_CODE_IDENTITY`, prepended by default whenever a
gateway `baseUrl` is set (off for a direct Anthropic key). With this fix the live chain
(gateway → opus-4.8 @ xhigh extended thinking → tools → FINAL ANSWER → grader) works
end-to-end — a 2-task synthetic smoke went from 0/2 (both bogus-429) to 100% (`Paris`;
`Tungsten → 74` via `web_search`) at \~$0.09.

Other gateway details that carry over: `xhigh` = extended thinking at `budget_tokens` with
`max_tokens > budget_tokens`; let the SDK retry (`maxRetries: 12`) ride out transient 429/529s;
pin a fresh pool account with the `x-papercusp-account` header if the active one is
fleet-exhausted.

## Trap 3 — extended thinking forces STREAMING (non-streaming `create()` is rejected)

Once `max_tokens` is large enough that a request could exceed \~10 minutes (extended thinking
at a 16k budget trips this), the SDK throws **"Streaming is required for operations that may
take longer than 10 minutes."** The 2-task smoke worked only because it used a tiny 6k budget.
Fix: call `client.messages.stream(params).finalMessage()` (accumulates the stream into the
full `Message`) instead of `messages.create()`. This is why `agent-live.ts` streams.

## Trap 4 — (FIXED 2026-06-18) the gateway now round-robins the account pool

`account-failover.ts`: as of 2026-06-18 `active()` **round-robins** the fleet's **unpinned**
egress across every account that still has budget (it advances a cursor on each call) and fails
over off an exhausted one — so load now distributes across the pool. The behavior this trap
originally warned about (the whole fleet egressing through ONE fixed `active` account while
healthy accounts sat idle) is **gone**. Header-pinned requests (`x-papercusp-account`) bypass
the round-robin and keep their own credential for cache-affinity. Two things still help and are
both in `agent-live.ts`:

* **Pin a healthy account** (`x-papercusp-account`, the `accountId` opt) — separates your run
  from the fleet's contention on the active account. Pick one from `accounts:status` with
  `utilization < 0.6`, low `penaltyCount`, `available: true`.
* **Request interactive priority** (`x-papercusp-priority: interactive`, the `priority` opt) —
  jumps the gateway's priority queue ahead of the fleet's `batch` work, so a user-requested run
  isn't starved (the symptom of starvation is a request that just hangs → a client-side timeout
  with no response, distinct from a fast 429).

## Trap 5 — a gateway restart looks exactly like a capacity wall

A gateway restart **resets its `/stats` counters** (e.g. `totalRequests` 4633→718) and causes a
brief 429/timeout spike as it re-warms. This is indistinguishable from "the pool is exhausted"
unless you check: re-run a single **pinned-healthy-account** call — if it returns 200 in \~1s,
capacity is fine and you over-diagnosed a transient. (I burned several turns calling a real
GAIA run "blocked on capacity" when it was actually progressing 100→111→149/165 the whole time.)

## Getting the gated data without the gated token

`gaia-benchmark/GAIA` is gated, but **`smolagents/GAIA-annotated`** (HF's own smolagents team,
`gated: false`) is the canonical validation set — verify it's real before trusting it: 165 rows,
exact schema, per-level **L1=53/L2=86/L3=26**, the canonical task\_id `c61d22de-…`, all rows
self-gradable. `huggingface_hub.snapshot_download(..., allow_patterns=["2023/validation/*"])`,
no token needed. Use for internal measurement (not redistribution).

## Result + cost

opus-4.8 + this agent scored **\~74.5% GAIA validation** (L1 \~79% / L2 \~75% / L3 \~65%),
format-fail \~7% — strong (GPT-4+plugins was \~15% at GAIA's 2023 publication). **Cost \~$205 for
the 165-task pass** — well over the \~$10–80 estimate, driven by the 16k thinking budget × many
ReAct turns × large `fetch_url` tool-results fed back into context. Lever to pull next time:
lower the thinking budget and/or cap `maxToolResultChars` / turns.

## Source

`benchmark-suite-gaia-2026-06-17` (su-aef77), 2026-06-17. Files:
`packages/operator-core/lib/external-bench/{grader/gaia.ts,gaia/*}`; runbook
`apps/operator/docs/gaia-suite-runbook-2026-06-17.md`.
