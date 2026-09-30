# Agent briefs — batch 4 (2026-06-05, night)

Authored from a full audit of the 65 unshipped plans (22 active / 22 ready / 21 draft). **Headline finding: that count is misleading.** Most of the backlog is already shipped-but-mislabeled, owner-gated, or a design memo. After deep-diving every plan with apparent remaining work, the *real* self-servable engineering left is ~10–12 items across ~8 plans. This batch = those, rounded out with the active test-coverage campaign's disjoint lanes + the high-value housekeeping that closes out the stale-status plans.

**The #1 staleness trap (affects nearly every plan):** the operator backend was carved `apps/operator/lib/` → **`packages/operator-core/lib/`** (the SP1-C4 move). Every plan written before that has stale paths/line-numbers. Re-resolve against `packages/operator-core` before trusting a plan's file refs.

**Stale-status plans (verified done in code, never flipped) — handled by Brief 64, do not re-build:** `dbos-durable-jobs` + `dbos-orchestrator-durability` (superseded by 4 shipped `dbos-*` plans; DBOS is now default-ON), `papercusp-user-protection-gate` (P-001..P-010 shipped w/ SHAs), `calltool-endpoint-seam` (core + Phase D live-verified), `test-coverage-rest-non-critical` (22/25 done), `operator-context-compaction` (feature built, mig 168 + 15/15 green), `self-contained-migration-baseline` (core shipped).

**Standing rules (every brief):** (1) re-check the plan + `coord:presence` first; claim via `coord:declare-intent`; (2) shared-tree rules — `main` only, **git-sync owns commits (never `git commit`/`push`)**, the per-edit lock hook serializes, finish with `work_items:complete`; (3) paths moved to `packages/operator-core/lib/` — don't trust plan paths; (4) migration numbers via `db:next-migration`, never max-on-disk+1; (5) two-port deploy model (`:3070` green = release checkout, test server edits on `:3170`, promote via the release gate); (6) tests ship with the work (`npm run test:affected`); (7) TUI live-checks under **Xvfb `DISPLAY=:99`, never the user's `:0`** (no focus-steal).

**Owner-gated — do NOT execute, only surface:** `SUBMODULES_PAT` CI secret (prod-readiness P-001) · APNs `.p8`/Key-ID/Team-ID + picovoice key (mobile) · `ZEROENTROPY_API_KEY` (search-rerank) · the mem0 revive/retire decision (scorecard delivered) · operator-core C5 + per-window desktop items (supervised live-Tauri, desktop submodule) · locks-correctness live-wiring (federation seam, coordinate su-584a8; D-007 is a non-goal) · project-centric-harness-rethink companion plans (owner/architect authoring) · voice-realtime-tui owner smoke (in flight) · holepunch-voice Phase 1+ · **`needs-human` HARD stops never to auto-run:** coord-channels P-014, spec-md P-010, test-coverage-rest P-025, `unify-agent-launches` P-009 teardown (crash-looped the fleet once), DBOS legacy-file hard-delete (NO-TS-deletion rule).

**In-flight peers — stay out of their files:** su-73795 (voice-realtime-tui, `apps/tui` — standing by), su-222323 (Cupboard restyle, `apps/operator/app/cupboard/*`), su-5cf8c (app-wide-test-coverage **UI gaps** lane), rate-limit-v2.

---

## Brief 52 — Workspace RLS deny-by-default 〔security/backend, M〕
**Plan:** `per-window-workspace-context-2026-05-31`, item **P-062**.
**Mission:** harden the agent-tools dispatch chokepoint `packages/operator-core/lib/endpoint-route/routes/agent-tools/catchall.ts` (~line 73, `const { sql } = getOrgPg();`) to deny-by-default workspace scoping: hand each tool a workspace-scoped handle (`getOrgPgApp` inside `withWorkspace`, GUC = `activeWorkspaceId()`) so RLS protects every `/api/agent-tools/*` tool by default; a tool that legitimately spans workspaces must opt out by calling `getOrgPg()` explicitly (mirror the Scout customer-isolation chokepoint). First assess per-tool path usage (tools reading per-harness `harness_<slug>.*` not covered by the GUC, or genuinely cross-workspace), then convert + add a per-tool test.
**Gate:** owner owes a "P-062 go + timing" call per the plan's `## Now` — blast radius on RLS-bypassing tools is real; confirm before landing. High security value.
**Verify:** `npm run test:affected` from inside `packages/operator-core/`; a per-workspace isolation test proves a scoped tool can't read another workspace's rows.

## Brief 53 — Operator-brain MCP tool-allowlist + tool-name reconcile 〔operator, M〕
**Plan:** `voice-persona-production-readiness-2026-06-02`, items **P-009 + P-010/P-005** (the infra root-cause of operator flailing — NOT the persona tuning, which is Brief 62).
**Mission:** P-009 — add a tools-list allowlist to the agent-mcp transport (`packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts`, which today has no `?tools=` filter; the line-702 gate is profile-only) and have `agent-tools/operator/converse.ts` pass the operator's ~15–40 core tools on its `…/api/mcp?superuser=1…` URL, so Claude Code loads them non-deferred instead of all 226. P-010/P-005 — reconcile colon tool refs to underscore in `agent-tools/operator/converse-prompt.ts` (verified present: `chat:ask_choice` ×14, `harness:status/list/escalation/pending_reviews`, `issues:list`) + `operator.persona.md`/`operator.tools.md`. `/api/mcp` is the SHARED endpoint — add a test that worker/scoper spawns still see their full surface.
**Collision:** owns `converse-prompt.ts` for this batch — **land before Brief 62 rebases on it.**
**Verify:** operator-brain init shows tools non-deferred; `LLM_TEST_JUDGE_MODEL=sonnet npm --prefix apps/operator run llm-test -- --scenario op-S16` at **3× matrix**; the 600s-timeout flailing stops.

## Brief 54 — Structured stream views (desktop) 〔UX, M〕
**Plan:** `structured-streams-not-terminals-2026-06-05`, **P0** (clean pick — this is `apps/operator` React, zero TUI collision).
**Mission:** build a shared `<StructuredStreamView>` component (typed-step primary view: per-step ✓/✗/running + duration + collapsible "show only failures" + a one-click raw-output drawer that preserves the xterm escape hatch — D-002 requires the drawer in v1), fed by the existing `@papercusp/sse` `createResilientEventSource`. Then migrate `apps/operator/app/_components/ProvisionStream.tsx` off its xterm render to that component against the same `/api/provision/stream` SSE feed. Keep the D-001 interactive keep-list untouched (`PiPanel`, `dev/TerminalTab`, `InlinePtyTerminal`, `AuthSignInCards`).
**Stretch (P1):** `BranchActionRunner.tsx` + the harness-run viewers (off `harness-log-bus`/`agent-activity-bus`).
**Verify:** `npm run test:affected` (Vitest) + a Tauri-shell UI check per `/internal/docs/testing/agent-e2e` (renders in the desktop, NOT a `:3055`/`:3070` browser view). Light coordination only on the `_components` hotspot.

## Brief 55 — PUI Enter-by-location + empty-pane hint 〔PUI, M〕
**Plan:** `pui-workbench-usability-2026-06-05`, **P0** (D-001 + D-002).
**Mission:** make Enter on a Fleet-roster agent route by *where the agent lives*. **Scope correction the plan misses:** the TUI's own `RosterEntry` (`apps/tui/src/models.rs:54`) does NOT yet deserialize the `pid`/`windowId`/`ompThreadId` handles the backend already emits (`packages/operator-core/lib/adv-roster.ts`) — so **first extend `models.rs`**, then add a `client.rs` call to `POST /api/adv/sessions/focus`, then in `app.rs` dispatch Enter → local-pane `focus_pane` (via `companion.rs`) / external-window focus / `psu --resume` for ended sessions / `pty-ws` attach, checking liveness first to avoid double-spawn. Add an empty-work-area startup hint + a `[r]/[n]/[f]` no-session menu (do NOT auto-launch). Files: `app.rs`, `models.rs`, `client.rs`, `companion.rs`, `layout.rs`.
**Defer D-003** (zellij tutorial step — explicitly sequenced behind dockview/Brief 50; lands with that owner).
**Collision:** shares `app.rs` with Brief 56 + the standing-by voice work — claim-first via locks.
**Verify:** `cargo test` under `apps/tui` (317 baseline) + live pui check under Xvfb `:99`.

## Brief 56 — Workbench theme system 〔PUI, L〕
**Plan:** `workbench-theme-system-2026-06-05`, **P0**.
**Mission:** refactor `apps/tui/src/theme.rs` from hardcoded `const` RGB literals into a data-driven `ThemeSpec` registry covering the full semantic slot set (existing `selected/dim/warn/header` + liveness `live/idle/stale`, work-status `todo/doing/blocked/done`, kind/severity/accent/bg-fg), zero color literals outside it, then migrate every draw site (`theme.rs`, `ui.rs`, `fleet.rs`, `glyph.rs`) to named slots. Render must be **byte-identical** — add a per-theme render snapshot test (the `!` needs-human glyph must stay visible). Adopt the in-flight styling pass's palette as the `papercusp-dark` default (D-004) — confirm it landed first.
**Stretch (P1):** `:theme`/`:themes` palette command + ViewState (PG) persistence + live re-render.
**Collision:** the `ui.rs` slot-migration overlaps Brief 55's `app.rs` + standing-by voice — claim-first, serialize `ui.rs`. Heavier of the two TUI briefs.
**Verify:** `cargo test` under `apps/tui` + live pui check under Xvfb `:99`.

## Brief 57 — Drop spec_present/contract_present tombstone columns 〔schema cleanup, S-M〕
**Plan:** `spec-md-ui-deprecation-cleanup-2026-05-30`, item **P-007** (env now unblocked — the "branch off main / wait for psu-wrappers refactor" blocker in the `## Now` is stale; that refactor merged, the branch is gone, P-006 already landed).
**Mission:** stop writing `spec_present`/`contract_present` at `libs/papercusp/apps/web/app/api/_hono/harness.ts:~1296-1298` (the live health-check writer — NOT the `harness-fs-watcher.ts` path the plan names, that's stale), then drop both columns via a new migration in `libs/papercusp/libs/db/sql/` (number via `db:next-migration`), and remove from drizzle `schema.ts`/`generated.ts` + `libs/zero-harness/src/schema.ts`. Last tombstone removal — code-side check already gone.
**Leave:** P-005 (empty-state — owner owes surface confirmation), P-010 (`needs-human`).
**Verify:** `db:migrate` on embedded-pg + `db:check-drift` + `tsc` on the db package.

## Brief 58 — SU playbook scenario suite 〔testing/prompts, M〕
**Plan:** `su-scenario-suite-2026-05-31`. **Adopt D-001 option (a)** (in-process model loop) and proceed — the decision body already recommends it, it adds no prod surface, and pre-alpha norms say make the call.
**Mission:** **fix paths first** (home is `packages/operator-core/lib/llm-testing/`, not `apps/operator/lib/`). Build P-001 `targets/su.ts` (model `targets/operator.ts`; base `ChatTarget` from `@papercusp/testing-shell/llm`) — `send()` loads the playbook from source (`apps/operator/prompts/papercusp-su-engineer.tools.md`), runs the model via `llm-client.ts`, dispatches the `papercusp-su` catalog via `dispatchProjectedTool`. Then P-002 `rubrics/su.ts`, P-003 `scenarios/su/` wired into `scenarios/index.ts` + the `runner-aggregate.test.ts` registry assertion, P-004 author SU-S01..S06 (each ≥1 deterministic `tool_called`/`tool_not_called`/`text_excludes` assert pinned to known failure modes: Tauri/webapp, harness-arg, polling, design-docs, raw-SQL; judge secondary), P-005 run with `ANTHROPIC_API_KEY`, P-006 make it the SU-prompt gate.
**Disjoint** — touches only `llm-testing/{targets,rubrics,scenarios}`.
**Verify:** `npm --prefix apps/operator run llm-test -- --scenario su-S01 --no-matrix` then 3× matrix; `npm run lint:tests` for the new scenario files.

## Brief 59 — Integration-tier triage + honest coverage baseline 〔testing, M〕
**Plan:** `production-readiness-test-coverage-2026-05-30`, item **P-006** (now unblocked — the migration-baseline it waited on shipped; the `## Now` "BLOCKED on migration-baseline" is stale).
**Mission:** run the full `*.integration.test.ts` suite end-to-end locally against a `pgvector/pgvector:pg16` testcontainer via the `baseline-schema-global-setup.ts` globalSetup; convert never-executed surfaces into an honest red/green + coverage baseline; file the real failures as issues (expect ~355 pass / ~21 pre-existing fails — triage, don't chase the known classes: e2e "principal not provisioned", drizzle-under-vitest `is()`, P2P swarm). Then reconcile P-002 → done (hand the flip to Brief 64).
**Do NOT:** touch P-001 (`SUBMODULES_PAT` — owner-only CI secret) or the Tauri-shell E2E (supervised).
**Verify:** the suite runs green/red honestly; issues filed for real fails; coverage baseline recorded.

## Brief 60 — Shared-libs unit coverage (papercusp-shared + flags) 〔testing, M〕
**Plan:** `app-wide-test-coverage-2026-06-05`, the **deferred package-audit tranche** the `## Now` names ("continue auditing remaining packages").
**Mission:** take **`libs/papercusp-shared` + `libs/flags`** — stable, low-churn, outside the UI fan-out. Test home: Vitest unit `<pkg>/lib/**/<name>.test.ts` (`.integration.test.ts` for per-file PG via `@papercusp/test-config`). Every new file must pass `npm run lint:tests` (coverage-glob guard) + `npm run gen:contract:check` from `apps/operator`.
**Collision:** su-5cf8c owns this plan and is actively writing the 15 enumerated Phase-2 UI gaps — message them which package you take; do NOT touch those UI gaps or `libs/generic` (P-005 deferred).
**Verify:** green in isolation from a clean checkout, not the churning tree.

## Brief 61 — Harness/blueprint engine + agent-mcp coverage lane 〔testing, M〕
**Plan:** `app-wide-test-coverage-2026-06-05`, a **new disjoint lane**.
**Mission:** cover the harness blueprint engine (`libs/papercusp/packages/harness/` — `deriveNext`, the `base`/`coding`/`research`/`gym`/`review` blueprints) and `packages/agent-mcp/` role-config / tool-projection read-side — core correctness surfaces with thin coverage and no active claimant. Vitest unit + `.integration.test.ts` where PG is needed; same guards as Brief 60 (`lint:tests` + `gen:contract:check`).
**Collision:** claim the packages via `coord:declare-intent`; stay clear of the UI gaps (su-5cf8c) and the shared-libs tranche (Brief 60).
**Verify:** green in isolation; new tests discovered by the registry glob (no manual registry edit for existing areas).

## Brief 62 — Operator voice-persona behavioral hardening 〔operator/prompts, M〕
**Plan:** `voice-persona-production-readiness-2026-06-02`, the **persona items** P-002 (terseness fallback), P-003-Phase2 (card-disambiguation — note: duplicate P-003 ID, renumber), P-004 (no narrating state before the tool result), P-007 (ban jargon/IDs in `<say>`), P-008 (forbid stray `Bash`/`Task`/`<spawn>` on chat turns).
**Mission:** `converse-prompt.ts` + `operator.persona.md` edits, each landed **one phase at a time** with a 3× sonnet-judge re-validation (D-002 recipe) against op-S13–S16. Also restore the plan's **empty `## Now`** via `plans:set-now`.
**Gate (flag the owner):** D-003's 2026-06-05 EL-first directive may deprioritize the local-converse persona surface entirely — confirm priority before deep tuning.
**Collision:** rebase on `converse-prompt.ts` **after Brief 53 lands** (they own the tool-name reconcile there).
**Verify:** each phase re-validated 3× before the next; no regression on the shipped S13-S16 rig.

## Brief 63 — promote-wave `spawn_child` schema + lint 〔harness, S〕
**Plan:** `promote-spawn-child-harness-2026-05-31`, items **P-001 + P-002 only** (the additive, fail-safe slice; P-003+ commit the contentious D-002/D-003 calls — leave them).
**Mission:** P-001 — extend `WaveSchema` in `packages/operator-core/lib/agent-tools/plans/promote-policy.ts` with an optional `spawn_child` (`{slug, template?, repo?, goal?}`); P-002 — add the soft lint warning in `.../plans/lint.ts` (bad slug → null + warning, never throws), adopting the plan's own recommendation (D-001 soft-lint-not-hard-block).
**Gate:** the 4 decisions D-001–D-004 are owner-open; this brief builds ONLY the additive schema/lint and holds the behavior. If you'd rather hold the whole plan for the owner, say so.
**Verify:** Vitest on the parse path — no side effects, no wiring to actual scaffolding.

## Brief 64 — Plan-status reconciliation sweep 〔housekeeping, S-M〕  *(one agent owns ALL plan writes — avoids the plans-subsystem advisory-lock wedge that hit the fleet today)*
**Mission:** pure `plans:set-status`/`set-now` metadata (no code). Flip: `dbos-durable-jobs` → **superseded** (items→done/dropped, cite the 4 shipped `dbos-*` plans); `dbos-orchestrator-durability` → **superseded**; `papercusp-user-protection-gate` → **shipped** (P-001..P-010→done); `calltool-endpoint-seam` → **shipped** (Phase E noted declined); `test-coverage-rest-non-critical` → **shipped** (only P-025 needs-human remains); `operator-context-compaction` → P-001..P-007 done, `## Now` → "built, awaiting P-008 live DB apply"; `self-contained-migration-baseline` → **shipped** (split P-010/P-012 to an owner follow-up); reconcile `per-window-workspace-context` Now-vs-items and `production-readiness` P-002→done (after Brief 59 confirms). Consumes the audit results from Briefs 59/66/67.
**Note:** if `:3070` plan ops hang, do the writes via `:3170` (the known wedge workaround). Stops the fleet being misled by ~7 lying statuses.
**Verify:** `plans:list` shows the flipped statuses; `plans:lint` clean on each touched plan.

## Brief 65 — Coordinated docs-mirror rebuild 〔deploy, S〕  *(owner-precondition + single quiet-window job)*
**Mission:** ONE coordinated `cd apps/operator-docs && npm run build` that publishes BOTH `starlight-projection-generators-2026-06-05` (the 5 additive `reference/*` pages + "Reference" nav) AND `finish-next-removal-2026-06-01` P-012 (the Next-removal prose fixes) — they are the **same physical rebuild**, must not race.
**Precondition (do NOT proceed without it):** owner confirms starlight **D-001** (the additive 5-page set survives the big-bang-Starlight decline).
**Hazard:** `postbuild-copy.sh`'s `rsync --delete` wipes any peer doc page that lands after your `astro build`, and it commits a ~220-file diff — acquire a **docs-quiet window** via coord first, announce intent, re-run the build immediately before committing.
**Verify:** `astro build` exits 0 with the 5 `reference/*.html` present; `/internal/docs` 200s; "Reference (generated)" nav renders. Hand both flips to Brief 64.

## Brief 66 — Migration-baseline finish + compaction verify 〔cleanup/verify, S〕
**Mission:** two small isolated code/test jobs (no plan writes — feed Brief 64). (a) `self-contained-migration-baseline-2026-06-02` P-008b-remainder: remove the ~9 harmless inline `CREATE … IF NOT EXISTS` runtime-DDL no-ops in endpoint-route + feature-module creators (tables already in `000-baseline.sql`). (b) `operator-context-compaction-2026-06-05`: run `operator-conversation-compaction.integration.test.ts` from `packages/operator-core/` against a throwaway PG schema to confirm the already-built feature (migration 168 + the `operatorContextMode` pref), so Brief 64 can flip it.
**Leave:** P-010/P-012 (owner/supervised). `libs/papercusp/libs/db/sql/` is churn-heavy — never renumber.
**Verify:** `fresh-migrate.integration.test.ts` (the strict gate) green; the compaction integration test green.

## Brief 67 — Coord-channels Phase-5 dead-code audit 〔substrate/cleanup, S〕
**Plan:** `coord-channels-pg-port-2026-05-30` — confirm the Phase-5 destructive cleanup that **already happened incidentally** via the substrate-extraction refactor.
**Mission:** verify the `coord/` channel dirs and `packages/coordination/src/paths.ts` are gone, `PgCoordLog` is wired in `operator-core`, and there are no dead `FsCoordLog`/FS-helper refs in live wiring. **Surface the conflict for the owner:** the refactor *kept* `FsCoordLog` as a portable backend (`libs/generic/pubsub-substrate/`), which contradicts the plan's D-001 "PG-only, delete FS" — so P-017/P-018 (amend v2 decisions + README) can't be executed as written until the owner reconciles D-001.
**Leave:** P-014 (`needs-human`). Code/audit only — report findings to Brief 64 for the status reconcile.
**Verify:** grep confirms no live `coord/*.jsonl` writers or dead FS helpers; findings written to the plan's `## Now` (via Brief 64).

---

## Collision matrix (for simultaneous launch)

| Risk | Briefs | Mitigation |
|---|---|---|
| `apps/tui` `ui.rs`/`app.rs` | **55, 56** + standing-by voice (su-73795) | Claim-first; 56 owns `theme.rs`+`ui.rs` sweep, 55 owns `app.rs`+`models.rs`+`client.rs` — mostly disjoint, serialize `ui.rs` |
| `converse-prompt.ts` | **53, 62** | 53 (tool-names) lands first; 62 (persona rules) rebases |
| `app-wide-test-coverage` ownership | **60, 61** + su-5cf8c (UI lane) | Three disjoint tranches; message su-5cf8c, claim packages via coord |
| Plan-subsystem writes | **64** only | 59/66/67 do code/audit and hand flips to 64 (the plans wedge bit the fleet today) |
| Docs `rsync --delete` | **65** + ~6 docs editors | Quiet-window + owner D-001 precondition |

## Honest tiering
- **Real features (build now):** 52, 53, 54, 55, 56, 57 — and the additive 63.
- **Active test/prompt-quality campaign (disjoint lanes):** 58, 59, 60, 61, 62.
- **High-value housekeeping/deploy:** 64 (closes ~7 stale-status plans), 65, 66, 67.

If you want a *smaller* high-confidence batch instead of all 16, the strongest standalone picks are **52, 53, 54, 55, 58, 64** — clean lanes, real value, minimal gating.
