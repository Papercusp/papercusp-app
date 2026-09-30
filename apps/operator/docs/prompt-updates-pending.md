# Pending prompt updates

A running list of prompt rewrites **deferred until their underlying surface lands**. The pattern: we keep redesigning systems (work_items, the event/coord automation, blueprints) whose new behavior the agent prompts must eventually reflect — but rewriting a prompt against a *hypothetical* surface guarantees drift from what ships. So we **defer the rewrite, record it here, and do it once the surface is real.**

> **How to use:** append an entry when you defer a prompt update; include *what / why deferred / gate (the condition that unblocks it)*. When a gate clears, do the rewrite and remove the entry.

## SU / psu prompt — `apps/operator/prompts/papercusp-su-{engineer,power}.tools.md`

> **STATUS 2026-06-08 — list FULLY ZEROED. The consolidated rewrite (Brief 39) executed items 1–3 + 5–8 on 2026-06-05; the last holdout, item 4 (memory/mem0), is now APPLIED 2026-06-08 — the owner revived the backend as the HYBRID and both SU prompts' caveat was flipped to "use the live `memory:*`".** Applied log (each cites its shipped system; full text in git history of this file):
>
> 1. **convert-at-pickup** ✅ 2026-06-05 — both SU prompts' *Coordination* (`unify-work-items` RFC D-015).
> 2. **coord re-scope (typed ops; auto-emits; `coord:send` only for the unpredictable)** ✅ 2026-06-05, **subscription-scoping clause added late 2026-06-05** ("auto-emits reach watchers, not the fleet" — `coord-emit-subscription-scoping-2026-06-05`; "don't narrate the predictable") — both SU prompts (`coord-lifecycle-automation-2026-06-04`).
> 3. **work-item / blueprint vocabulary + Pot/Brew/Cup naming** ✅ 2026-06-05 — both SU prompts' *Orientation* (`unify-work-items`, `project-centric-harness-rethink` D-014).
> 5. **blueprint discovery** ✅ 2026-06-05, **`blueprint:catalog` named + throwaway-harness-to-test added late 2026-06-05** — both SU prompts now teach `blueprint:catalog` → `validate`/`extend` → `harness:create`, incl. "to TEST a blueprint, instantiate a throwaway harness" (`autoloop-pot-operator-rebuild-2026-06-05` P-003).
> 6. **query-first fleet-state reflex** ✅ late 2026-06-05 — both SU prompts' *Coordination* + `operator.tools.md` ("who's working on what?" workflow) + the pot persona's *Survey*: `fleet:assignments` / `coord:presence` for state, never inbox-replay; the inbox is for messages addressed to you; machine change-awareness = the `fleet_assignment` NOTIFY feed (`state-not-chat-fleet-state-2026-06-05` D-004, migration 165).
> 7. **await-event reflex ("don't poll or block — `events:await` and sleep")** ✅ late 2026-06-05 — both SU prompts: lock-blocked → `locks:acquire { wake_on_grant: true }` → end turn (the "pivot/retry/yield" lock guidance is rewritten); announced events → `events:await { event, note, on_timeout: 'wake' }`; pair-emit via `events:emit`; ack a parked wake with `events:cancel { delivery_id }`; rate-limit wake-at-reset; `events:status { meter: true }`; notify ≠ wake, a wake costs a turn (`await-event-primitive-2026-06-05` D-002/D-005/D-007).
> 8. *(Brief 39 item 6)* **operator wake routine — inbox-first triage** ✅ late 2026-06-05 — the pot operator persona (`blueprints/pot/prompts/operator.md`): triage via `inbox:triage` with recorded WHY (required on downgrade/resolve), escalate under-flagged items, **leave the inbox clean before sleep**; pot blueprint `dependencies.tools` += `inbox:triage`, `fleet:assignments` (`inbox-tiering-and-message-agent-2026-06-05` D-006/D-007, `autoloop-pot-operator-rebuild` D-013). The scanner-side prompt (`operator-prompt-system.ts`) already carried the full triage pass.
>
> **Note on reach:** the SU playbooks render per-launch from the **release checkout**, so these rewrites go live on psu at the next release-gate deploy — the same deploy that puts `events:*` / `fleet:assignments` / `blueprint:catalog` on `:3070`. Prompt and surface arrive together by construction.

> 4. **memory: backend REVIVED as the HYBRID — ✅ APPLIED 2026-06-08.** The owner's revive-vs-retire call (the gate) was made off the `memory-backend-benchmark-2026-06-05` scorecard + the `memory-backend-improve-and-hybrid-2026-06-08` build: **REVIVE**. The HYBRID backend (cosine = `harness_shared.memory_canonical` in PG, OpenAI-embedded · lexical = the owner's Claude file store) is live + populated — the owner's 142 durable memories were migrated in (`packages/operator-core/lib/memory/migrate-claude-to-cosine.ts`), the junk cleared, and `operator_settings.memory_backend` flipped to `hybrid`. Both SU prompts' caveat was FLIPPED from "⚠ mem0 unpopulated, rely on client-native memory" to "✅ memory backend is LIVE — use `memory:*`, not your client's BUILT-IN store" (covers Claude / Codex / OMP). **OPEN nuance flagged to the owner:** the user's personal `~/.claude/AGENTS.md` "edit topic files" memory guidance is a *separate layer* (the owner's direct Claude CLI + the hybrid's lexical leg), so reconcile-vs-keep is the owner's call — not auto-changed.

## Role personas — `libs/papercusp/packages/harness/prompts/<role>.md`

*(append role-prompt updates here as roles/blueprints change — e.g. new demo-blueprint personas, the scanner→`scan`-blueprint persona, etc.)*

---
*Append new deferred prompt updates above. Last updated 2026-06-08 — list fully zeroed (item 4 memory/hybrid applied; only the owner-call nuance on `~/.claude/AGENTS.md` remains open).*
