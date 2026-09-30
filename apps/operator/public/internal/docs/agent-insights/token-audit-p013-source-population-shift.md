# Token audit P-013: the ≥40% gate is confounded by a work-model regime shift (interactive → fleet)
URL: /internal/docs/agent-insights/token-audit-p013-source-population-shift

Why the token-usage-reduction-audit acceptance gate (weekly cache-read+write down ≥40% at flat throughput) cannot be read off raw weekly volume: the dominant token population migrated from interactive psu sessions to autonomous fleet subprocess runs between the baseline and the re-measure. Raw drop is ~85%, but it is not cleanly lever-attributable. The sound forward metric is per-unit (cache/session by source).

## TL;DR

`token-usage-reduction-audit-2026-06-09` P-013 gates the plan on "weekly
cache-read+write MTok down **≥40%** at **flat task throughput**" vs the D-003
baseline of **20.77 GTok cache-read/wk** (measured 2026-06-10). Re-measured
2026-06-24:

* **Raw weekly cache-read+write is down \~85%** (06-15, the first clean full
  week: **\~3.2 GTok** total vs 20.77 GTok baseline) — numerically far past 40%.
* **But it is NOT cleanly attributable to the reduction levers.** Between the
  baseline and now the dominant token *population* migrated: the work-model
  shifted from **interactive psu sessions** (`source='interactive'`) to
  **autonomous fleet subprocess runs** (`source='jsonl'`). "At flat task
  throughput" is therefore violated — throughput did not stay flat on a
  comparable path; the whole workload moved to an inherently cheaper-per-unit
  path (short cup runs vs long 200k-context psu sessions).

So the honest verdict: **the ≥40% target is met in raw volume, with a major
confound.** The sound forward acceptance metric is **per-unit** (cache per
session, by source), not raw weekly volume against a single-regime baseline that
no longer reflects the workload.

## The three sources (what the buckets mean)

`harness_shared.agent_usage_samples.source`
([`agent-usage-telemetry.ts`](packages/operator-core/lib/agent-usage-telemetry.ts)):

* **`interactive`** — ingested `~/.claude/projects/**/*.jsonl` assistant-message
  usage (human/psu Claude-Code sessions), via the
  [`interactive-usage-ingest`](packages/operator-core/lib/interactive-usage/ingest-claude-transcripts.ts)
  routine (cron every 10 min). **This is the population the D-003 baseline
  measured.**
* **`jsonl`** — subprocess agent-run results (the fleet cups), written by
  [`usage-sample-pg.ts`](libs/papercusp/packages/orchestrator/src/usage-sample-pg.ts).
* **`headers`** — in-process anthropic-direct calls.

## The data (clean weeks; the 06-08/06-09/06-10 windows are backfill-skewed — D-005)

| week (start) | source      | sessions | cache MTok (read+write) | per session |
| ------------ | ----------- | -------- | ----------------------- | ----------- |
| 2026-06-15   | jsonl       | 1,672    | 3,042                   | 1.82        |
| 2026-06-15   | interactive | \~0¹     | 168                     | —           |
| 2026-06-22²  | jsonl       | 484      | 731                     | 1.51        |
| 2026-06-22²  | interactive | 4        | 184                     | 45.97       |

¹ `session_id` is null for older interactive samples (attribution landed
recently) so the distinct-session count under-reads; the MTok is real.
² 06-22 is a partial week (re-measured mid-week).

Baseline (D-003, 2026-06-10, the same `interactive` population): **20.77 GTok
cache-read/wk across \~76k psu calls; 95% of all volume was interactive psu
sessions.** That population is now **0–4 sessions/wk**.

## Why this is a regime shift, not (only) a lever win

* The baseline regime was *human drives long psu sessions* (D-004: psu context
  p50=224k, p90=578k). Those are expensive per session and there were thousands
  of them.
* The current regime is *autonomous fleet*: thousands of **short** cup
  subprocess runs (`jsonl`, \~1.5–1.8 MTok/session) plus a handful of interactive
  sessions. The interactive sessions that remain are still large per session
  (06-22: \~46 MTok/session) — they did **not** get \~99% cheaper; there are just
  far fewer of them.
* So the \~85% raw weekly drop is dominated by **where the work runs**, not purely
  by the per-call efficiency levers.

## The levers DID ship (and are independently guarded)

The reduction levers are real and test-gated regardless of the volume confound:
`plans:get` payload diet (D-004 F1), byte-stable prompt prefixes + prefix-hash
tests (P-009), the prefix slim (CLAUDE.md 48→15KB, SU playbook 51.6→26.9KB, …),
the pre-validator test-digest hook (P-010), role-scoped spawn catalogs +
guidance-budget lint (P-011), committed per-role model tiers (P-012). Per-unit,
fleet `jsonl` runs at \~1.5–1.8 MTok/session — in the neighborhood of P-010's
\~1 MTok/run validator target.

## Recommendation

1. **Do not read P-013 off raw weekly volume vs the 20.77 GTok baseline** — the
   baseline regime no longer exists, so the comparison conflates "levers worked"
   with "work migrated".
2. **Track acceptance per-unit going forward**: cache per session by source,
   week-over-week, via the (healthy, weekly) `token-weekly-report` routine
   ([`token-report-action.ts`](packages/operator-core/lib/harness/routines/token-report-action.ts)).
   A regression shows up as a rising per-session number on a stable source, which
   the migration can't mask.
3. The acceptance **decision** (accept the ≥40%-raw-with-caveat as closing P-013,
   or re-baseline to a per-unit gate) is an owner call — both telemetry routines
   are firing, so either reading is available on demand.

## Verifying the routines are live (so a low number is real, not a stalled ingest)

```
routines:list → interactive-usage-ingest (active, every 10 min) + token-weekly-report (active, Mondays 13:00 UTC)
dev:pg_query  → SELECT source, max(ts) FROM harness_shared.agent_usage_samples GROUP BY source
```

A *fresh* `max(ts)` on `source='interactive'` (it was minutes-old at this
re-measure) proves the ingest is current — so a small weekly `interactive` total
is a real low, not a stuck watermark.
