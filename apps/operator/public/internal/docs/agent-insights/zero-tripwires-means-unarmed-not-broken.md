# 0 autonomy tripwires is the UNARMED dark-ship state, NOT a broken backstop
URL: /internal/docs/agent-insights/zero-tripwires-means-unarmed-not-broken

autonomy_tripwire_list returning 0 does not mean the auto-revert safety net is broken. Tripwires arm ONLY when the autonomy policy is armed (papercusp-mug-autonomy-armed) or papercusp-mug-full-autonomy is ON — both default OFF. Unarmed → the decider returns gated for every action → planReversibleArm returns null → nothing arms, BY DESIGN (D-007). And don''t be fooled by "N auto-actions in the decision ledger": the action-layer logs every governed call with posture=auto; that is not the same as an autonomy-gated reversible Mug auto-take, and most of the volume is unrelated (in papercusp-workspace ~1000 were the palette command-palette runaway, EI-597). The arm seam is wired only to work_items:set_state + set_priority.

When an agent sees `autonomy:tripwire_list` return **0 rows** "despite hundreds
of auto-actions," the tempting conclusion is *"the auto-revert backstop is
broken — every auto-take runs unbacked."* **That conclusion is almost always
wrong, and chasing a `planReversibleArm` "fail-safe-critical bug" wastes an
hour.** (It already has — twice: EI-570, then the mug-loop-alignment P-003
re-investigation.) Two things bite.

## 1. 0 tripwires is the dark-ship contract, not a bug

The tripwire only arms when the autonomy policy is **ARMED**. The two gates,
both default **OFF**, fail-dark:

* `papercusp-mug-autonomy-armed` (the P-092 arm flag), and
* `papercusp-mug-full-autonomy` (the residue-lifting grant).

With both OFF, `decideAutonomy`
(`packages/operator-core/lib/autonomy/decider.ts`) returns **`gated` for every
action** — the explicit behavior-neutral D-007 contract. So
`planReversibleArm` (`autonomy/arm-reversible-action.ts`) sees a non-`auto`
posture and returns **`null`**, the caller skips `commitReversibleArm`, and
**no tripwire is ever inserted**. Zero rows is *correct*.

**Check before concluding "broken":**

```
flags:get papercusp-mug-autonomy-armed     # OFF ⇒ dormant by design
flags:get papercusp-mug-full-autonomy       # OFF ⇒ dormant by design
autonomy:policy_get                            # ceilings (FYI; not the blocker)
```

If both flags are OFF, the backstop is **dormant, not broken**. Arming it is
the **owner's deliberate gate** (it changes whole-fleet autonomous behavior) —
do **not** flip it autonomously to "test" the backstop.

Note the ceilings are a red herring here: in `papercusp-workspace` all 13
categories already sit at `effectiveCeiling: critical`, so the
"fail-safe-to-critical → gated" path the older notes hypothesized is **not**
the blocker once armed — a critical-risk reversible action is *within* a
critical ceiling. The only blocker is the arm flags being off.

## 2. "N auto-actions" is a measurement artifact — count the right rows

The number that triggers the false alarm is usually
`decision_ledger:summary { byPosture: { auto: ~1000 } }`. **That count is not
"autonomy-gated reversible Mug auto-takes."** The action-layer ledger records
*every* governed MCP call with a posture; `posture: auto` just means "ran
without owner-gating" — true of ordinary authorized tool calls.

In `papercusp-workspace` those \~1000 rows were dominated by the **`palette`
command-palette runaway** (EI-570/EI-597): `coord:wake-mode` /
`coord:wake-queue`, `actorRole: operator`, `actorPrincipal: loopback`,
categories `coord` + `system-control`, all `riskTier: null`. Those would
**never** arm a tripwire even with autonomy armed, because:

* **The arm seam is wired to exactly two verbs** — `work_items:set_state`
  (→ `work-item-state` handle) and `work_items:set_priority`
  (→ `work-item-priority` handle) — the only reversible families the B-16
  revert executor knows how to undo. A new reversible action family must wire
  the same seam (`registerReverter` + a `planWorkItemArm`-style call site).

So "1000 auto-actions, 0 tripwires" compares two unrelated populations. The
honest question is "how many *armed-policy, reversible, set\_state/set\_priority*
auto-takes happened?" — and unarmed, that is **0**.

## 3. To VERIFY the backstop works — run the tests, don't re-implement

The arm → insert → list → sweep → revert chain is covered by **44 green
tests**; run them rather than hand-arming live autonomy:

```
cd packages/operator-core && npx vitest run \
  lib/autonomy/arm-reversible-action.test.ts \
  lib/agent-tools/work_items/arm-reversible-work-item.test.ts \
  lib/autonomy/tripwire/core.test.ts \
  lib/autonomy/tripwire/scan.test.ts
# + lib/autonomy/tripwire/store.integration.test.ts (real PG)
```

They pin: disarmed → no-op; **armed + within-ceiling → an `auto` decision arms
a row** with the decision-ledger `decisionId` threaded; and that the
fail-safe-to-`critical` path is **intentional and tested** (an undeclared-risk
action gates; a declared sub-critical risk at a sub-critical ceiling arms). The
code is correct — it is waiting for the owner to arm, nothing more.

## See also

* `agent-insights/autonomy-residue-and-the-full-autonomy-knob` — why maxing all
  13 ceilings still leaves a gated residue, and how `QUEEN_FULL_AUTONOMY` lifts
  both the decide gate and the implement TCB.
* Plan `mug-loop-alignment-2026-06-14` D-004 (this finding) and
  `mug-autonomy-policy-2026-06-13` (the B-12/B-16 design).
