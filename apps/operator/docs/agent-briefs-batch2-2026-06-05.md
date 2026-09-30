# Agent briefs — relaunch batch 2 (2026-06-05)

Batch 1 (`agent-briefs-2026-06-05.md`) is ~shipped. This batch is the **new design work from the 2026-06-05 owner discussions** + the backlog tails. ~16 briefs (owner caps ~20 concurrent, leaving a few ad-hoc slots).

**Standing rules (every brief):**
1. **Most of these have NO plan yet.** Author a tight PG plan from the decisions embedded below (`plans:new` → `plans:set-content`, lint 0, decisions D-001…), THEN execute. Tails marked *(existing plan)* — continue that plan instead.
2. **Re-check before starting** — read the plan/coord; a peer may already be on it. Announce via `coord:declare-intent`; claim shared surfaces first.
3. **Deploy model:** `:3070` = green release checkout; test server edits on **staging `:3170`** (`systemctl --user restart papercup-staging-api`); promote via the release gate (green-checkpoint advances `ready` hourly; deploys deliberate via `deploy-cli --execute`).
4. Shared-tree rules (stay on main, git-sync owns commit/push, file-lock hook, `work_items:complete` not prose). Tests ship with the work.
5. **`apps/tui` is hot** — several PUI briefs touch `app.rs`/`ui.rs`/`client.rs`; coord-claim before editing.

---

## Brief 20 — Shared rate-limit layer v2 (the big one) 〔platform, HIGH〕
**Plan:** author `rate-limit-layer-v2`. The layer EXISTS (`@papercusp/rate-limit` + the shared `RateLimitGovernor` RB-012 per-(provider,model-class) buckets in `harness-invoke-once.ts` + `operator-rate-limit.ts` 503-breaker) — this brief adds the missing top half.
**Decisions:**
- **D-001 Provider-aware error classifier** — `(provider, status, headers, body) → { kind: rate_limit | usage_limit | overload | auth | other, retryable, retryAfterMs, surfaceToUser }`. Must cover **Claude** (429 / usage-limit / 503 + `anthropic-ratelimit-*` headers) AND **Codex/OpenAI** (`insufficient_quota`, their 429 shape). Detecting the error isn't enough — the *kind* dictates the response: rate_limit→back off the **whole fleet** (Claude's limit is account-wide), usage_limit→**pause + surface, don't retry**, overload→breaker.
- **D-002 Capture usage headers** — read `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}` off every response into telemetry (extends `cross-backend-cost-capture`).
- **D-003 Per-call pacing at the shared chokepoint** — pace in-flight calls against the live remaining-budget headers, not just spawn-admission. **OWNER DECISION NEEDED:** bridge-level (one chokepoint, true global view — preferred IF all agents route through the shared Meridian bridge) vs per-CLI-wrapper. Confirm the routing before building.
- **D-004 User-editable `maxSimultaneousAgents`** — lift the hardcoded `MAX_CONCURRENT_PTYS=16` (`pty-bridge.ts`) to a first-class **operator-level setting, editable live from the overview top-bar**, read by the governor immediately. Owner sets it low (e.g. 2) when using Claude themselves.
- **D-005 Adaptive concurrency under the ceiling** — AIMD (additive-increase on success, multiplicative-decrease on 429) + headers-driven ("fit under remaining budget before reset"). The user's max is the hard cap; the adaptive layer finds the safe floor. Surface the *effective* rate next to the max.
- **D-006 Cascade-aware** — on an account-wide rate_limit, pause the fleet briefly (avoid the thundering-herd re-trip that costs context + spend), don't let every agent retry at once.
**Verify:** a simulated 429 backs off the fleet (not one agent); a usage-limit pauses + surfaces a reset time; usage% reads from real headers; the max edits live and the governor honors it.

## Brief 21 — Inbox tiering + message-the-agent 〔UX, HIGH〕
**Plan:** author `inbox-tiering-and-message-agent`.
**Decisions (owner-updated 2026-06-05 — SURFACE-FIRST triage model; supersedes the original "tighten needsHuman at the source"):**
- **Surface-first, no gate.** An agent surfacing need_human → `needs_human` IMMEDIATELY (user-visible). NO `needs_review`/operator-gated intermediate state. Fail toward visibility — a sleeping operator must never hide a real decision (missing one ≫ a false positive).
- **Loose criteria at the source; operator is the precision filter.** Agents surface generously (they have limited context); do NOT over-engineer static rules to perfectly classify `needsHuman` — rules are a cheap pre-sort, **operator triage is the real filter** (judgment).
- **Operator triage is a PASS, not a gate**, run at the operator's NEXT wake. Wakes are **USER-DRIVEN** (the user wakes the operator during normal work) — **NO event-wake on inbox pressure** (owner explicitly rejected it; accepts some uncleaned items between wakes). At wake the operator downgrades false positives, **escalates under-flagged** ones (its bigger context catches missed urgency), and confirms/enriches the rest.
- **Downgrades are VISIBLE + auditable** — resolved-by-operator items move to a **"Handled by operator"** tier carrying *what it did + why*, never a silent vanish.
- **Tiers: Decisions (untriaged + operator-confirmed) ▸ Handled-by-operator (audit) ▸ Alerts ▸ Activity** — only Decisions demands the user.
- **"Message owner" action** on each item → opens a thread with the owning agent scoped to its work-item (`coord:ask-owner` / a conversation). TUI + desktop.
- **Operator prompt (triage side):** "manage the inbox FIRST each wake" (downgrade/resolve/annotate before other work), leave it clean before sleeping, and record the *why* on each downgrade (audit + the operator learns its own triage).
**Verify:** an agent's need_human is user-visible immediately; the operator downgrades a false positive into the Handled tier *with a rationale* (not a vanish) + escalates an under-flagged one; "message owner" opens a scoped, context-carrying thread.

## Brief 22 — `<report>` structured-message protocol (cards ⊕ TUI) 〔platform+UX, HIGH〕
**Plan:** author `structured-report-protocol`.
**Decisions:** The operator already emits control tags (`<say>` = prose, `<spawn>`, …) parsed by `chat_tags.rs` + `operator-converse-tags.ts`. Add a **`<report>`** tag carrying structured per-plan/per-item blocks; instruct the operator (prompt) when to emit it. **Desktop renders `<report>` as cards** (unify with the existing operator card system), **TUI renders it as a two-tiered plan→item list** (extend `chat_tags.rs`). Chat prose stays clean; structured content renders structured.
**Verify:** operator emits a `<report>`; desktop shows cards; TUI shows the two-tiered list; the `<say>` prose is unaffected.

## Brief 23 — Overview / dashboard view 〔UX, HIGH〕
**Plan:** author `overview-dashboard`. *(Depends on Brief 20's usage surface + Brief 21's tiers — can stub those, but coordinate.)*
**Decisions:** The single highest-value new surface (owner-approved mockup). A **new Overview tab (the default)** in the TUI + a desktop equivalent: **top bar** = rate/usage% · $spend · **editable `maxSimultaneousAgents` control** · alerts badge; **tiles** = Plans (active progress bars) · NEEDS-YOU (the tiered inbox from Brief 21) · Agents (live, top-N, what they're doing) · Activity (live stream); **always-on operator strip** at the bottom (Brief 24). Every tile clicks through to its full tab.
**Verify:** renders live data; top-bar usage + max-edit functional; tiles click through; it's the default landing surface.

## Brief 24 — Operator always-visible (docked pane) 〔UX〕
**Plan:** author `operator-always-visible` (or fold into Brief 23's plan — coordinate).
**Decisions:** Make the operator chat a **persistent docked pane**, not a tab you switch to — TUI workbench: dock it beside the tabbed content (like the HUD pane); desktop: a persistent chat dock/sidebar. Renders `<report>` blocks (Brief 22) inline.
**Verify:** operator chat visible + usable on every tab/surface.

## Brief 25 — Conversations tab 〔UX〕
**Plan:** author `conversations-tab`.
**Decisions:** TUI + desktop tab over `coord_conversations` (+ `coord_thread_posts` replies, topics joined via `coord_links`). **List** filterable by state (open/answered/resolved) / kind (question/discussion) / topic; **detail** = the thread + accepted answer + linked work-item + **promote-to-issue** action; surface all fields incl. topics. Pairs with Brief 21's message-the-agent (same surface, browse vs inbox entry).
**Verify:** list + detail render with topics; filters work; promote-to-issue works.

## Brief 26 — OPS → pui terminal button 〔desktop, SMALL〕
**Plan:** author `desktop-pui-launch-button`.
**Decisions:** Add a **terminal-icon button next to the OPS button** in the AdvShell header; a Tauri command spawns a terminal emulator running `pui workbench` (reuse the `console-launcher`/`psu` terminal-spawn pattern; resolve `$TERMINAL`). 
**Verify:** clicking opens a terminal running the live pui workbench.

## Brief 27 — UI glyph/icon vocabulary (throughout, not just tabs) 〔design-brief〕
**Plan:** author `tui-glyph-vocabulary`. **First step: write the glyph brief, get owner sign-off, THEN implement** (owner rates visual execution as needing a spec, not freehand).
**Decisions:** A **semantic glyph table** defined once (a `glyphs` module + `theme.rs`) applied **throughout** the TUI — liveness (●◐○) · work-status (todo/doing/blocked/done) · kind (feature/bug/plan/chunk) · severity · row actions — plus the tab strip. **Width-aware:** prefer single-width geometric Unicode + Nerd-Font glyphs for in-line use; reserve emoji for headers (emoji are double-width and break TUI alignment). Coordinate — `apps/tui` is hot.
**Verify:** consistent glyphs across every tab; alignment intact at 80/120 cols.

## Brief 28 — Coord auto-emit subscription-scoping (noise → targeted) 〔platform〕
**Plan:** author `coord-emit-subscription-scoping`. *(Extends coord-lifecycle-automation + the topics/subscribe substrate.)*
**Decisions:** Lifecycle auto-emits currently broadcast to `*` (~360 events/6h to everyone). Make them **subscription-scoped** — delivered only to agents watching that plan/topic/work-item. The coordination signal is preserved (watchers still get what they need); the firehose stops. This also feeds Brief 21 (only relevant events reach the inbox).
**Verify:** an auto-emit reaches only subscribers; broadcast volume drops sharply; a watching agent still receives its plan's events.

## Brief 29 — Starlight projection generators 〔docs〕
**Plan:** author `starlight-projection-generators`. *(Implements docs-and-memory-as-projections, framework shipped.)*
**Decisions:** Write `gen-*` projectors (read PG/registry/code → emit MDX into `apps/operator-docs/src/content/docs/`, Starlight builds it) for the high-value sources: **tool catalog, blueprint catalog, plans index, the role/persona registry, agent-insights**. Wire into the build (`gen:` scripts + CI check that the projection is current). Hand-written prose stays; derivable reference pages become projections.
**Verify:** a projected page regenerates from its source + builds in Starlight; the CI freshness check gates drift.

## Brief 30 — mem0 revive-vs-retire + ClaudeFileMemoryBackend 〔memory, has needs-human〕
**Plan:** author `mem0-revive-or-retire`. *(Builds on Brief 10's neutral `MemoryBackend` seam — shipped.)*
**Decisions:** mem0 is stillborn (2 test rows, broken embed path). Build the **`ClaudeFileMemoryBackend`** on the neutral seam (reads/writes `~/.claude/projects/<project>/memory/*.md`, respects the auto-generated-index rule) so the **de-facto Claude memory becomes a selectable backend** with real data → the memory tab works. The final **revive (seed+fix mem0) vs retire** call is **`needs-human`** — present the measured tradeoff, don't decide autonomously.
**Verify:** ClaudeFileMemoryBackend is selectable + the memory tab shows real Claude-memory data; the revive/retire decision is surfaced for the owner.

## Brief 31 — tui-workbench P-010 tail 〔PUI〕 *(existing plan: tui-workbench-ratatui-2026-06-04)*
**Mission:** the remaining P-010 items — **coord-inbox→PUI push bridge** (handoffs/escalations notify in-TUI; needs the coord owner-identity decision — flag it), **HTTP remote transport** verified against a real remote `serve` instance, **production spawn-to-pane** orchestration (the blueprint-as-tool wiring so an operator-spawned agent opens as a pane).
**Verify:** a coord handoff notifies in the PUI; remote transport works end-to-end; an operator spawn opens a pane.

## Brief 32 — Finish the Next.js removal 〔platform〕 *(existing plan: finish-next-removal-2026-06-01, status ready)*
**Mission:** execute it. operator-vite still imports `app/**` via the `@/app` alias + `next/*` compat shims — remove the shims, complete the `next/*` removal, keep the live page implementations working under Vite.
**Verify:** operator-vite builds + runs with zero `next/*` imports; the Tauri shell loads clean (test via the desktop shell, not a browser).

## Brief 33 — Bidirectional federation phase-1b 〔substrate, L〕 *(existing plan: papercusp-phase1b-bidirectional-federation-impl-2026-06-01)*
**Mission:** implement bidirectional federation per the plan (read it + the substrate-model-b impl + revocation plans first; this is the cross-machine sync arc). Verify per the plan's acceptance + a two-instance federation smoke.

## Brief 34 — DBOS scheduler consolidation + test-VM infra 〔infra〕 *(existing plans: dbos-scheduler-consolidation-2026-06-03, linux-test-vm-and-federation-2026-06-04)*
**Mission:** consolidate the DBOS schedulers (the routines/autoloop/orchestrator tickers into one durable scheduler per the plan) and stand up the linux test-VM + federation harness. Verify: one scheduler drives the ticks; the test VM runs the federation suite.

## Brief 35 — Production-readiness tails 〔misc cleanup〕 *(existing plans)*
**Mission:** close the open items in `voice-persona-production-readiness-2026-06-02`, `harness-blueprint-distribution-2026-06-03` (the distribution tail), and `coordination-integration-adoption-2026-06-03`. Read each plan, pick up its remaining items, verify + flip to shipped where done. This is a sweep — re-check each before starting (some items may already be done).

---

**Sequencing notes for the owner:** Brief 20 (rate-limit) is the foundation — its usage surface + `maxSimultaneousAgents` feed Brief 23's overview top-bar; Brief 21's tiers feed Brief 23's NEEDS-YOU tile; Brief 22's `<report>` + Brief 24's docked operator feed Brief 23's operator strip. So **20→21→22 can run parallel, with 23/24 slightly behind them**. 26, 27, 29, 32 are independent and small-ish. One owner decision is embedded in Brief 20 (D-003: bridge-level vs per-CLI pacing) and one needs-human in Brief 30 (mem0 revive/retire).
