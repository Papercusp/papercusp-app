# A skipped verification leg must say WHY, in the same window
URL: /internal/docs/agent-insights/a-skipped-verification-leg-must-say-why

Four separate bugs in live-federation-gate.sh share one shape: a correct, well-logged decline that exits 0 and is therefore indistinguishable from \"ran and was fine\". The fix is never to remove the decline — it is to make it name itself at the verdict line.

## The shape

`papercusp-desktop/bin/live-federation-gate.sh` has now produced **four** bugs with one root shape:

> A decline to run a leg that is individually correct, cheap, well-logged — and **exits 0**, so it is
> indistinguishable from "ran and was fine" at every consuming surface.

The four, in the order they were found:

| # | Decline                                      | Filed as             |
| - | -------------------------------------------- | -------------------- |
| 1 | `LOAD_GATE` defer                            | EI-18657324526667507 |
| 2 | `MATRIX_TTL_H` cadence window                | EI-18657324526667507 |
| 3 | §0z rig-busy pre-check skip                  | EI-18657324526667507 |
| 4 | content-matrix red ⇒ local-matrix never runs | EI-18715623477356990 |

Each was written by someone who reasoned correctly about the *local* question ("should this heavy
leg burn the box right now?") and not at all about the *global* one ("what does a consumer waiting
on this leg's verdict see?").

## Why "we already have a staleness detector" is not the answer

The fix for #1–#3 was a `last-matrix-verdict` stamp plus `check_matrix_staleness()` — a good fix,
and it did **not** cover #4. The reason is worth internalising: that detector's threshold is
`MATRIX_STALE_H = MATRIX_TTL_H + 48h`, i.e. **192h ≈ 8 days** by default.

So there are two different questions, and a detector for one is not a detector for the other:

* **"Has this leg been dark for a week?"** — the staleness clock. Catches chronic suppression.
* **"Did it decide THIS window, and if not, why not?"** — what an agent *waiting on the verdict
  right now* needs. Nothing answered this until EI-18715623477356990.

Observed 2026-07-26: content-matrix was red on `incr-B→A`, so every hourly window skipped
local-matrix — the only leg that runs `revocation_kcut` (order 90) and
`attestation_unattested_device` (order 91). Two agents each waited on a gate run for evidence that
*structurally could not arrive*, and neither could have known from the gate's own output. The
staleness detector would have surfaced it — up to eight days later.

## The rule

When a verification leg declines to run:

1. **Do not remove the decline.** The sequencing rationale is usually right (don't burn the rig on a
   window whose cheap smoke already failed). The defect is the silence, not the skip.
2. **Set one reason string, on every decline path.** Not a boolean per path, not a log line per
   path — *one* variable (`MATRIX_SKIP_REASON`) that every branch assigns, so the reason is always
   attributable and can never fall through unset. In practice this means turning a compound
   `if A && B && C` into an `if/elif` ladder: a compound condition **cannot** name which clause
   closed, which is precisely why all four bugs read identically.
3. **Give a consequential decline its own result token.** `SKIPPED-CONTENT-RED`, not `SKIPPED` —
   so the verdict `SUMMARY` line carries it. Keep it inside the existing family shape
   (`SKIPPED*`) so predicates like `is_skip_result()` still treat it as "nothing proven" and the
   vacuous-pass trap keeps working.
4. **Put it on the human-facing verdict line, every exit path.** An EI in a queue and a line in
   journald are both easy to miss; `GATE: …` is not. The gate already had `matrix_stale_suffix()`
   for exactly this reason — `matrix_skip_suffix()` is its sibling and hangs off GREEN, RED,
   SKIPPED, SKIPPED-STARVATION and SKIPPED-STORM alike.

Point 4 has a corollary that is easy to get wrong: **the GREEN path needs it most.** A green gate is
the state that best hides a dark leg, because the cheap leg keeps `last-green` fresh on its own.

## Testing this class

Both fixes are pinned by tests that **extract the real bash out of the shipping script** and eval it
under `bash` against a scratch state dir — see
`live-federation-gate-matrix-leg-skip-reason.test.ts` and its older sibling
`live-federation-gate-matrix-leg-staleness.test.ts`. That pattern is worth copying for any
gate-script change: a static leg pins the structural invariant (every exit line carries the suffix;
the chain stays an `elif` ladder), a behavioural leg proves each branch actually names itself, and
`bash -n` guards the parse.

One gotcha when writing the static leg: `live-federation-gate.sh` echoes `GATE: RED` in **two**
places — the §4 verdict and a much earlier assert-core self-test bail. The early one exits before
the leg section runs, so it correctly has no leg reason to report; select the verdict line via
`${REDS[*]}` rather than a bare `GATE: RED` prefix.

## Where else to look

The same shape lives anywhere a cheap gate guards an expensive one. When you add a
"don't bother running X when Y already failed" condition, ask the second question before you commit
it: *what does someone waiting on X's verdict see this window?* If the honest answer is "nothing
distinguishable from success", you are writing bug #5.
