# Watchdog can SEE a tool failing yet file nothing — dedup masking + the rate-limit class
URL: /internal/docs/agent-insights/watchdog-tool-error-dedup-and-rate-limit-class

>-

import { Aside } from '@astrojs/starlight/components';

## Symptom

A tool is visibly, repeatedly failing — `memory:search`/`memory:remember`
returning `openai_embed_failed_429` dozens of times in
`harness_shared.tool_invocations` — yet the improvement watchdog files **no new
EI** and surfaces nothing actionable. It looks like the watchdog "missed it."

It didn't miss it. It **saw the signal every tick and deliberately dropped it.**

## Root cause 1 — dedup masking (the key is blind to the error shape)

The `repeated-tool-error` collector keys each signal as
`repeated-tool-error:<tool>:<class>` (class ∈ structural | transient | caller |
rate-limit). The pre-filter (`partitionSignalsByKnownKeys`) drops any signal
whose key matches an **OPEN** EI — that's the cross-tick dedup. The trap: the key
carries **no error fingerprint**, so two genuinely different failure modes under
one tool share one key.

On 2026-06-17 the OpenAI embedding endpoint hit its org-wide 1M-TPM ceiling and
`memory:search` started failing with `openai_embed_failed_429`. That error has
`error_code='handler_error'`, which classified as **`structural`** → key
`repeated-tool-error:memory:search:structural`. But **EI-630 was already open**
under that exact key — for a *completely unrelated* bug (`"requires a
workspace-scoped call"`, a session-scoping error from two days earlier). So every
tick the embed-429 signal landed in `known_open_keys` and was dropped as a
"duplicate" of EI-630.

A watchdog key in `watchdog_ticks.known_open_keys` means "already filed, don't
re-file" — but the OPEN EI it matched may be about a **different** failure than
the one firing now. Always read the EI's actual `body` ("Sample error: …"), not
just its key, before concluding an issue is tracked.

### How to diagnose

```sql
-- Is the tool actually failing, and with what?
SELECT tool_name, error_code, left(error_message,80), count(*)
  FROM harness_shared.tool_invocations
 WHERE status<>'ok' AND invoked_at > now() - interval '24 hours'
 GROUP BY 1,2,3 ORDER BY 4 DESC;

-- Did the watchdog SEE it? (known_open = saw-but-deduped; captured = filed)
SELECT tick_at, known_open_keys, captured FROM harness_shared.watchdog_ticks
 ORDER BY tick_at DESC LIMIT 3;

-- What is the masking EI ACTUALLY about? (read the body, not the key)
-- sql-snippet-justified: watchdog forensics keyed on payload->>'watchdogKey' —
-- an internal dedup key no work-item tool filters on.
SELECT issue_id, state, payload->>'watchdogKey', left(body,200)
  FROM harness_shared.engineer_issues
 WHERE payload->>'watchdogKey' = 'repeated-tool-error:memory:search:structural';
```

## Root cause 2 — external rate-limits misclassified as `structural`

`classifyToolError` only treated **PG/DB exhaustion** (`too many clients`,
`ECONNREFUSED`, …) as `transient`. An **external provider** rate-limit (OpenAI
embed 429, `rate limit reached`, `tokens per min`) matched nothing and fell
through to the `ELSE 'structural'` branch — i.e. it was filed as a *deterministic
code bug* (kind=bug, major), routed to the auto-implement lane, when it is really
**capacity/infra** (owner-escalation). The misleading OpenAI body `"Request too
large … Requested 6, Limit 1000000"` is the SAME TPM saturation — even a 6-token
request is rejected when the org budget is already spent by other traffic.

## The fix (plan watchdog-embed-resilience-and-dedup-2026-06-17)

* **New `rate-limit` `ToolErrorClass`** (`EXTERNAL_RATE_LIMIT_ERROR_RE`, mirrored
  in `classifyToolError` and the SQL CASE). Volume-gated, `kind=change`, body says
  "EXTERNAL CAPACITY, not a code bug — route to infra/owner, not auto-implement."
  This alone unmasks the embed-429: it now gets its own
  `repeated-tool-error:<tool>:rate-limit` key, distinct from any `structural` EI.
* **Structural dedup fingerprint** (P-003): the SQL computes a normalized
  error-shape fingerprint (first 6 alpha tokens of the digit/punct-stripped
  message) and groups structural rows by it; the key becomes
  `<tool>:structural:<fingerprint>`. Two different deterministic modes under one
  tool no longer mask each other. Load classes keep the bare `<tool>:<class>` key.
* **Embedder resilience** (`buildOpenAiEmbedder`): retries a 429 on the SAME
  embedder with header-aware (`Retry-After` / `x-ratelimit-reset-tokens`),
  jittered, budget-capped backoff (8 attempts / \~30s) instead of hard-failing —
  rides out transient spikes (it cannot ride out an hours-long saturation; for
  that, isolate the embedding load that's burning the TPM).

A key-shape change orphans existing EIs from their dedup match. Do the EI-key
backfill/cleanup **after** the code deploys — a pre-deploy backfill races the
still-live old watchdog (bare keys) and causes the very re-file churn it's meant
to avoid.
