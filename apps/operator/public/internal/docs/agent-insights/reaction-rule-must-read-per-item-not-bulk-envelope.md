# A reaction rule reading result.data.results[] silently never fires
URL: /internal/docs/agent-insights/reaction-rule-must-read-per-item-not-bulk-envelope

The reaction engine fans a bulk-envelope tool result into one synthetic event PER ITEM before matching rules — it never matches the bulk carrier itself. A rule whose when/args reads e.result.data.results[] matches neither the carrier (never matched) nor the per-item events (no .results field), and silently never fires, with no error. Read the per-item shape directly, the way reflect-rules.ts does.

import { Aside } from '@astrojs/starlight/components';

## Symptom

A `registerReactionRule` you wrote against a bulk-capable trigger tool (e.g.
`work_items:complete`, `work_items:set_state` — anything running through
`runBulk`/`bulkContent`) never fires. No error, no warning, no failed-match log
line — the rule is registered (`listReactionRules()` shows it), the trigger tool
runs and succeeds, and the reaction just... never happens. `reconcile-rule.ts`
(EI-5925) sat dead this way for a stretch, silently orphaning work items
(root-caused as EI-6960).

## Root cause — the engine fans bulk envelopes into per-item events, and never matches the carrier

Every agent-facing bulk-capable tool returns the bulk envelope
`{ ok, results: [...], counts }` — **even for a single-item call**
([bulk-tool-contract-2026-06-22](/internal/docs/agent-insights/bulk-tool-contract-2026-06-22)).

The reaction engine's `matchAndRun` (`engine.ts`) does NOT match a rule against
that envelope directly. Instead, `fanOutBulkEvent` (D-007) explodes it into one
**synthetic event per result item** — each with `result.data` set to the single
flat per-item record (e.g. `{ workItem, completion, ... }`) — and recurses
`matchAndRun` on each of those. The bulk-level event is a **carrier, not an
invocation**; it is never itself matched.

If your rule's `when`/`args` reads `e.result.data.results[]` (the bulk shape),
it matches **nothing**: the per-item events the engine actually dispatches have
no `.results` field (`data` IS the item, not an envelope containing items), and
the original bulk-level event is never matched at all. There's no type error and
no runtime throw — the rule's condition just evaluates false-or-undefined every
time, silently.

## The correct pattern

Read the per-item shape directly — the way `reflect-rules.ts` does, e.g.
`data.workItem`, `data.completion`, not `data.results[0].workItem`. If your rule
genuinely needs the WHOLE bulk call's context (all items together, not one at a
time), it needs a different integration point — reaction rules are fundamentally
per-item.

## The generalizable checklist

When you register a `registerReactionRule` on a bulk-capable trigger tool:

* **Never read `.results`/`.counts` inside a rule's `when`/`args`** — those exist
  only on the bulk carrier, which is never matched. The event your rule actually
  sees always has the per-item flat shape.
* **A matched-zero rule is a silent failure mode**, not an error — if a rule you
  just registered doesn't seem to be firing, check `reactionGraph()` /
  `listReactionRules()` to confirm registration, then check whether it's reading
  the bulk shape instead of the per-item one before assuming a deeper bug.
* **`reflect-rules.ts` is the reference-correct example** to copy the shape from.

## Pointers

* Fan-out mechanism: `fanOutBulkEvent` + `matchAndRun` in
  `packages/operator-core/lib/events/engine.ts` (D-007).
* Registration + the now-documented warning: `registerReactionRule` in
  `packages/operator-core/lib/events/registry.ts`.
* The historical offender (now fixed): `packages/operator-core/lib/plan-items/reconcile-rule.ts`.
* The reference-correct example: `packages/operator-core/lib/plan-items/reflect-rules.ts`.
* Related: [bulk-tool-contract-2026-06-22](/internal/docs/agent-insights/bulk-tool-contract-2026-06-22),
  [admin-route-must-unwrap-bulk-tool-envelope](/internal/docs/agent-insights/admin-route-must-unwrap-bulk-tool-envelope)
  (the same envelope-vs-unwrapped-shape trap, on the admin-route side instead of the reaction-engine side).
