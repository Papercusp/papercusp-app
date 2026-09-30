# A spawn that dies in ~1.5s with exit 1 is a MODEL/BINARY mispairing, not quota — and the real stderr is in harness_run_output.err_body
URL: /internal/docs/agent-insights/spawn-dies-at-launch-check-model-binary-pairing-not-quota

An agent spawn that exits 1 before its first turn, with an apparently empty stderr in the operator journal, reads exactly like the documented weekly-limit/quota signature and routes triage to accounts/egress. It usually is not. The CLI's actual refusal IS persisted — in harness_shared.harness_run_output.err_body, not the journal — and on 2026-08-08 it said `Model \"sonnet[1m]:high\" not found. Run \"omp models\"`: every cup was launching the omp binary with a Claude-only model spec. Duration is the tell (a quota refusal costs a round-trip; a bad model id dies in ~1.5s). This fleet has now been bitten in BOTH directions.

:::caution\[The spawns observed here were `cup:spawn`s — the DIAGNOSIS is path-independent]
`cup:spawn` **refuses** as of 2026-08-09 (the Mug · Kettle · Cup tier is
[retired](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired)), so reproduce this
with `fleet:launch-on-plan` / `capability:launch-agent` instead. Everything that makes this
page worth reading is unchanged: **a spawn dying in \~1.5s with exit 1 is a model/binary
MISPAIRING, not quota**, the real stderr lives in `harness_run_output.err_body` and not the
journal, and env sourcing can silently no-op. Read `cup:spawn` below as "the launch call".
:::

## The symptom, and why it misroutes you

An agent spawn returns `ok`, then dies almost immediately. The operator journal shows:

```
[dbos-invoke] role=cup exited 1 — stderr:
```

…with **nothing after the colon**. That empty-stderr shape is precisely what
[fleet-token-weekly-limit-silent-invoke-failures](/internal/docs/agent-insights/fleet-token-weekly-limit-silent-invoke-failures)
teaches as the weekly-limit signature, so the natural next move is to go probe accounts, egress
and rate limits. On 2026-08-08 that cost real time while six consecutive `cup:spawn`s reported
`ok` and produced nothing (WI-36197 / WI-36237).

**The stderr is not lost. The journal line drops it; the database keeps it.**

```sql
SELECT run_id, exit_code, duration_ms, right(err_body, 200)
  FROM harness_shared.harness_run_output
 WHERE harness_slug = '<harness>' AND role = '<role>'
 ORDER BY started_at DESC LIMIT 5;
```

That returned, verbatim:

```
Model "sonnet[1m]:high" not found. Run "omp models" to see available models.
```

`out_body` was genuinely empty (0 chars) — note this is the OPPOSITE stream from the quota case,
where the claude CLI prints its refusal to *stdout*. The two failure classes land in different
places, which is exactly why one insight cannot cover both.

> **`duration_ms` is the cheapest discriminator.** A genuine quota/auth refusal costs an upstream
> round-trip. A bad model id dies in **1.4–3.6s** having never reached the API. If the spawn died
> in under \~5s, stop thinking about accounts.

## The mechanism

`harness-invoke-once.ts` resolves the spawn's base command as:

```ts
process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p'
```

and `inferBackendFromModelSpec` **only forces a backend swap for Codex-shaped specs**
(`gpt-N`, `chatgpt:`, `openai-codex/`). It deliberately does not force one for Claude aliases,
because an explicit operator choice (`AGENT_CMD`, `AGENT_ROLE_BACKENDS`) must win.

Meanwhile `ROLE_MODEL_DEFAULTS` pins cup/mug/kettle to `sonnet[1m]:high` and
release-fixer/merge-resolver to `opus:xhigh` — **bare Claude-Code aliases**. `omp models`
publishes no bare alias at all; its Claude entries are fully qualified (`claude-sonnet-4-6`,
`claude-opus-4-8`, `claude-haiku-4-5`). So any process without `AGENT_CMD` hands `omp` a spec it
cannot resolve, and the role is hard-down on every fire.

## The asymmetry that hid it from 100% of cup spawns

This is the part worth remembering, because the working process **conceals** the broken one:

| process                    | sources                                                    | `AGENT_CMD` | result                                  |
| -------------------------- | ---------------------------------------------------------- | ----------- | --------------------------------------- |
| `papercup-bg-host.service` | the **staging** tree's `apps/operator/.env.local`          | `claude -p` | mug/kettle always fine                  |
| `papercup-dev-api.service` | the **release** checkout's copy — **which does not exist** | unset       | every spawn it serves falls to `omp -p` |

`dev-api`'s `ExecStart` is `[ -f .env.local ] && . ./.env.local`, so the missing file makes the
sourcing **silently no-op**. And `dev-api` is the process that serves `cup:spawn`. Check both
directly rather than reasoning about unit files:

```bash
for u in papercup-dev-api papercup-bg-host; do
  pid=$(systemctl --user show -p MainPID --value $u.service)
  echo "== $u"; tr '\0' '\n' < /proc/$pid/environ | grep -E '^(AGENT_CMD|CLAUDE)=' || echo '  unset'
done
```

## It has now happened in BOTH directions

* **2026-07-16, kettle\@papercusp** — a role whose spawn keeps the `claude` binary was handed the
  codex-only `gpt-5.6-luna` and hard-downed. That incident is why the codex branch of
  `inferBackendFromModelSpec` exists (see `role-models.ts`'s `ROLE_MODEL_DEFAULTS` history).
* **2026-08-08, cup\@papercusp** — the mirror: the `omp` binary handed the Claude-only
  `sonnet[1m]:high`.

**Rule: when a spawn dies before its first turn, compare the resolved MODEL against the resolved
BINARY before you touch accounts.** A spec/binary mismatch is fatal at launch and near-silent in
the logs.

## A comment asserted the fix already existed — it did not

`role-models.ts` carried, for weeks, the sentence that `sonnet[1m]:high` *"infers the
claude/anthropic backend, so the spawn binary stays correct."* No such inference existed in code;
`inferBackendFromModelSpec` returned `undefined` for every non-Codex spec. The binary "stayed
correct" only in processes that happened to export `AGENT_CMD`.

That false comment is very likely why nobody re-checked the path: it reads as a verified
invariant. **A comment claiming an invariant is a hypothesis about code, not evidence of it** —
when one is load-bearing for your diagnosis, read the function.

## The fix, and the shape to copy

Two layers, because they fix different things:

1. **Config parity (immediate).** A systemd drop-in giving `dev-api` the same `AGENT_CMD` as
   `bg-host`. ⚠ `Environment=AGENT_CMD=claude -p` is **split on the space** by systemd and
   silently sets `AGENT_CMD=claude`. Quote it: `Environment="AGENT_CMD=claude -p"`.
2. **Derive-don't-configure (durable).** `fallbackBaseCmd(spec)` in `harness-invoke-once.ts` now
   picks the no-config fallback **binary from the model spec**, so a process without `AGENT_CMD`
   can no longer mispair them. Its regex is anchored on both ends — it matches bare
   `sonnet|opus|haiku|fable` (+ optional `[1m]`) but **never** `claude-sonnet-4-6`, which is a
   real omp id. Steering those would be the same bug sign-flipped.

The generalisable half is (2): **configuration that lives in one process's environment is a
latent split-brain.** Prefer deriving behaviour from data that travels with the request over env
that varies per process — and when you must keep the env, make the code's fallback coherent on
its own.

## Two related gaps this exposed

* The journal line at `orchestrator-runner.ts:188` renders `— stderr:` with an empty body while
  `err_body` holds the text. That is the whole reason this reads as quota. Filed on
  EI-19919820934195792.
* A headless `cup:spawn` writes **no** `harness_shared.adv_sessions` row (all nine
  `recordAdvSession` callers are tracked-console/su paths), so a running cup is invisible to
  roster/presence/session-audit — and `adv_sessions.role='cup'` is unsatisfiable for
  orchestrator-placed cups. Use `tool_invocations.role='cup'` joined on `coord_owner_id`. Filed
  as WI-36281; ruling in plan `goal-mode-2026-08-07` D-014.
