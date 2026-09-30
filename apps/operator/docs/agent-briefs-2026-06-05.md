# Agent briefs — relaunch batch 1 of N (2026-06-05)

**How to use:** hand ONE brief to each `psu` agent at launch (16 briefs ≈ the 16-agent parallel ceiling). Each brief is the *mission envelope*; the named plan (PG-canonical — `plans:get { harness:'all', slug }`) carries the detail and is authoritative.

**Standing rules for every brief:**
1. **Re-check before starting.** Read the plan's status/items AND `coord:presence` — an autonomous-loop agent may already be (or have been) on this plan. If work landed, **verify it and continue from the next phase**; never redo or duplicate. Announce with `coord:declare-intent`.
2. **Shared-tree rules apply:** stay on `main`, no commits/pushes (git-sync owns them), file-lock hook serializes edits, record completions on the work item (`work_items:complete`) — not prose coord spam.
3. **The deploy model changed (2026-06-05):** `:3070` runs the GREEN release checkout (`papercup-release`); restarting it does NOT pick up your `lib/**` edits. Test live server edits against the **staging operator `:3170`** (`systemctl --user restart papercup-staging-api`), promote via the release gate (`green-checkpoint` → `deploy-cli`).
4. Tests ship with the work (`npm run test:affected`); plans get their items checked off as you land.

---

## Brief 1 — Pot operator: P0+P1 of the autoloop rebuild 〔v1-core, L〕
**Plan:** `autoloop-pot-operator-rebuild-2026-06-05` (D-001..D-004; P0/P1). *A loop agent (su-487a71…) started P0 — verify + continue.*
**Mission:** the **Pot** exists as a minimal operator blueprint: woken with "you're the operator in charge — figure out what to do"; before ending a turn it **declares its own next wake** (a time, an event-subscription via the event-reaction system, or nothing; user can override; a wake-floor clamp stops spinning). Its superpower tool exists: **`harness:create-from-blueprint`** + the blueprint-catalog discovery so it can *choose* which harness to spin up.
**Verify:** a Pot session wakes, surveys (work_items frontier / spawn-tree / events), makes one decision, declares its next wake; `harness:create` from a named blueprint produces a working harness.
**Constraints:** ride DBOS + the event-reaction system (no new timer loops); judgment sparse, substrate deterministic (D-004).

## Brief 2 — Blueprint-driven dispatch: autoloop P2 〔v1-core, M〕
**Plan:** `autoloop-pot-operator-rebuild-2026-06-05` (D-005; P2).
**Mission:** lift the hardcoded dispatch policy (`computeFrontier` in `packages/operator-core/lib/dbos/orchestrator-loop.ts` — readiness/priority/concurrency/costCap/SAFETY_CEILING) into a **`dispatch:` blueprint section** (`{concurrency, priority, readiness, costCap, safetyCeiling}`), and drive each harness's autoloop from its own blueprint (detach from `director-config.json`). `coding` declares `concurrency:4`; `research` declares `concurrency:1`.
**Verify:** schema test for `dispatch:`; the orchestrator tick reads the per-harness blueprint policy; byte-equivalence on the coding pipeline's behavior.
**Constraints:** behavior-preserving for the feature pipeline; coordinate with Brief 1 (same plan).

## Brief 3 — Declarative lifts + autoloop fixes: P3+P4 〔v1-core, M-L〕
**Plan:** `autoloop-pot-operator-rebuild-2026-06-05` (D-006..D-009; P3/P4).
**Mission:** (a) the **`requires:`** precondition field on `defineTool` — MatchMap over args+state, `{error}` reject | `{fire, then:retry}` auto-correct, evaluated via `@papercusp/rules` at preInvoke (the mirror of `emits:`); (b) **`childBlueprint: <param>`** on the recursion schema (the gym's runtime override becomes declared); (c) the autoloop fixes — read `consecutive_errors` → circuit-break, resolve the `director` role-name collision, **delete the legacy `setInterval` loop**; (d) keep safety gates imperative (D-007 — don't lift don't-deploy-on-red/protected-paths/quota into rules).
**Verify:** a `requires:` reject + an auto-correct each covered by a test; a gym recursion resolves a parameterized child; the legacy loop is gone.

## Brief 4 — Operator→spawn: the minimal human-testable path 〔v1-core, M〕
**Plan:** none yet — findings live in this brief; add items to `autoloop-pot-operator-rebuild-2026-06-05` as you go.
**Mission:** the owner can make the operator spawn one agent and watch it. Today the only working spawn is the coord-program path (`coordSpawnRunner` → `spawned_agents`, 25 rows); the operator-chat `<spawn role=… feature=…>` tag is dead — it POSTs `/api/plugins/orchestrator/spawn` (**404**) and targets `harness='system'` (no repo). Do: (1) repoint the `<spawn>` tag (`agent-tools/operator/converse.ts:394` + `operator-converse-tags.ts`) at the working nursery spawn with a **real registered harness slug** + real `projectDir`; (2) give the human a trigger (a chat command / admin action: "spawn <role> in <harness> on <feature>"); (3) **unify spawn-tracking** — what's spawned must appear in `fleet:tree` (the durable `spawned_agents` nursery, not the plugin's in-memory Map); (4) seed a test harness (real repo + ≥1 `todo` feature).
**Verify:** the owner triggers a spawn from operator chat → an agent process starts in the right repo → a `spawned_agents` row goes `running→done` → visible in `fleet:tree`/the Fleet tab.

## Brief 5 — Close the self-improvement loop 〔v1-core, M〕
**Plan:** `close-the-self-improvement-loop-2026-06-05` (D-001..D-003; P0–P2). *A loop agent (su-585f80…) started P0 — verify + continue.*
**Mission:** the loop closes: the `implement` blueprint gets a real **worker prompt**; an **`improvements:resolve`** back-edge marks a verified fix done so it leaves the queue; capture writes the real `kind` column + populates `paths` (so the protected-path gate fires); the **watchdog hard feed-in** auto-captures RED-test/CI signals as `work_item[kind=bug]`.
**Constraints:** **do NOT arm auto-implement** (P3/D-004 is owner-gated); keep the runner isolated (D-005 — never the operator's own harness).
**Verify:** a synthetic bug flows capture→triage→(manually dispatched) implement→resolve and leaves the queue; a forced RED test auto-captures exactly one deduped bug.

## Brief 6 — Official blueprints → the Cupboard 〔distribution, M〕
**Plan:** `official-blueprints-cupboard-publish-2026-06-05` (D-001..D-005). *A loop agent (su-13244…) started P0 — verify + continue.*
**Mission:** all 14 built-in blueprints carry real `dependencies: {tools, plugins}` blocks (derived from their role personas — today 0/14 declare any) and are **published as `kind=blueprint` listings via the standard publish path** (gh attestation, author = the papercupai account — no special-casing). The bundle stays as the bootstrap fallback; `blueprint:extend`/`validate` stop gating on built-in-only parents.
**Verify:** `GET /api/cupboard/listings?kind=blueprint` shows the 14; a fork of one resolves; the dep-validator fails loud on a missing plugin dep.

## Brief 7 — Tool-distribution granularity (packs) 〔distribution, M-L〕
**Plan:** `tool-distribution-granularity-2026-06-05` (D-001..D-005). *A loop agent (su-5ca84…) started P0 — verify + continue; it already coordinated with Brief 6's agent.*
**Mission:** the pack model lands — tool = pack[n=1], plugin = pack+runtime; deps stay declared on **tools**, resolved to providing packs/plugins; `DependenciesSchema` → `{tools, packs, plugins}`; the marketplace gets tools + packs sections.
**Verify:** a blueprint declaring one tool out of a multi-tool pack installs only what it needs; the Cupboard renders the tools/packs sections.

## Brief 8 — PUI P0+P1: naming, tabs, dead-tab fixes 〔PUI, M〕
**Plan:** `pui-completion-and-polish-2026-06-05` (D-001/D-002/D-004/D-005/D-009 + tutorial visibility). *A loop agent (su-07e61…) started P0 — verify + continue.*
**Mission:** Harnesses→**Pots**, Fleet (labels only, both PUI + desktop AdvShell); tab order Operator/Inbox/Plans first; **merge Fleet+Sessions** (keep Fleet's superset view, fold in `n`-launch + dossier, one cursor); unify the duplicated keybinding map; **Testing run-on-click** (the backend `/testing/run` exists — wire client+action+Enter); **Activity → `agent_activity`** (or retire — owner leans retire since Fleet covers it); **Docs → the `/internal/docs` corpus**; add header rows + highlight (none exist today); the **plans-filter collapsible sidebar** on Inbox+Sessions (all data already client-side); a config-empty placeholder; **a very visible tutorial launch** (a footer hint + a `?`-menu entry + a palette `:tutorial` — tutorial.rs exists, it's just not discoverable).
**Verify:** `cargo test` green + a live workbench walkthrough of each change.

## Brief 9 — PUI P2: POTS selector, Cupboard tab, create/share-pot 〔PUI, L〕
**Plan:** `pui-completion-and-polish-2026-06-05` (D-003/D-010/D-011).
**Mission:** (a) the **global Pot selector** with "All Pots" — mirror the desktop's two-axis model (`?slug` + `?scope=all`; never an "all" papercup in the slug); selector overlay + ViewState persistence; thread the filter through the global tabs (plans carry a slug → client-side; roster/attention may need a backend `?harness=` param). (b) a **Cupboard tab** — kind-filter row / search / list / detail / per-kind actions (join·fork·install) — entirely against the existing `/api/cupboard/*` + `/api/snapshots/*` routes (zero backend). (c) **`:create <slug> <path>`** and **`:share <slug>`** palette commands → `POST /api/harness/projects` and the share-finalize + cupboard-publish sequence.
**Verify:** filter narrows every tab; a plugin installs from the Cupboard tab; `:create` produces a registered pot.

## Brief 10 — Memory backend generalization 〔platform, M〕
**Plan:** `generalize-memory-backend-swappable-2026-06-05` (D-001..D-005).
**Mission:** a neutral **`MemoryBackend`** interface in the shared lib `libs/generic/memory` (`remember/search/list/forget/update` over `{id,text,kind,scope,metadata}` — no mem0 vocabulary); mem0 wrapped as one impl behind the `getMemoryClient()` choke point; the `memory:*` handlers + the desktop memory page generalized off the mem0 shape; a backend **selector** + a `NoopBackend`. Then the PUI Memory tab (pui plan D-006 step 2) against the neutral shape.
**Constraints:** keep the core interface small — mem0's pgvector dedup/anchors become an optional capability, not core. `ClaudeFileMemoryBackend` is optional P3 (owner undecided on the store).
**Verify:** lib tests for both impls; the tools work identically on mem0; the selector flips backends without touching handlers.

## Brief 11 — Release-gate completion (the cutover follow-ups) 〔stability, M〕
**Plan:** `release-gate-ready-branch-2026-06-04` + the 2026-06-05 cutover state (READ `apps/operator/lib/release/README.md` first).
**Mission:** the cutover happened (`:3070` = green `papercup-release`; staging `:3170` = main; the setup-script node_modules bug was fixed in main). Finish it: (1) **a fresh end-to-end deploy** — advance `ready` to current main + `setup-release-checkout` + `deploy-cli --execute` — proving the fixed script and getting the newest prompt edits live on `:3070`; (2) update the **power prompt + CLAUDE.md** restart-guidance to the two-port model (the engineer prompt is already done — mirror it); (3) **decide + implement the routine posture**: green-checkpoint auto-advance on/off (owner leans deploys-stay-deliberate; document whichever); (4) the README's step-4 audit — `console-launcher.ts` + any cwd-relative spawn paths must target the **integration tree**, not the release checkout (set/verify `PAPERCUSP_INTEGRATION_ROOT`).
**Verify:** the deploy runs clean with auto-revert untriggered; `:3070` serves the post-cutover prompts; a spawned agent lands in the integration tree.

## Brief 12 — Functional verification of the psu/coordination updates 〔verification, S-M〕
**Plan:** none — this is the pre-relaunch test pass (#4). File `issues:create` / `improvements:capture` for every break.
**Mission:** from a real psu identity (coord tools reject a bare SU token — psu gives you `uiClientId`), functionally verify: the **lifecycle auto-emits** (`work_items:claim` → "Taking X"; `work_items:complete{completion}` → structured broadcast; `coord:declare-intent` → intent emit; `work_items:create[kind=bug]` → finding) observed from a SECOND identity's `coord:inbox`; `coord:ask` knowledge-first + conversation-on-miss; `topics:subscribe`→tag→inject; `issues:link blocks` flipping a plan item to `blocked`; `blueprint:validate/extend`; `harness:create` (dry); `dev:coord_categorize` sanity. Confirm the SU prompts' tool references all resolve on the live `:3070`.
**Verify:** a written pass/fail matrix posted as the work item's completion record + issues filed for failures.

## Brief 13 — Adopt the event/rules engines (the migration inventory) 〔platform, M-L〕
**Plan:** `adopt-event-rules-engines-2026-06-04` (the full audit inventory is in the plan).
**Mission:** execute the migration inventory: move the audited hardcoded reaction sites onto **`emits:`**/`registerReactionRule` and the audited precondition/gate sites onto **`requires:`**/`@papercusp/rules` (condition-language convergence is the load-bearing decision — MatchMap everywhere). Do NOT migrate the explicitly-excluded safety gates.
**Constraints:** depends on Brief 3's `requires:` field for the precondition half — sequence behind it or start with the `emits:` half.
**Verify:** each migrated site has a rule-level test; `events:graph` shows the new rules; no behavior change.

## Brief 14 — Work-items remainder + convert-at-pickup tooling 〔platform, M〕
**Plan:** `unify-work-items-2026-06-04` + `project-centric-harness-rethink-2026-06-04` (D-015) + `plan-item-assignment-claim-liveness-2026-06-04`.
**Mission:** close out unify-work-items' open items (check the plan — the kind-views/rename tail), and make **convert-at-pickup real end-to-end**: the SU prompts now instruct "working a plan item = convert it to a work_item first" — verify the conversion verb exists and is ergonomic (plan-item → `work_item` with kind + claim + lease, linked back to the plan item), build/fix it if not, and wire the PUI plan-item claim (tui-workbench P-010, EI-8 fixed) to it.
**Verify:** pick a real plan item, convert→claim→complete; the plan item reflects the work_item's state; the lifecycle auto-emits fire.

## Brief 15 — Claude-memory projection integration 〔memory/docs, M〕
**Plan:** `claude-memory-projection-integration-2026-06-05` (D-001..D-007) + `docs-and-memory-as-projections-2026-06-05` (P0–P3 shipped, being verified by su-1785d6…).
**Mission:** make the docs-and-memory projection system work with the **Claude Code file memory** (the de facto store — mem0 is stillborn/deferred per D-008): the projection writes/reads the Claude topic-file format (`~/.claude/projects/<project>/memory/`), respects the auto-generated-MEMORY.md rule (never hand-edit the index), and stays consistent with the memory-compact SessionStart hook that shipped in `fix-claude-code-memory-2026-06-05`.
**Constraints:** coordinate with Brief 10 (the `MemoryBackend` seam) — the projection should target the neutral interface where it touches memory:*; don't re-litigate the mem0 deferral.
**Verify:** a projected fact lands as a valid topic file + appears in the regenerated index; round-trip with the hook.

## Brief 16 — Voice mode in the TUI: P0–P2 〔PUI, L〕
**Plan:** `voice-mode-tui-port-2026-06-05` (D-001..D-005).
**Mission:** PTT voice in the TUI: the Rust audio stack (`cpal` capture + `rodio` playback + `hound` WAV + 16k resample) in a new `apps/tui/src/voice.rs`; HTTP clients for the existing **Whisper STT** (`/v1/audio/transcriptions`) + **Kokoro/ElevenLabs TTS** endpoints; a hold-to-talk key on the Operator tab driving record → transcribe → operator-converse → speak.
**Constraints:** NO WebRTC/VAD/wake-word (browser-bound, out of scope — D-005). Disambiguate the default mic first (this box has the Brio + multiple USB devices — see the audio-setup notes). Never drive/steal the user's live audio focus for testing without an isolated check.
**Verify:** a record→play smoke test; a full PTT turn end-to-end against the live engines.

## Brief 17 — TUI: editable Config, plugin settings, tutorial visibility, Activity verdict 〔PUI, M-L〕
**Plan:** `pui-completion-and-polish-2026-06-05` (D-012..D-015) — read it first. *These are the owner's 2026-06-05 follow-up review items; an investigation was queued but never run — it is your first step.*
**Mission (4 parts):**
1. **Visible tutorial launch (S).** `apps/tui/src/tutorial.rs` exists but only fires on first run. Make it discoverable three ways: a footer/help-bar hint, an entry in the `?` help overlay, and a **`:tutorial`** palette command that re-opens it any time.
2. **Editable Config tab (M).** Today it read-only renders the harness's `.claude/settings.json` (empty for `papercup` → blank pane). Owner's direction: **the Config tab should let you configure the settings, and when empty it should show the DEFAULTS**, not a blank. Investigate first: (a) what `.claude/settings.json` controls + whether a write endpoint exists (`packages/operator-core/lib/endpoint-route/routes/harness/config-files.ts` — add a `PUT` if missing); (b) where the defaults live (find or define a defaults template so "empty = defaults" is real, then render *effective* settings = defaults overlaid by the file); (c) whether "Config" should also cover the broader surfaces — `/api/agent-config`, `operator:preferences`, flags (`POST /api/flags/set` exists). **Note:** the TUI's "write-side settings stay on the desktop" v1 posture (`app.rs:228`) is **overridden** by this brief — update that comment. Start with a `:set <key> <value>` palette command or a field-editor overlay; round-trip edit→save→re-render.
3. **Plugin settings in the TUI (M).** Plugins declare a **`configSchema`** in their manifest (`libs/papercusp/plugins/github-repo/papercusp.json` has one; the field is in `packages/plugin-sdk/papercusp-plugin.schema.json`) — that's how the git plugin was configurable in the desktop settings page. Investigate the full chain (configSchema → where configured values are STORED → the read/write endpoints → the desktop form), then surface it in the TUI Plugins tab: select a plugin → view its schema-driven settings → edit + save via the same endpoints, so TUI and desktop edit the same config.
4. **Activity-tab verdict (S).** Owner asserts the orchestrator is deprecated → `run.log` deprecated too. Verify: find what **WRITES** `<harnessDir>/logs/run.log` (grep writers — the readers are `harness-readers.ts`/`harness-log-bus.ts`), whether that writer is the legacy orchestrator path, and check mtimes of real `run.log` files on disk. **If confirmed dead: RETIRE the TUI Activity tab** (the Fleet tab already shows the live `agent_activity` feed) and file an issue to retire the desktop's run.log surfaces; if still live, re-point Activity at `agent_activity` (plan D-004b). Record the verdict in the plan.
**Verify:** tutorial reachable all 3 ways; a config edit round-trips and re-renders effective values; a github-repo setting edited in the TUI persists + shows in the desktop; the Activity decision implemented + documented.
**Constraints:** coordinate with Brief 8/9's agent — same files (`app.rs`/`ui.rs`/`client.rs`); check `coord:presence` before editing.

## Brief 18 — Android app revival + redesign 〔mobile, L〕
**Plan:** `mobile-apps-revival-redesign-2026-06-05` (D-001..D-006) — read it first. **Repos:** `papercup-rust-mobile` (sibling repo — **normal git commit/push applies there**, it is NOT under git-sync) + `papercup` (the backend device routes — git-sync owns commit/push).
**Mission:** get the Android app working against today's server, then rebuild the UI around the new model.
1. **Shared P0 — CLAIM-FIRST** (the iPhone agent, Brief 19, shares this layer — `coord:declare-intent` + claim each chunk before touching `crates/papercup-core` or `routes/device/`): the **6 contract fixes** (sync → `rest-query`; rebuild `push/register`; voice via `runtime-config` → `:3068` + `voice-session-init`; pairing consumes `defguardEnrollmentUrl`; nested error decoder; 403 = re-pair) and the **3 new device routes** (`device/operator-converse` bridging the shared conversation, `device/plans`, `device/attention` — work_items-native). Update the wiremock tests to the CURRENT shapes (today's green tests mock dead endpoints).
2. **Compose redesign:** 5 tabs **Inbox-first** (Inbox · Operator · Plans · Fleet · Settings), the operator tab is a **real chat thread** with the suggestion-cards rendered **inline as actionable bubbles** (retire the card-feed tab; absorb "Running" into Fleet), **Pot switcher in the header** with "All Pots" (slug+scope two-axis, matching desktop/PUI), voice FAB kept everywhere.
3. **FCM push end-to-end:** register → server sends on inbox events → notification **deep-links to the Inbox item**.
**Verify:** on an emulator/device against the live operator — pair (incl. the Defguard URL handling), Inbox renders live attention items, a chat round-trip on the shared thread, voice connects (`runtime-config` discovery), one push deep-link.
**Constraints:** backend route work is tested on **staging `:3170`**; the phone pairs against **green `:3070`** (promote via the release gate). Android build = `make build-android` (cargo-ndk + gradle, JDK 17, SDK/NDK 27). Secrets (`google-services.json`, `picovoice.access-key`) are uncommitted — **ask the owner** where they live.

## Brief 19 — iPhone app revival + redesign 〔mobile, L〕
**Plan:** `mobile-apps-revival-redesign-2026-06-05` (D-001..D-006) — read it first. **Repos:** same split as Brief 18.
**Mission:** the SwiftUI app reaches parity on the new model, built + verified through the Mac VM.
1. **Shared P0 — CLAIM-FIRST with Brief 18's agent:** coordinate via coord on the shared `papercup-core` fixes + device routes — take unclaimed chunks, verify claimed ones; do NOT duplicate. (If Brief 18's agent has P0 fully claimed, start at step 2 against their landed contract.)
2. **SwiftUI redesign parity:** the same 5-tab Inbox-first design as Brief 18 (chat with inline cards, Pot switcher header, Fleet absorbing Running, voice FAB) — screen-for-screen with the Compose app per the repo's parallel-UI convention.
3. **APNS push:** register via the rebuilt route; deep-link to Inbox. (APNS needs cert/entitlement work — flag to the owner if the push cert is missing; simulator can't receive real APNS, use a device or the simulator push file.)
4. **The Mac-VM build pipeline:** build via `papercup-vm-mac.service` (QEMU macOS Sonoma; Xcode 16.2+; `tools/build-scripts/build-ios.sh` + `install-ios.sh` per `docs/BUILD.md`). **VM gotchas:** QEMU **pauses on disk I/O errors** (black screen + SSH hang + flat CPU = paused, not crashed — resume via monitor `cont`); the unit must stay `Type=simple` (the old `Type=forking`+PIDFile combo kill-looped it).
**Verify:** the app builds in the VM, installs on the simulator (documented iPhone 16 sim), pairs against green `:3070`, Inbox/Operator/Plans/Fleet render live data, a chat round-trip works.
**Constraints:** never block on the shared P0 — coordinate; the VM is slow, batch your build cycles; commit/push normally in `papercup-rust-mobile`.

---

**Next batch (not in these 19):** `finish-next-removal` (ready), the tui-workbench P-010 tail (coord-inbox→PUI bridge, HTTP remote transport, spawn-to-pane), `dbos-scheduler-consolidation`, `linux-test-vm-and-federation`, the federation/substrate phase-1b arc, `voice-persona-production-readiness`, `harness-blueprint-distribution` tail, `coordination-integration-adoption`, the mem0 revive-vs-retire decision.
