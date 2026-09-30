# Does this routine spend money? Ask target_role, never the name
URL: /internal/docs/agent-insights/does-this-routine-spend-money

Routine spend classification derives from target_role, not a name regex — the regex was wrong six ways. Plus the two traps beside it: a cadence is not a readable clock, and `controllable:false` meant four different things.

## The question

"Can this routine cost the owner tokens when it fires?" — the question the left
rail's Agents/System split, the `tokens` flag, and every "pause the expensive
things" flow all rest on.

## The answer: `target_role`

A routine row carries `target_role`, the handler the routines engine dispatches to.
That is the only field that knows whether a model runs. The mapping lives in
`lib/automation/routine-classification.ts`:

```ts
spendForTargetRole('system:blueprint-run')   // 'llm'
spendForTargetRole('system:git-sync')        // 'none'
spendForTargetRole('system:brand-new-thing') // 'unknown'  ← never defaults to 'none'
```

`unknown` is a third value on purpose. A new system action nobody classified must
not be able to present itself as free; the pane surfaces it, and
`routine-classification.registry.test.ts` fails the build until someone says.

## Why not the name — it was wrong six ways

The predecessor was `AGENT_SPAWNING_PATTERNS`, a list of regexes over the routine's
NAME. A name is a label; it cannot see the handler. Measured on 2026-07-26:

| routine                          | regex said | truth                                                           |
| -------------------------------- | ---------- | --------------------------------------------------------------- |
| `wake-brain`                     | spends     | handler is `async (ctx) => { void ctx; }` — a retired tombstone |
| `improvement-triage`             | spends     | "never dispatches — only records routing metadata"              |
| `improvement-watchdog`           | spends     | a SQL pass that files work items                                |
| `improvement-human-digest`       | spends     | ranks the queue and sends it                                    |
| `improvement-invalid-args-miner` | spends     | mines `tool_invocations` in SQL                                 |
| `template-gym`                   | spends     | **no handler is registered at all** (EI-18741229858124453)      |

Five false positives and one routine that turned out to be firing into a void. The
tests pinning that behaviour asserted the guess faithfully — `catalog.test.ts` had
`template-gym` and `wake-brain` listed under "observed firing and billing tokens".

## Trap 1 — the registry has more than one import root

`listSystemActions()` after `import './register-system-actions'` is the enumeration
you want, but be aware:

* some actions register from a **constant**, not a literal, so `grep -oP
  "registerSystemAction\(\s*'\K[a-z-]+"` misses them (`wake-brain`, `p2p-work-intake`,
  `overwatch-launch`, …);
* some register inside a **function** that must be called at boot — and
  `registerScoutCycleAction()` is exported and never called (EI-18741240128927188);
* `system:loop-wake` is a **sentinel** `target_role` with no handler at all: the DBOS
  fire recognises a loop by `reschedule_interval_sec` + `target_owner_id` and delivers
  a wake instead of running an action.

So enumerate at runtime in a test, not statically, and keep an explicit sentinel list.

## Trap 2 — a cadence is not a readable clock

`collectScheduleInventory()` returns rows from five sources. Only `routines` rows are
backed by a scheduler that writes `next_fire_at`. A DBOS workflow, a managed timer, an
in-process sweep and an external-process timer all report a human **cadence**
("every 30s") while having **no next fire to report**.

Deriving "is this row late?" from `nextFire || cadence` therefore marks every one of
them stalled. Shipped exactly that; the System pane opened announcing that 17 healthy
sweeps needed the owner's attention. Every unit test was green, because the defect was
in what the caller computed. `isClockDriven()` now owns the rule and is tested:

```ts
isClockDriven({ source: 'routines', kind, cron, rescheduleIntervalSec }) // cron or interval
isClockDriven({ source: 'other',    kind, nextFireAt })                  // next fire ALONE
```

**The lesson worth carrying:** a derivation living as an inline expression in a data
mapper is untestable, and this one was wrong in production while 87 tests passed.
Extract it.

## Trap 3 — `controllable: false` meant four different things

The old pane rendered a padlock for every non-`routines` row, with the tooltip "runs
as an in-process schedule". That single marker covered:

1. a DBOS scheduled workflow,
2. a `managedSetInterval` timer,
3. a **git-sync event hook** (`doc-freshness-sweep`) — not a schedule at all,
4. a row whose switch **is a feature flag** (`doc-steward-dispatch` →
   `papercusp-doc-steward`) — a real, throwable control the pane was refusing to offer.

`control: 'routine' | 'flag' | 'none'` replaces it. A `flag` row toggles via
`flags:set`; a `none` row says *why* in its tooltip; and `kind: 'triggered'` gives an
event hook a name for its trigger instead of a fake cadence.

## If you are adding a system action

1. `registerSystemAction('your-action', …)` as usual.
2. Add `'system:your-action'` to `TARGET_ROLE_SPEND` with `{ spend, why }`. The `why`
   is the row's tooltip, so write it for the owner, not for yourself.
3. `spend: 'llm'` means a fire can DIRECTLY bill model turns — it spawns an agent,
   launches or **wakes** a session (a wake costs a turn), or dispatches queued work.
   Filing a work-item someone may later pick up is not `llm`. The test the owner is
   really asking is *"if I pause this, does spending stop?"*.

The registry cross-check will fail the build if you skip step 2 — which is the point.
