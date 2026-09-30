# Agent briefs — batch 3 (2026-06-05, late)

Batches 1–2 are ~shipped. This batch = the unclaimed remainder: new design work from the late-2026-06-05 owner discussions, verify-and-continue tails from batch 2, and backlog remainders. **Several briefs are tails** — the prior agent went quiet without a SHIPPED signal, so the first step is always *verify what landed, then continue*; never redo.

**Standing rules (every brief):** (1) re-check the plan + `coord:presence` first; claim via `coord:declare-intent`; (2) shared-tree rules (main only, git-sync owns commits, lock hook, `work_items:complete`); (3) two-port deploy model (`:3070` green — test server edits on `:3170`, promote via the release gate); (4) tests ship with the work; (5) plans marked *(author)* need a PG plan written from the embedded decisions before building.

**Owner-gated — do NOT execute, only surface:** the mem0 revive/retire decision (gated on Brief 36's scorecard) · holepunch-voice Phase 1+ (awaits greenlight) · self-improvement P3 arming · the work-items base-table rename · mobile secrets/certs (flag, don't hunt).

---

## Brief 36 — Execute memory-backend-benchmark 〔memory, M〕
**Plan:** `memory-backend-benchmark-2026-06-05` (D-001..D-006, committed).
**Mission:** the measured judge for mem0 revive-vs-retire. One suite over the neutral `MemoryBackend` seam (+ Noop control); seed BOTH backends with the same 111 real Claude memories (the seeding **is** the revive trial — mem0's embed-path fix/stub is in scope); the frozen gold set with adversarial classes (lexical-gap vs exact-identifier vs hard-negatives vs session-start intents); T1/T2 deterministic Vitest (extend `memory/suite/checks.ts`), **T3/T4 on the existing llm-testing scenarios framework** (frozen judge + rubric); the scale tier (111→1k→10k).
**Verify:** the scorecard table renders for all three backends; the report surfaces to the owner via the inbox as needs-human. **You do not make the revive/retire call** (D-006).

## Brief 37 — Operator context compaction 〔operator, M〕 *(author)*
**Mission:** the owner wants the operator to keep **effectively-full context**. Today `operator-converse-history.ts` runs a token-budgeted window + per-turn truncation — the operator *forgets*. Replace windowing with **compaction**: recent turns verbatim + a rolling summary of older turns (regenerated as turns age out), so the operator remembers the gist of everything at bounded cost. Decisions to embed: the summary is stored with the conversation (PG), regenerated incrementally (not from scratch each turn), and the summarization call is metered (it's a model call — ride the governor). Keep a config escape hatch to the old window.
**Verify:** a long conversation (>2× the old window) where the operator correctly references an early decision; token-per-turn stays bounded; the summary survives restart.

## Brief 38 — `<report>` ⊕ cards reconciliation + operator-structured→Inbox 〔operator/UX, M〕 *(author)*
**Mission:** Brief 22 shipped the `<report>` tag **before** the owner's correction landed. Reconcile per the owner's stated preferences: (a) **`<report>` stays as the wire format, and the card system becomes its rendering** — unify the models so a `<report>` block IS a card (one schema, desktop renders cards, TUI renders the two-tiered list; no parallel structured channels); (b) **the operator's non-conversational output routes to the INBOX** (the tiered inbox from Brief 21) **and is stripped from the chat stream** — "these need your review" from the operator is the same kind of item as an agent's escalation (chat = conversation only). Audit what Brief 22 + the card system actually share today; merge, don't fork.
**Verify:** an operator turn with structured content shows clean prose in chat, the structured items land in the Inbox (correct tier), and desktop/TUI render the same block natively.

## Brief 39 — The consolidated prompt rewrite (prompt-updates-pending is now UNGATED) 〔prompts, M-L〕
**Plan:** the running list at `apps/operator/docs/prompt-updates-pending.md` + the gated items accumulated across today's plans.
**Mission:** the gate ("after the underlying systems ship") has lifted — nearly everything shipped today. Execute the consolidated rewrite across the SU prompts (engineer + power) + the operator persona: (1) convert-at-pickup wording (shipped, Brief 14); (2) coord guidance re-scope — lifecycle auto-emits are live + subscription-scoped: "don't narrate the predictable; coord:send is for the unpredictable"; (3) blueprint discovery (`blueprint:catalog` + `harness:create`, incl. "to TEST a blueprint, instantiate a throwaway harness"); (4) the **query-first reflex** (state-not-chat D-004: "who's running / who's on plan P" = query `coord:presence`/the assignment view, never scan the inbox); (5) the **await-event reflex** ("don't poll or block — await-event and sleep"; the lock-conflict guidance loses "pivot/retry"); (6) the **operator wake routine** ("manage the inbox FIRST each wake — triage/downgrade/escalate with recorded why; leave it clean before sleep"). Run the tools-md sync test after every prompt edit.
**Verify:** `tools-md-sync` green; each rewrite cites its shipped system; the pending-list file is zeroed out (or items explicitly re-gated).

## Brief 40 — Wire the Overview rate-control (Brief 23's gated tail) 〔UX, S-M〕
**Plan:** `overview-dashboard-2026-06-05` (the two Brief-20-gated swaps) — **coordinate with su-37c9ba28** (rate-limit-layer-v2, in flight).
**Mission:** once Brief 20's `fleet-rate-status.ts` read-model lands: wire the Overview top-bar on BOTH surfaces to it — live usage%/$spend/bucket-headroom readout + the **editable `maxSimultaneousAgents` control** (`operator:rate_limit_config`, live-propagating, no restart). Finish the TUI Overview half if su-73795 left it (desktop shipped as default landing).
**Verify:** dropping the max to 2 from the top-bar clamps the governor live; the readout shows real headers-derived numbers where available (and honestly omits usage% on the subscription path).

## Brief 41 — Verify-and-continue: operator-always-visible (Brief 24 tail) 〔UX, S-M〕
**Plan:** `operator-always-visible` (su-814b6 went quiet, no SHIPPED signal).
**Mission:** audit what landed (TUI docked pane? desktop chat dock?); finish: the operator chat as a **persistent docked pane** on both surfaces (TUI workbench: docked beside the tabbed content like the HUD; desktop: persistent dock), rendering `<report>`/card blocks inline (coordinate with Brief 38).
**Verify:** operator visible + usable from every tab on both surfaces.

## Brief 42 — Verify-and-continue: glyph vocabulary + Fleet-label reversal (Brief 27 tail) 〔PUI, S-M〕
**Plan:** `tui-glyph-vocabulary-2026-06-05` (su-971000d4 went quiet mid-sweep; they had folded the owner's Brew→Fleet reversal in).
**Mission:** audit `glyph.rs`/`theme.rs` + the label state; finish the semantic glyph table across every tab (width-aware: single-width geometric/Nerd-Font inline, emoji only in headers) + confirm the **Fleet** label reversal is complete (titles, help, tutorial strings, test assertions, view-state fixtures — zero "Brew" remains in apps/tui).
**Verify:** `cargo test` green; `grep -r Brew apps/tui/src` returns nothing; alignment intact at 80/120 cols.

## Brief 43 — Finish Brief 17: editable Config + plugin settings + Activity verdict 〔PUI/desktop, M〕
**Plan:** `pui-completion-and-polish-2026-06-05` D-013/D-014/D-015 (su-ba750 built the effective-defaults backend; su-becbe was on the D-014 TUI side; D-015 status unknown).
**Mission:** audit + complete: **D-013** editable Config (effective defaults render; `:set key value`; PUT round-trip); **D-014** plugin settings (configSchema → form, TUI + desktop edit the same values); **D-015** the Activity/run.log deprecation verdict — find the run.log *writer*, check mtimes, then retire the TUI Activity tab (Fleet covers it) or re-point it, and record the verdict in the plan.
**Verify:** a config edit round-trips; a github-repo setting edited in the TUI shows in the desktop; the Activity decision is implemented + documented.

## Brief 44 — Mobile P2 tail 〔mobile, M-L〕
**Plan:** `mobile-apps-revival-redesign-2026-06-05` (Android shipped build-green w/ the new 5-tab model; iOS shell VM-green; P2 remains).
**Mission:** finish P2 on both: **Defguard enrollment adoption** at pair time (drop the dead wg-at-pair code), the **voice runtime-config fix verified live** (WS discovers `:3068`), **push end-to-end** (FCM deep-link on Android; APNS on iOS — **flag to the owner** if the push cert is missing), on-device/simulator e2e against green `:3070`. **Owner-gated:** the Android secrets (`google-services.json`, `picovoice.access-key`) — ask, don't hunt.
**Verify:** pair → Inbox live → chat round-trip → one push deep-link, on a device/simulator per platform.

## Brief 45 — Coordination-integration-adoption + harness-blueprint-distribution tails 〔platform, M〕
**Plans:** `coordination-integration-adoption-2026-06-03` + `harness-blueprint-distribution-2026-06-03` (su-c073a855 assessed, closed some, stood down — remainder unknown).
**Mission:** audit both plans' open items against reality (much may be done by adjacent work — e.g., subscription-scoping, the Cupboard publish arc); close the genuinely-buildable remainder; flip statuses; mark superseded items superseded with a pointer.
**Verify:** both plans reflect reality (items checked or explicitly re-scoped); anything closed has a test or a verification note.

## Brief 46 — Cross-backend cost capture: reconcile with Brief 20 〔platform, M〕
**Plan:** `cross-backend-cost-capture-2026-06-01` (draft; partially absorbed — Brief 20 captures Anthropic headers + $spend).
**Mission:** reconcile: what does Brief 20's `agent-usage-telemetry` already cover, and what remains — **per-backend cost capture for codex/OMP paths** (no Anthropic headers there), the spend rollup feeding the Overview top-bar + `operator:budget`, per-agent attribution. Close the remainder or supersede the plan into rate-limit-layer-v2 with a pointer.
**Verify:** the Overview's $spend reflects all three agent CLIs (or documents which paths are unmeasurable and why).

## Brief 47 — Linux test-VM remainder 〔infra, M〕
**Plan:** `linux-test-vm-and-federation-2026-06-04` (Brief 34 shipped the scheduler consolidation; the test-VM phases were only partially started).
**Mission:** stand up the Linux test VM per the plan's remaining items + wire the federation suite to run in it (pairs with the active phase1b work — coordinate with su-d87536).
**Verify:** the federation suite runs green inside the VM from a clean boot.

## Brief 48 — Gym tail: eval-optimizer + UI handoff + e2e 〔gym, M〕
**Plans:** `harness-gym-eval-optimizer-2026-06-02` + `gym-ui-handoff-2026-06-02` (both draft; the gym shipped as a blueprint since — D-022, `childBlueprint:<param>` landed in Brief 3).
**Mission:** reconcile the two drafts against the shipped gym-as-blueprint (much is superseded); run one **real gym cycle e2e** (gym blueprint optimizing a target blueprint via `childBlueprint`, gates + A/B math + commit); close/supersede the drafts; keep only the genuinely-missing UI handoff pieces.
**Verify:** one full gym cycle on a real target completes with the A/B gates evaluated; the drafts' statuses reflect reality.

## Brief 49 — Agent-turn-robustness: reconcile + close 〔platform, S-M〕
**Plan:** `agent-turn-robustness-2026-06-02` (draft; Brief 20 just rebuilt `turn-error.ts`/`turn-runner.ts`/`retry.ts` with the error-kind taxonomy).
**Mission:** audit the plan's items against Brief 20's landed taxonomy + retry work; close what's covered; build the genuine remainder (mid-turn crash recovery, partial-output salvage — whatever survives the audit); supersede the rest into rate-limit-layer-v2.
**Verify:** plan reflects reality; any built remainder has tests alongside Brief 20's.

## Brief 50 — Dockview-style workbench 〔PUI, S-M〕 *(author)*
**Mission:** from the owner's zellij/dockview discussion: (1) **stack the work area by default** — agent panes open into a zellij *stacked* group (tab-like, one expanded) beside the fixed HUD, instead of ever-thinner tiles; (2) ship **tuned `swap_tiled_layout` presets** in the workbench KDL (1/2/4/6-agent arrangements) so `Alt+[`/`]` cycles sensible geometries; (3) **palette dock-verbs** — `:stack`, `:float`, `:dock left` driving `zellij action` through the companion. zellij 0.44.3 supports all of it; the owner's config already binds stacked panes.
**Verify:** `pui workbench` opens with a stacked work area; 6 agents stay readable; the dock-verbs work from the palette.

## Brief 51 — Plans hygiene sweep (status reconciliation) 〔housekeeping, S-M〕
**Mission:** the plans table has known **frontmatter lag** (plans whose code shipped but whose status says draft) + superseded drafts. Sweep the 2026-06-0x plans: flip shipped-in-practice plans (verified against code/coord, not vibes — e.g. `coord-lifecycle-automation`, `engineer-issues`, `coordination-ops-as-blueprint-primitives`, `plans-pg-canonical-migration`, `git-sync-auto-commit`); mark superseded ones superseded **with a pointer** (`BRIEF-fleet-rate-limiting` → rate-limit-layer-v2; the absorbed drafts from Briefs 45/48/49); leave genuinely-open ones alone. **Read-the-code-first discipline:** never flip on a plan's own claim.
**Verify:** `plans:list` statuses match reality for the June set; every flip cites its evidence in the plan's rationale.

---

**Deliberately NOT in this batch (owner-gated):** the mem0 revive/retire call (Brief 36 produces the scorecard) · holepunch-voice Phase 1+ · self-improvement auto-implement arming · the work-items base-table rename · Brief 20's D-003 if still open (check with su-37c9ba28).
