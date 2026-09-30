# A coord-invariant AGE alarm must fire on its own drain/sweep deadline, not a lower threshold
URL: /internal/docs/agent-insights/coord-invariant-alarm-must-track-its-drain-deadline

Why coord-invariant-monitor age alarms perpetually re-file on expected human-owned backlog, and the fix pattern: tie the alarm to the deadline of the in-pass sweep that remediates it (EI-6910 / EI-7087 / EI-8664).

## Symptom

The hourly `system:coord-invariant-monitor` (coord-invariant-actions.ts) files a
`kind=bug` EI that re-opens every hour and can never be closed by working it —
because it is measuring **expected, human-owned state**, not a substrate leak. The
same shape has recurred at least three times:

* **EI-6910** — "operational escalations undrained": the old check fired on *any*
  open escalation past 6h, i.e. the human's normal decision backlog (554+ open).
* **EI-7087** — a follow-on tick-cadence race on the same escalation check.
* **EI-8664** — "wake-queue depth/age growth": the AGE alarm fired at
  `wakeQueueAgeHours=6h`, but the auto-expiry sweep (`sweepStalePendingWakes`) only
  reaps at `pendingWakeStaleHours=24h`. A staged wake for a **live** owner aging in
  the 6h–24h window (a busy owner who hasn't cleared their pui wake board yet) is
  expected review backlog the sweep will reap at 24h — yet the alarm filed an EI
  every hour for it.
* **EI-8786** — a variant one layer up: the operational-escalation check was
  already tied to the right deadline (`OPERATIONAL_ESCALATION_TTL_MS` + the
  EI-7087 grace), but the DRAIN it depended on ran on a **separate** hourly DBOS
  tick (`attentionReconcile`, fired at :20) rather than *in the same pass as the
  check* (the invariant monitor fires at :37). A missed/shed/stalled/lagged
  reconcile tick left an operational escalation past the TTL at measure time —
  observed live at 49.5h open while the separate tick had resolved nothing for
  8h — firing the check on the OTHER routine's outage, not its own drain
  failure. Fix: `drainOperationalEscalationsBeforeMeasure` now runs the same
  reconcile sweep **in-pass, immediately before the check**, exactly like the
  handoff and wake-queue remediations — making the check self-healing and
  fully independent of the separate tick's cadence/health.

## Root cause (the class)

Each of these invariants has a **remediation** that runs in the *same monitor pass,
immediately before the check*: `autoAcceptStaleHandoffs`, `sweepDeadOwnerPendingWakes`,
`sweepStalePendingWakes`, and (as of EI-8786) `drainOperationalEscalationsBeforeMeasure`
— which now calls the SAME `reconcileStaleEscalationsOnce` sweep the separate hourly
`attentionReconcile` tick uses, but in-pass rather than relying on that other tick
having already run. The alarm is supposed to detect that **the remediation is
failing** — not that a human hasn't manually cleared a queue yet, and not that some
OTHER routine's tick was late.

When the ALARM threshold is set *lower* than the remediation's DEADLINE, everything
in the gap between them is state the remediation deliberately keeps (a live owner's
review backlog, an escalation within its reconcile TTL). The alarm then fires
perpetually on normal steady-state, minting a non-actionable, un-closeable EI.

## The fix pattern

**Tie the alarm to the deadline of the sweep that remediates it — never a separate,
lower "alert" threshold.** Because the sweep runs in-pass just before the check, a
row surviving *past its own drain deadline* can only mean the sweep genuinely
failed — the one real leak. Add a small boundary grace (≈ the monitor cadence, 1h)
to absorb the clock/edge race, matching the `OPERATIONAL_ESCALATION_TTL_MS +
ESCALATION_RECONCILE_GRACE_MS` idiom already in the file.

Concretely for EI-8664: the wake-queue AGE alarm now fires on
`oldest > pendingWakeStaleHours + WAKE_QUEUE_STALE_GRACE_MS` (24h + 1h), and the
drift-prone separate `wakeQueueAgeHours` knob was removed outright (mirroring
EI-6910's removal of `staleEscalationHours`) so the alarm and the sweep deadline can
never drift apart and reopen the gap. The DEPTH check (`> wakeQueueDepthMax`) stays a
genuine bloat backstop, independent of age — but EI-10177 recalibrated its threshold
(see below); the flat 50 it shipped with was itself a "warn early on count" value
measuring normal backlog.

## Follow-on: the DEPTH leg's flat count threshold was the same anti-pattern (EI-10177)

The DEPTH backstop is legitimate (a wake-creation storm / owners drowning is real bloat
the AGE alarm can't see), but its threshold, like an age "warn early" threshold, must sit
above the fleet's normal steady-state — not below it. `wakeQueueDepthMax=50` fired on
**expected live-owner review backlog**: observed live, 57 young staged wakes across 8
LIVE owners (one owner alone at 32), **0 stale**. None were reap-eligible (the in-pass
sweeps reap only dead-owner + `>pendingWakeStaleHours` wakes), so the alarm re-filed a
non-actionable EI every hour (recurred 5×) — the identical EI-6910/EI-8664 shape, one leg
over. Note the system's own `BOARD_READ_LIMIT` (500, pending-wakes.ts) already treats up
to 500 as a *realistic review queue* to render whole, directly contradicting a 50-count
"bloat" line. Fix: raised `wakeQueueDepthMax` to 250 — well above realistic busy-fleet
backlog (a genuine runaway still trips it) yet below `BOARD_READ_LIMIT` so the wake board
still renders the full queue when the backstop fires. A raw-count runaway is caught by
the AGE alarm anyway once the storm's wakes age past the sweep deadline, so 250 masks no
real leak.

Rule-of-thumb corollary: a COUNT backstop is not exempt from the "don't measure the
human's normal backlog" rule — calibrate it above steady-state, using a principled anchor
(here, below `BOARD_READ_LIMIT`), not a round number that undershoots a busy fleet.

## Scope note: not every check in this file is an age/backlog alarm

As of 2026-07-10 (EI-8999, `system:claim-integrity-sweep`), the same file also runs a THIRD,
structurally different kind of check — deliberately NOT the age-drain-deadline pattern above.
Claim integrity (a work-item's `taken_by` desynced from its plan-item's live claim lease, or a
durable plan-item assignment with no live lease backing it) is a **live double-placement risk
right now**, not a slow backlog leak — so instead of filing a deduped backlog bug on an age
threshold, it fires a **LOUD, directed, woken alarm** to the holder + its fleet leader
immediately on detection (and still files a deduped improvement as the durable audit trail /
catch-all when nobody is reachable to wake). There is no "drain deadline" to tie an alarm
threshold to here — the violation itself, the instant it's observed, is the actionable signal.
Don't generalize the rule-of-thumb below to this check; it is the one exception the file's own
header comment calls out.

## Rule of thumb

If a coord-invariant AGE/backlog alarm has an in-pass auto-remediation, its
threshold **is** that remediation's deadline (+ grace). A lower "warn early"
threshold that files an EI is measuring the human's normal backlog — the anti-pattern
this insight names. (Surfacing the backlog to a human is the job of the review
surface — the pui wake board / attention queue — not a filed bug.)

Corollary (EI-8786): the remediation must run **in the same pass, right before the
check** — not on a separate schedule the check merely assumes has already fired. A
check that depends on another routine's tick having run recently is exposed to that
OTHER routine's cadence, shedding, or outages, which looks identical to "my own
remediation is failing" from the check's point of view. Pull the remediation call
in-pass so the check's only remaining failure mode is a genuine drain failure.
