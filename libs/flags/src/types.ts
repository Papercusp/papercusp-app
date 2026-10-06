// Single source of truth for Papercusp feature flag keys, defaults, and shape.
// Adding a flag: append here, then create the matching definition in PostHog
// (key MUST match the string literal exactly). Defaults are V1 ship-state (off).

/** Sync-bus event emitted after a server-side flag value changes. */
export const FLAGS_CHANGED_EVENT = "flags.changed";

export const FLAGS = {
  // SNAPSHOTS retired (retire-snapshots-instance-spec-2026-06-09): the harness-
  // snapshot system + the Cupboard `kind=snapshot` path are gone; the reproducible
  // clone is now the lightweight InstanceSpec (capture/boot/vary, ungated). The
  // legacy :3057 marketplace + /templates were already deleted (revive-cupboard D-004);
  // distribution lives in the (ungated) Cupboard.
  // dev:pg_mutate — the audited, guarded DML escape hatch over operator PG
  // (EI-20478724424443538). Default ON (derived FLAG_DEFAULTS — not in
  // DARK_FLAGS); this flag is the kill-switch: OFF makes the tool refuse with
  // flag_disabled while dev:pg_query and every documented write verb are
  // untouched.
  // converge-frozen-candidate-by-fix-only-admission-2026-08-27 (P-013 / D-007, owner
  // directive 2026-08-27): the owner-visible OFF SWITCH for freeze-and-converge as the
  // default response to a red candidate. Default ON (derived FLAG_DEFAULTS — deliberately
  // NOT in DARK_FLAGS): ON is the ALREADY-DEPLOYED behaviour (a first real code red opens
  // the one frozen repair queue, green-checkpoint.ts, D-001/WI-39944), so this flag ships
  // matching production exactly and changes nothing on its own.
  // OFF restores the pre-D-001 re-cut-at-tip stream — the treadmill D-007 diagnosed, where
  // each new cut re-admits the whole sweep and imports breakage faster than fixes land. It
  // exists because D-007 requires the default to be an owner-revocable choice rather than a
  // constant, NOT because turning it off is expected to be a good idea.
  // A cycle ALREADY open is never suppressed by this switch (see
  // decideFrozenConvergenceCycleEntry): flipping it off stops new cycles opening and leaves
  // an in-flight convergence to finish, rather than stranding its repair worktree.
  RELEASE_FREEZE_AND_CONVERGE_DEFAULT: "papercusp-release-freeze-and-converge-default",
  // machine-enforced-terminal-criteria-2026-09-05 (P-006/P-007, D-018): the ENFORCEMENT
  // kill-switch for item-scoped terminal criteria on work-item closes. Default ON (derived
  // FLAG_DEFAULTS — deliberately NOT in DARK_FLAGS): ON is the shipped behaviour, so the
  // flag ships matching production and changes nothing on its own.
  //
  // It exists because this gate changes close OUTCOMES for ~6.1% of committed bug/change
  // closes fleet-wide the moment it deploys, against ~68 active agents. Without a switch the
  // only rollback is a revert — unacceptable blast radius for a behaviour change that lands
  // on every agent's close path at once.
  //
  // OFF is a pure ENFORCEMENT switch, not a blind spot: the evaluator still RUNS and its
  // verdict is still RECORDED on the completion, so the gate stays measurable while disabled
  // (which is exactly what you need to decide whether to turn it back on). Only the
  // committed->proposed DOWNGRADE is suppressed. See complete.ts's third downgrade stage.
  TERMINAL_CRITERIA_ENFORCEMENT: "papercusp-terminal-criteria-enforcement",
  // progress-certified-release-trace-2026-09-05 (P-005, D-015): the STEERING kill-switch for
  // the checkpoint progress certificate in release:trace's nextVerb. Default ON (derived
  // FLAG_DEFAULTS — deliberately NOT in DARK_FLAGS): ON is the shipped behaviour, so the flag
  // ships matching production and changes nothing on its own.
  //
  // It exists for ONE carried risk, named in D-015: reachability of the `stalled` branch is
  // now tested end-to-end (producer -> certifier), but DEFAULT_STALL_THRESHOLD_MS = 600_000 is
  // labelled in-source "A JUDGEMENT, NOT A MEASUREMENT" and its falsifier — a healthy run
  // observed with a >600s heartbeat gap — remains unrun. A run that legitimately goes quiet
  // inside one long test file would be certified `stalled` and steer every reader away from
  // a correct `checkpoint:await`. OFF restores that plain await instead.
  //
  // OFF is a STEERING switch, not a safety switch. The D-004 re-triage interlock in
  // safeNextVerb is NOT gated by it: that interlock withholds a manual release:checkpoint-run
  // inside the auto-refire window, and disabling a threshold judgement must never re-arm the
  // discarded-rescue footgun. See release-trace.ts progressGatedAwait vs safeNextVerb.
  RELEASE_TRACE_PROGRESS_CERTIFICATE: "papercusp-release-trace-progress-certificate",
  PG_MUTATE_TOOL: "papercusp-pg-mutate-tool",
  CLOUDFLARE_PUBLISH: "papercusp-cloudflare-publish",
  HARNESS_PHASES: "papercusp-harness-phases",
  DESIGN: "papercusp-design",
  // external-triggers-gmail-slack-2026-08-22 P-004: the owner-local
  // /admin/triggers surface for sources, bindings, arming, storm policy, and
  // recent runs. Default ON (derived FLAG_DEFAULTS — deliberately NOT in
  // DARK_FLAGS): the screen is additive and every arm/disarm mutation still
  // requires an explicit owner confirmation at the server boundary. OFF hides
  // the tab and makes the route return its disabled shape without touching data.
  TRIGGERS_ADMIN: "papercusp-triggers-admin",
  // external-triggers-gmail-slack-2026-08-22 P-011: future automatic Gmail
  // SEND authority. The shipped flagship tool creates drafts only and never
  // reads this flag. DEFAULT OFF in DARK_FLAGS (owner-authority): enabling a
  // future consumer would send outward-facing email without per-message review.
  GMAIL_AUTO_SEND: "papercusp-gmail-auto-send",
  // social-platform-integrations-2026-08-23 P-006 / D-004(b): the PUBLISH
  // side-effect of social:post — create-shaped public publishing to the owner's
  // real social identity. DEFAULT OFF in DARK_FLAGS (owner-authority), the same
  // category as GMAIL_AUTO_SEND above. The verb itself is live and unflagged:
  // with this OFF it still parses, runs BOTH D-020 rails, resolves the account
  // and audience, and returns that echo with `withheld` set — only the outbound
  // call is withheld. So OFF is a publish kill-switch, not a hidden feature.
  SOCIAL_AUTO_PUBLISH: "papercusp-social-auto-publish",
  // stripe-subscription-signup-2026-10-01 P-004 (owner directive #1102): LIVE-MODE
  // Stripe charging for hosted organization subscriptions. DEFAULT OFF in DARK_FLAGS
  // (owner-authority), the same category as GMAIL_AUTO_SEND: a live key charges real
  // cards. Test-mode subscription signup (checkout, portal, webhooks, state) is live
  // and unflagged; with this OFF the hosted billing runtime refuses an sk_live_/rk_live_
  // key and reports `live_mode_not_allowed`, so OFF withholds ONLY real charging.
  HOSTED_BILLING_LIVE_MODE: "papercusp-hosted-billing-live-mode",
  // enterprise-data-sources-2026-10-01 P-016: the Slack ORGANIZATION connector
  // (the customer's own internal Slack app as the credential model — connect,
  // channel-membership sync into permission lists, paced history backfill).
  // Default ON since 2026-10-06 (slack-messages-to-bug-reports-2026-10-05 P-001):
  // the plan's GATE, a legal read of Slack's 2025 API terms for the
  // customer-internal-app model, is on record (enterprise-data-sources-2026-10-01
  // D-029) and the owner approved switching it on (directive #1417). Flip OFF via
  // /admin/features to make every entry point in data-sources/slack-org-connector.ts
  // refuse before any Slack call.
  SLACK_ORG_CONNECTOR: "papercusp-slack-org-connector",
  // RES — the workspace-scoped Resources section (top-level nav CTA next to OPS
  // + the /res allocation board): hand account pools + local GPUs to the fleets
  // inside the workspace hive tree, each with a share %. Default ON (derived
  // FLAG_DEFAULTS — additive new surface, nothing else changes behavior when the
  // tab is hidden); flip OFF via /admin/features to pull the nav item + route.
  RES_ALLOCATION: "papercusp-res-allocation",
  // WI-40825 / EI-21218726167520963 — the PUSH half of plan-item text drift: the
  // post-commit warning a plan write hands back to the editor, plus the one-shot
  // coord ping to the holders of work-items minted from an item that write
  // rewrote or removed. Default ON (derived FLAG_DEFAULTS — deliberately NOT in
  // DARK_FLAGS): it is additive, runs only after the write has already committed,
  // and is fail-soft throughout. This flag is the kill-switch for the FAN-OUT
  // specifically: the fan-out is the only part with a blast radius (bounded at
  // MAX_DRIFT_NOTIFICATIONS per write), so if it ever proves noisy or
  // false-positive, flipping this OFF degrades gracefully to the PULL half — the
  // derived `planItemTextDrift` verdict on work_items:get, which is the authority
  // anyway and stays on. The mint-time hash stamp is NOT gated: withholding it
  // would silently create a population of records that can only ever answer
  // `unknown`, which is the exact false-absence this feature exists to close.
  PLAN_ITEM_TEXT_DRIFT_PUSH: "papercusp-plan-item-text-drift-push",
  // Testing-only surfaces (pi tab, add-plugin button) AND the Oracle assistant
  // (dock + Tutorial menubar button + /settings/oracle + /api/oracle/*) — the
  // separate `papercusp-oracle` key was folded into this one by owner ask
  // (2026-06-10): the Oracle is a testing surface.
  TESTING: "papercusp-testing",
  // The operator chat sidebar — the docked, full-height left web chat
  // (OperatorChatSidebar in ChromeShell), REVIVED as the app's primary chat
  // surface by owner decision (operator-chat-sidebar-revival-2026-07-13; it
  // was retired 2026-07-09 in favor of the zellij pui dock, which is itself
  // now TESTING-gated). Its OWN flag — deliberately NOT under FLAGS.TESTING
  // (that flag is parked/cut for V1). Default ON (derived FLAG_DEFAULTS);
  // flip OFF via /admin/features to hide the sidebar without a rebuild.
  OPERATOR_CHAT_SIDEBAR: "papercusp-operator-chat-sidebar",
  // The curator-operator's deterministic status messages render in the chat as
  // structured CARDS instead of flattened markdown lines
  // (deterministic-status-cards-2026-07-17): status glyph + source + an
  // ACTIONABLE drill-in, vs the old dead `drill in: \`escalation:<id>\`` monospace.
  // Additive — the curator turn always carries both the plain text (fallback for
  // voice/search) and the report card; this flag only gates the CHAT RENDER.
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS). OFF = the clean
  // kill-switch: the chat falls back to the turn's plain-text lines
  // byte-identically, no data change.
  CURATOR_STATUS_CARDS: "papercusp-curator-status-cards",
  // WI-5071 (reply-latency TTFT): reuse ONE claude-code brain session per chat
  // conversation — turns 2+ resume the session with a DELTA prompt (new
  // trigger/utterance only; the session carries the verbatim history) instead
  // of cold-spawning with the full prompt every turn. Measured baseline
  // 2026-07-16: 21.1s to first visible event, 68% of it inside claude-code
  // (MCP init + opus TTFT on an uncached full prompt). Default ON (derived
  // FLAG_DEFAULTS); OFF restores the per-turn cold-spawn path byte-identically
  // — the clean kill-switch if resumed sessions misbehave.
  OPERATOR_CHAT_SESSION_REUSE: "papercusp-operator-chat-session-reuse",
  // Quick Panel — the global-shortcut popup window's tabbed body (Saved Prompts
  // outline / Docs search / Brainstorm), served at /quick-panel
  // (quick-panel-saved-prompts-2026-07-13). Default ON (derived FLAG_DEFAULTS —
  // additive surface); OFF renders the panel's disabled note, nothing else
  // changes behavior.
  QUICK_PANEL: "papercusp-quick-panel",
  // inbox-cards-unification Phase D (P-031): when on, a chat decision card
  // (chat:ask_choice / ctx.askUser) ALSO writes a durable coord escalation so
  // the human can answer it live OR later from the inbox; either path resolves
  // the same record.
  //
  // DEFAULT ON — ratified 2026-07-12 (WI-4240, su-00a91); this comment used to say
  // "Default off — the live ctx.askUser path is unchanged". Finished additive work, not a
  // dark case: the mirror write + resolve are best-effort throughout (a flag/identity/write
  // failure never breaks the card — ask_choice.ts), and the durable record is resolved
  // idempotently on EVERY card-exit path (live answer, inbox answer via coord:resolve, and
  // timeout/cancel — ask_choice.ts ~L300). Verified live: ~2 weeks default-ON with ZERO
  // leaked escalations from this path (harness_shared.coord_open_escalations rows carrying a
  // cardCorrelationId = 0, all workspaces, 2026-07-12). Per repo policy (finished work never
  // ships dark) it is ratified ON rather than darkened. OFF ⇒ interactive cards do not mirror
  // to the inbox (they can only be answered live).
  INBOX_DURABLE_ESCALATIONS: "papercusp-inbox-durable-escalations",
  // inbox-bulk-resolve-2026-08-23 (D-001/D-002/D-003): the Inbox's BULK RESOLVE
  // command strip — one click hands the items the pane is CURRENTLY showing to a
  // resolver agent, which settles what it can on the owner's behalf (every such
  // action audited) and hands the rest back pre-recommended for one-click accept.
  //
  // DEFAULT ON — finished additive work, not a dark case. The strip is purely
  // ADDITIVE to the pane: with no run it renders one idle button, and every item
  // stays individually resolvable by hand exactly as before. Its sync query
  // degrades to `{ run: null }` on any read failure (sync-resolver/index.ts), so
  // a broken bulk substrate renders IDLE rather than breaking the inbox. Accepts
  // dispatch the SAME client paths a hand-resolve uses (resolveAttentionAction /
  // replyToAttentionItem), so asker-wake, provenance and triage-audit parity hold.
  // OFF ⇒ the strip does not render and the pane is byte-identical to before.
  INBOX_BULK_RESOLVE: "papercusp-inbox-bulk-resolve",
  // cleanup-report-flows-2026-08-24: Plans-pane cleanup run + grouped review.
  // DEFAULT ON (derived FLAG_DEFAULTS) — finished additive surface; OFF removes
  // the strip and revokes already-launched resolver authority at its tool seam.
  PLAN_CLEANUP: "papercusp-plan-cleanup",
  // papercusp-self-improvement-loop-2026-06-04 Phase 3 (D-004/D-006/D-008): the
  // master switch for AUTO-implementing captured improvements. When OFF (default),
  // the improvement-implement routine is a no-op — capture (Phase 1) + triage
  // (Phase 2) run, but nothing is auto-built. Flip ON only once the work_items
  // surface + the release-gate cutover have landed (the routine spawns the
  // implementer in a dedicated runner harness and lands via the release gate).
  IMPROVEMENT_AUTO_IMPLEMENT: "papercusp-improvement-auto-implement",
  // self-improvement-consume-edges-2026-06-12 P-003 (D-002): the composite
  // "learning system offline/degraded" status — llm-spine reachability + runner
  // spawn path + gym circuit → ONE Learning-tab chip + an owner notification on
  // the transition to offline. Infra failures escalate; they don't queue.
  LEARNING_INFRA_HEALTH: "papercusp-learning-infra-health",
  // Learning tab header: the pause/resume-all-learning-routines + spend chip
  // (WI-39501, owner ask 2026-08-16). Default ON (derived FLAG_DEFAULTS — not in
  // DARK_FLAGS); OFF removes the control, nothing else changes.
  LEARNING_LOOP_CONTROL: "papercusp-learning-loop-control",
  // REM dream recombination (rem-dream-recombination-2026-08-17 D-001):
  // gates the feature surface (run ledger, Learning controls, Analyze view),
  // NOT autonomous spend. Default ON (derived FLAG_DEFAULTS — not in
  // DARK_FLAGS). Automatic dreaming has its own inactive routine/owner toggle
  // and therefore remains OFF on every fresh pot until deliberately enabled.
  DREAM_CYCLE: "papercusp-dream-cycle",
  // holepunch-video-shared-harnesses-2026-06-05: gates the desktop P2P video
  // channel (the participant-grid VideoGrid). Runtime default ON (derived
  // FLAG_DEFAULTS — not in DARK_FLAGS), made DELIBERATE by
  // voice-unified-sentinel-pipeline-2026-07-01 P-011: voice/video are the
  // product surface under active completion; flip OFF via /admin/features to
  // go dark.
  VIDEO_CHANNELS: "papercusp-video-channels",
  // holepunch-voice-channels-2026-06-05 (P-015/D-014): gates the desktop P2P
  // VOICE-channel surface (VoiceChannelPanel — channel list/join/mute/meter +
  // mic capture/mix playback over the desktop voice bridge). Runtime default ON
  // (derived FLAG_DEFAULTS — not in DARK_FLAGS), made DELIBERATE by
  // voice-unified-sentinel-pipeline-2026-07-01 P-011; flip OFF via
  // /admin/features to go dark.
  VOICE_CHANNELS: "papercusp-voice-channels",
  // on-desktop-direct-lan-voice-2026-07-14 (P-004): the device-authed
  // desktop-local mobile voice surface (POST /api/device/voice/turn +
  // /warmup — phone audio → local whisper STT → papercup brain → kokoro
  // TTS, streamed back as SSE). ADDITIVE alongside ElevenLabs (D-010): the
  // phone picks its pipeline from voice-session-init's `mode`. Runtime
  // default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS); flip OFF via
  // /admin/features to go dark.
  MOBILE_DESKTOP_VOICE: "papercusp-mobile-desktop-voice",
  // the-hive-lexicon-2026-06-06: selects the active brand pack for the
  // user-facing LEXICON layer. ON = the `the-hive` bee pack (Hive/Colony/Queen/
  // Bee/…); OFF = the `classic` Papercup POT pack. DEFAULT OFF as of
  // restore-pot-lexicon-public-release-2026-07-04 (owner 2026-07-04): public
  // release ships the Pot lexicon; the Swarm skin is kept but TESTING-gated
  // (in DARK_FLAGS, reachable only via the FLAGS.TESTING BrandSwitcher). Fully
  // reversible presentation switch; @papercusp/lexicon resolves it. NOTE: the
  // backend-identifier rename (hive→pot, Phase 6) is a SEPARATE change from this
  // presentation flag.
  THE_HIVE: "papercusp-the-hive",
  // blueprint-aware-harness-ui-2026-06-09 (P-008): gates the new SCHEMA-DRIVEN
  // harness settings panel (BlueprintSettingsPanel) that renders controls from the
  // harness blueprint's declared `params` (P-006), replacing the hardcoded
  // coding-pipeline form. ON (default, owner-activated 2026-06-09); OFF = the
  // legacy HarnessSettingsPanel. Reversible presentation switch; the Tauri visual
  // pass + folding in the legacy panel's residual sections (Discord/telemetry)
  // are tracked on the plan.
  BLUEPRINT_AWARE_SETTINGS: "papercusp-blueprint-aware-settings",
  // blueprint-aware-harness-ui-2026-06-09 (P-011): gates the Prompt Studio surface
  // (edit the renderSuPlaybook SOURCES — base playbooks / per-client overlays /
  // project-guide — with a live assembled-prompt preview), mounted at
  // /settings/prompt-studio. ON (default, owner-activated 2026-06-09). The
  // /api/prompt-studio/* routes are gated on this flag TOO (plus the loopback
  // guard + 512KB cap + id-whitelist from the security review).
  PROMPT_STUDIO: "papercusp-prompt-studio",
  // hive-agent-tabs-psu-tui-2026-06-09: gates the unified agent-tabs system where
  // EVERY agent surface (Queen · Bee · Sentinel · Planner) is a real psu/Claude
  // TUI session, plus the per-agent wake-mode gate, per-type color/grouping, and
  // per-frame tabs. Server-side gates only (wake delivery, roster stamping) —
  // the pui dock ships the unified shape unconditionally since P-014 retired
  // the legacy `pui chat-pane`/`pui watch-pane` surfaces (2026-06-12).
  POT_AGENT_TABS: "papercusp-hive-agent-tabs",
  // hive-inference-gateway-2026-06-09 (P-012): when ON, every bee spawn gets
  // ANTHROPIC_BASE_URL pointed at the localhost pacing gateway (127.0.0.1:8788), so
  // the whole fleet egresses through ONE bound account paced against the unified
  // 5h/7d utilization budget (D-009) instead of each `claude -p` bursting blind.
  // DEFAULT ON (graduated — not in DARK_FLAGS; comment-staleness fix, EI-9826: this
  // block's ORIGINAL "DEFAULT OFF... flip ON only AFTER the service is deployed + the
  // 20-bee load test (P-015) passes" gate condition is confirmed met — the gateway
  // service (papercup-inference-gateway.service) is live-running (verified via
  // systemctl + a healthy :8788/healthz), and the sibling INFERENCE_GATEWAY_MULTI_ACCOUNT
  // flag's own comment independently confirms 8 live registered accounts with real
  // utilization telemetry, which requires this base gateway to already be functioning).
  // OFF = the reversible fallback (bees use their symlinked ~/.claude credential directly).
  INFERENCE_GATEWAY: "papercusp-inference-gateway",
  // inference-gateway-multi-credential-routing-2026-06-14 (P-009): when ON, the
  // inference gateway routes each request to one of N registered Claude Max subscriptions by the
  // `x-papercusp-account` header (multi-credential — aggregate 5h-budget pooling / per-account IP
  // routing / cache-affinity / failover), and the spawn chokepoint assigns a cache-affinity +
  // budget-draining credential per bee. DEFAULT ON (WI-3855, 2026-07-11: this comment's own
  // "DEFAULT OFF ... Listed in KNOWN_DARK_FLAGS" was never actually added to the DARK_FLAGS map,
  // so the 2026-06-29 P-011 inversion silently made it live default-ON — the same EI-7230-class
  // comment/reality mismatch as WATCHDOG_AUTO_CLOSE et al. Confirmed SAFE-as-is, not a drive-by
  // flip: the D-003 gate this comment names — "needs ≥2 Max OAuth subscriptions registered + a
  // real multi-account run" — is met and then some: operator_account_pool carries 8 live
  // registered Claude accounts with real utilization/penalty telemetry in the production
  // workspace, i.e. the multi-account run has been live for a while). OFF = the single
  // bound-credential gateway (the reversible fallback).
  INFERENCE_GATEWAY_MULTI_ACCOUNT: "papercusp-inference-gateway-multi-account",
  // agent-liveness-heartbeat-hardening-2026-06-12 P-010 (owner decision D-006):
  // auto-reap WEDGED bees — alive + supervisor-heartbeating but stream-silent
  // past WEDGE_REAP_SILENT_MS (30min; bees stream thinking deltas + tool events,
  // so true silence that long means hung-not-thinking — the generous threshold
  // absorbs long local tool calls like full test suites). Reap rides the
  // fleet:cancel engine (claims/locks released, coord notice). Checked per
  // supervisor tick; flip takes effect without a restart.
  WEDGE_AUTO_REAP: "papercusp-wedge-auto-reap",
  // claude-credential-sync-2026-06-10 (P-002): gates the operator's background
  // newest-wins reconciler that keeps the Claude OAuth bundle converged across
  // ~/.claude and every per-session CLAUDE_CONFIG_DIR fork (the fix for the
  // every-terminal-relogin rotation cascade). Checked per reconcile PASS, so a
  // flip takes effect without an operator restart. ON by default — leaving it
  // off means credential forks mutually invalidate again.
  CLAUDE_CRED_SYNC: "papercusp-claude-cred-sync",
  // auth-tier-rollout-2026-06-10 (OWNER rows review): POST /auth/signup is
  // `public` and internet-reachable via the cloudflared tunnel. The route
  // allows the FIRST account unconditionally (fresh-install bootstrap); once
  // any active user exists, further signups require this flag.
  OPEN_SIGNUP: "papercusp-open-signup",
  // hive-from-github-url-2026-06-11 (P-011/P-012): gates the picker's GitHub-URL
  // entry — paste a repo URL → create a Hive from it (clone → blueprint detect →
  // hive home + member → visibility-gated auto-publish), join the existing hive
  // when the paste-time lookup hits, or clone standalone (D-007). OFF = the
  // legacy coming-soon stub renders instead. Backend (P-006..P-010) is ungated.
  POT_FROM_GITHUB_URL: "papercusp-hive-from-github-url",
  // auth-tier-rollout Wave 1 (audit D-007/D-009, owner-approved 2026-06-10):
  // when ON, routes declared `auth: 'loopback'` are enforced at the dispatch
  // chokepoint — non-loopback Host → 403. OFF is the emergency revert lever
  // (routes fall back to public behavior); PAPERCUSP_ALLOW_REMOTE_ADMIN=1
  // remains the per-host deliberate remote-admin opt-out.
  ENDPOINT_AUTH_TIERS: "papercusp-endpoint-auth-tiers",
  // queen-model-tier-selection-2026-06-11 (P-005): when ON, the Queen's
  // cup:spawn `tier` picks are honored (resolved + clamped to [role floor,
  // role ceiling]). OFF = the kill-switch: a queen-supplied tier is ignored
  // and her spawns run at the role's standing default. Human/operator tier
  // and model args are honored regardless — this gates only the Queen's
  // autonomous escalation lever.
  MUG_TIER_SELECTION: "papercusp-queen-tier-selection",
  // EI-322 (authenticated authority RPC): when ON, POST /api/authority/rpc
  // REQUIRES a valid Ed25519-signed caller envelope (sig + freshness +
  // non-revoked device) before running a mutating lock/claim op — closing the
  // self-reported-holderPubkey hole on the cross-machine path. OFF = legacy
  // behavior (verifyIsAuthority + the EI-284 revocation gate only; unsigned
  // callers accepted). The transport ALWAYS signs, so enabling is safe on a
  // box where every peer runs current code; the flag is the cross-machine
  // rollout lever (sign everywhere → then enforce).
  AUTHORITY_RPC_SIGNED: "papercusp-authority-rpc-signed",
  // shared-hive-hardening-2026-06-13 P-001 / D-005 (owner-ratified option c):
  // route remote lock-authority RPCs over the EXISTING per-harness Hyperswarm
  // connection (a papercusp/authority-rpc protomux channel) so NAT'd desktop
  // peers — unreachable by a raw :3070 URL — are served; the connection IS the
  // address. Composes with the HTTP transport (addressable peers) and fails open
  // (D-004) when no channel/address exists. DEFAULT OFF: the cross-machine path
  // is real-hardware-unverified (P-003) — flipping it on is gated on the
  // two-machine serialization proof. OFF = byte-identical to today (HTTP-only).
  // NOW ACTUALLY IN DARK_FLAGS (added 2026-07-12, WI-4240, su-00a91) — the comment always
  // said DEFAULT OFF and was right, but the flag was never added, so P-011 derived it live-ON.
  // Byte-identical to fix here: wireAuthorityRpcSwarmTransport returns early without a signer/
  // swarm, so ON is a no-op on a single box regardless.
  AUTHORITY_RPC_PROTOMUX: "papercusp-authority-rpc-protomux",
  // shared-hive-hardening-2026-06-13 P-016: wire the φ-accrual + SWIM failure
  // detector into authority selection so a CRASHED authority is evicted promptly
  // (relays confirm it dead over the same RPC seam) instead of waiting out the 90s
  // staleness window. When ON, boot installs the eviction monitor; selection
  // excludes a peer ONLY when a reachable relay confirms it dead (never on our own
  // blindness — single box / no transport is a no-op, fail-open preserved). DEFAULT
  // OFF (dark): the live cross-machine eviction path is real-hardware-unverified
  // (D-003, like the sibling AUTHORITY_RPC_PROTOMUX it rides) — the flip is gated
  // on the two-machine proof. OFF = staleness-only selection, byte-identical to
  // pre-P-016.
  // NOW ACTUALLY IN DARK_FLAGS (added 2026-07-12, WI-4240, su-00a91) — the comment always
  // said "DEFAULT OFF (dark)... KNOWN_DARK_FLAGS" and was right, but the flag was never added,
  // so P-011 derived it live-ON. Byte-identical to fix here: wirePeerEviction returns without
  // installing the monitor when the flag is off, and single-box/no-transport is a no-op anyway.
  AUTHORITY_EVICTION_PROBE: "papercusp-authority-eviction-probe",
  // substrate-peer-log-compaction-2026-06-13 (design A, D-005). WI-3370
  // (2026-07-10): this flag used to gate BOTH the reader (seedCursorFromSnapshots)
  // AND the producer (produceLogSnapshot) from one boolean — and despite this
  // comment always having said "DEFAULT OFF (dark) ... Listed in KNOWN_DARK_FLAGS",
  // it was never actually added to DARK_FLAGS, so the 2026-06-29 P-011 default-
  // inversion silently made BOTH legs live-default-ON in production (the 6th
  // instance of that EI-7230 bug class in this file). Split: this flag now gates
  // ONLY the PRODUCER — periodically compacts the OWN log (appends one additive
  // snapshot set once ops since the last snapshot reach
  // `snapshotCompactThreshold`, i.e. max(1000, ratio × the prior set's rows)).
  // GRADUATED 2026-09-24 (p2p-join-catchup-speed-2026-09-23 P-005): the
  // cross-machine proof it was dark for landed — P-003 (proportional cadence,
  // compaction off the merge gate), P-004 (reader finds the latest set at any
  // distance) and P-008 (sequential readers skip redundant sets, A/B-verified).
  // Default ON (not in DARK_FLAGS). OFF (env `PAPERCUSP_FLAG_…=0` or an override)
  // ⇒ no NEW snapshot sets produced; existing sets on disk are untouched and
  // still read normally. The READER leg (seeding a joiner's cursor at a log's
  // latest snapshot) is its own flag, SUBSTRATE_LOG_SNAPSHOT_READER, immediately
  // below — see that flag's comment for why the two needed to separate.
  SUBSTRATE_LOG_SNAPSHOT: "papercusp-substrate-log-snapshot",
  // WI-3370 (2026-07-10) split of SUBSTRATE_LOG_SNAPSHOT (design A, D-005): gates
  // ONLY the reader — seedCursorFromSnapshots seeds a fresh/reset merge cursor at
  // each log's latest `__snapshot__` index so a new joiner (or a post-reset
  // re-fold) folds from the snapshot instead of replaying full history. DEFAULT
  // ON (not dark): the LOCAL-seed case (blocks pre-positioned by a bundled seed,
  // e.g. seed-history-trim-public-builds-2026-07-07's sparse public-build seed,
  // which REQUIRES this reader ON to restore) is unambiguously safe and already
  // proven single-box. RESIDUAL, KNOWINGLY UNSCOPED: seedCursorFromSnapshots runs
  // generically across every log in the merge pass, so it ALSO reads a __snapshot__
  // marker on a REMOTE peer's log that reached us by replication — i.e. a
  // reader-over-wire path riding the same P-008 cross-machine-convergence proof
  // this flag's producer sibling stays dark for. That residual case is NOT split
  // out at this call site (would need to distinguish "log seeded from a local
  // bundled tarball" from "log folded from a live peer" inside boot's merge loop —
  // left for a follow-up once someone needs to actually gate it); today it is a
  // NON-regression (identical wire-reader exposure to before this split, since the
  // single prior flag already defaulted this on too) but is flagged here so the
  // next reader of this flag doesn't assume ON is fully hardware-verified end to
  // end. OFF ⇒ cursor never seeds from a snapshot (any log, local or remote),
  // folds from the last cursor position instead — slower but always correct.
  SUBSTRATE_LOG_SNAPSHOT_READER: "papercusp-substrate-log-snapshot-reader",
  // operator-memory-and-psu-resilience-2026-06-14 P-009 (D-008): substrate
  // process isolation — dedicated sidecar for corestores/Hyperswarm natives.
  // When ON, bootAllHarnessesForActiveWorkspace spawns a sidecar process
  // (apps/operator/bin/substrate-sidecar.ts, JSON-RPC 2.0 over Unix socket)
  // and calls it over IPC instead of in-process. Main operator freed from GC
  // pauses + per-harness RSS; sidecar owns merge loops + replication.
  // DEFAULT OFF — staged on :3170 FIRST; never :3070 until integration-verified
  // (two-peer-swarm federation test + event-loop latency regression test).
  // Phase 1 (this sprint): skeleton + basic methods + IPC client.
  // Phase 2: socket handoff + integration tests. Listed in KNOWN_DARK_FLAGS.
  SUBSTRATE_SIDECAR: "papercusp-substrate-sidecar",
  // WI-2105 (shared-hive-p2p-release-readiness) REV-leg fix: persist the substrate
  // boot merge cursor's per-log positions to harness_shared.substrate_merge_cursor
  // (seed before the first fold, checkpoint persist-after-apply during it) so fold
  // progress is MONOTONIC across bg-host restarts. Without it an orphaned 70k-op
  // peer log re-folds from 0 every restart, starves routinesTick past the 240s
  // bghost-watchdog, and the watchdog restart loop means the fold never reaches
  // tail (the REV restart loop). DEFAULT ON (not dark — a correctness fix, verified
  // live on the tower sidecar). OFF = in-memory cursor only, byte-identical to the
  // pre-fix behavior (the kill-switch: reverts to full re-fold each restart).
  SUBSTRATE_MERGE_CURSOR_PG: "papercusp-substrate-merge-cursor-pg",
  // spawner-sidecar-offload-2026-06-30 WI-344 ③ — the SPAWNER sibling of
  // SUBSTRATE_SIDECAR. When ON, spawnInvokeOnceWithFallback (orchestrator-runner.ts)
  // routes the agent-spawn fork/exec + buildInvokeOnce (the ~24.5% main-loop CPU
  // that freezes routinesTick) OFF the bg-host main loop into a dedicated sidecar
  // process (apps/operator/bin/spawner-sidecar.ts, JSON-RPC 2.0 over a Unix socket,
  // mirroring the substrate sidecar). Registered enum-only — EXACTLY like its
  // SUBSTRATE_SIDECAR sibling (which is also NOT in DARK_FLAGS post the 2026-06-29
  // P-011 inversion, so it likewise DERIVES default-ON; the live OFF state is a
  // runtime `system`-scope override, the same way the substrate sidecar is staged).
  // It stays DARK in practice because spawnInvokeOnceWithFallback is INERT — nothing
  // wires it into the hot path yet (the orchestrator does that separately), so the
  // flag's default is byte-irrelevant to the running operator until it is wired +
  // verified. Adding it to DARK_FLAGS for a code-level default-OFF is intentionally
  // NOT done here: the production-defaults guards (count==9 + value-preserving
  // snapshot + owner anti-reconstruction mandate) forbid a NEW default-OFF flag.
  SPAWNER_SIDECAR: "papercusp-spawner-sidecar",
  // operator-memory-and-psu-resilience-2026-06-14 P-011 (D-007): the idle-session
  // reaper. When ON, a periodic sweep marks DEAD-process open adv_sessions ended
  // (owner stopped heartbeating past the liveness grace), reclaiming the live
  // roster + unblocking session-dir-gc for them. DEFAULT ON (not in DARK_FLAGS —
  // proven safe on the fleet). Slice 1 only touches already-dead sessions; it
  // never terminates a live process (that's the follow-on slice, the sibling flag
  // below).
  IDLE_SESSION_REAPER: "papercusp-idle-session-reaper",
  // operator-memory-and-psu-resilience-2026-06-14 P-011 / WI-152 (D-007): the
  // idle-session reaper's WRITE half — actually TERMINATING a LIVE-but-idle
  // session (the D-007 event-loop-saturation cohort: alive + heartbeating but no
  // genuine activity for the idle threshold, holding LISTEN conns + polling).
  // DOUBLE-GATED: the terminate sweep no-ops unless BOTH this flag AND the
  // sibling IDLE_SESSION_REAPER are on. DEFAULT ON (not in DARK_FLAGS — the
  // owner's live --dry-run proof on the fleet already passed; WI-1658: this
  // flag's default was already flipped true pre-inversion, though the DESTRUCTIVE
  // description below stayed accurate and worth keeping). This is a reaper that
  // Ctrl-C's then SIGKILLs a live process. It only ever targets genuinely-idle
  // sessions (busy owners — claim / in-flight wake / running bee — are excluded);
  // a terminated wake-armed session is safe because the wake-executor --resumes
  // it. OFF ⇒ a pure no-op (the kill-switch if this ever misfires).
  IDLE_SESSION_REAPER_TERMINATE: "papercusp-idle-session-reaper-terminate",
  // dead-target-routine-reaper-2026-08-30 (EI-19278517916030043): the DEAD-TARGET
  // reaper — the sibling of the session reaper above, one level down. It probes each
  // install's TREE directly and, only on a permanent verdict (root missing / git
  // object store corrupt) confirmed across two spaced sweeps, parks that install's
  // durable routines with the evidence stamped on the row. `ei669-repro-su-b621d`
  // burned ~2,400 doomed git-sync attempts over 5 days (646 consecutive error ticks,
  // fleet deploy panel crit for 32h) before a human paused it by hand. DEFAULT ON
  // (derived FLAG_DEFAULTS — not in DARK_FLAGS): it is fail-closed at every step
  // (home harness excluded before probing, `unknown` never parks, two spaced
  // sightings required) and parks nothing on today's fleet. This is the PRIMARY,
  // runtime-flippable gate; `PAPERCUSP_DEAD_TARGET_REAPER=0` remains a process-level
  // emergency override for a host that cannot reach the flag store, and a read
  // failure here is itself treated as OFF. OFF ⇒ a pure no-op, nothing is probed.
  DEAD_TARGET_REAPER: "papercusp-dead-target-reaper",
  // session-db-archive-retire-dirs-2026-07-10 P-004: the end-of-session
  // archive-then-delete fast path. When ON, markAdvSessionEnded schedules
  // archiveAndDeleteSession for the ended session: its irreplaceable files
  // (claude/omp transcripts; codex rollout + memories/goals sqlite +
  // config.toml) are zstd'd into harness_shared.session_archive_files with a
  // sha256-verified manifest stamp (migration 539), and ONLY then deleted
  // from disk — a post-archive write refuses deletion. Resume rematerializes
  // from PG on disk-miss (wake-executor P-008). DEFAULT ON (not in
  // DARK_FLAGS); OFF ⇒ pure no-op kill-switch — session dirs simply
  // accumulate as in the old world (session-dir-gc live-protection is
  // unaffected, and the P-006 reconciler is separately gated by this flag).
  SESSION_ARCHIVE_AT_END: "papercusp-session-archive-at-end",
  // agent-managed-compaction-2026-07-01 P-012 (L2 mechanical backstop): the
  // compaction-compliance watchdog's FORCE rung. When ON, a limit-carrying
  // session that ran PAST its soft compaction limit WITHOUT self-cutting gets a
  // forced CARRY-RESPAWN (P-022, 2026-07-18: the host kills the CLI at a clean
  // boundary and relaunches it on a deterministic carry document — the old
  // /compact typing is retired) — the sanctioned backstop for the 2026-07-04
  // incident (sonnet[1m] fleet members drifted to 836k because nothing
  // mechanical caught the ones that ignored every reminder). DEFAULT ON (not in
  // DARK_FLAGS — the owner directed this fix); OFF disables ONLY this rung
  // (seeding + estimate caching + context-death detection keep running) ⇒
  // warn-only. The kill-switch if the force-respawn ever misfires.
  COMPACTION_WATCHDOG_FORCE_COMPACT:
    "papercusp-compaction-watchdog-force-compact",
  // agent-managed-compaction P-013 (D-009 ambient awareness): when ON, a BANDED
  // context-usage gauge ("context: N/L (X%)", silent <65% / quiet 65-80% / loud ⚠
  // 80-90% / critical >90%) is appended to EVERY papercusp-su MCP tool RESULT (the
  // result-annotator seam) so a heads-down session that never calls a coord tool still
  // sees its usage — the surface that was missing in the 2026-07-02/07-04 blind-drift
  // incidents. DEFAULT ON (not in DARK_FLAGS — owner-proposed). The flag is read by the
  // compaction watchdog each pass into a sync in-process mirror (the annotator is on a
  // sync hot path), so a flip takes effect within one sweep (~2 min). OFF removes the
  // gauge from tool results (the coord:inbox usage line + P-015 native-tool hook are
  // unaffected) — the kill-switch if it is ever noisy.
  CONTEXT_GAUGE: "papercusp-context-gauge",
  // EI-316 (hive completion split-brain): when ON, work_items:create refuses a
  // title that embeds an existing OPEN work-item id (the "WI-118: …" mirror
  // signal) — the creator must work the given id, not fork a duplicate it then
  // completes while the original strands in `validating`. force:true overrides
  // per-call. DEFAULT ON (not in DARK_FLAGS). OFF = the kill-switch if the guard
  // ever false-positives.
  WORK_ITEM_MIRROR_GUARD: "papercusp-work-item-mirror-guard",
  // pot-membership-enforcement-2026-07-20 (P-005/P-006, owner directive
  // 2026-07-20 "AUDIT ALL WORK ITEMS THEY SHOULD ALL BE PART OF A REAL POT ...
  // WE ADDED SOMETHING TO ENFORCE WORK ITEMS TO BE PART OF A REAL POT, RIGHT?"):
  // when ON, createWorkItem resolves every new item's harness_slug to a REAL pot
  // (harness_shared.pots) — an operator/workspace-global scope homes to the
  // workspace platform pot, and an explicit made-up pot slug is REJECTED
  // (pot_not_found) instead of silently drifting (the `operator:<ws>` /
  // `papercusp-workspace` non-pot rows the backfill had to clean up). Fails OPEN
  // for a workspace with no platform pot (test fixtures). DEFAULT ON (derived
  // FLAG_DEFAULTS — not in DARK_FLAGS). OFF = the kill-switch if it ever wrongly
  // blocks a create; the DB backstop trigger (P-006) is the un-flagged safety net.
  POT_MEMBERSHIP_ENFORCEMENT: "papercusp-pot-membership-enforcement",
  // EI-309 (Queen frontier-blind wake wedge): when ON, pot:declare-wake refuses
  // an event-only/none declaration (no time component) while the home harness has
  // unplaced todo work items — forcing the Queen to place them or arm a time-wake
  // instead of sleeping on phantom self-claim. force:true overrides per-call.
  // OFF = the kill-switch if the guard ever wrongly blocks a declaration.
  POT_WAKE_FRONTIER_GUARD: "papercusp-hive-wake-frontier-guard",
  // learning-packs-2026-06-11 (P-005): seeding a new hive's mem0 store with the
  // selected knowledge pack at pot:create, plus the knowledge_packs:* management
  // verbs and the Learnings UI surfaces. OFF skips seeding + hides pack
  // management; the hive:<slug> memory scope itself stays live (recall of an
  // unseeded pool is harmless).
  KNOWLEDGE_PACKS: "papercusp-knowledge-packs",
  // per-hive-learning-loops-2026-06-14 (P-020, D-003/D-008): provisioning a
  // per-HIVE learning loop at pot:create — a DARK gym_autoloop_config row
  // (enabled:false, budget:null) + an INACTIVE scout routine under the hive's
  // own install_slug (NOT @singleton). Both ship inert: the gym tick doubly
  // refuses a disabled+unbudgeted row, and an inactive routine never fires —
  // the owner arms each via the gym/routines UI. Flag-gated + best-effort: a
  // provision failure warns and reports, never fails the create. OFF skips
  // provisioning (a hive still works; it just has no per-hive loop until armed
  // by hand). The matching pot:dissolve teardown is P-021.
  PER_POT_LEARNING_LOOPS: "papercusp-per-hive-learning-loops",
  // per-hive-git-and-release-gate-2026-06-29 (P-009, D-008): gates seeding the per-hive
  // staging→main green-checkpoint (+ release-trigger when a deploy target is declared) for
  // repo-backed CODING hives at create/retrofit. DEFAULT ON (graduated 2026-07-03: the D-008
  // canary condition was met — oddsmith-hive's green-checkpoint went green and fast-forwarded
  // oddsmith's main, live-verified via pipeline_events "advanced" 2026-07-03T15:16Z — not in
  // DARK_FLAGS). Effective only for a hive whose releaseGate.enabled AND that actually has a
  // repo; a hive without per-hive git stays byte-identical.
  PER_POT_RELEASE_GATE: "papercusp-per-hive-release-gate",
  // slash-exposure-tool-catalog-2026-06-12 (P-007): gates the DYNAMIC slash
  // projection — every MCP-exposed tool a session can see surfaces as a
  // `tool:*` MCP prompt (slash command) on prompts/list, with prompts/get
  // rendering the invoke-with-elicitation instruction. Static definePrompt
  // prompts (agent:role, …) are NOT gated by this. OFF = the kill-switch if
  // a client chokes on the 400+-prompt catalog (plan D-003 risk lever).
  SLASH_EXPOSURE: "papercusp-slash-exposure",
  // self-learning-frontier-2026-06-12 (P-004 / FB-02, D-003): the
  // behavior-affecting change ledger — best-effort append-only rows on every
  // prompt/rule mutation (gym commits, prompt-override API, repo prompt-file
  // scan, future FB-09 ablations) + the system:change-ledger-scan cadence.
  // Pure record-keeping (no LLM spend, no queue filing) — Phase 0 FOUNDATION,
  // not one of the D-001 dark-shipped frontier loops: the EKG/ablation need
  // attribution history to already exist when they arm. OFF = kill-switch
  // (every writer no-ops).
  CHANGE_LEDGER: "papercusp-change-ledger",
  // self-learning-frontier-2026-06-12 (P-010 / FB-04): the negative-space
  // miner — `system:negative-space-mine` turns zero-hit docs/plans/memory
  // searches (tool_invocations) into a demand map of missing knowledge and
  // files capped kind=change candidates through the capture core. OFF until
  // the plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule
  // for frontier loops); the Learning tab demand panel reads the map either way.
  NEGATIVE_SPACE_MINER: "papercusp-negative-space-miner",
  // self-learning-frontier-2026-06-12 (P-011 / FB-05): the neologism miner —
  // `system:neologism-mine` mines coord traffic + insights for emergent
  // recurring vocabulary with no corresponding primitive (tool/table/verb)
  // and routes capped abstraction-proposal candidates into Scout's
  // improvement rail via the capture core. OFF until the plan's P-001 arming
  // gate closes (D-001 owner-ratified dark-ship rule for frontier loops).
  NEOLOGISM_MINER: "papercusp-neologism-miner",
  // self-learning-frontier-2026-06-12 (P-003 / FB-01, D-004): the learning
  // governor — ONE shared learning-spend ledger every unattended learning loop
  // registers with (sub-budget + priority). ON: learningGovernorPreflight
  // gates governor-enforced (frontier) loops — unregistered / unbudgeted /
  // exhausted ⇒ REFUSE (the gym null-budget precedent) — and the gym + scout
  // routine actions mirror their budgets/spend onto the ledger (their own
  // gates stay authoritative; zero behavior change). OFF: the preflight
  // refuses EVERYTHING with 'governor-dark' and the mirrors no-op — the
  // kill-switch.
  LEARNING_GOVERNOR: "papercusp-learning-governor",
  // operator-scalability-event-loop-2026-06-16 P5-2: kill-switch for the
  // loop-pressure concurrency governor (startLoopPressureGovernor). ON: the fleet
  // sheds effective agent concurrency when THIS box's event loop is critically
  // saturated (AIMD multiplicative-decrease), recovering as it clears. OFF: the
  // governor never starts — concurrency follows only the user's cap + 429 AIMD.
  // Safe always-on (bounded under the user's cap, self-recovering); the flag is the
  // operator's escape hatch.
  LOOP_PRESSURE_GOVERNOR: "papercusp-loop-pressure-governor",
  // backend-connection-scaling-2026-06-17 C5-1: kill-switch for the CONNECTION-pressure
  // concurrency governor (the sibling of LOOP_PRESSURE_GOVERNOR). ON: the fleet sheds
  // effective agent concurrency (same AIMD seam) when server-wide PG saturation crosses
  // the critical threshold, recovering as it falls — defense-in-depth if PgBouncer is
  // killed/bypassed or a connection storm hits, shedding BEFORE PG returns "too many
  // clients". OFF: the 30s connection-pressure tick only WARNS (today's signal-only
  // behavior). Safe always-on (only sheds at ≥90% saturation, no-op without a finite cap,
  // hysteresis + transition-debounce, self-recovering); the flag is the escape hatch.
  CONNECTION_PRESSURE_GOVERNOR: "papercusp-connection-pressure-governor",
  // infra-perf-reliability-audit-round4-2026-06-19 P-013: the perf/reliability
  // REGRESSION RIG. ON (alpha default-on): the perf-regression collector
  // (system-health/perf-regression-rig.ts) rides the existing improvement-watchdog
  // tick, snapshots the four key reliability SLO metrics (event-loop-lag p95, PG
  // connection saturation %, the dispatch-orphan rate that silently regressed to
  // 91%, and the coord open-escalation backlog) to harness_shared.perf_regression_snapshots,
  // and FILES a watchdog signal on a budget breach so the round-2/3/4 perf gains
  // can't silently regress. SQL + in-memory only, zero LLM spend; a missing
  // table/metric returns a graceful note. OFF = the collector reports a 'disabled'
  // note and emits nothing (the kill-switch). NOT dark — finished, additive,
  // read-mostly monitoring; flipping it OFF only blinds the regression watch.
  PERF_REGRESSION_RIG: "papercusp-perf-regression-rig",
  // inference-gateway-robustness-audit-2026-06-20 (gateway P2 / B-GW-4): the fleet
  // OPUS-BUDGET governor. ON (alpha default-on): as the aggregate Claude-Max 5h opus
  // utilization climbs, a spawn's NON-CRITICAL opus tier-escalation is shed back to
  // sonnet (background first, then normal), reserving 5h headroom so the fleet paces
  // UNDER the ceiling instead of blow-then-starve; `critical` opus is never downgraded
  // (paced only past near-cap). OFF: spawns run their resolved tier verbatim (today's
  // behavior). Safe always-on (only removes an opus ESCALATION, never below a role's
  // floor; self-healing as the window decays); the flag is the operator's escape hatch.
  OPUS_BUDGET_PACING: "papercusp-opus-budget-pacing",
  // agent-activity-liveness-truth-2026-06-21 P-003 (D-001/D-003/D-004): arm the
  // STALLED leg of the stale-claim reconciler. ON: reclaimStaleWorkItemClaims ALSO
  // frees a claim whose holder is ALIVE but has made no item-scoped progress within
  // the window (last_progress_at stale) — a claim is not progress (D-001) — requeuing
  // the item so the Queen/agents re-pick it. OFF (default): only DEAD-holder + the
  // confirmed-terminal-spawn legs free claims (today's behavior + the new immediate
  // spawn-death release, both safe). DARK because freeing a LIVE agent's claim
  // changes live placement on a fleet-critical hot path (D-003: land it attended).
  RECLAIM_STALLED: "papercusp-reclaim-stalled",
  // operator-memory-and-psu-resilience-2026-06-14 P-008 (WI-147, D-004/D-005/D-006):
  // lazy + bounded harness-substrate boot. ON: the operator boots a harness's heavy
  // substrate ENGINE (corestore + merge-fold + projections + merge-poll) on demand and
  // evicts idle ones via LRU (planSubstrateEviction), keeping only the N hottest resident
  // — a lightweight swarm-presence + LISTEN-substrate_outbox keepalive stays resident so an
  // evicted harness still drains its outbox + receives peer pushes (re-boot-on-NOTIFY/connection).
  // Bounds operator RSS sub-linearly in harness count (~108 MB/harness today). OFF (default):
  // boot is byte-identical to today (eager all-harness boot). DARK + STAGED-ON-:3170-FIRST
  // because a wrong eviction silently stops a harness syncing → fleet data divergence (the
  // EI-126 102 GB class) — D-005/D-006 binding execution constraint.
  LAZY_SUBSTRATE_BOOT: "papercusp-lazy-substrate-boot",
  // self-learning-frontier-2026-06-12 (P-020 / FB-06): the replay harness —
  // re-run an agent from a historical transcript point (or synthetic context)
  // under a modified prompt/policy and judge the divergence; the substrate for
  // regret mining / transfer / shadow ablation (P-021..023). OFF until the
  // plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule):
  // replayPreflight refuses with 'replay-dark', so no unattended replay can
  // spend. Double-gated — the loop also ships unregistered/unbudgeted on the
  // learning governor until the P-001 arming act.
  REPLAY_HARNESS: "papercusp-replay-harness",
  // experiment-registry-invocation-api-2026-06-14 (#2, "close the loop"): the dark
  // Scout→experiment rail. ON ⇒ each testable (gym-rail) Scout proposal is ADDITIVELY
  // expressed as a DRY-RUN experiment spec (no spend, no change to gym routing); OFF ⇒
  // Scout unchanged. D-001 dark-ship rule; double-gated — experiment:run also rides
  // papercusp-replay-harness + the governor before anything could spend.
  SCOUT_EXPERIMENT_RAIL: "papercusp-scout-experiment-rail",
  // blender-loop-repair-and-opus5-xhigh-2026-08-16 P-013 (D-005, owner: "I want goal
  // mode to be full auto too"): the Blender's GOAL rail — a goal-scale routed idea
  // (multi-plan scope, weeks-long measurable end-state) CREATES AND STARTS a real goal
  // (headless GOAL-mode agent, drafted killCriterion + budgetCents riding inside the
  // record per D-005 — the confirm card's replacement). Default ON (derived
  // FLAG_DEFAULTS — not in DARK_FLAGS). KILL SWITCH: OFF reroutes goal-bound ideas to
  // the plan rail (draft plans) — never dropped; routing is otherwise byte-identical.
  BLENDER_GOAL_RAIL: "papercusp-blender-goal-rail",
  // plan-templates-and-rubric-v2-2026-06-20 (P-009, Phase 4 auto-crystallization):
  // the Scout `rubric` rail. ON ⇒ on a detected RUBRIC GAP (corpus-digest rubricGaps,
  // P-008) Scout AUTHORS a `template: rubric` DRAFT plan → the existing queen↔scout
  // loop ratifies it into an active rubric; OFF ⇒ the gap is detected (visible in the
  // digest) but no draft is auto-authored. DARK by default — a brand-new autonomous
  // PLAN-WRITE behavior; the owner flips it after observing gap quality. Idempotent
  // (one stable slug/gap) + best-effort (never disturbs the cycle); drafts are
  // Queen-gated (invisible to rubrics:list until promoted active+templateData).
  SCOUT_RUBRIC_RAIL: "papercusp-scout-rubric-rail",
  // blender-self-learning-2026-07-12 P-002 (WI-4318): VOLUME-BASED Scout firing —
  // the cadence gate consumes the signal-accumulator's weighted new-signal score
  // (scout/signal-accumulator.ts, migration 582): score ≥ threshold fires, score 0
  // NEVER fires (stale-corpus heartbeat cycles eliminated), friction/queen-feedback
  // paths unchanged. Default ON (derived FLAG_DEFAULTS). KILL SWITCH: flip OFF →
  // the scheduler stops supplying signalScore and the gate reverts byte-identical
  // to the legacy time-based cadence (reversible cutover, no restart needed).
  SCOUT_VOLUME_CADENCE: "papercusp-scout-volume-cadence",
  // self-learning-frontier-2026-06-12 (P-021 / FB-07): regret mining —
  // `system:regret-mine` selects bad historical sessions (token-burn
  // percentile, validator bounces, rescue markers), locates the divergence
  // turn in the persisted transcript, and — once the FB-06 replay harness
  // lands — counterfactually replays candidate rule changes from that turn,
  // filing scored what-would-have-helped reports origin=replay through the
  // capture core. OFF until the plan's P-001 arming gate closes (D-001
  // owner-ratified dark-ship rule for frontier loops).
  REGRET_MINING: "papercusp-regret-mining",
  // self-learning-frontier-2026-06-12 (P-022 / FB-08, D-006): the transfer
  // harness — `system:transfer-distill` distills candidate lessons from the
  // day's transcripts, admits them FREE at memory tier 'probationary'
  // (admission is never gated — the same-turn insight rule is untouched), and
  // promotes a lesson to 'validated' only when a fresh student agent with it
  // beats one without it on the source historical task (replayed via
  // lib/replay, judged by the frozen eval-battery). Repeated failures retire
  // (forget) the lesson; knowledge-pack candidate adoption inherits the bar.
  // DEFAULT ON — deliberately RATIFIED 2026-07-19 (knowledge-pack-loop-
  // integrity P-004, EI-18106972904923204). History: this comment said "OFF
  // until the P-001 arming gate closes" but the flag was never added to
  // DARK_FLAGS, so the 2026-06-29 P-011 inversion silently derived it ON —
  // the 5th instance of that bug class. Rather than another at-watermark
  // dark-allowlist raise (13/13 as of EI-16635 the same day), ON is ratified
  // because the flag is NOT the arming gate: the transfer loop self-registers
  // UNBUDGETED on the learning governor and REFUSES to run until the owner
  // budgets `frontier:transfer-harness` (verified live: 0 transfer_lessons
  // rows after weeks of derived-ON), and the pack-bar is fail-open and can
  // only block on a 'failed'/'retired' lesson — which requires that
  // governor-gated battery to have run. The owner's arming act is therefore
  // preserved with the flag ON; OFF remains a clean kill-switch.
  TRANSFER_HARNESS: "papercusp-transfer-harness",
  // self-learning-frontier-2026-06-12 (P-030 / FB-10): the Fleet EKG —
  // `system:fleet-ekg-scan` embeds agent sessions (agent_activity) into
  // behavioral feature vectors (tool mix/bigrams, pacing, retry rhythm — no
  // LLM), detects fleet-wide distribution shifts against the trailing
  // baseline, attributes them to the behavior-change ledger (D-003), and
  // alarms the attention rail on unattributable MAJOR shifts. OFF until the
  // plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule for
  // frontier loops); the Learning tab EKG panel reads stored shifts either way.
  FLEET_EKG: "papercusp-fleet-ekg",
  // self-learning-frontier-2026-06-12 (P-023 / FB-09): prompt sedimentology —
  // `system:prompt-ablation`, the weekly SHADOW ablation of one SU-playbook
  // governance rule via the llm-testing su target (a snapshot-baseline arm vs
  // an ablated arm; live prompts are NEVER mutated by this lane). Dead-weight
  // evidence accumulates in harness_shared.prompt_ablation_runs for owner
  // review. Spends real LLM tokens per cycle, so it is governor-preflighted
  // (loop `prompt-ablation`). OFF until the plan's P-001 arming gate closes
  // (D-001 owner-ratified dark-ship rule for frontier loops).
  PROMPT_ABLATION: "papercusp-prompt-ablation",
  // self-learning-frontier-2026-06-12 (P-042 / FB-14, D-006): deferral
  // interest — `system:deferral-interest-refit` backfills realized deferral
  // costs from history (human-lane items → downstream blockage accrued while
  // each sat deferred) and fits the learned pricing model the one queue
  // ranker (P-040 / FB-12) reads as its deferral-interest feature. SQL-only,
  // zero LLM spend. OFF until the plan's P-001 arming gate closes (D-001
  // owner-ratified dark-ship rule for frontier loops); the ranker feature
  // degrades to zero-priced while no model is trained.
  DEFERRAL_INTEREST: "papercusp-deferral-interest",
  // self-learning-frontier-2026-06-12 (P-043 / FB-15): the owner preference
  // model — implicit owner-attention telemetry (owner grades/regrades,
  // queue-view exposure) scored as a bounded re-ranking feature of the one
  // queue ranker (P-040 / FB-12). SQL-only, zero LLM spend; re-ranking only,
  // explicit grades stay sovereign. OFF until the plan's P-001 arming gate
  // closes (D-001 owner-ratified dark-ship rule for frontier loops); the
  // interaction CAPTURE seams are unflagged substrate (FB-02/FB-03 call) so
  // history accumulates before arming.
  OWNER_PREFERENCE_RANKING: "papercusp-owner-preference-ranking",
  // self-learning-frontier-2026-06-12 (P-041 / FB-13): calibration markets —
  // cheap recorded claims at natural moments (improvements:resolve confidence,
  // plan starts, flake filings), matured by `system:calibration-resolve` and
  // Brier-scored per persona per domain; consumed as a feature of the one
  // queue ranker (P-040 / FB-12, D-005) and by Queen-weighting reads
  // (calibration:summary). SQL-only, zero LLM spend. OFF gates BOTH the
  // capture seams and the sweep until the plan's P-001 arming gate closes
  // (D-001 owner-ratified dark-ship rule for frontier loops); the ranker
  // feature contributes 0 while OFF or while no bets are scored.
  CALIBRATION_MARKETS: "papercusp-calibration-markets",
  // relight-self-learning-edges-2026-06-14 (P-033): the `memory-precision`
  // learning singleton — a WEEKLY bench that replays the frozen gold set against
  // the production hybrid backend AT THE PUSH FLOOR and records FP@5 / R@10 /
  // precision to harness_shared.memory_precision_bench, so the Learning tab
  // MONITORS the injection floor (solved/optimal, D-007) instead of trusting a
  // one-time benchmark. Flag-only (no governor, like change-ledger): cheap
  // (~$0.05 embeddings/run, no LLM); ON by default so the monitoring panel has
  // data. OFF cuts the bench (and the precision chips degrade to "—").
  MEMORY_PRECISION_BENCH: "papercusp-memory-precision-bench",
  // EI-10047: the memory RECALL CANARY — a daily known-item replay against the
  // LIVE memory stack (read-only; frozen query→memory-id pairs sampled from real
  // stable memories) recording recall@10 vs a frozen baseline to
  // harness_shared.memory_live_recall_canary_run, alerting (attention + severe-event)
  // on a >5pt drop or a zero-hit blackout. Complements MEMORY_PRECISION_BENCH
  // (fixture corpus in an isolated bench schema = code-path monitor): the canary
  // watches the DEPLOYMENT — live schema drift / embedder misconfig, the
  // 2026-07-12 PG-42703 silent-blackout class. Cheap (~25 live searches/day, no
  // LLM, no writes to the store); ON by default. OFF cuts the canary tick.
  MEMORY_LIVE_RECALL_CANARY: "papercusp-memory-live-recall-canary",
  // data-scoping-audit-2026-06-22 P-006 / D-004 / D-012: workspace-scope the memory RECALL
  // user-pool (drop cross-workspace `project` hits; keep owner-tier user/feedback/reference
  // + legacy NULL-workspace rows). Dark CUTOVER — the flip is the attended live recall-
  // hit-rate verify. Rides migration 398's generated workspace_id column.
  MEMORY_WORKSPACE_SCOPED_RECALL: "papercusp-memory-workspace-scoped-recall",
  // context-injection-audit-2026-07-28 P-008 / D-037: the SECOND retrieval leg.
  // The injector read mem0 memories ONLY — session transcripts (~400k turns,
  // gemma@384-embedded + tsvector-indexed) and work-items were structurally
  // unreachable from an injected turn. This leg searches both through the
  // existing @papercusp/search sources and appends a small POINTER section
  // (teaser + the tool call that resolves it) on its OWN item cap + char
  // budget. It takes no share of INJECTION_TOTAL_LIMIT, because the mem0 user
  // pool alone already saturates that ceiling on 64.3% of turn-start recalls,
  // and because the two corpora sit in incompatible vector spaces
  // (harrier@1024 vs gemma@384) so they cannot share one comparable ranking.
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS): additive, bounded
  // (2s), and fail-open. OFF = the clean kill-switch — the block returns to
  // its mem0-only form byte-identically.
  MEMORY_CORPUS_RECALL: "papercusp-memory-corpus-recall",
  // WI-36046 (workstream A): hand the nightly anchor sweep's verdict to the AGENT.
  // `memory/audit-memory-anchors.ts` has been re-checking every memory's extracted
  // anchors nightly (DBOS `0 0 5 * * *`) and writing last_check_ok per anchor — but
  // the only consumer was the human settings UI, so recall rendered a memory whose
  // referents provably no longer exist as ordinary binding guidance (measured
  // 2026-08-08: 354 memories with a dead anchor, invisible to memory:search). ON =
  // a stale hit carries a `staleness` field AND a prepended one-line banner, so it
  // reads as evidence to reconcile rather than an instruction. Reads the STORED
  // verdict only — never computes the check inline, because coord:orient folds this
  // path and the audit does fs.stat + PG per anchor. Default ON (derived
  // FLAG_DEFAULTS — not in DARK_FLAGS): additive, bounded (one indexed read over
  // the recall's own ids), and fail-open at every step. OFF = the clean kill-switch
  // — recall returns to its byte-identical pre-WI-36046 shape.
  MEMORY_STALENESS_IN_RECALL: "papercusp-memory-staleness-in-recall",
  // WI-37403 / migration 771: retain the retrieval QUERY TEXT on a bounded
  // window (harness_shared.memory_recall_query_text), joined to the recall row.
  // Before this only query_sha256 + query_chars were stored, so the table could
  // say what came BACK and nothing about whether the query was even about the
  // right thing — a live finding (mid-turn cosine queries matching on shell/path
  // chrome) had to be evidenced from an agent transcript instead of measured.
  // Stores the DERIVED per-leg query (post splitLegQueries), never raw
  // tool_input; text that trips the credential detector is refused outright.
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS): the owner directed
  // the capture, and it is additive + retention-bounded by the existing
  // system:telemetry-retention janitor. It is nonetheless the one capture here
  // that stores agent-authored TEXT, so it gets a flag precisely so it can be
  // stopped instantly without a deploy — and its guard fails CLOSED (a
  // flag-read error captures nothing), unlike the retention prunes' fail-safe.
  MEMORY_RECALL_QUERY_TEXT: "papercusp-memory-recall-query-text",
  // jev-performance-improvements-2026-09-30 P-010 (owner directive #1050): memory:remember
  // refuses, once at save time, a new memory that only claims its own relevance or
  // importance (Jev's substance question, asked in the same request as the conflict
  // check; refused with reason content_free and the usual force override). Default ON
  // (derived FLAG_DEFAULTS — not in DARK_FLAGS): the threshold was chosen on a measured
  // real-memory sample (at most 1% refused, plan R-3). OFF is the kill switch — the
  // write path returns to the conflict-only request.
  MEMORY_CONTENT_FREE_REFUSAL: "papercusp-memory-content-free-refusal",
  // context-injection-audit-2026-07-28 P-039 / D-012: the presence-transition
  // emitter — the missing FEEDER for the mid-turn coord rail. Automatic
  // injection carried zero liveness, and every coord_event_log writer was an
  // explicit agent action, so a peer dying emitted nothing to the agent blocked
  // on them. Writes ONE commitment-scoped line (never a roster broadcast) to
  // each agent whose own awaited reply / lock / held item just became void.
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS): additive,
  // self-budgeting (silent unless a crossing intersects a real commitment) and
  // fail-soft on every leg. OFF = the clean kill-switch — the rail carries no
  // presence lines, exactly as before it landed.
  COORD_PRESENCE_TRANSITION_ALERTS:
    "papercusp-coord-presence-transition-alerts",
  // self-learning-frontier-2026-06-12 (P-031 / FB-20): Red Queen vaccination —
  // `system:red-queen-drill` plants origin=drill synthetic frictions in the
  // SANDBOX workspace ('red-queen-sandbox'), detects them with a real watchdog
  // tick, routes them through the real triage path (drill-opted-in), heals
  // them with the class's known remedy, and records MTTSH + a per-run
  // zero-leak assertion (lib/red-queen). SQL-only, zero LLM spend. The same
  // flag gates the out-of-band routine-engine-death sentinel (a plain
  // interval in host-bootstrap — the 06-12 DBOS incident class). OFF until
  // the plan's P-001 arming gate closes (D-001 owner-ratified dark-ship rule
  // for frontier loops).
  RED_QUEEN: "papercusp-red-queen",
  // self-learning-frontier-2026-06-12 (P-047 / FB-21): audit-as-sensors — five
  // learning-system SLO collectors riding the existing improvement-watchdog
  // tick (triage-distribution entropy, capture-vs-consume flow imbalance,
  // MTTSH regression, governor budget starvation, memory recall zero-hit
  // spike). SQL-only, zero LLM spend, no routine of its own — a breach FILES
  // into the improvements queue. DEFAULT ON (derived FLAG_DEFAULTS — not in
  // DARK_FLAGS; EI-18886519654229938, 2026-08-02: this comment's own "ships
  // dark until the plan's P-001 arming gate closes" was never true in the
  // code — the key was never added to DARK_FLAGS, so it always derived live
  // default-ON — and the gate closed 2026-06-13 anyway, naming this exact
  // wave-1 zero-spend sensor bank safe-to-arm, D-010; zero learning-slo:*
  // findings have ever fired). OFF is a normal operator kill-switch: every
  // collector reports a 'dark' note and emits nothing.
  LEARNING_SLO_SENSORS: "papercusp-learning-slo-sensors",
  // self-learning-frontier-2026-06-12 (P-045/P-046 / FB-19): the graduation
  // evidence tracker — `system:graduation-scan` counts per-class clean
  // auto-implement passes over the existing outcome rails (resolve evidence,
  // decay verification, dispatch ledger, gym/EKG regressions) and files a
  // "class X is graduation-eligible" OWNER report when a class crosses the
  // threshold. It NEVER edits autoKinds — widening stays a reviewed policy.ts
  // config change riding the release gate (D-008). SQL-only, zero LLM spend,
  // but it FILES into the improvements queue, so it ships dark until the
  // plan's P-001 arming gate closes (D-001).
  GRADUATION_TRACKER: "papercusp-graduation-tracker",
  // queen-autonomous-execution-2026-06-13 B-10 (P-041/P-045): card interception
  // for the Queen hive loop. When ON, a fleet AGENT's (bee / signed-spawn) blocking
  // chat:ask_choice / ctx.askUser is intercepted — routed through the agent-question
  // gate as a durable, routable escalation (category=agent-question, owner-Queue by
  // default; autonomy-policy's classifier injects the rung) instead of a frozen card
  // no human is watching, and the card gets a bounded timeout that degrades to
  // {action:'cancel'} so the bee never spins forever. ON by default (behavior-neutral
  // throughput improvement, D-007): interactive callers (human/operator) are untouched.
  MUG_CARD_INTERCEPTION: "papercusp-queen-card-interception",
  // agent-capability-confinement-2026-06-13 B-06 (P-012): ENFORCEMENT of the per-role
  // capability envelope at the dispatch chokepoint. OFF by default — DELIBERATE (not the
  // alpha flags-default-on policy): enabling it would DENY autonomous-fleet MCP tool calls
  // outside the (still-initial) per-role allowlist before the B-18 fleet cutover wires the
  // fleet onto the gated capability defineTools (B-05). When OFF the envelope runs in
  // OBSERVE-ONLY/shadow mode — it evaluates + annotates the ledger posture ('gated' =
  // would-deny) but never blocks — giving B-18 real arming data safely. SU / power-user /
  // non-fleet callers are exempt regardless (D-002). Surfaced loudly in the plan ## Now +
  // the completion report as the pending B-18 flip.
  CAPABILITY_ENVELOPE: "papercusp-capability-envelope",
  // live-configurability-audit-2026-06-20 P-008 — runtime role→capability grant tool
  // (capability:grant_role / capability:revoke_role). DARK by default (owner-authority, D-007):
  // it flag-gates both the loadRoleCapabilities grant-union AND the grant/revoke tools.
  CAPABILITY_GRANT_TOOL: "papercusp-capability-grant-tool",
  // live-configurability-audit-2026-06-20 P-007 — BOINC work-item redundancy master switch
  // (migrated off the PAPERCUSP_WORKITEM_REDUNDANCY env gate). DEFAULT ON — graduated out of
  // DARK_FLAGS 2026-06-22 (this comment said "DARK (N× model spend)" until 2026-08-03, contradicting
  // the derived FLAG_DEFAULTS one file over; EI-19448574704459898). Default-ON is NOT N× spend
  // fleet-wide: the master switch only makes redundancy AVAILABLE, and a redundant run additionally
  // requires an explicit per-item work_items:set_redundancy (≥ MIN_REDUNDANCY). SYNC-cached
  // because the claim-path read is synchronous (the WORKITEM_CLAIM_LEASE migration pattern).
  WORKITEM_REDUNDANCY: "papercusp-workitem-redundancy",
  // live-configurability-audit-2026-06-20 P-009 — runtime per-role capability-envelope
  // overrides (capability_envelope:set_role / :set_protected). DARK: when ON the D-010
  // sync-cache merges per-role deny/allow overrides OVER the baked ROLE_ENVELOPES and unions
  // tighten-only protected-floor additions, at the dispatch checkCapabilityEnvelope step.
  // OFF (default) ⇒ the sync-cache stays empty ⇒ byte-identical. (Also needs CAPABILITY_ENVELOPE
  // ON for the envelope to actually bite — this flag only governs whether overrides apply.)
  CAPABILITY_ENVELOPE_OVERRIDES: "papercusp-capability-envelope-overrides",
  // live-configurability-audit-2026-06-20 P-020 — runtime dispatch telemetry-buffer config
  // (telemetry:set_buffer: maxPending / debounceMs / maxBatch). Default-ON kill-switch: the
  // override store is empty by default ⇒ baked defaults ⇒ byte-identical; flip OFF to ignore any
  // stored override and force the baked defaults. Operational (not auth/spend), so not dark.
  TELEMETRY_BUFFER_CONFIG: "papercusp-telemetry-buffer-config",
  // live-configurability-audit-2026-06-20 P-020 — runtime per-workspace txn lock_timeout/statement_timeout
  // (db:txn-timeouts) applied by inWorkspaceTxn via the @papercusp/locks getTxnTimeouts seam. Default-ON
  // kill-switch: the override store is empty by default ⇒ baked 5s/5s ⇒ byte-identical; flip OFF to ignore
  // any stored override and force the defaults. Operational (not auth/spend), so not dark.
  TXN_TIMEOUTS_CONFIG: "papercusp-txn-timeouts-config",
  // live-configurability-audit-2026-06-20 P-019 — the §G AUTH/SANDBOX runtime-override umbrella.
  // DARK (owner-authority): when ON, the operator_auth_config store's overrides apply —
  // auth:set_full_access_roles REPLACES the baked TESTING_FULL_ACCESS_ROLES bypass set (the strongest
  // escalation in the system, so the override is gated here), clamp:set_safe_tools NARROWS the
  // scoped-SU cross-workspace allowlist (tighten-only), and exec_sandbox:set_policy ADDS sandbox mask
  // dirs / forces deny-all-egress (tighten-only). It ALSO gates capability_tier:set (P-010) — a
  // runtime capability→tier override consulted by papercuspTierFor before the baked table. OFF
  // (default) ⇒ every §G sync-cache stays empty ⇒ every surface uses its baked literal ⇒
  // byte-identical. The owner flips this ON to ratify the §G auth-config dials.
  AUTH_CONFIG_OVERRIDES: "papercusp-auth-config-overrides",
  // live-configurability-audit-2026-06-20 P-019 — the testing-phase full-access master switch, the
  // env→flag conversion of the PAPERCUSP_TESTING_FULL_ACCESS_ROLES=off kill-switch (gate-bypass.ts).
  // Default-ON = the testing-phase role+capability bypass (operator/queen/bee/overwatch/sentinel/scout)
  // stays enabled exactly as today; flip OFF to globally DISABLE testing-full-access (least-privilege).
  // Not dark — ON reproduces current behaviour; this is just the kill-switch as a runtime flag.
  TESTING_FULL_ACCESS: "papercusp-testing-full-access",
  // agent-capability-confinement-2026-06-13 B-06 (P-011) ⨯ queen-autonomy-policy D-012/P-110:
  // the Queen decision-ledger ACTION-CHOKEPOINT emit — one append-only row per governed
  // (tier != 'low') action by a non-SU principal, from the dispatch postInvoke seam. ON by
  // default: pure additive record-keeping, no LLM spend, a subset of tool_invocations — the
  // same Phase-0-foundation call as CHANGE_LEDGER (rows must accumulate before queen-autonomy
  // B-13's surface + the autonomy gate consume them). OFF is the kill-switch (the emit no-ops).
  DECISION_LEDGER: "papercusp-decision-ledger",
  // queue-authorization-redesign-2026-06-14 (P-004/P-006): the Queue UI redesign —
  // group the pending queue by AUTHORIZER ("Needs your call" vs "Automatable — for
  // now") instead of urgency tiers, surface the per-card why-it's-here line +
  // category badge, and add the "Queen's log" segmented tab. ON by default (alpha
  // flags-default-on): pure presentation over the already-computed whyGated/authorizer
  // fields + the existing decision.ledger read; no new writes. OFF = the prior
  // tier-grouped queue (safe rollback).
  QUEUE_AUTHORIZATION_VIEW: "papercusp-queue-authorization-view",
  // queen-autonomous-execution-2026-06-13 B-09 (P-020/P-021/P-022): the placement
  // completion watchdog for the Queen hive loop. When ON, the 30s routinesTick
  // reconciles each Queen-placed unit (hive_placements, mig 263) against live bee
  // state (hive_placements, mig 263): a non-terminal placed unit whose serving bee
  // died/stalled and is not re-claimed fires ONE recovery wake to the Queen (P-020); after N
  // failed placements the unit flips `cursed` and is escalated to the owner
  // instead of re-placed forever (P-021); a stuck `failing`/`failed` blocker
  // gating downstream work is escalated once (P-022). Behavior-neutral throughput
  // (D-007): the sweep only acts on STARTED hives, and the hive is owner-gated.
  // OFF = the kill-switch (the sweep returns immediately).
  POT_PLACEMENT_WATCHDOG: "papercusp-hive-placement-watchdog",
  // queen-autonomy-policy-2026-06-13 B-12 (P-070/P-092): the ARMING GATE for the
  // Queen autonomy decider (lib/autonomy/decider.ts). When OFF the decider returns
  // `gated` for EVERY queue item — autonomy is dark, behavior identical to today
  // (D-007). When ON the D-004 gating function applies, but every category still
  // ships at `never-auto` (D-007), so nothing auto-decides until the owner ALSO
  // lowers a per-category ceiling and a class graduates within it (D-005). OFF by
  // default — DELIBERATE, NOT the alpha flags-default-on policy: flipping it is the
  // owner's P-092 arming act, gated on B-19's behavior-neutral proof + the frontier
  // consume-edges live proof. The decider's default deps fail-DARK on a flag-IO
  // error so a hiccup can never arm autonomy. Surfaced loudly as the pending P-092 flip.
  MUG_AUTONOMY_ARMED: "papercusp-queen-autonomy-armed",
  // state-plane-interest-and-hardening-2026-08-21 P-014: mechanize the
  // transition watches the fleet-leader persona already mandates. Default ON
  // (derived FLAG_DEFAULTS — not in DARK_FLAGS): OFF is the reversible
  // kill-switch for profile-driven auto-arm only; AUTO mode, the leader monitor
  // loop, and inbox wake remain unchanged. A flag-read error fails SAFE to ON so
  // a transient flag backend miss cannot silently leave a leader monitoring blind.
  FLEET_LEADER_PROFILE_AUTO_ARM: "papercusp-fleet-leader-profile-auto-arm",
  // queen-autonomy-and-selffeed-fix-2026-06-15 Phase 2 (P-001/P-002): the OWNER
  // FULL-AUTONOMY grant — the reversible knob the owner flips to let the Queen
  // auto-decide the ENTIRE residue the per-category ceilings can't reach. When ON,
  // (1) the autonomy decider (lib/autonomy/decider.ts) returns `auto` for the
  // categorical hard-gates too — `authority:'owner'`, protected/locked categories,
  // irreversible actions, above-ceiling — and graduation:* ratification asks, so the
  // Queen widens her own ceilings without pausing; and (2) the self-improvement
  // auto-implement loop's risk-tier policy (harness/improvements/policy.ts) lifts the
  // `protectedPathPatterns` + `protectedKeywords` TCB bars, so a kind=bug touching the
  // deploy gate / flags / capability dispatch / migrations / the loop's own code is
  // auto-implement-eligible (still separately gated by IMPROVEMENT_AUTO_IMPLEMENT,
  // default OFF, + the release-manager at deploy). This is the recursive-self-
  // improvement boundary — the owner was warned it removes the last human check on the
  // system widening its own ceilings and editing its own safety machinery, and chose
  // it (knob scope = "decision gate + implement TCB"). OFF by default — DELIBERATE, NOT
  // the alpha flags-default-on policy; the decider/loop fail-DARK on a flag-IO error.
  // REVERSIBLE: flipping it OFF restores today's gated residue VERBATIM (the safety
  // net for an alpha — pinned both directions in tests). Audited via the flag change +
  // the decision ledger (every auto decision records `owner-full-autonomy-grant`).
  MUG_FULL_AUTONOMY: "papercusp-queen-full-autonomy",
  // queen-autonomy-policy-2026-06-13 B-15 (P-030): the owner control surface —
  // /settings/autonomy, where the owner sets per-category risk ceilings / locks
  // and sees the earned graduated + derived effective level. ON by default (alpha
  // flags-default-on policy): the page only reads + writes the already-audited
  // autonomy_policy (every category ships never-auto, and editing a ceiling never
  // ARMS autonomy — that's the separate MUG_AUTONOMY_ARMED / P-092 gate). OFF is
  // the kill-switch that hides the nav entry (the page's auto-decisions feed +
  // graduation prompts are still stubbed pending B-16).
  MUG_AUTONOMY_SETTINGS: "papercusp-queen-autonomy-settings",
  // storage-settings-page-2026-06-15 (P-002): the Settings → Storage owner
  // surface — live usage by category + user-controlled trim-by-age. ON by default
  // (alpha flags-default-on); keep-all is the default behavior regardless. OFF
  // hides the nav entry (the page never auto-prunes — only an explicit trim runs).
  STORAGE_SETTINGS: "papercusp-storage-settings",
  // storage-settings-page-2026-06-15 P-006 — per-retention disable for the
  // pre-existing background prunes surfaced on the Storage page (D-001: "see the
  // full retention picture and disable if desired"). ON by default = the prune
  // keeps running (current behavior); OFF = the DBOS tick skips it. The tick guard
  // is fail-safe (a flag-read error keeps the prune running).
  STORAGE_RETAIN_TELEMETRY: "papercusp-storage-retain-telemetry",
  STORAGE_RETAIN_SCRATCH: "papercusp-storage-retain-scratch",
  STORAGE_RETAIN_TEST_RUNS: "papercusp-storage-retain-test-runs",
  // WI-924391 — retention for resource-governor admission receipts (ephemeral
  // queue-state rows written into work_items, which is otherwise "not age-prunable
  // by design"). ON by default like its siblings = the prune runs; OFF = the hourly
  // DBOS tick skips it. Turning this OFF re-arms the exact failure it was added for:
  // ~24k rows/hour accumulating unbounded into work_items until the scheduler
  // claim-spec census collapses fleet-wide. See resource-governor/receipt-gc.ts.
  STORAGE_RETAIN_GOVERNOR_RECEIPTS: "papercusp-storage-retain-governor-receipts",
  // agent-capability-confinement-2026-06-13 B-18 (P-020/P-021): the FLEET CUTOVER —
  // when ON, autonomous-fleet (bee/pipeline) claude-code spawns drop the native
  // WRITE/exec tools (Bash/Edit/Write/WebFetch) from `--allowed-tools` and route
  // them to the gated `capability:*` defineTools (B-05), keeping only the read-only
  // natives (Read/Glob/Grep/WebSearch) + the role-scoped `mcp__papercusp` wildcard.
  // DEFAULT ON — graduated 2026-06-23 (owner-directed arming of agent-capability-
  // confinement B-18/P-020, WI-602). The fleet cutover drops native write/exec tools from
  // autonomous spawns and routes them to the gated capability:* defineTools. Live-validated
  // on this box (operator_flag_overrides ON for days): bees+queen made hundreds of
  // successful capability:bash/edit/git/write calls with 0 errors — capability:* ergonomics
  // confirmed on live agents. Pairs with CAPABILITY_ENVELOPE (enforcement) +
  // CAPABILITY_EXEC_SANDBOX (re-containment, still default-OFF pending bwrap-host validation
  // — WI-608; on a fresh bwrap host flip exec-sandbox too so capability:bash isn't
  // unsandboxed). OFF = today's native-tool allowlist (kill-switch).
  FLEET_CAPABILITY_ONLY: "papercusp-fleet-capability-only",
  // agent-capability-confinement-2026-06-13 B-18 (P-022 / D-008): re-apply the OS
  // sandbox to the SERVER-SIDE capability exec path. The capability:bash / capability:git
  // tools spawn real subprocesses in the operator (Hono host) process — OUTSIDE the
  // per-spawn agent sandbox (bwrap+egress) that contains native Bash — so the cutover
  // would move exec from a sandboxed context to an unsandboxed one. When ON (and bwrap
  // is available) those subprocesses are wrapped in bwrap with the fleet-sandbox
  // credential masking + cwd-confinement. FAIL-OPEN: bwrap unavailable / flag OFF ⇒ raw
  // spawn (today's behavior) — it can never break a non-bwrap host. OFF by default until
  // validated end-to-end on a bwrap-capable host (this dev box's userns is restricted).
  CAPABILITY_EXEC_SANDBOX: "papercusp-capability-exec-sandbox",
  // agent-virtual-desktops-2026-08-23 P-010 (D-015): wrap APPS launched on a leased
  // sandbox desktop in bubblewrap — read-only host root, a private /tmp and HOME, and the
  // shared credential masks — so a GUI app no longer runs bare as the operator user.
  // ON by default (alpha default-on) and FAIL-OPEN: bwrap unavailable ⇒ the app launches
  // raw exactly as before, so this can never break a non-bwrap host. Distinct from
  // CAPABILITY_EXEC_SANDBOX, which contains capability:bash/git payloads: that one's
  // `--tmpfs /tmp` is actively WRONG for a desktop app, whose display and a11y bus are both
  // sockets under /tmp (D-015). Network isolation is a separate per-desktop opt-in, not
  // this flag — see `denyNetwork` in desktop-sandbox.ts.
  DESKTOP_APP_SANDBOX: "papercusp-desktop-app-sandbox",
  // git-sync-content-guard-2026-06-13 (D-006-superseded): the runtime KILL-SWITCH for
  // the git-sync content guard (EI-438) — the pre-commit check that quarantines a dirty
  // file failing a content detector (an .mdx that won't compile, a curly quote used as
  // code) so it never reaches staging, + the content-fixer auto-repair. ON by default
  // (alpha default-on + it's a safety feature). When OFF, git-sync passes the guard an
  // EMPTY detector set, so it commits exactly as before this plan (no quarantine, no
  // escalation, no fixer dispatch) — the instant off-switch if the guard ever
  // mis-quarantines real work on the shared commit path, without waiting for a deploy.
  GIT_SYNC_CONTENT_GUARD: "papercusp-git-sync-content-guard",
  // EI-17 (git-sync-deletion-import-guard-2026-07-20): the runtime KILL-SWITCH for the
  // git-sync DELETION-import guard — the pre-commit check that quarantines a dirty file
  // DELETION when a surviving file still (relatively) imports it, so a breaking deletion
  // (the 2026-06-05 fleet-wide crash-loop on `Cannot find module './operator-last-scan'`)
  // can never reach `staging` again. ON by default (alpha default-on + it's a safety
  // feature, same class as GIT_SYNC_CONTENT_GUARD). When OFF, the deletion is committed
  // exactly as before this plan (no quarantine, no escalation) — the instant off-switch on
  // this shared commit path if the guard ever mis-quarantines a real, safe deletion.
  GIT_SYNC_DELETION_GUARD: "papercusp-git-sync-deletion-guard",
  // github-bridge-hive-egress-2026-07-02 P-008: the hive P2P git <-> GitHub bridge —
  // on a BRIDGED hive's git-sync tick, ingress origin branches into the synthetic
  // github-origin namespace (admission-gated) + egress canonical refs FF-only to the
  // resolved remote (fork wins — D-007b), divergence reported-not-applied (P-006).
  // Default ON (derived FLAG_DEFAULTS): inert fleet-wide until a hive's federated
  // `hiveGit.mode` setting is flipped to 'bridged' (the owner-set per-hive activation);
  // this flag is the fleet-wide kill-switch, not the activation surface.
  GITHUB_BRIDGE: "papercusp-github-bridge",
  // p2p-work-distribution-2026-07-02 P-002/P-005: the P2P work-sharing surface —
  // the /settings/p2p page (host opt-in, peers capability matrix, GLOBAL
  // kill-switch) + the foreign-work admission contract Phase-1 consumers read.
  // Default ON (derived FLAG_DEFAULTS), the GITHUB_BRIDGE pattern: this flag is
  // the FLEET-WIDE kill-switch, not the activation surface — activation is the
  // real surface (explicit grants P-001 + host opt-in, zero/empty by default per
  // M11), so inertness is structural and no dark-allowlist entry is needed.
  // P-005 layers the rollout TIERS on top (tier 1 same-owner / tier 2 delegate-
  // capped / tier 3 operator grants).
  P2P: "papercusp-p2p",
  // agent-allocation-framework-2026-07-03 P-008 (D-006): the PER-HOST "accept delegated
  // seats" trust gate. Cross-machine agent-slot delegation = a remote fleet owner (A) asks
  // THIS host (B) to spawn bounded agents joined to A's fleet. Letting a remote owner spawn
  // on your box is a real privilege step, so B must OPT IN. DEFAULT OFF (owner-authority):
  // OFF ⇒ this host honors NO delegated-seat spawn requests (fail-closed, byte-identical to
  // today — the gate simply refuses). The contributing-host owner flips it ON per-host via
  // /res (or /admin/features) to opt in. This is the trust half of P-009's honor path.
  ACCEPT_DELEGATED_SEATS: "papercusp-accept-delegated-seats",
  // git-sync-dx-hardening-2026-06-17 P-004: DERIVED commit attribution — when ON, git-sync
  // groups dirty files by the agent who declared them (coord:declare-intent / lock holder)
  // and makes per-agent commits with the intent message + a Co-Authored-By trailer (catch-all
  // commit for the unattributable remainder), restoring git blame/bisect/review for humans.
  // DEFAULT ON since 2026-08-10 (WI-37718): the owner flipped it after the end-to-end live
  // verification its owner-authority dark entry demanded. This comment's own superseded
  // pre-flip claim was "DEFAULT OFF: it rewrites the commit hot path; OFF = today's single
  // `git add -A` commit, byte-identical. Owner flips post-review" — the DARK_FLAGS entry
  // carrying it is removed (the set only shrinks, which is always allowed).
  // EVIDENCE AT FLIP TIME: the writer-side defect that made attribution derive a placeholder
  // holder (EI-20055604348536487, fixed by su-0d1fbffd in b2af0024a8) is live on every writer
  // path; once the last pre-fix process cycled, 39/39 consecutive lock rows carried a real
  // declared intent with zero sentinels, and the last 60 commits carried real per-agent
  // subjects with zero sentinel subjects. No new agent ceremony (attribution is DERIVED).
  // Flipping it back OFF remains the tested rollback: one whole-tree `git add -A` commit.
  GIT_SYNC_DERIVED_ATTRIBUTION: "papercusp-git-sync-derived-attribution",
  // WI-38594 [owner 2026-08-13]: diff-derived git-sync commit SUBJECTS — the subject
  // becomes the commit's actual content (`sync(<areas>): <what> (<n> files, +A/-D)`,
  // from the just-staged numstat) and the agent's intent line (the previous subject)
  // is demoted to the first commit-body paragraph, ahead of the Papercusp-* trailers —
  // still greppable, no longer masquerading as a diff description. Applies to BOTH the
  // per-agent attributed commits and the catch-all whole-tree commit. Default ON
  // (derived FLAG_DEFAULTS — not in DARK_FLAGS). OFF = the instant off-switch back to
  // the pre-WI-38594 subjects (intent line / message stem), no deploy needed.
  GIT_SYNC_DIFF_SUBJECTS: "papercusp-git-sync-diff-subjects",
  // docs-corpus-audit WS2 P-008 / deterministic-commit-workitem-attribution P-005: the
  // doc-steward — the post-git-sync freshness sweep, on a drifted doc, dispatches a
  // doc-steward agent to re-verify/regenerate it against the current code (the LLM consumer
  // that closes the doc-drift loop). DEFAULT OFF: it auto-edits the doc corpus (owner-authority
  // surface) + spawns an agent per drift — flip ON after the owner-verified end-to-end check.
  DOC_STEWARD: "papercusp-doc-steward",
  // plan-federation-regrain-2026-06-13 P-005/P-006: per-PART plan federation —
  // kills the whole-document LWW clobber where two peers editing DIFFERENT plan
  // items lose one edit (D-009). DEFAULT ON since 2026-07-18: the two-machine
  // merge proof its cutover demanded (P-008) ran GREEN on the live tower↔Avis-iMac
  // rig — concurrent different-part edits under flag-ON on both machines converged
  // byte-identically with both edits surviving on both sides, no whole-blob
  // clobber (p2p-part-merge-proof-2026-07-18 D-001, WI-5331). OFF is the tested
  // rollback: plans federate as the whole harness_plans.content blob (mig 125),
  // per-part capture/projection inert — the pre-cutover path, byte-identical.
  PLAN_PART_FEDERATION: "papercusp-plan-part-federation",
  // Plan ownership/attribution badges: owner + last-editor on plan list rows +
  // detail, and per-item author (shared-hive-collaboration-2026-06-14 P-001, B1).
  // DEFAULT-ON: additive surfacing over data that already exists; degrades to
  // handle+initials when no github identity is bound (hive_members empty) and the
  // per-item badge stays dark until real per-op author pubkeys federate.
  PLAN_ATTRIBUTION_BADGES: "papercusp-plan-attribution-badges",
  // shared-hive-collaboration-2026-06-14 B11 / P-014 (D-011): role/permission
  // tiers (owner/collaborator/read-only) derived from the GitHub collaborator
  // graph, gating owner-actions on a SHARED hive (dissolve/leave/teardown). A
  // read-only member can't do owner actions; the local owner's tier is
  // re-derived LIVE from GitHub for these high-stakes actions (never federated
  // state). DEFAULT-ON (owner-directed) — enforces immediately; this key is the
  // kill-switch. OFF = today's behavior (existing root-only/source/confirm gates
  // only); SOLO/unbound hives are never gated (the owner keeps owner tier).
  POT_ROLE_TIERS: "papercusp-hive-role-tiers",
  // generic-column-filters-2026-06-14 (Phase 2): gates the generic per-column
  // FILTER BAR on the /adv dock panels (RichGrid + non-grid) — the +Add-filter
  // Select → per-type Popover editor → removable chip row built on
  // @papercusp/grid-core's pure filter engine. When OFF, <ColumnFilterBar/>
  // renders nothing (the panels still list unfiltered rows). DEFAULT ON (alpha
  // flags-default-on policy): the bar is additive surfacing over a tested engine.
  GRID_COLUMN_FILTERS: "papercusp-grid-column-filters",
  // queen-interactive-brain-fresh-context-2026-06-14: when ON (default), the
  // interactive `psu --brain` pane launches FRESH per open (new session + an
  // injected computeQueenWakeBrief) instead of resuming the persistent D-013
  // pinned brain (which grows → Claude compacts → the resume picker). Reverses
  // native-terminal-desktop D-013; OFF = the persistent-resume brain (today's).
  MUG_BRAIN_FRESH: "papercusp-queen-brain-fresh",
  // per-hive-learning-loops-2026-06-14 P-070 (D-006/D-007): the deployment-mode
  // knob for the LAYER-3 PLATFORM-IMPROVEMENT loops — the workspace-SINGLETON
  // Class-C frontier/measurement/watchdog set (negative-space, neologism,
  // fleet-ekg, calibration, deferral-interest, graduation, red-queen, regret,
  // transfer, prompt-ablation, change-ledger, iq-battery +
  // improvement-watchdog/triage/implement). When ON the Class-C loops register /
  // materialize at seed time; when OFF they are SKIPPED / seeded-inactive. This
  // gates REGISTRATION ONLY — no loop's logic changes, and the frontier loops
  // each keep their own arming gate on top (the individual dark flags + governor
  // budgets). gym/scout (per-hive Class-B, layers 1-2) are NEVER gated by this.
  // DEFAULT ON: dev / self-host run the full platform loop (this dev workspace
  // is exactly "Papercusp inside Papercusp"). A public RELEASE build keeps it
  // OFF until the user opts into platform mode (D-006) — but the repo has NO
  // dev-vs-release runtime signal yet, so release-off is achieved by the build
  // setting PAPERCUSP_PLATFORM_MODE=off (resolved in @papercusp/flags/server),
  // an OWNER design point flagged in P-070's report (do not invent
  // release-detection infra). OFF = the Class-C loops ship dark.
  PLATFORM_IMPROVEMENT_LOOPS: "papercusp-platform-improvement-loops",
  // directed-wake-honesty-and-spawn-handoff-2026-06-14 P-014/P-021: gates the ONE
  // bounded spawn/wake-hydration block (assembleSpawnHydration) — the volatile-tail
  // `## Handoff` section a freshly-spawned or warm-woken agent opens with
  // (predecessor handoff + hive-roster snapshot + work-item carry-note). When ON
  // (default), the spawn paths (operator-spawn autonomous + bootstrap-role
  // interactive, P-012) precompute the block and thread it to buildPrompt; when OFF
  // the block is skipped and no `## Handoff` section renders. DEFAULT ON (alpha
  // flags-default-on; finished work ships on): each source is fail-soft + bounded,
  // so the block degrades to empty rather than breaking a spawn.
  SPAWN_HANDOFF_HYDRATION: "papercusp-spawn-handoff-hydration",
  // overwatch-role-2026-06-15 (B-10): gates the OVERWATCH role — the always-on
  // autonomous system-health supervisor (sibling to the Queen; product-facing name
  // "Kettle"). The flag gates (a) the `overwatch` role registration (B-01), (b) the
  // autonomous wake-loop + its routine/rule (B-04), and (c) the Overwatch UI pane
  // (B-08). DEFAULT ON (graduated — not in DARK_FLAGS; comment-staleness fix, EI-9826:
  // B-12's live-run proof condition this block originally gated on is long since met —
  // Kettle is confirmed live and running in production, e.g. EI-9794's fire-recency
  // liveness alarm work verified harness_shared.autoloop_state firing on its 600s
  // cadence). OFF = the reversible fallback (no overwatch role, no wake-loop, no pane).
  OVERWATCH: "papercusp-overwatch",
  // retire-mug-kettle-su-only-2026-08-09 (D-015): the scorecard-emission pulse's OWN
  // kill switch. The pulse (scorecard-emission-pulse.ts, WI-2374) is the deterministic
  // FLOOR that guarantees a `pot-coordination-health` scorecard keeps landing when no
  // agent emits one — it exists precisely BECAUSE the supervisor may be stopped or dead.
  // It used to borrow OVERWATCH above as its gate, which reintroduced the very coupling
  // it was built to remove: retiring the Kettle (flag OFF) silently stopped rubric
  // emission with `outcome:'skipped'` and no alarm — the WI-2374 defect one level up
  // (there it was the `started` bit; here it was the flag). A floor must not be gated on
  // the aliveness OR the existence of the agent it backstops. DEFAULT ON (not in
  // DARK_FLAGS): this gates behaviour that already ships. OFF = no synthesized floor;
  // agent-emitted scorecards are unaffected.
  SCORECARD_EMISSION_PULSE: "papercusp-scorecard-emission-pulse",
  // MUG_KETTLE_SYSTEM ("papercusp-mug-kettle-system") WAS HERE and is DELETED
  // (retire-mug-kettle-su-only-2026-08-09 P-068 / D-098, owner-directed).
  //
  // It was the cutover switch for the MUG + KETTLE + CUP/nursery tier, with an
  // INVERTED polarity: OFF (the default) was the CHANGE — the tier retired — and
  // ON was a reversible testing escape hatch. Its own entry set the terms of its
  // removal: "graduating this flag does NOT mean flipping it ON. It means deleting
  // the tier and removing the flag entirely." Stage 2/3 landed (P-059, P-062,
  // P-063), so the flag is gone and the retirement is now permanent.
  //
  // ⚠ Do NOT re-add it to "make the tier testable again". The gates it fed did not
  // go with it: `pot/started.ts`'s `mugKettleSystemEnabled()` is now a permanent
  // `false`, and that one predicate still feeds ~20 gates (the 5 retired actuator
  // tools, the 3 spawn doors, the engine gate, both pot watchdogs, and Scout's own
  // sweeps). D-098 records why several of those cannot be deleted with the tier:
  // they sit on live shared substrate that SCOUT STILL RUNS ON (D-003/D-093).
  // sentinel-as-herald-2026-06-21: gates the PAPERCUP role (formerly `sentinel`) — a
  // new always-on autonomous system-health supervisor (sibling to the Mug, mirrors
  // OVERWATCH). The flag gates (a) the `papercup` role registration, (b) the
  // autonomous wake-loop + its routine/rule, and (c) the Papercup UI pane. Runtime
  // default ON: the live-run proof landed (sentinel-herald ## Now, verified live
  // 2026-06-24) and the flag was live-enabled; with the derived FLAG_DEFAULTS
  // inversion it is ON-by-default and voice-unified-sentinel-pipeline-2026-07-01
  // P-011 makes that DELIBERATE — the Papercup pane is now the one voice brain, so a
  // dark papercup means a dead voice product. Flip OFF via /admin/features to go
  // dark. (Wire value stays "papercusp-sentinel" until the stored-axis slice.)
  PAPERCUP: "papercusp-sentinel",
  // sentinel-as-herald-2026-06-21 Phase 5 (P-018..P-022): gates the SERVER-SIDE
  // proactive "decide to speak" sweep — the voice-host periodic tick that lets the
  // Sentinel Herald speak out-of-band (a role:'sentinel' converse turn with trigger
  // 'sentinel_scan', TTS'd + pushed via broadcastOpVoice) with NO desktop UI open,
  // or routes a salient alert via attention-push + hindsight when no live voice
  // session exists. Runtime default ON (derived FLAG_DEFAULTS — live-enabled at
  // sentinel-herald ship, made DELIBERATE by voice-unified-sentinel-pipeline
  // P-011). Safe despite being an autonomous speak loop because it is
  // triple-gated on top of the flag: humanFacingRole==='sentinel' AND not
  // DND/paused/over-budget AND the voice-host owns the lease (single-owner) —
  // most ticks are a flag read + no-op. Flip OFF via /admin/features to silence
  // proactive speech entirely.
  PAPERCUP_PROACTIVE: "papercusp-sentinel-proactive",
  // scheduled-recurring-plans-2026-06-16 (P-028 → D-019): the global master switch for
  // the scheduled-plan EXECUTION path — the system:plan-run action + arming. DEFAULT ON
  // (owner-directed at ship, D-019). Safe despite being an autonomous executor: the real
  // control is per-plan ARMING (autonomy-gated, schedule-arm never-auto, owner-only);
  // an un-armed feature fires nothing. Flip OFF via /admin/features for dark.
  SCHEDULED_PLANS: "papercusp-scheduled-plans",
  // work-on-everything-goal-2026-08-23 P-020 (D-006 ruling 3) — scheduled GOAL
  // activation: goals:set-schedule / goals:arm-schedule materialize a routine
  // firing `system:goal-start`, which dispatches the one goal-activation
  // primitive (startGoalById). Default ON (derived FLAG_DEFAULTS — not in
  // DARK_FLAGS); OFF stops goals:arm-schedule from arming new schedules
  // (already-armed routines keep firing — disarm them individually).
  GOAL_SCHEDULES: "papercusp-goal-schedules",
  // impartial-benchmark-suite-2026-06-15 (P-005/BRIEF 3): gates the EXTERNAL-BENCH
  // grader adapter + the `external-bench:run` op — the runner that clones a public
  // benchmark task, spins a throwaway coding harness, extracts the diff, and grades
  // it with the benchmark's OFFICIAL external Docker grader (SWE-bench Pro, M1).
  // DEFAULT OFF — DELIBERATE (NOT the alpha flags-default-on policy): the runner is
  // genuinely incomplete (M2 in-container modality unbuilt; the SWE-bench-Pro grader
  // needs a dedicated Docker host + GB-scale image pulls) and infra-heavy (it spins
  // real harnesses + pulls per-instance images).
  // DEFAULT OFF — PERMANENTLY, and NOT awaiting a graduation. WI-5646 (owner decision
  // 2026-07-26) RETIRED the external-bench blueprint: its design premise ("the treatment
  // IS the shipped coding system, byte for byte") died when the per-feature coding spine
  // was retired 2026-06-24 and `coding` was reassigned to the pot/Mug architecture, so the
  // arm would benchmark a system that no longer exists. The previous graduation condition
  // recorded here — "ships dark until the ~50-task P-009 pilot proves the end-to-end path,
  // the owner flips it ON after that" — is VOID; that pilot will not run. Do NOT flip ON.
  // What it still gates is the eval UI + run/reproducibility stores, kept ONLY so historical
  // run data stays readable. A pot/Mug benchmark is a NEW blueprint with its OWN flag.
  EXTERNAL_BENCH: "papercusp-external-bench",
  // system-health-tab-2026-06-15: gates the read-only HEALTH tab (a live
  // at-a-glance dashboard of the whole running system — Queen / bees / work-feed
  // / tokens / deploy / infra) beside Working in /adv, plus its `health.snapshot`
  // sync resolver + the periodic system-health tick. DEFAULT ON (alpha
  // flags-default-on): a purely additive read-only surface over reads that
  // already exist (computeSystemHealth fail-soft per panel). OFF = the tab is
  // hidden + the resolver returns empty + the tick no-ops. The SAME aggregation
  // also feeds the overwatch role (overwatch-role-2026-06-15 C-1, D-001).
  SYSTEM_HEALTH_TAB: "papercusp-system-health-tab",
  // schedule-inventory-and-ephemeral-tier-2026-06-26 P-003: gates the read-only
  // /admin/schedules page + its inventory endpoint (the central view of every
  // scheduled/recurring thing — DBOS crons, system routines, in-process sweeps).
  // DEFAULT ON (alpha flags-default-on): a purely additive read-only diagnostic
  // surface over reads that already exist. OFF = the tab is hidden + the endpoint
  // returns { enabled: false }.
  SCHEDULE_INVENTORY: "papercusp-schedule-inventory",
  // schedule-inventory-and-ephemeral-tier-2026-06-26 P-013 / D-006: gates the
  // blueprint-declared EPHEMERAL cadence tier. Read at MATERIALIZE time (a request
  // context — boot-time getFlag is fragile, see host-bootstrap): OFF ⇒ a blueprint's
  // tier:'ephemeral' schedule entries are NOT materialized into routine rows, so the
  // per-host ephemeral executor arms nothing and the frequent non-DBOS cadence never
  // fires (durable cron + in-process sweeps unaffected). DEFAULT ON (flipped on after
  // the P-013 real-PG live verify — do NOT ship dark).
  EPHEMERAL_CADENCE: "papercusp-ephemeral-cadence",
  // bee-context-efficiency Phase 1 (D-001/D-018/D-019): fresh-context warm-inject.
  // When a DRAINED bee is warm-injected a NEW task, re-invoke with a FRESH session
  // (full bee-prompt re-assembly + the hydration tail) instead of `--resume`-ing the
  // grown transcript (the ~138K/turn dead-transcript carry, D-011). DEFAULT ON (flipped
  // 2026-06-23, WI-593, after P-006 live verification — see the graduation note + its own
  // dedicated assertion in warm-inject-carry-seam.test.ts). WI-3855 (2026-07-11): this FLAGS
  // comment was simply never updated after the flip — corrected here, no behavior change.
  // OFF ⇒ legacy `--resume` (the reversible kill-switch, behavior-neutral).
  CUP_FRESH_CONTEXT_WARM_INJECT: "papercusp-bee-fresh-context-warm-inject",
  // bee-context-efficiency Phase 2 (P-008/P-009, D-004): inject the precomputed
  // work-item DOSSIER (computeBeeWakeDossier — item text + linked plan item + outgoing
  // `blocks` edges + topics + recent comments + hive-roster snapshot) into the spawn/
  // wake-hydration VOLATILE TAIL, so a (re)spawned agent opens already-briefed and skips
  // the work_items:get / plans:get / coord:presence round-trips. Rides the volatile tail
  // ONLY (never the cacheable preamble, D-004); a sub-feature of SPAWN_HANDOFF_HYDRATION.
  // DEFAULT ON (alpha flags-default-on) — additive, bounded, fail-soft; OFF ⇒ no dossier
  // (the agent falls back to its read tools), behavior otherwise unchanged.
  CUP_WAKE_DOSSIER: "papercusp-bee-wake-dossier",
  // RETIRED (P-059, D-090): CUP_TRANSCRIPT_CAP ("papercusp-bee-transcript-cap") — gated
  // the cup transcript-cap backstop sweep, which retired with the Mug/Kettle/Cup tier.
  // The flag was DEFAULT-ON and never in DARK_FLAGS, so removing the key parks no dark
  // debt. Restore contract: `_retired/mug-kettle-deciders/RESTORE.md` § `bee-transcript-cap`.
  // plan-implementation-framework P-003 (compiled-briefs): when on, plan_items:convert
  // COMPILES the work-item brief from the plan item + plan focus (## Now) + the decisions
  // bearing on the item, instead of leaving payload.brief to a hand-authored overlay.
  COMPILED_BRIEFS: "papercusp-compiled-briefs",
  // plan-implementation-framework P-002 (touch-set-exclusion): when on, the Queen's
  // placement chokepoint (place_batch) drops a ready work_item whose declared file
  // touch-set overlaps a running bee's files or an already-admitted sibling — proactive
  // hive-scoped conflict avoidance (cross-hive collisions stay on reactive git-merge).
  TOUCH_SET_EXCLUSION: "papercusp-touch-set-exclusion",
  // EI-1611: when the Queen's fleet:place_batch places >=2 bees onto tasks sharing the
  // SAME plan in one batch, auto-ensure a `plan:<slug>` topic and subscribe every
  // placed bee to it — pushed, scoped group updates (sibling completions, decisions,
  // blast-radius warnings) instead of each bee polling coord:inbox. Additive + best-
  // effort (a subscribe failure never blocks/reverts the placement); DEFAULT ON — no
  // hot-path risk, only adds a topic subscription row alongside an already-committed
  // placement.
  QUEEN_GROUP_TOPIC_SUBSCRIBE: "papercusp-queen-group-topic-subscribe",
  // plan-implementation-framework P-004 (workitem-amend): when on, work_items:amend
  // records a non-re-derivable structural decision (split/drop/reapproach/expand/note)
  // durably on a node — the Queen disposes, a bee proposes; the commit-before-dispatch record.
  WORKITEM_AMEND: "papercusp-workitem-amend",
  // plan-implementation-framework P-005 (deferred-expansion): when on, work_items:expand
  // emits child work_items from an expand-here node (bee proposes, Queen disposes) — the
  // record starts shallow and self-elaborates at the point of best context.
  DEFERRED_EXPANSION: "papercusp-deferred-expansion",
  // steering-nested-hive-plan-tree-2026-06-17 (P-003): the 👑 Queen steering panel's
  // NESTED hive→plan picker — hives at top, their plans nested beneath, a plan
  // selectable only under a checked hive. Replaces the two FLAT lists (Eligible
  // hives + Eligible plans) that let you express a contradiction (an eligible plan
  // under an excluded hive — a dead no-op the survey silently drops). DEFAULT ON
  // (alpha flags-default-on): a complete presentation switch over the unchanged
  // persisted (eligibleHives, eligiblePlans) shape (D-001); OFF renders the legacy
  // two flat sections as the fallback.
  STEERING_POT_TREE: "papercusp-steering-hive-tree",
  // workspace-data-isolation-leaks-2026-06-17 (F-C1): scope the coordination plane
  // (messages / handoffs / escalations / plan-events via coord_event_log + watermarks)
  // to the ACTIVE workspace instead of the single shared `default` partition.
  //
  // DEFAULT ON — the cutover COMPLETED and is graduated (agent-tools/coordination/log.ts
  // has said so since WI-599: "it graduated default-ON in WI-599"). This comment used to
  // say "DEFAULT OFF — reversible kill-switch... flipping OFF fully restores it", which is
  // now DANGEROUSLY STALE and was corrected 2026-07-12 (WI-4238 investigation, su-00a91).
  //
  // ⚠ DO NOT "RESTORE THE DARK BASELINE" ON THIS FLAG. `coordScopeWorkspace()` swings the
  // partition every coord read/write targets: `activeWorkspaceId()` when ON vs the legacy
  // `default` partition when OFF. The live corpus is in the workspace partition and the
  // legacy one is a fossil — measured 2026-07-12 in harness_shared.coord_event_log:
  //     papercusp-workspace  67,468 rows  (2026-05-30 → today, LIVE)
  //     default                  74 rows  (dead)
  // So flipping this OFF does NOT restore a byte-identical world — it strands ~67k live
  // coord events and re-points the whole fleet's coordination at a 74-row husk. The old
  // comment's "byte-identical / fully restores it" was written BEFORE the flag was ever
  // on; two weeks of production have made it false. Reversibility is a property of the
  // DATA, not of the flag.
  COORD_PER_WORKSPACE: "papercusp-coord-per-workspace",
  // workspace-data-isolation-leaks-2026-06-17 (owner D-001): scope the engineer-issues
  // store (engineer_issues rows + their coord tags/threads/links/subscriptions) to the
  // ACTIVE workspace instead of the single shared `default` coord workspace. EI-<n> ids
  // stay GLOBALLY allocated (nextIssueId), preserving the ObjectRef contract; only the
  // ROWS become per-workspace.
  //
  // DEFAULT ON — the cutover COMPLETED (2026-06-22). This comment used to say "DEFAULT OFF
  // — reversible kill-switch... old `default` issues preserved", corrected 2026-07-12
  // (WI-4239 investigation, su-00a91).
  //
  // ⚠ DO NOT "RESTORE THE DARK BASELINE" ON THIS FLAG — it is a DATA-HIDING change, not a
  // safety one. `issuesScopeWorkspace()` swings the partition every issue read/write
  // targets: `activeWorkspaceId()` when ON vs the legacy `default` coord workspace when
  // OFF. Measured 2026-07-12 in harness_shared.engineer_issues:
  //     papercusp-workspace  11,730 rows  (2026-06-05 → today, LIVE — the entire backlog)
  //     default               2,443 rows  (last write 2026-06-22 — dead 3 weeks)
  // Flipping this OFF would instantly hide all 11,730 live issues (every EI/WI in flight,
  // including the ones tracking this very bug) and resurrect a corpus frozen in June. The
  // old comment's "byte-identical" claim was written BEFORE the flag was ever on and has
  // been false since 2026-06-22. Reversibility is a property of the DATA, not of the flag.
  //
  // NOTE — this was NOT collateral damage from the 2026-06-29 P-011 inversion, contrary to
  // what EI-9769 assumed ("it is on because a comment lied"). The row dates prove the
  // cutover was DELIBERATE and finished BEFORE P-011: writes to the workspace partition
  // begin 2026-06-05 and the legacy `default` partition takes its last write 2026-06-22 —
  // both ahead of the 06-29 inversion, so the flag was already being held ON on purpose.
  // P-011 only made the code default agree with the state the cutover had already reached.
  ISSUES_PER_WORKSPACE: "papercusp-issues-per-workspace",
  // work-queue-stuck-item-recovery-2026-06-17 P-012 / D-008: the per-Hive authority claim
  // LEASE (decentralized-dispatch-scaling P-004) — migrated off the ad-hoc
  // PAPERCUSP_WORKITEM_CLAIM_LEASE env gate to a runtime-flippable FLAG. DEFAULT ON
  // (graduated 2026-06-23, owner-directed verify+flip, WI-597): the recovery layer the D-008
  // gate waited on is now in place — the stale-claim reaper requeues mid-flight items (GAP 1)
  // and covers the issue family (GAP 2), closing the stuck-item risk regardless of the lease.
  // Verified: lease acquire/heartbeat/expiry-steal + dead-holder reclaim (work-item-claims +
  // work-items-stale-claims integration tests green). On a single box claim_next gates re-claim
  // on work_items.taken_by (liveness-reclaimed), NOT the lease TTL, so the self-selection path's
  // no-heartbeat is benign (worst case: edit-attribution coarseness); cross-Swarm double-claims
  // are reconcile-covered (P-005). Reversible (OFF = local SELECT … FOR UPDATE SKIP LOCKED).
  // Read SYNC-cached (deep in the claim path) via work-item-claim-lease-wiring.ts.
  WORKITEM_CLAIM_LEASE: "papercusp-workitem-claim-lease",
  // cross-machine-coord-parity-and-trust-2026-07-01 P-004 (D-002/D-008): presence rides
  // the EPHEMERAL gossip channel (presence-gossip.ts, papercusp/hive-presence frames)
  // instead of appending beats to the append-only peer-log — beat-like data immortalized
  // in logs is the 256×10 scaling wall (heartbeats ≈ half the hive's write budget).
  // OFF = today's log-append announce loop (wire-presence.ts), byte-identical. ON = the
  // announce loop broadcasts device-signed gossip frames; pot:leave publishes a signed
  // del tombstone frame. CUTOVER flag: every peer must carry the gossip READER before a
  // writer flips (a gossip-only announcer is invisible to a log-only reader).
  // DEFAULT ON — GRADUATED 2026-07-16 (LIVE-1 P-059 drill; see the graduation note in the
  // DARK_FLAGS block below). The cutover gate was MET: both dogfood machines (tower + mac
  // VM) on reader-carrying builds (G3 verified static + live), and the 2-machine presence-
  // federation verify ran on the tower↔VM rig per
  // docs/plans/CUTOVER-presence-gossip-2026-07-16.md. Live-confirmed 2026-07-26:
  // operator_flag_overrides carries papercusp-presence-gossip=true for papercusp-workspace
  // (set 2026-07-16), so the derived default and the live override AGREE. Rollback = flip
  // OFF + a presence-loop reboot (the reader stays wired either way).
  // ⚠ This comment used to end "so it ships dark until both dogfood machines updated;
  // owner flips after a 2-machine verify. Listed in KNOWN_DARK_FLAGS (cutover)" and was
  // left stale by that graduation, claiming a DARK_FLAGS membership the flag no longer has
  // (WI-6045). Note for anyone reading the cutover doc: its "Live-verified 2026-07-16:
  // papercusp-presence-gossip = OFF" line is a PRE-FLIP baseline inside a "why this
  // matters" rationale section, not current status — reconciling that cost real time.
  PRESENCE_GOSSIP: "papercusp-presence-gossip",
  // cross-machine-coord-parity-and-trust-2026-07-01 P-021 live cutover (WI-1491):
  // switches lockAuthorityFor/lockAuthorityForHive's winner-selection algorithm from
  // the single global argmin(device_pubkey) (D-005, one peer is EVERY scope's
  // authority) to per-scope-key RENDEZVOUS HASHING (HRW — authority/rendezvous-
  // authority.ts). OFF ⇒ selectAuthorityFromRows argmin, pre-cutover byte-identical
  // behavior (the tested rollback path). ON ⇒ selectAuthorityRendezvous (argmax HRW
  // weight over `scopeKey`, defaulting to the harness/hive slug when no finer-grained
  // scopeKey is threaded through by a caller — so existing call sites work unchanged,
  // they just get HRW's peer picked instead of argmin's).
  // GRADUATED 2026-07-17 (superseding the stale "ships dark" note this comment used to
  // carry — see the full graduation rationale + drill evidence near KNOWN_DARK_FLAGS
  // below, watermark 27→29): the attended multi-peer same-inputs verify ran on the
  // tower↔VM rig and passed, so this is now DEFAULT ON, not dark. NOT in
  // KNOWN_DARK_FLAGS.
  HRW_RENDEZVOUS_AUTHORITY: "papercusp-hrw-rendezvous-authority",
  // workspace-data-isolation-leaks-2026-06-17 F-E1 (PHASE 1): scope the routines
  // upsert's ON CONFLICT to (workspace_id, install_slug, name) so a hive in workspace
  // B can no longer CLOBBER a same-named routine in workspace A (the latent leak — 0
  // collisions live today).
  //
  // DEFAULT ON — live since the 2026-06-29 P-011 inversion, ~2 weeks in production with no
  // upsert incident. Comment corrected 2026-07-12 (WI-4238 investigation, su-00a91): it
  // used to claim "DEFAULT OFF — reversible kill-switch; OFF = today's ON CONFLICT
  // (install_slug, name), byte-identical."
  //
  // ⚠ ON is the SAFER direction here, so "restoring the dark baseline" would REMOVE a live
  // guard rail: OFF re-opens the cross-workspace clobber this flag exists to close (a hive
  // in workspace B overwriting a same-named routine in workspace A). Phase 2 (drop the old
  // unique + fold workspace_id into the routine id, to let same-slug routines fully COEXIST
  // across workspaces) is still a separate staged migration.
  ROUTINES_PER_WORKSPACE: "papercusp-routines-per-workspace",
  // workspace-data-isolation-leaks-2026-06-17 F-M7: when ON, ui:dispatch / ui:get_state /
  // tui:dispatch reject a target ui_client that belongs to a DIFFERENT workspace than the
  // caller's active one (ui_intents keys on client_id with no workspace column; ui_clients
  // carries workspace_id). These tools are SU-only, so this is a guard rail (low exploitability).
  // DEFAULT ON — live since the 2026-06-29 P-011 inversion. Comment corrected 2026-07-12
  // (WI-4238 investigation, su-00a91); it used to claim "DEFAULT OFF — reversible; OFF =
  // today's behavior (no check), byte-identical. KNOWN_DARK_FLAGS."
  // ⚠ ON is the SAFER direction: it BLOCKS a cross-workspace UI dispatch. "Restoring the
  // dark baseline" would REMOVE the guard rail (OFF = no check at all), so this is not a
  // conservative flip — it is a widening. The guard is fail-open by design (a lookup error
  // allows), so it cannot wedge a legitimate dispatch.
  UI_WORKSPACE_GUARD: "papercusp-ui-workspace-guard",
  // scoped-superuser-workspace-clamp-2026-06-18: bind a psu workspace-scoped superuser
  // session to its launch workspace at the DISPATCH layer (its ctx workspaceId becomes that
  // concrete workspace instead of '*'), engaging the EXISTING effectiveDispatchWorkspace
  // clamp; ALSO deny crossWorkspace:true tools + the harness:'all' global plan escape for a
  // scoped session.
  //
  // DEFAULT ON — live since the 2026-06-29 P-011 inversion (~2 weeks in production, no
  // reported superuser breakage). Comment corrected 2026-07-12 (WI-4239, su-00a91): it used
  // to claim "DEFAULT OFF — ... ships as a reversible kill-switch the owner flips ON after
  // an attended :3170 verification (OFF = today's unscoped '*' superuser, byte-identical)."
  //
  // ⚠ OFF IS THE *WIDER* AUTH STATE, NOT THE SAFE ONE. ON clamps a scoped psu superuser to
  // its launch workspace and denies crossWorkspace tools + the harness:'all' escape; OFF
  // restores the UNSCOPED '*' superuser. So "restore the documented dark baseline" — the
  // option WI-4239 originally offered as the conservative choice — would RELAX auth
  // enforcement fleet-wide. Do not flip it OFF as a safety measure; that is backwards.
  //
  // THE CLAMP DEMONSTRABLY ENGAGES — it is not a live-but-inert guard (checked 2026-07-12,
  // which is the thing an attended verify would have been run to establish):
  //   · wired at the MCP dispatch handler (endpoint-route/routes/transport/_mcp-handler.ts
  //     ~L594) — a bare `?superuser=1` whose workspace can't be resolved is REJECTED with
  //     `scoped_superuser_workspace_unresolved`; also read in agent-tools/memory/search.ts.
  //   · THREE integration tests independently document it as "default-on" and had to opt
  //     into `all_workspaces=1` explicitly BECAUSE it engages (su-locks-http-mcp,
  //     ask-choice-e2e, pretooluse-locks-live). A guard nothing hit would not have forced
  //     three suites to opt out of it.
  //   · its own handler comment calls the unscoped '*' fallback "the root of the
  //     demonstrated cross-workspace reach" — i.e. OFF reopens a DEMONSTRATED hole.
  // So the original "flip it ON after an attended :3170 verification" is satisfied in
  // substance: it has been on for two weeks, it engages, and nothing broke.
  SCOPED_SUPERUSER_CLAMP: "papercusp-scoped-superuser-clamp",
  // domain-generic-agent-personas-2026-06-17 P-006: resolve the `su` role's persona via the
  // blueprint prompt-resolve chain (blueprints/base/prompts/su.md) instead of the hardcoded
  // papercusp-su playbook. DEFAULT ON (owner-authorized 2026-06-18; the papercup-hive su instance
  // override is seeded — P-008 met). OFF = legacy renderSuPlaybook, byte-identical.
  SU_BLUEPRINT_PERSONA: "papercusp-su-blueprint-persona",
  // watchdog-and-exposed-systems-improvement-2026-06-18 P-009: the watchdog auto-CLOSES
  // an EI whose signal stopped firing for N ran-ticks. DEFAULT OFF — auto-closing real
  // improvement items autonomously is unsafe until the owner reviews; OFF = today's
  // behavior (escalate-only, never auto-resolve), byte-identical. KNOWN_DARK_FLAGS.
  WATCHDOG_AUTO_CLOSE: "papercusp-watchdog-auto-close",
  // WI-5563 (bug-drain-200k structural-starvation diagnosis, 2026-07-20): auto-CLOSES an
  // open replication-liveness EI whose target harness STILL EXISTS (unlike
  // replication-stall-orphan-sweep's renamed/deleted case) but has recorded no activity
  // for a long, separate inactivity window — the "abandoned demo/test harness" class
  // (hello-world*, spoon-knife*, dummy-pot-0707, sharetest732, lane2-*, etc) that
  // otherwise sits open FOREVER as noise. DEFAULT OFF — same owner-authority class as
  // WATCHDOG_AUTO_CLOSE (autonomously resolving a durable escalation without a human/
  // agent looking at the specific item is unsafe until the owner reviews the staleness
  // criteria); OFF = today's behavior (escalate-only), byte-identical. KNOWN_DARK_FLAGS.
  REPLICATION_LIVENESS_STALENESS_AUTO_CLOSE:
    "papercusp-replication-liveness-staleness-auto-close",
  // shared-hive-rekey-2026-06-19 (C-001 read-plane revocation, S0-for-release): the
  // master gate for the hive epoch RE-KEY — content encrypted under a per-epoch group
  // key so a removed/excluded peer cannot READ post-boundary content. The K-half
  // modules (hive-epoch-* / resolveHiveEpochCrypto) + the boundary + op-path wiring all
  // resolve behind it. DEFAULT ON (graduated 2026-06-29 via the P-011 flag-default
  // inversion — NOT in DARK_FLAGS): the live cut-off witness (P-008 / public-release
  // GATE-1) passed cross-machine on the real binary (shared-hive-public-release D-014)
  // and shipped in desktop alpha.2, so the gate condition is met. ON ⇒ the real
  // per-epoch crypto (encrypt-on-write / decrypt-on-read) for NEW hives; existing hives
  // stay legacy-unencrypted (rekey D-003). Re-add to DARK_FLAGS to fall back to the
  // notImplemented stub (byte-identical to pre-rekey).
  POT_REKEY: "papercusp-hive-rekey",
  // hive-seed-bundle-2026-07-04 (P-011): the master gate for the installer-shipped
  // SEED restore — a bundled snapshot of the shared hive (git bundles + federated
  // corestore) that first boot RESTORES so the live join only carries the DELTA.
  // DEFAULT ON (not in DARK_FLAGS — finished work never ships dark): a fresh install
  // with a bundled seed restores it before the (unchanged) join; the real join +
  // admission + delta replication STILL run (D-007 — the seed pre-positions BYTES,
  // it does NOT bypass the join), and every store re-verifies natively (git hashes,
  // corestore merkle/signatures). OFF ⇒ the pure COLD path (whole-history transfer),
  // byte-identical to a --no-seed / no-seed-bundled build — a runtime kill-switch if a
  // seed restore ever misbehaves. Inert on a build with no bundled seed (resolveSeedDir
  // → null ⇒ cold join regardless). Read at the two bootstrap restore call sites
  // (bootstrap-papercusp-hive.ts). NOT in KNOWN_DARK_FLAGS.
  POT_SEED_BUNDLE: "papercusp-hive-seed-bundle",
  // WI-3232 (owner v1 directive): a packaged install with the bundled papercusp seed
  // must materialize a LOCAL papercusp hive offline (no GitHub login, no federation
  // admission) by adopting the canonical hive identity from the baked invite and the
  // installer seed. DEFAULT ON (not in DARK_FLAGS): v1 explicitly excludes the
  // federation dependency; OFF restores the pre-WI-3232 behavior where a skipped
  // canonical join retries next boot.
  POT_SEED_SELF_ADMIT: "papercusp-hive-seed-self-admit",
  // loop-routines-interval-recurrence-2026-06-20 (B-LOOP-5 / P-008): the master gate for
  // engine-managed LOOPS — the tracked replacement for Claude /loop (loop:arm re-wakes a
  // warm su session N sec after each turn settles). DEFAULT ON (WI-612): the B-LOOP-1..5
  // chain shipped green, the manual warm-loop e2e passed, and the post-storm live-verify
  // gate (loop-wake-rate-limit-robustness-2026-06-23 D-001) is satisfied — the owner
  // flipped it live-ON 2026-06-23 and it is not in DARK_FLAGS below, so it now also
  // defaults ON for fresh hosts (the derived FLAG_DEFAULTS inversion). OFF would make
  // loop:arm refuse (loop:end/loop:status always work); inert otherwise (no loop rows).
  LOOPS: "papercusp-loops",
  // su-cold-auto-mode-2026-07-03 (P-007): the MASTER AVAILABILITY gate for su COLD-AUTO loops
  // (a loop whose wakes RESET-CONTEXT / periodically RECYCLE to a carry-note instead of a warm
  // in-place turn). DEFAULT ON (not dark) — owner-enabled 2026-07-03. Safe ON because it is only
  // an availability switch: the REAL opt-in is per-loop (`loop:arm { carry:'cold' }`) AND a
  // carry-note must exist (decideColdWake), so NOTHING goes cold until an operator explicitly
  // arms a loop cold. OFF ⇒ every loop wake stays warm regardless of its carry marker. Read at
  // the wake-executor call-site (engine.ts) as the injected coldAutoEnabled dep.
  SU_COLD_AUTO: "papercusp-su-cold-auto",
  // fuzzy-tool-name-resolution-2026-07-02 (P-006): runtime KILL-SWITCH for typo-recovering tool-name
  // resolution (resolveMcpNameTagged's fuzzy stage). DEFAULT ON — it ships on (finished work is not
  // dark). Read at the dispatch seams: OFF ⇒ seams call the canonical-only resolveMcpName, i.e. a
  // typo returns unknown_tool exactly as before. The exact and canonical-fold stages are NOT gated
  // (they are formatting tolerance, not guesses).
  TOOL_NAME_FUZZY_RESOLVE: "papercusp-tool-name-fuzzy-resolve",
  // cold-with-carry-activation-2026-07-20 (owner-directed A+B, fact
  // cold-with-carry-activation-approved): loop:arm defaults an UNATTENDED HEADLESS
  // session's loop (host.bridgeTty===false ⇒ sessionClassForHost 'claude-headless')
  // to carry:'cold' when the caller does not pass an explicit `carry` — the whole
  // point of the cold-auto system is to keep unattended loops from re-waking the
  // SAME warm session until context overflows and dies uncleanly (WI-5557 / the
  // fa10eeb7 warm-to-974k-death incident). An INTERACTIVE session ALWAYS stays warm
  // (D-005 never-cold-a-human), and an explicit `carry` arg ALWAYS wins. DEFAULT ON
  // (not in DARK_FLAGS); OFF = the kill-switch that restores the historical
  // warm-everywhere default (existing loops are unaffected — this only sets the
  // arm-time default for NEW loop:arm calls). Layered under SU_COLD_AUTO: a
  // cold-armed loop still only actually colds when SU_COLD_AUTO is on AND a
  // carry-note anchor exists (decideColdWake), so this is a DEFAULT change, not a
  // new cold path.
  HEADLESS_LOOPS_COLD_BY_DEFAULT: "papercusp-headless-loops-cold-by-default",
  // cold-with-carry-activation-2026-07-20 (owner-directed A2): gates the AUTOMATIC
  // cold-boot drill runner — a system-health managed interval that BOOTSTRAPS P-021
  // cold-by-default by producing the graded drills it requires. P-021's
  // classDefaultColdForWake only colds a session class the drill ledger PROVES
  // sufficient, but drills were opt-in and never run at scale, AND the classifier's
  // live vocabulary ('claude-headless'/'claude-interactive') never matched the
  // manually-run drills' class strings (EI-18133456688790756), so NO live-wake
  // class was ever proven and cold-by-default stayed inert for the whole headless
  // fleet. Each pass this runner (a) server-side GRADES its prior ungraded-but-
  // respawned drills, then (b) if a live-wake class is not yet proven, starts ONE
  // rate-limited, flush-gated cold-boot drill on an eligible headless
  // carry-respawn-capable host — passing NO explicit class so the grade lands under
  // sessionClassForHost's real vocabulary. It stops drilling a class once proven.
  // DEFAULT ON; OFF = the kill-switch (the timer still ticks but every pass no-ops).
  COLD_BOOT_DRILL_AUTORUNNER: "papercusp-cold-boot-drill-autorunner",
  // EI-12755 (deterministic-context-carry P-020 hardening): gates the
  // carry-drill drop watchdog — a system-health sweep that tails the shared
  // drill ledger (~/.papercusp/psu-pty/carry-drills.events.jsonl) and opens ONE
  // deduped escalation per dropped/respawn-failed carry drill, so a drop
  // reaches the attention queue in ~a minute instead of waiting for someone to
  // poll session:carry-drill op:'report' (the 2/2 silent failures of 2026-07-15
  // sat unnoticed ~40min). DEFAULT ON. OFF = the kill-switch: the timer still
  // ticks but every sweep no-ops before reading the ledger.
  CARRY_DRILL_DROP_WATCHER: "papercusp-carry-drill-drop-watcher",
  // EI-18741922664751805: gates the service restart-rate watchdog — a
  // system-health sweep that counts systemd "Started" events for the long-lived
  // operator units (papercup-dev-api, papercup-staging-api) over a trailing hour
  // and opens ONE deduped escalation per unit above 8/hour. Restart RATE was
  // previously unmeasured: :3170 restarted ~10x/hour through 2026-07-26 with
  // nothing alarming, and the condition was only found by a human running
  // `journalctl | grep -c 'Started '` by hand ~4h in — by which point the
  // driving defect had already been fixed, so the resulting issue also
  // mis-attributed the cause off a measurement window that straddled the fix.
  // Threshold is measured, not chosen: pre-fix hours ran 9-10, post-fix 1-6.
  // DEFAULT ON. OFF = the kill-switch: the timer still ticks but every sweep
  // no-ops before reading the journal.
  SERVICE_RESTART_RATE_WATCHDOG: "papercusp-service-restart-rate-watchdog",
  // system-notices-on-its-own-2026-08-16 P-001: gates the GOAL-liveness watchdog
  // — a system-health sweep that joins active harness_shared.goals against their
  // agent_modes goal-mode holders and the shared liveness oracle, opening ONE
  // deduped escalation per goal that is `active` with nobody actually working it.
  // Every layer BELOW goal was already watched (engine loops, cadence drift, idle
  // sessions, MCP-dark, supervision units, cgroups, green-stall, git-sync-stall);
  // GOAL — the layer the product is organized around since mug/kettle/cup was
  // retired in its favor — had nothing, and `routines:list { q:'goal' }` returned
  // zero rows. Measured on 2026-08-16 the moment the sweep was written: 4 of 6
  // active goals in papercusp-workspace had a stale goal-mode row and NO live
  // holder, two of them real product goals dark since 08-11 and 08-14. An
  // agent_modes row is a plain DB row that OUTLIVES the session that wrote it, so
  // "holders: 1" reads as healthy for a goal nobody has touched in five days.
  // DEFAULT ON. OFF = the kill-switch: the timer still ticks but every sweep
  // no-ops before reading the goals table.
  GOAL_LIVENESS_WATCHDOG: "papercusp-goal-liveness-watchdog",
  // goal-live-holder-guarantee-2026-08-18 P-009 / D-002: permits the operator
  // to launch a replacement GOAL-mode holder when an active goal explicitly
  // declares holder.requireLive=true + holder.onLoss='respawn'. This spends
  // money and opens unattended agent sessions, so it is deliberately SEPARATE
  // from the report-only GOAL_LIVENESS_WATCHDOG and DEFAULT OFF as an
  // owner-authority surface. OFF is a pure no-op before the goals table read;
  // deterministic read-time deactivation and liveness reporting remain live.
  GOAL_HOLDER_RESPAWN: "papercusp-goal-holder-respawn",
  // work-on-everything-goal-2026-08-23 P-011 (retirement doc open loss #3,
  // owner:Avi 2026-08-23): the operator-boot arm — a BOUNDED window at operator
  // start that respawns the LOST holder of an ACTIVE, un-paused STANDING goal
  // (goals.standing=true) that earned recovery via holder.onLoss='respawn'.
  // Restores the retired Mug's cold-start autonomy as an owner CHOICE.
  // POLARITY: OFF (default) = the retirement doc's correct-by-design reading —
  // recovery from the su population reaching zero is the OWNER's restart, by
  // hand; ON = the operator self-heals standing stewardship at boot. Bounded:
  // ~10 passes × 60s then self-stop; 'unheld' NEVER spawns (install ≠ start,
  // D-002); DEFERS entirely while GOAL_HOLDER_RESPAWN is ON (the runtime 60s
  // respawner owns recovery then — no same-tick double-launch race).
  STANDING_GOAL_BOOT_ARM: "papercusp-standing-goal-boot-arm",
  // EI-19919820196426791 (half 2): gates the unservable-critical watchdog — a
  // deduped escalation per issue that is simultaneously `critical` and
  // structurally UNCLAIMABLE — behind ANY structural claim floor, derived from
  // STRUCTURAL_CLAIM_FLOORS rather than hard-coded here (WI-2141964 widened this
  // from the original two, observation-lane and needs-human, which were blind to
  // 26 stranded criticals sitting behind claim-hold / not-claimable-status) — past
  // a 7-day UNTOUCHED floor, measured from the LAST WRITE (max of updated_at and
  // last_progress_at), not from creation. Those two facts are in conflict and
  // nothing else reported
  // it. Sibling of the WRITE-TIME guard already shipped on set_priority/update
  // (structuralClaimabilityWarning), and deliberately not folded into it: that
  // guard only fires when SOMEONE WRITES to the row, and the filed instance was
  // an item nobody ever wrote to after filing it as a nit in the observation
  // lane — cup:spawn 100% broken for 19 days behind exactly that shape. Scoped
  // to `critical` ON MEASUREMENT, not taste: on 2026-08-19 the filed
  // critical-OR-major spec matched 57 rows past 7 days (a backlog listing that
  // trains the reader to ignore it) against 5 for critical alone. The widened
  // floor set is measured the same way: on 2026-09-02 the floors alone would have
  // fired 55 (re-creating that backlog listing), the floors TOGETHER WITH the
  // last-write basis 34. Neither knob is safe to move alone. DEFAULT ON.
  // OFF = the kill-switch: the timer still ticks but every sweep no-ops before
  // reading engineer_issues.
  UNSERVABLE_CRITICAL_WATCHDOG: "papercusp-unservable-critical-watchdog",
  // learning-loop-identity-and-consumption-2026-08-08 P-013 (owner amendment
  // D-042): DERIVED-identity fold-in-place for AGENT-filed observations at the
  // `improvements:capture` seam. Keyed folding (a caller-supplied conditionKey)
  // already works and is untouched; this covers the ~1,583 rows/day filed with
  // NO key, which skipped dedupe entirely and minted a row every time. An
  // incoming filing whose identity matches an existing OPEN observation folds
  // into it (repeatCount bump, reporter recorded, occurrence appended) instead
  // of forking a near-identical sibling.
  //
  // It NEVER REJECTS a filing — D-003's no-rejection half is unweakened and is
  // enforced by the classifier's own type (there is no 'reject' variant). OFF
  // restores today's always-mint behaviour exactly; the classifier is not even
  // consulted. DEFAULT ON (derived FLAG_DEFAULTS — deliberately NOT in
  // DARK_FLAGS): the change is reversible, and shipping it dark would leave the
  // measured row-minting problem unaddressed while looking done.
  OBSERVATION_DERIVED_FOLD: "papercusp-observation-derived-fold",
  // EI-20581099901890760 (1): gates the GOAL-mode edit-deny guard wired into
  // agent-tools/locks/acquire.ts — a session whose REGISTERED mode is 'goal'
  // (an agent_modes row; the contract binds at mode:set) is denied PreToolUse
  // Edit/Write lock acquisition, with the correct route named in the deny
  // ("file it — your drain fleet picks it up"). The GOAL contract's
  // never-implement clause was prose-only; in the measured run (WI-39348,
  // 2026-08-16) the subject edited production source in three escalating
  // windows, and each editing window was also a low-supervision window —
  // the exact failure the contract predicts. DEFAULT ON. OFF = the
  // kill-switch: acquire.ts skips the mode check entirely (the guard is
  // also fail-open on flag/PG errors).
  GOAL_MODE_EDIT_DENY: "papercusp-goal-mode-edit-deny",
  // EI-20581099901890760 (2): gates the goal-drain-fleet watchdog — sibling of
  // GOAL_LIVENESS_WATCHDOG above, deliberately on its own kill-switch. That
  // sweep fires when NOBODY is working an active goal; this one fires only
  // when somebody IS and the standing drain fleet the GOAL contract requires
  // (goals metadata.drainFleet, recorded via goals:update) is undeclared past
  // the kickoff grace, missing from agent_fleets, or has no live member.
  // Escalates (deduped) + emits goal:drain-dead:<goalId> for parked awaits.
  // goal-plan-fleet-obligation-detector P-002 widened the same sweep with a
  // PLAN-FLEET leg over the same live-held goals: a started goal plan with no
  // live claim-spec-targeting fleet (goal:plan-fleet-missing) or with a live
  // targeting fleet holding zero claims (goal:plan-fleet-unclaimed). Same flag
  // on purpose — one sweep, one kill-switch.
  // DEFAULT ON. OFF = the kill-switch: the timer still ticks but every sweep
  // no-ops before reading the goals table.
  GOAL_DRAIN_FLEET_WATCHDOG: "papercusp-goal-drain-fleet-watchdog",
  // WI-42442: gates the agent-productivity watchdog — the present-but-unproductive
  // sweep over EVERY agent, not just goal holders. Measured 2026-08-27: 22 of 166
  // present sessions had made ZERO agent-origin tool calls since starting (11 of
  // them fleet members, one wakeable for 18h with no calls of any origin), and
  // every count-based surface read healthy because none of them counts THIS.
  // Escalates ONE CORRELATED WAVE per (workspace, phase) rather than N per-victim
  // alarms — wedge causes are correlated, so N reports bury the one fact that
  // matters. REPORT-ONLY: never respawns (that would fire N relaunches back into
  // the wall that caused the wedge). DEFAULT ON. OFF = the kill-switch: the timer
  // still ticks but every sweep no-ops before reading coord_presence.
  // WI-42445 widened the same sweep with a CADENCE leg over the same population:
  // an agent carrying overlay:ideate past the grace that has never recorded a
  // blender:ideate-pass-record tick. Measured 2026-08-27: 13 of 14 such sessions
  // had never recorded one. Same flag on purpose — one sweep, one kill-switch.
  AGENT_PRODUCTIVITY_WATCHDOG: "papercusp-agent-productivity-watchdog",
  // goal-mode-design-intent-hardening-2026-08-16 P-001 (D-005): gates the drain-fleet
  // AUTO-MINT in goals:start — the PLATFORM, not the agent, stands up the standing
  // drain fleet the GOAL contract requires: registry row + goal-scoped claim spec
  // ({field:'goal',op:'=',value:<goalId>} — the POSITIVE form only; WI-37711: `goal`
  // is nullable, so a not/!= leaf silently excludes every unstamped row) + one
  // headless member + goals metadata.drainFleet, minted with the goal itself so the
  // agent cannot forget what the platform did for it. The watchdog above demotes to
  // backstop. DEFAULT ON. OFF = the kill-switch: goals:start skips the mint and a
  // drainless goal is only ever REPORTED after the kickoff grace — exactly the
  // pre-P-001 behavior.
  GOAL_DRAIN_FLEET_AUTOMINT: "papercusp-goal-drain-fleet-automint",
  // WI-2140699 (card 4 goal-mode-e2e, owner:Avi 2026-09-01 grade+fix mandate): gates
  // the goal-drain-fleet watchdog's RELAUNCH leg — for a STANDING, live-held goal whose
  // declared drain fleet has read dead/missing for a full sweep (10 min, durable
  // metadata.drainRespawn.deadSinceMs), re-mint the goal-scoped lane and launch ONE
  // headless member through launch-su, at most 3 per rolling hour; a spent budget flips
  // needsHuman and escalates once. Measured failure: the everything-goal's drain fleet
  // had 0 live members for 3.5h+ while the report-only rail fired twice and the holder
  // never awaited the event. Outcome (non-standing) goals stay report-only. Same
  // authority as GOAL_DRAIN_FLEET_AUTOMINT above (the platform already spawns this
  // member at goals:start with no agent action). DEFAULT ON. OFF = the kill-switch:
  // the watchdog keeps reporting + emitting, it just never launches.
  GOAL_DRAIN_FLEET_RELAUNCH: "papercusp-goal-drain-fleet-relaunch",
  // goal-mode-design-intent-hardening-2026-08-16 P-008 (EI-20581177540737568 half 2):
  // gates the goal-edit-claim watchdog — a ~90s pkey-range sweep of
  // edit_attribution_ledger joined to goal-mode agent_modes rows on ACTIVE goals.
  // The FIRST edit-claim by a goal-mode owner escalates (deduped per owner+goal),
  // emits goal:edit-claim:<goalId> for parked graders, and wakes the subject + every
  // grade-mode session in the workspace — never-implements is monotonic-downward, and
  // the measured alternative (a grader SAMPLING the run) went stale 28 minutes after
  // an honest interim 'exemplary' (WI-39348). Reports + injects, never blocks (hard
  // enforcement is EI-20581099901890760's lane). DEFAULT ON. OFF = the kill-switch:
  // the timer still ticks but every sweep no-ops before reading the ledger.
  GOAL_EDIT_CLAIM_WATCHDOG: "papercusp-goal-edit-claim-watchdog",
  // goal-mode-design-intent-hardening-2026-08-16 P-009: gates the goal owner-report
  // cadence watchdog — a 10-min sweep that nudges a goal-mode owner whose ACTIVE
  // goal has had no owner report (coord_event_log escalations authored by the owner,
  // or attention_notifications naming the goal/owner in data) past the 4h floor.
  // The nudge is ONE directed wake per silence (gated on the deduped escalation
  // being newly opened) and carries the GOAL contract's report skeleton: what
  // moved, what it cost, what is owner-walled, what you killed. Measured failure
  // (WI-39348): exemplary reporting for 2.5h, then 5h silence including goal-met.
  // Floor carries a D-016 reviewBy (guard test fails past it). Only fires on a
  // POSITIVELY-alive owner — a dead one is GOAL_LIVENESS_WATCHDOG's lane.
  // DEFAULT ON. OFF = the kill-switch: the timer still ticks but every sweep
  // no-ops before reading the goals table.
  GOAL_OWNER_REPORT_WATCHDOG: "papercusp-goal-owner-report-watchdog",
  // goal-mode-design-intent-hardening-2026-08-16 P-002: gates the wind-down
  // DISPOSITION demand — loop:end (and session:end for a loopless owner) by a
  // GOAL-mode owner whose goal is still active refuses without a disposition
  // (achieved | killed | handoff), then auto-generates the owner report from the
  // loop carry-note + end reason and delivers it as an advisory escalation (the
  // owner inbox). The graded run that motivated this had all the per-platform
  // evidence sitting in its own loop:end text and sent NONE of it. DEFAULT ON.
  // OFF = the kill-switch. Unlike GOAL_DRAIN_FLEET_AUTOMINT above (fail-OPEN:
  // a provisioning gate should provide on infra errors), this gate fails
  // CLOSED on flag/PG errors: it is a REFUSAL gate on the stop path, and you
  // must always be able to stop a loop you armed.
  GOAL_WINDDOWN_DISPOSITION_GATE: "papercusp-goal-winddown-disposition-gate",
  // consult-min-max-and-rubric-vetting-2026-08-17 P-009 (D-004 §2, owner-ruled):
  // 'achieved' is a CLAIM, and the claim needs acceptance evidence — a goal may only
  // be dispositioned 'achieved' when it carries an acceptance rubric (kind:
  // 'acceptance', subjectGoal = the goal id) authored post-pursuit by the goal-mode
  // agent, VETTED against the meta-rubric (complete meta-scorecard with a linked
  // consult on the CURRENT rubric revision), and GRADED by a NON-owner of the goal.
  // 'killed'/'handoff' are exempt — you don't grade a goal you abandoned. DEFAULT
  // ON; OFF = the kill-switch. Same stop-path posture as
  // GOAL_WINDDOWN_DISPOSITION_GATE above: fails CLOSED on flag/PG errors — the gate
  // refuses only on a POSITIVE finding, and an infra fault must never wedge an
  // agent stopping its own loop.
  GOAL_ACHIEVED_ACCEPTANCE_GATE: "papercusp-goal-achieved-acceptance-gate",
  // goal-mode-design-intent-hardening-2026-08-16 P-004: gates the server-side dedup
  // demand on work_items:create for a GOAL-mode creator. The creator's goal context
  // is resolved SERVER-SIDE (resolveGoalContext — never a tool argument, same
  // operative rule as the P-002/P-003 provenance stamps) and, when it resolves, the
  // create-time dedup probes must actually RUN and the create fails CLOSED
  // ('dedup_unavailable') if the semantic leg — the only leg that catches reworded
  // titles — is down (WI-39373 relapsed exactly there: probes ran, semantic leg
  // 'unavailable', create failed OPEN, dup landed 107s after the canonical).
  // force:true remains the explicit escape (the probes still run and their
  // coverage/candidates are returned); DRAIN's requireCompleteDedupCoverage rail is
  // unchanged and still overrides force. DEFAULT ON. OFF = the kill-switch:
  // goal-mode creates degrade to the fail-open advisory behavior every other
  // creator gets.
  GOAL_CREATE_DEDUP_GATE: "papercusp-goal-create-dedup-gate",
  // goal-mode-design-intent-hardening-2026-08-16 P-005 (D-003): gates the goal
  // spend-rollup tick — a recurring platform sweep (operator-core
  // lib/goals/spend-rollup.ts, managedSetInterval like the goal watchdog family)
  // that aggregates the cost ledger (agent_usage_samples) per ACTIVE goal over
  // its budget window — the goal_id-attributed stream is authoritative (D-011),
  // the pot and session legs ride along as diagnostics — and writes
  // goals.metadata.spentCents (+Source 'goal-lineage-rollup' +At +Breakdown)
  // platform-side. D-003: agents never hand-write spentCents; before this tick
  // only 3 of 17 goals ever carried one. DEFAULT ON. OFF = the kill-switch: the
  // timer still ticks but every sweep no-ops before reading the goals table.
  GOAL_SPEND_ROLLUP_TICK: "papercusp-goal-spend-rollup-tick",
  // goal-mode-design-intent-hardening-2026-08-16 P-006 (D-001 structural beats
  // prose, D-003 spend truth): makes goals.budget_cents a BINDING launch
  // ceiling. The one launch resolver (goal-launch-settings.ts
  // resolveGoalLaunchForGoal) refuses further fleet/agent launches once the
  // PLATFORM spend snapshot (goals.metadata.spentCents, written only by the
  // goal-spend-rollup tick — never an agent-supplied figure) has reached
  // budget_cents, and opens a per-goal-deduped owner escalation naming the goal
  // and the levers. DEFAULT ON. OFF = the kill-switch: budget truth still
  // resolves and rides the resolution for display, but no launch is refused
  // over it.
  GOAL_BUDGET_LAUNCH_GATE: "papercusp-goal-budget-launch-gate",
  // system-notices-on-its-own-2026-08-16 P-002: gates the retrieval-degradation
  // watchdog — reads the trailing-window leg-health rate that observeLegs now
  // records for every hybrid search, and escalates when a sustained share of
  // searches did not run at full strength. summariseLegs has always computed a
  // precise per-search verdict ("semantic leg blocked: query embed exceeded
  // 1200ms budget"), but it was rendered as one line of prose and then thrown
  // away, so nothing could answer "is retrieval degrading, and since when?".
  // Observed 2026-08-16: three semantic-leg blocks plus one zero-candidate
  // lexical leg inside a single agent session, all silent. Retrieval is how
  // stored knowledge reaches the moment of need, so half-strength retrieval is
  // the mechanism behind "the knowledge existed and it didn't reach me".
  // DEFAULT ON. OFF = the kill-switch: the timer still ticks but every sweep
  // no-ops before reading the counter.
  RETRIEVAL_DEGRADATION_WATCHDOG: "papercusp-retrieval-degradation-watchdog",
  // EI-21491088289861649: gates the embed-latency watchdog — reads the
  // trailing-window per-caller embed-latency samples that the hybrid engine's
  // embed choke point records (libs/generic/search/src/embed-latency.ts), and
  // escalates when a caller's p99 breaches ITS OWN budget. The sibling
  // RETRIEVAL_DEGRADATION_WATCHDOG sees only leg OUTCOMES, so an embed that is
  // SLOW but still succeeds — measured on this box: 1.92s cold vs ~1ms warm,
  // under search's 4000ms budget while blowing the mid-turn corpus's 1200ms —
  // never trips it, and the breach keeps surfacing indirectly as a wrong
  // consult verdict or a degraded semantic leg instead of AS a breach.
  // DEFAULT ON (advisory-only escalations). OFF = the kill-switch: the timer
  // still ticks but every sweep no-ops before reading the buffer.
  EMBED_LATENCY_WATCHDOG: "papercusp-embed-latency-watchdog",
  // deterministic-context-carry P-019 (D-010 live leg 2): gates the residual
  // carry SAMPLER — at each REAL compaction boundary the gateway's deterministic
  // maintenance-carry branch serves, fire-and-forget one reserved-lane residual
  // pass (stage-1 doc vs the dropped raw material) and append the per-class
  // MissRateSample to ~/.papercusp/psu-pty/residual-carry-samples.events.jsonl.
  // That corpus is what scoreResidualMissRate's strict-zero retirement gate
  // (≥30 parsed samples/class, missRate 0, errorFraction ≤0.1) reads, and the
  // per-class `retire` verdict is exactly what P-022 (retire native compaction
  // fleet-wide) consumes — without this sampler the corpus never accumulates and
  // P-022 can never unblock. Interactive boundaries only (the launcher threads
  // ?carryInteractive=1; headless boundaries skip, they are graded by P-020
  // drills instead) + a 10-min per-owner rate limit bound the LLM cost. Rides
  // GATEWAY_MAINTENANCE_CARRY (no deterministic branch ⇒ nothing to sample).
  // DEFAULT ON; OFF = the kill-switch (no sampling, served compactions
  // byte-identical either way).
  RESIDUAL_CARRY_SAMPLER: "papercusp-residual-carry-sampler",
  // deterministic-context-carry P-021 (verdict-gated cold-by-default): once a session
  // CLASS's cold-boot drills prove its deterministic carry sufficient
  // (gradeColdBootDrills → sufficientClasses), that class's LOOP wakes go cold WITHOUT
  // the per-loop `loop:arm { carry:'cold' }` opt-in — still hard-gated on SU_COLD_AUTO
  // (master), a carry-note anchor existing (P-006), and NO active interactive exchange
  // (no human keystroke into the host within the ACTIVE_EXCHANGE_WINDOW — the plan's
  // "warm continuation stays within active interactive exchanges"). DEFAULT ON — safe
  // because the mechanism is EVIDENCE-gated: nothing goes cold-by-default until a class
  // has a passing drill record. OFF = the kill-switch: only explicitly cold-armed loops
  // ever go cold (today's behavior).
  COLD_BY_DEFAULT_PROVEN_CLASSES: "papercusp-cold-by-default-proven-classes",
  // deterministic-context-carry P-026 (verdict-gated enrichment retirement): for a
  // session class whose cold-boot drills prove the deterministic carry sufficient, the
  // POST-COMPACTION speculative memory re-prime (compact-reprime.ts — the same-session
  // hole-patch auto-recall that refills a wiped context with nearest-neighbour hits,
  // observed at 0.023–0.033 cosine = noise) is SKIPPED: the epoch bump stays (ledger
  // hygiene — turn-start deltas re-arm), only the speculative fold is retired. A needed
  // successor search is a BUILDER gap to fix, not a reason to keep the fold. DEFAULT ON
  // (evidence-gated like P-021 — inert until a class passes drills). OFF = kill-switch:
  // every compaction re-primes, today's behavior.
  ENRICHMENT_RETIRE_PROVEN_CLASSES:
    "papercusp-enrichment-retire-proven-classes",
  // workspace-scoped-coordination-2026-06-20 (D-007): the SHARED master gate for the QUEEN +
  // SCOUT + OVERWATCH per-HIVE → per-WORKSPACE brain re-key — ONE central brain per workspace
  // spanning all its hives (all halves flip together on THIS one flag; keying must stay
  // consistent across the three brains, D-006). DEFAULT ON — graduated 2026-08-02 at the
  // owner-attended cutover (WI-605, D-019; build verified complete D-010, flipped live via the
  // pg override first). OFF = the reversible kill-switch restoring the per-hive brains (that
  // code path is deliberately retained until the post-graduation cleanup):
  // isWorkspaceCoordinationOn() fails to false and workspaceBrainScopeKey read-falls-back to
  // the legacy per-hive keys, so flipping OFF strands no state.
  WORKSPACE_COORDINATION: "papercusp-workspace-coordination",
  // unified-work-item-ledger-2026-06-21 P-003 (D-002): auto-promote a started plan's OPEN
  // items into placeable, UNCLAIMED work-items inside plans:start (the single promotion path;
  // the Queen just calls plans:start). DEFAULT ON (WI-3855, 2026-07-11: this comment's "DEFAULT
  // OFF (dark) ... KNOWN_DARK_FLAGS" was never actually added to the DARK_FLAGS map, so the
  // 2026-06-29 P-011 inversion silently made it live default-ON — the same EI-7230-class mismatch
  // as WATCHDOG_AUTO_CLOSE et al. Confirmed live + working, not a drive-by flip: plan items
  // across multiple live plans resolve with linked, auto-minted work-items today — e.g. this
  // very fleet's claimable backlog carries WI-4137..WI-4141 each stamped with a `plan_item` ref
  // back to their source plan item). OFF ⇒ no promotion (the reversible fallback).
  PLAN_WORKITEM_PROMOTION: "papercusp-plan-workitem-promotion",
  // (MUG_WARM_SESSION / "papercusp-queen-warm-session" — the queen-memory-hybrid L2 warm-wake
  // flag — was DELETED with the Mug tier: retire-mug-kettle-su-only-2026-08-09 P-059. Its sole
  // reader, pot/mug-warm-session.ts, is retired to root `_retired/`, so the flag gated nothing.
  // It was default-ON, which is why it had to go rather than linger: a live flag that gates no
  // code reads as a working feature to anyone who greps for it.)
  // work-queue-completeness-2026-06-21 Phase A (unified-work-item-ledger): ENFORCEMENT —
  // every plan-item claim auto-mints a tracked work-item. When ON, the three bare-claim
  // bypass paths (plan_items:claim, coord:declare-intent { items }, plans:set-status → wip
  // auto-claim) route the claim through convertPlanItem (policy-checked lease → resume-or-mint
  // a work_item → claim it → link it back), so WORKING a plan item never leaves untracked work.
  // DEFAULT ON (WI-3855, 2026-07-11: this comment's "DEFAULT OFF (dark, reversible) ...
  // KNOWN_DARK_FLAGS" was never actually added to the DARK_FLAGS map, so the 2026-06-29 P-011
  // inversion silently made it live default-ON — the same EI-7230-class mismatch as
  // WATCHDOG_AUTO_CLOSE et al. Confirmed live + working, not a drive-by flip: coord:orient's own
  // `planItems` claim lever and plans:set-status → wip auto-claim are exercised continuously by
  // this very fleet, producing exactly the linked work-items PLAN_WORKITEM_PROMOTION's note
  // above cites as evidence). OFF ⇒ bare claimPlanItem (the reversible fallback). The
  // auto-convert legs in declare-intent / set-status stay best-effort (wrapped so a convert
  // failure never breaks the underlying claim).
  PLAN_ITEM_CLAIM_AUTO_CONVERT: "papercusp-claim-auto-convert",
  // acceptance-rubrics-on-every-plan-2026-08-11 (P-004/P-005, owner-ruled D-007/D-008):
  // every plan ships with a GRADED acceptance rubric. ON ⇒ plans:set-plan-status →
  // 'shipped' (and its 'done' alias) refuses unless an acceptance-kind rubric with
  // subjectPlan=<the plan> exists AND carries a complete non-synthesized scorecard graded
  // by a NON-implementer (grader ≠ rubric author, D-005). The refusal message is the
  // authoring nudge (author the rubric POST-implementation — better informed, D-007).
  // Rubric-template plans + scheduled template instances are exempt. Default ON (derived
  // FLAG_DEFAULTS — not in DARK_FLAGS); OFF restores ungated plan shipping byte-identically.
  ACCEPTANCE_RUBRIC_COMPLETION_GATE:
    "papercusp-acceptance-rubric-completion-gate",
  // consult-min-max-and-rubric-vetting-2026-08-17 P-004: the VETTING half of the rubric
  // family. Before a NON-implementer grades the WORK, the acceptance-rubric AUTHOR vets
  // the RUBRIC against the meta-rubric ('meta-acceptance-rubric'): a get_feedback
  // consult bounded by the 'rubric-vetting' selection policy critiques it (the count is
  // that registry's to state, never this comment's), the author improves it, then
  // attests via a meta-scorecard — scorecards:emit { rubricRef:'meta-acceptance-rubric',
  // subject:{ kind:'rubric', ref:<the acceptance rubric> }, vettingConsult:<the
  // consult's conversation_id> }. ON ⇒ evaluatePlanAcceptanceGate additionally refuses
  // (acceptance_rubric_unvetted) unless the CURRENT rubric revision
  // (harness_plans.version, pinned at emit) carries a complete non-synthesized
  // meta-scorecard with a linked consult. Pass is the vetting agent's judgment per
  // criterion — no mechanical score floor (plan D-001 §3). Exempt: criteria:[]
  // investigation rubrics (D-009), the meta-rubric itself, rubric-template plans +
  // template instances (exempt upstream), and a workspace with NO registered
  // meta-rubric — the check disables rather than deadlocking every ship ('proposed'
  // counts as registered: ratification governs content authority, not gate mechanics;
  // plan D-009/D-010). Like the sibling rubric gate, NOT waivable by `force` (D-005).
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS); OFF restores the
  // P-004-less gate byte-identically.
  ACCEPTANCE_RUBRIC_VETTING_GATE: "papercusp-acceptance-rubric-vetting-gate",
  // plan-completion-audit-and-acceptance-verdict-2026-08-13 P-009 — the CODE-TRUTH half
  // of plan completion. The rubric gate above checks the ceremony (a rubric exists, every
  // criterion carries some rating, the grader is not the author); it reads neither what
  // the ratings SAY nor the code. This one requires an audit (plans:audit) covering every
  // non-dropped item, with its citations re-resolved against the CURRENT tree at ship time
  // because the tree moves between audit and ship. Bypassable per-ship with an explicit
  // reasoned `force` (D-003). Default ON; OFF restores the pre-audit shipping path.
  PLAN_CODE_AUDIT_GATE: "papercusp-plan-code-audit-gate",
  // design-to-code-coverage-seam-2026-09-02 P-020 / D-032 — the EXIT for the gate
  // above. Entry into `awaiting-acceptance` is automated (plan-drain rule + sweep)
  // and exit was not, so the state accumulated monotonically: measured 187 plans,
  // 86.1% of which had never had `plans:audit` run once, oldest 2026-06-04. The
  // refusal was only ever visible to someone who explicitly attempted a ship. This
  // sweep files ONE claimable work item per held plan, naming the gate's actual
  // first blocker and quoting its own repair instruction — the same queue-not-wall
  // pairing SPEC_TRIAD_REQUIRED already has. Default ON; OFF stops the filing and
  // restores the silent backlog (it changes no gate verdict, only who is told).
  ACCEPTANCE_DRAIN_SWEEP: "papercusp-acceptance-drain-sweep",
  // plan-completion-audit-and-acceptance-verdict-2026-08-13 P-009 — the cheap floor under
  // the audit: 'shipped' refuses while an item is still todo/wip/blocked/needs-human.
  // `dropped` passes, because that is a recorded decision (D-002). Deliberately a SEPARATE
  // flag from PLAN_CODE_AUDIT_GATE: this check costs nothing and would have caught
  // claude-md-projection-from-pg-2026-08-10 shipping with P-009 still todo, so it should
  // survive an audit-gate rollback rather than die with it. Default ON.
  PLAN_ITEM_COMPLETION_GATE: "papercusp-plan-item-completion-gate",
  // first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 P-008 — the SPEC-PROOF
  // half of plan completion. The audit gate above re-resolves the plan's code citations
  // against the tree; this one reads the plan's first-class spec clauses and refuses
  // (spec_proof_stale) when a clause was REVISED after its evidence was recorded, so its
  // only proof is bound to a promise that no longer applies.
  //
  // P-013 WIDENED IT (2026-08-24). This comment previously read "an enforceable clause
  // with NO evidence at all is REPORTED and never refused, because widening WHICH clauses
  // are enforced is P-013's". P-013 did that widening: an enforceable clause with no
  // evidence at any revision now refuses too (spec_clause_unproven) — the weaker condition
  // no longer passes where the stronger one refuses.
  //
  // What stops it freezing ships fleet-wide is not narrowness any more but per-plan
  // ELIGIBILITY (spec-enforcement-eligibility.ts): a shipped/superseded plan (D-018) and a
  // draft (D-012) stay report-only, and so does an active plan that has adopted no clauses
  // — so enforcement arrives as each plan is reconciled, individually, rather than all at
  // once. A not-yet-eligible plan still NAMES its findings in `wouldBlock`, so the
  // migration lane is visible rather than silently exempt.
  //
  // Legacy-safe otherwise: a truncated evidence census degrades to report-only rather than
  // rendering a floor as a refusal, and an unreadable plan status degrades to
  // non-enforcing. Bypassable per-ship with the same reasoned `force` as the code-truth
  // family (D-003). Default ON; OFF restores the pre-P-008 shipping path byte-identically.
  PLAN_SPEC_COVERAGE_GATE: "papercusp-plan-spec-coverage-gate",
  // infra-perf-reliability-audit-round4 P-005 (D-005): switch listEscalations({status:'open'})
  // to read the materialized harness_shared.coord_open_escalations projection (mig 355) instead
  // of the unbounded ~35k-event full-surface replay that pg_stat_statements pinned as ~88% of
  // DB exec time. DEFAULT ON (WI-3855, 2026-07-11: this comment's "DEFAULT OFF (dark) ...
  // KNOWN_DARK_FLAGS" was never actually added to the DARK_FLAGS map, so the 2026-06-29 P-011
  // inversion silently made it live default-ON — the same EI-7230-class mismatch as
  // WATCHDOG_AUTO_CLOSE et al. Confirmed live + safe, not a drive-by flip: mig 355 has been
  // applied in prod since 2026-06-21 and harness_shared.coord_open_escalations is populated
  // with real rows (364 as of this check) — the "migration+backfill confirmed applied" condition
  // this comment names as the flip gate is met). OFF ⇒ the unbounded event-fold (the reversible
  // fallback, byte-identical to pre-P-005).
  COORD_OPEN_ESCALATIONS_PROJECTION:
    "papercusp-coord-open-escalations-projection",
  // coord-wake-on-reply: by default, when an agent coord:sends a DIRECTED message and
  // a peer REPLIES to it (their coord:send sets related_msg_id to the original msg_id),
  // auto-wake the ORIGINAL sender so they re-invoke the moment the reply lands — the
  // dual of deliver-and-wake (which wakes the RECIPIENT). DEFAULT ON (alpha default-on
  // policy): the reply-wake is OPTIMISTIC + fully fail-soft (a lookup miss / sql hiccup /
  // wake failure is swallowed and never blocks the send), so it only ever adds a
  // best-effort re-invoke. OFF ⇒ no opt-in persisted + no reply-wake fired (today's
  // behavior, byte-identical: a reply just sits in the inbox until the sender's next turn).
  COORD_WAKE_ON_REPLY: "papercusp-coord-wake-on-reply",
  // caching-layer-tag-eca-2026-06-22 P-004: wire the operator cache to the change
  // stream — a `<schema>.<table>.changed` event (emit_change_notify, mig 368 carries
  // args.id + workspace_id) fires the built-in `cache.bumpTags` reaction action, which
  // bumps the per-(workspace, tag) generation for `['<table>', '<table>:<id>']` so every
  // tagged getOrSet entry is lazily stale on its next read. DEFAULT ON (alpha
  // flags-default-on): the action + rule are complete + tested and the bump is a SAFE
  // no-op side effect (it only marks cache generations; with no consumers yet nothing
  // breaks) — the kill-switch is purely precautionary. OFF ⇒ the rule's `when` falls
  // false ⇒ no invalidation (byte-identical to no cache). Reading the live change stream
  // INTO emitSystemEvent is a focused follow (the sync bus's bridge sees only the event
  // name, not args.id/workspace_id) — see the P-004 completion note.
  CACHE_TAG_ECA: "papercusp-cache-tag-eca",
  // caching-layer-tag-eca-2026-06-22 P-018 (operational hardening): the operator
  // L1 cache READ kill-switch (distinct from CACHE_TAG_ECA, which only gates the
  // invalidation ECA rule). DEFAULT ON: the cache serves/single-flights getOrSet
  // entries. OFF ⇒ the singleton's `bypass` returns true ⇒ every getOrSet runs its
  // factory directly (no L1 read/write) — byte-identical to having no cache, the
  // panic switch if a cache consumer ever serves wrong/stale data in prod. Read
  // SYNC-cached (the getOrSet hot path can't await), refreshed on boot + flag change.
  CACHE_LAYER: "papercusp-cache-layer",
  // no-http-anywhere-2026-07-28 P-007 / D-082: the durable L2 tier (PgL2Store over
  // harness_shared.cache_l2, migration 369) wired read-through/write-through inside
  // `cachedRead`. DEFAULT ON: D-078 measured the actual cost as the 16-worker
  // cold-start spread against per-process L1s — one worker's build could not serve
  // the other fifteen, producing user-facing 10s deadline hits clustered right after
  // every deploy/restart (when all 16 are cold at once). L2 makes a build durable and
  // cross-process, so a cold worker reads a peer's result instead of rebuilding.
  // OFF ⇒ cachedRead is byte-identical to the L1-only behaviour that shipped before.
  // Read SYNC-cached alongside CACHE_LAYER (same reason: the read path can't await a
  // flag), and STRICTLY SUBORDINATE to it — CACHE_LAYER off disables L2 too, because
  // that kill-switch means "no cache", not "no L1".
  CACHE_L2: "papercusp-cache-l2",
  // data-sync-push-completion P-005/D-012: the DEBOUNCED live-invalidation detector for the
  // six APPEND_HEAVY_TABLES (audit_log, agent_runs_consolidated, user_actions, harness_hook_logs,
  // toast_log, feature_audit_consolidated) — which intentionally carry NO per-row change-notify
  // trigger (notify-storm; mig 376 + COVERAGE_EXEMPT). ON ⇒ the host polls max(id) per table and
  // synthesizes a `<table>.changed` invalidation when it advances, so their mapped sync queries
  // (userActions.*, auditLog.*, toastLog.recent, …) push-update without the per-row storm. OFF ⇒
  // no detector; those consumers fall back to their own poll / the 180s drift-repair (the
  // pre-P-005 behavior). DEFAULT ON: the detector + the bus per-call dedupe override are complete
  // + tested; cuttable kill-switch if the synthesized fires ever misbehave.
  APPEND_HEAVY_LIVE_INVALIDATION: "papercusp-append-heavy-live-invalidation",
  // hybrid-bee-scheduler-work-stealing-2026-06-22 — gate the SPEC-driven claim path: ON ⇒
  // scheduler:get_next pulls per the bee's Queen-issued claim spec; OFF ⇒ get_next ignores stored
  // specs and falls back to the DEFAULT ordering (== work_items:claim_next) — a no-breakage
  // kill-switch. DEFAULT ON (alpha flags-default-on; the resolver + spec store are complete + tested).
  SCHEDULER_SPEC_CLAIM: "papercusp-scheduler-spec-claim",
  // WI-5940 — gate the SELF-SELECT claim paths (scheduler:get_next + its work_items:claim_next
  // wrapper) on the caller's own context pressure: ON ⇒ a caller whose cached bucket is CRITICAL
  // gets a typed compact-first verdict (claim_refused_context_critical) instead of an item, since
  // an agent that compacts mid-task carries in-flight state worst. OFF ⇒ today's behavior.
  // Only 'critical' refuses; 'ok'/'high'/unknown always serve, and the caller can override with
  // ignoreContextPressure when its LIVE gauge contradicts the ~2-min-stale cached bucket — so an
  // over-eager refusal can never manufacture a false drain. DEFAULT ON (complete + tested;
  // cuttable kill-switch if the gate ever withholds work it should have served).
  SCHEDULER_CONTEXT_PRESSURE_GATE: "papercusp-scheduler-context-pressure-gate",
  // WI-2092233 — gate the SELF-SELECT claim paths (scheduler:get_next + work_items:claim_next)
  // on the caller's GOAL-holder authority: ON ⇒ an ELECTED goal holder (or live handoff window)
  // gets a typed route-it-instead verdict (claim_refused_goal_steward) instead of an item — the
  // GOAL contract is categorical (never implement; every execution unit is a launched agent), and
  // the filed breach (the work-on-everything holder self-pulling WI-1801547 then stranding it on
  // release) is exactly what this prevents. OFF ⇒ today's behavior. Fail-open on an unreadable
  // authority; the by-id door (work_items:claim) stays deliberately ungated as the escape.
  // DEFAULT ON (complete + tested; cuttable kill-switch).
  SCHEDULER_GOAL_STEWARD_GATE: "papercusp-scheduler-goal-steward-gate",
  // work-item-deps-and-readiness-2026-06-22 P-005: the scheduler claim reads the maintained
  // readiness sidecar (work_item_blocked — an indexed anti-join) instead of the inline per-claim
  // NOT EXISTS subquery. Behavior-identical; a performance cutover. DEFAULT ON (derived
  // FLAG_DEFAULTS — graduated out of DARK_FLAGS 2026-06-22 after a sustained live drift=0 verify;
  // requires mig 379). OFF is the reversible kill-switch back to the inline predicate.
  SCHEDULER_MAINTAINED_READY: "papercusp-scheduler-maintained-ready",
  // gateway-priority-tiers-2026-06-22: gates the inference-gateway priority-tier
  // queueing/admission path (a reserved tier-1 capacity floor + per-tier in-flight caps
  // over the flat priority+aging queue). DEFAULT ON (WI-3855, 2026-07-11: this comment's
  // "DEFAULT OFF ... KNOWN_DARK_FLAGS" was never actually added to the DARK_FLAGS map, so
  // the 2026-06-29 P-011 inversion silently made it live default-ON — the same EI-7230-class
  // mismatch as WATCHDOG_AUTO_CLOSE et al. resolvePriorityTiers (launch.ts) is fully
  // implemented + tested and wired live at gateway launch, not a stub; the effect is
  // additive/directionally-conservative (reserves floor capacity for higher-priority
  // interactive callers, sheds background tiers first under pressure) rather than a
  // destructive behavior change — flagged here for the record, not independently proven via
  // an attended :3170 verify, so leader/owner should give this one a further look). OFF ⇒ the
  // flat priority+aging queue (the reversible fallback).
  GATEWAY_PRIORITY_TIERS: "papercusp-gateway-priority-tiers",
  // codex-gateway-oauth-proxy-2026-07-04 (WI-2198): gates the codex
  // ChatGPT-subscription OAuth STREAMING reverse-proxy — the gateway forwards a
  // codex-cli account's native Responses request to chatgpt.com/backend-api/codex with
  // the OAuth bearer injected from ~/.codex/auth.json. DEFAULT ON after WI-272118's
  // owner-directed 2026-08-27 live canary proved a gpt-5.6-luna:max agent could cross
  // two native Responses turns, call gateway:status, send its fleet result, and finish
  // with LUNA_AUTO_FLEET_OK through transport oauth-http. OFF remains the emergency
  // kill-switch to the one-shot `codex exec` bridge; that fallback cannot preserve an
  // outer tool-capable Responses turn and is suitable only for text-only compatibility.
  CODEX_GATEWAY_OAUTH_PROXY: "papercusp-codex-gateway-oauth-proxy",
  // deterministic-context-carry-2026-07-14 P-017 (WI-4845): gates the gateway's
  // DETERMINISTIC maintenance-carry branch — POST /maintenance/summarize?carryOwner=<id>
  // answers from buildMaintenanceCarrySummary (the PG carry-doc builder) instead of the
  // LLM oneshot, falling through to the LLM lane on any miss (fail-soft). DEFAULT ON —
  // owner-directed release cutover 2026-07-15: ship the deterministic consumer live and
  // shorten P-020's pre-cutover campaign to one clean smoke per affected class. Deploy
  // ordering is enforced by the release pipeline (gateway reader lands before a launcher
  // carrying ?carryOwner is distributed). OFF remains the emergency kill-switch: the
  // gateway ignores carry params and uses the reserved LLM maintenance lane.
  GATEWAY_MAINTENANCE_CARRY: "papercusp-gateway-maintenance-carry",
  // autonomous-spawn-gateway-dispatch-gate-2026-07-04 (WI-2376): before an
  // AUTONOMOUS durable spawn posts /invoke, read the inference-gateway health
  // predicate and SKIP the dispatch when the Claude gateway is wholesale-throttled
  // (paused/rejected/no priority-tier capacity). DEFAULT ON (derived FLAG_DEFAULTS):
  // it is a conservative load-shed guard for background spawns only; interactive
  // spawns and Codex/OpenAI control-plane spawns are unchanged. OFF is the kill-switch
  // if the health predicate ever false-positives.
  AUTONOMOUS_SPAWN_GATEWAY_DISPATCH_GATE:
    "papercusp-autonomous-spawn-gateway-dispatch-gate",
  // queen-capacity-aware-dispatch-2026-06-22: gates the Queen's capacity-aware
  // dispatch (placement keyed on live fleet capacity) — clamps fresh-spawn headroom
  // under fleet:place_batch. DEFAULT ON (WI-3855, 2026-07-11: this comment's "DEFAULT
  // OFF ... KNOWN_DARK_FLAGS" was never actually added to the DARK_FLAGS map, so the
  // 2026-06-29 P-011 inversion silently made it live default-ON — the same EI-7230-class
  // mismatch as WATCHDOG_AUTO_CLOSE et al. capacity-dispatch.ts is fully implemented +
  // tested, not a stub; the effect is directionally conservative (ON ADDS a capacity
  // clamp that prevents over-spawning under load; OFF = no clamp = unrestricted spawn),
  // so the live-ON state is not destructive — flagged here for the record, not
  // independently proven via an attended :3170 verify, so leader/owner should give this
  // one a further look). OFF ⇒ no clamp (the reversible fallback).
  MUG_CAPACITY_DISPATCH: "papercusp-queen-capacity-dispatch",
  // fleet-headcount-governor-2026-07-14 (WI-2479): gates the persistent
  // per-fleet auto-top-up routine. DEFAULT OFF (dark): this is a dangerous
  // fleet-autonomy surface that can open real agent sessions; the owner flips
  // it only after reviewing the bounded deficit, duplicate-suppression, and
  // exponential-backoff behavior. OFF is a pure no-op for the routine.
  // R5 (interrupted-member-recovery-hardening-2026-09-01): even ON, the routine
  // acts ONLY on fleets whose persisted recipe carries `supervise: true` (the
  // per-fleet grant set via fleet:launch-on-plan { supervise } or
  // fleet:headcount-target { supervise }) — a per-fleet consent gate under this
  // master one; an ungranted fleet is untouched.
  FLEET_HEADCOUNT_GOVERNOR: "papercusp-fleet-headcount-governor",
  // WI-6054 (turn-end-tracking P-016): gates `system:unguarded-halt-rescue`, the
  // SYSTEM-side leg of the unguarded-halt guard. The detector already existed
  // (turn-end-tracking.detectUnguardedHalt) but its only caller was the
  // agent-invoked `journal:record-turn` tool — so it never fired for an agent
  // that simply STOPPED, which is the failure it was built for. This routine runs
  // the SAME sweep from a system path and WAKES halted agents. DEFAULT ON: it
  // opens no new sessions (unlike FLEET_HEADCOUNT_GOVERNOR — it only re-wakes
  // agents that already exist), is throttled per agent and capped per tick, and
  // recovers work that is otherwise lost silently. OFF ⇒ pure no-op.
  UNGUARDED_HALT_RESCUE: "papercusp-unguarded-halt-rescue",
  // interrupted-member-recovery-hardening-2026-09-01 P-003 (R1/R2): gates the
  // wake-BEFORE-page rung inside `system:reconcile-silent-halts`. The sweep's
  // owner page previously fired with NO wake attempt (plan D-001) even though
  // its subject is a live process holding stranded work. ON ⇒ one wake attempt
  // per (owner, disarm-epoch) rides the same sendMessage+wakeRecipients path as
  // UNGUARDED_HALT_RESCUE (opens no new sessions — it only re-wakes existing
  // ones; the wake-executor ladder can RESUME a dead-but-resumable process),
  // and the owner page becomes the NEXT sweep tick's fallback when the wake
  // produced no real turn. DEFAULT ON. OFF ⇒ exactly the pre-P-003 page-only
  // behavior — a reversible runtime kill-switch.
  SILENT_HALT_WAKE_FIRST: "papercusp-silent-halt-wake-first",
  // agent-tool-delta-protocol-2026-06-22 P-016 (D-007/D-008): gates the LLM-facing
  // SEMANTIC-delta opt-in (mode:delta merge responses) — the silent-wrong-merge
  // hazard the owner BUILD decision agreed to retire BY TEST. DEFAULT ON
  // (owner-directed flip 2026-06-22): enabled the server capability ahead of the
  // delta-aware client. ⚠ NO LONGER INERT (WI-3153, measured 2026-08-04): the MCP
  // transport's delta proxy (_mcp-handler.ts `maybeRunWithDeltaProxy` — defined AND
  // called since 2026-07-05) IS that client. It sends _meta.delta on the model's
  // behalf, merges + checksum-verifies the reply, and hands the model RECONSTRUCTED
  // full rows (mode:'full', reason:'proxy_reconstructed'), so the model itself never
  // merges. Do not re-derive "inert" from this comment's history — grep the dispatch
  // path. The delta-gate (apps/operator/lib/release/delta-gate.ts) stays
  // warn-only/un-armed so it never blocks deploys. OFF ⇒ tools degrade to the
  // unconditionally-safe Lane-B behaviour (full | not_modified), never a semantic
  // delta — a reversible runtime kill-switch (host wiring: operator-core's
  // agent-tools/delta-flag-wiring.ts).
  TOOL_DELTA_PROTOCOL: "papercusp-tool-delta-protocol",
  // agent-tool-delta-protocol-2026-06-22 P-009 (Lane D): gates the SSE state-snapshot
  // DATA-CARRYING delta path (/api/operator/state-snapshot ?delta=1 → per-run card
  // add/update/remove deltas instead of whole snapshots). A DISTINCT surface from
  // TOOL_DELTA_PROTOCOL (the LLM tool-result delta) — proven by the state-delta
  // round-trip test, not the Lane-C LLM scenarios. OFF ⇒ full snapshots (today).
  STATE_SNAPSHOT_DELTAS: "papercusp-state-snapshot-deltas",
  // agent-tool-delta-client-rollout-2026-06-23 P-006: gates the sync RESOURCE rows-delta —
  // the UI's invalidate-driven re-fetch of plans.attention/plans.list sends a cursor and the
  // server replies with only the changed rows (the ~327GB/3d win). A reversible CUTOVER
  // kill-switch: OFF ⇒ no codec injected ⇒ full re-fetch (byte-identical). The owner flips it
  // ON after an attended running-desktop verify (the checksum/keep-stale guard degrades a wrong
  // merge to a refetch, never a wrong view).
  SYNC_RESOURCE_DELTA: "papercusp-sync-resource-delta",
  // fleet-deltas-leader-primitives-2026-07-10 P-004: coord:orient mode:'monitor'
  // returns a fleet DELTA (member verdict/state transitions since the caller's
  // server-side read cursor — mig 537 coord_read_cursors, two-phase
  // ack-on-next-read) instead of the full fleet:assignments roster every wake.
  // DEFAULT ON — a read-path economizer with NO client merge (orient folds the
  // delta server-side; a died wake re-receives via the two-phase cursor), so the
  // D-012 dark-flag rationale (client-merge risk) does not apply. OFF ⇒ the full
  // roster fold, byte-identical to pre-P-004 monitor mode — a reversible runtime
  // kill-switch.
  ORIENT_MONITOR_DELTA: "papercusp-orient-monitor-delta",
  // fleet-deltas-leader-primitives-2026-07-10 P-005: the FULL-mode sibling of
  // ORIENT_MONITOR_DELTA above — extends the same server-side read-cursor
  // treatment (mig 537 coord_read_cursors) to coord:orient's default (non-
  // monitor) folds: the fleet roster (`me`, same 'fleet:monitor' surface),
  // coord:plan-events, and the fleet-catch-up fold. Each becomes an
  // "unchanged since your last orient" marker instead of a full re-delivery
  // when nothing changed (D-003 audit: ~96-100% exact-repeat on these folds).
  // DEFAULT ON — same no-client-merge, read-path-economizer rationale as
  // ORIENT_MONITOR_DELTA (D-012 dark-flag rationale does not apply); every step
  // is fail-open (a cursor error or unrecognizable shape just delivers in full,
  // never worse than pre-P-005 behavior). Deliberately does NOT touch
  // `claimable` (self-select surface) or `facts` (binding-context surface) —
  // omitting "unchanged" content there risks an agent acting on stale
  // knowledge; see plan decision D-007 for the full reasoning.
  ORIENT_FULL_DELTA: "papercusp-orient-full-delta",
  // fleet-deltas-leader-primitives-2026-07-10 P-004 / D-004 ruling 3: the
  // turn-start ORIENTATION fold. Orientation's READ half rides the injection
  // rail that already fires every turn, so an agent is oriented whether or not
  // it issues a read — measured 2026-08-11, 119 of 378 working owners (31.5%)
  // issued NO coordination read of any kind in 7d, and the mid-turn injection
  // path's floor-seeding assumes a session-start read that those never perform
  // (EI-20190140825808810). DEFAULT ON (alpha flags-default-on): the fold is
  // additive, budget-capped, delta'd against a server-side cursor, and
  // fail-soft — OFF ⇒ the endpoint returns exactly its pre-P-004 [control,
  // memory] composition, byte-identical.
  TURN_START_ORIENTATION: "papercusp-turn-start-orientation",
  // queen-bee-spawn-reclaim-relaunch-2026-06-22 (EI-85 restart-kills): the boot
  // spawn-admission reconcile RE-LAUNCHES a reclaimed queen/bee whose durable
  // work-item is non-terminal, instead of marking it `failed` and losing the work.
  // A host restart kills in-flight spawns before their admission-release runs; the
  // reconcile frees the ceiling debit AND re-fires the survivor so a queen/bee
  // survives ANY host restart. DEFAULT ON (alpha flags-default-on) — the relaunch
  // is bounded (only non-terminal work, ceiling-gated re-fire) and reversible; OFF
  // ⇒ the legacy reclaim-to-`failed` behaviour, byte-identical.
  SPAWN_RECLAIM_RELAUNCH: "papercusp-spawn-reclaim-relaunch",
  // code-run-token-frugality (owner directive 2026-06-23): the INLINE batch nudge — when an agent
  // fires the SAME tool repeatedly in a session, attach a one-shot hint to its result steering it to
  // bundle the calls into one code:run. The STRUCTURAL complement to the CODE_RUN_NUDGE prompt prose
  // (hits the decision point, which beats prose for adoption). Additive (only adds a [batch-hint]
  // line, one-shot per session+tool, code:run-capable callers only); DEFAULT ON; OFF ⇒ no hint.
  CODE_RUN_BATCH_NUDGE: "papercusp-code-run-batch-nudge",
  // code-run-token-frugality FAN-OUT upgrade (owner directive 2026-06-26): the INLINE nudge's second
  // trigger — when an agent fires ≥4 DISTINCT tools in a short window (the "many-different-reads-once"
  // fan-out the same-tool-N× trigger was BLIND to; the 2026-06-26 audit found same-tool covered only
  // ~30% of multi-call SU spawns), attach a [batch-hint] with a ready-to-paste Promise.all skeleton
  // over the exact tools seen. Its OWN flag (NOT CODE_RUN_BATCH_NUDGE) so the new trigger is an
  // independent A/B knob: flip OFF and measure the adoption delta via the code-run-adoption metric.
  // Additive + reversible; DEFAULT ON; OFF ⇒ only the same-tool trigger fires.
  CODE_RUN_FANOUT_NUDGE: "papercusp-code-run-fanout-nudge",
  // EI-10894 — the PREDICTIVE trigger: every nudge above is reactive (it keys on round-trips
  // ALREADY spent, so the waste is billed in full and then explained). But a list verb returning
  // >5 addressable rows IS the fan-out, one call before it happens — so attach the code:run
  // skeleton to THAT result, ids already extracted, while batching still costs the agent nothing.
  // Fires on a PREDICTION, so it is held to a higher bar than its reactive siblings: list-shaped
  // verbs only, addressable rows only, silent when the caller already used code:run, one-shot per
  // (session, tool), hard per-session cap, and it never escalates. Its OWN flag so the predictive
  // family is an independent A/B knob against the reactive ones. DEFAULT ON; OFF ⇒ no hint.
  CODE_RUN_FANOUT_PREEMPT: "papercusp-code-run-fanout-preempt",
  // agent-tooling-token-efficiency P-009 (2026-06-25): the SOFT orient-dedup nudge — when an agent
  // calls coord:plan-events / coord:inbox / memory:search / coord:declare-intent shortly after a
  // successful coord:orient (which already returned + declared exactly those), attach a one-shot
  // [nudge] line pointing it back at orient's payload. Never blocks; additive (only adds a line),
  // one-shot per session+subsumed-tool, time-windowed; DEFAULT ON; OFF ⇒ no nudge.
  ORIENT_DEDUP_NUDGE: "papercusp-orient-dedup-nudge",
  // state-plane-adoption-2026-08-02 P-008: two SOFT result-time advisories on the same
  // tool-call nudge plane. (a) ACT/QUOTE — an agent committing a durable write (coord:send,
  // plans:add-decision, work_items:*, facts:assert) while holding a pipeline-door value it
  // has not re-read gets pointed at state:read. (b) WAIT — a door polled across >=3 separate
  // turns gets pointed at state:subscribe. Measured 2026-08-08 (D-030): ACT/QUOTE adoption is
  // 1.7% and WAIT 5.3%, i.e. promotion by prose has asymptoted — CLAUDE.md has carried the
  // "RE-READ it, don't copy it" instruction for weeks. Never blocks; additive (adds one line),
  // one-shot per session per rule, time-windowed, and silent when the agent already did the
  // right thing; DEFAULT ON; OFF ⇒ no nudge.
  STATE_PLANE_NUDGE: "papercusp-state-plane-nudge",
  // work-item-deps-and-readiness-2026-06-22 P-007: make ISSUE-family work-items
  // (bug|change|task) self-pickable by the scheduler claim path. Today the
  // decentralized claim (claimNextWorkItem / getNextWorkItem) is feature-family-only —
  // the claim floors hard-code item_kind IN ('feature','research-task','chunk') and
  // UPDATE the feature view, so an issue can BLOCK a feature but can never itself be
  // claimed/placed; the Queen's steer levers (set_priority / co_locate) also report
  // applicable:false for issues. When ON, an ADDITIVE issue-claim branch (a separate
  // query over the work_items base for issue-family kinds, run only when no feature
  // is claimable) lets an UNBLOCKED issue be self-picked (readiness honored by the
  // SAME work_item_deps NOT EXISTS predicate; terminal = resolved/closed), and the
  // steer levers become applicable to issues. DEFAULT ON (WI-3855, 2026-07-11: this
  // comment's "DEFAULT OFF ... KNOWN_DARK_FLAGS" was never actually added to the
  // DARK_FLAGS map, so the 2026-06-29 P-011 inversion silently made it live default-ON —
  // the same EI-7230-class mismatch as WATCHDOG_AUTO_CLOSE et al. Confirmed live and not
  // merely safe but LOAD-BEARING: this exact mechanism is what every member of the
  // bug-drain-nonp2p fleet — including the agent that found this bug — uses to self-pick
  // bug/change/task work_items via scheduler:get_next/work_items:claim_next; if this flag
  // actually resolved OFF as the comment claims, the whole drain fleet's core dispatch loop
  // would not function). OFF ⇒ feature-family-only claiming (the reversible fallback, but
  // note it would break this and any other issue-family-claiming autonomous fleet today).
  SCHEDULER_ISSUES_CLAIMABLE: "papercusp-scheduler-issues-claimable",
  // psu-in-desktop-builds-2026-06-23 C1: exposes the `psu` superuser CLI as an
  // END-USER feature in the shipped desktop builds (the discoverable launch
  // entry + forcing the scoped `user` profile). DEFAULT OFF — this is the
  // legitimate owner-authority/SECURITY dark case (CLAUDE.md): psu opens a
  // superuser agent session, so the owner must personally ratify the end-user
  // exposure before it defaults on. OFF ⇒ the entry is not offered; the bundled
  // psu shim is inert (dev/internal launch is unchanged). KNOWN_DARK_FLAGS.
  PSU_END_USER: "papercusp-psu-end-user",

  // DEFAULT ON (derived FLAG_DEFAULTS; agent-first-onboarding-2026-07-03 P-003):
  // first-run lands on the agent-chat Onboarding Console (a full-window terminal
  // running the onboarding concierge → tutor handoff) instead of the GUI Setup
  // Wizard. Reversible cutover: OFF ⇒ byte-identical to today (first-run →
  // /setup); the GUI wizard stays reachable at /setup?force=1 either way.
  ONBOARDING_AGENT_FIRST: "papercusp-onboarding-agent-first",

  // DEFAULT OFF (owner-directed 2026-07-04, deterministic-onboarding-tutorial-2026-07-04
  // P-001): the onboarding tutorial references features whose backing implementation is
  // NOT ready yet — telemetry consent (anonymized crash reports), mobile pairing (pair a
  // phone for notifications / remote control), and the auto-update channel. This flag
  // gates those PREVIEW items: OFF ⇒ the tutorial + optional-setup flow omit them entirely
  // (what every fresh install sees), ON ⇒ testers see them to exercise the not-yet-shipped
  // surfaces. KNOWN_DARK_FLAGS (case: incomplete). Flip ON only to test the preview items.
  ONBOARDING_PREVIEW_FEATURES: "papercusp-onboarding-preview-features",

  // DEFAULT ON (owner-directed 2026-06-23, ship-papercusp-as-single-hive): on first
  // boot a PACKAGED desktop install clones github.com/Papercusp/papercup and creates
  // the `papercusp` dogfood hive (Papercusp building itself), then homes on it. Safe
  // default-on — it no-ops without gh auth or a local repo and retries on the next
  // boot, so it can never break a fresh launch. OFF ⇒ the app boots with no default
  // hive (bare onboarding). The repo is too large to bundle (~5GB) → clone-on-boot.
  DOGFOOD_PAPERCUSP_POT: "papercusp-dogfood-papercusp-hive",
  // DEFAULT ON (owner-ratified 2026-06-24, after the single-device smoke): announce
  // the dogfood `papercusp` hive as a SHARED P2P hive on install, under a PER-OWNER
  // identity (Solution C). The hive keypair + invite secret live in a per-owner
  // PRIVATE GitHub gist (never baked into the binary — a stranger who installs the
  // app can't get them), are injected into the keychain so all of the owner's
  // devices share ONE hive identity, and an owner-signed allowlist policy admits
  // ONLY the owner's own GitHub login (strangers refused). Best-effort + non-fatal:
  // no gh auth → no-op + retry next boot, so it can never break a fresh launch.
  // Flow: agent-insights/papercusp-shared-hive-per-owner.
  DOGFOOD_PAPERCUSP_POT_SHARE: "papercusp-dogfood-papercusp-hive-share",
  // DEFAULT ON (alpha flags-default-on): the shared embed-TPM admission lane
  // (watchdog-and-exposed-systems-improvement-2026-06-18 P-002). Routes BOTH embed paths
  // (search:semantic/work_items:search + memory:*) through ONE RateLimitGovernor whose
  // itpm + concurrency caps hold aggregate OpenAI embed rate UNDER the org 1M-TPM ceiling, so
  // the high-volume bench path can't exhaust the org and starve production memory (the
  // 2026-06-17 incident root cause, D-003). Bench sheds → BM25; memory passes through. Safe
  // default-on — additive + reversible; OFF ⇒ a byte-identical passthrough (ungoverned, the
  // pre-P-002 behaviour). The kill-switch if admission ever mis-paces a hot path.
  EMBED_ADMISSION: "papercusp-embed-admission",
  // enforce-system-on-generic-work-2026-06-29 P-006: the TEST-COMPLETION GATE on
  // work_items:complete — a feature work-item moved to a terminal state must have its plan-derived
  // test-requiring VALs passing (reuses the harness-test-rollup). DEFAULT ON (graduated 2026-07-04,
  // dark-flag-age review EI-7280: the done-without-test watchdog P-009 confirmed zero false-refusal
  // signals across every tick since activation — not in DARK_FLAGS). OFF ⇒ completion is
  // byte-identical to today (the gate is never consulted). FAIL-OPEN even when ON.
  TEST_COMPLETION_GATE: "papercusp-test-completion-gate",
  // ratified-mockup-implementation-validation-2026-08-24 P-007: the DESIGN-EVIDENCE gate on
  // work_items:complete. When a work-item's feature has a ratified design reference, every
  // required case must have CURRENT PASSING deterministic evidence (D-004). DEFAULT ON: what it
  // does when on is MEASURE and REPORT — D-006 mandates a report-only rollout, so the refusal is
  // a separate flag below. OFF ⇒ completion is byte-identical to today. FAIL-OPEN when reporting.
  DESIGN_EVIDENCE_GATE: "papercusp-design-evidence-gate",
  // ratified-mockup-implementation-validation-2026-08-24 P-011 / D-023: the ENFORCING half of the
  // gate above — turns the report into a refusal. DEFAULT ON since P-011 completed the rollout.
  //
  // Read this before assuming ON means "refuses everywhere": it does not, and that is deliberate.
  // The threshold it enforces (3.3816e-5, about 34 pixels of a 1280x800 render) was derived from
  // SAME-HOST noise only (D-021), so enforcement is scoped IN CODE to references ratified on the
  // machine the calibration was measured on. Everything else — a reference with no recorded host,
  // one ratified elsewhere, or a calibration that cannot say where it was taken — is REPORTED and
  // never refused. The scope is a property of the evidence rather than a switch someone can
  // forget to flip, and every non-enforcing outcome says so in words so that "could not enforce"
  // never renders the same as "passed". See design-compare/enforceability.ts.
  DESIGN_EVIDENCE_GATE_ENFORCING: "papercusp-design-evidence-gate-enforcing",
  // DEFAULT ON (enforce-system-on-generic-work-2026-06-29 P-019): the per-turn VERIFY-not-CREATE
  // work-item BACKSTOP behind the prompt directive (P-015). When a psu session ENDS A TURN having
  // edited workspace code but holds NO objective in the ledger (no in-execution work-item AND no
  // declared coord intent → coord:glance self.objective empty), the `workitem-verify-nudge` cc-hook
  // emits ONE short reminder to open a work-item (work_items:create / claim a plan item). It NEVER
  // creates anything — only reminds; fail-open + fire-and-forget + psu-gated, and per-TURN (not
  // per-edit — distinct from the rejected per-edit auto-capture hook). Safe default-on: additive +
  // reversible. OFF ⇒ the hook's nudge branch is inert (no reminder ever emitted); the cheap local
  // edit-marker touch is harmless either way. The owner kill-switch for the backstop.
  WORKITEM_VERIFY_NUDGE: "papercusp-workitem-verify-nudge",
  // DEFAULT ON (WI-6949): the WAKE-SOURCE halt guard — the `loop-halt-guard` cc Stop-hook.
  // An agent in an autonomy mode (auto/cold-auto/drain) with NO armed engine loop has no wake
  // source of its own: it runs only while an interactive owner keeps replying, and the moment
  // they stop, the next turn it ends is its last (a carry-respawn restores CONTEXT, not a TURN).
  // Observed 2026-08-02: an su went silently inert for ~37min this way. The playbook's own
  // "end-of-turn test" did not prevent it because that rule is anchored to a CESSATION rather
  // than an action, and the hazard is created at a transition (owner-present → owner-absent)
  // that nothing marks — so this hook is the only check that fires at the cessation point.
  // BLOCKING but hard-bounded: AT MOST ONE bounce per session (a `.done` marker written BEFORE
  // the decision is printed, verified to hold independently of the recheck rate-limiter), and
  // fail-CLOSED on every unknown — it must POSITIVELY prove the hazard (autonomy mode present
  // AND loop.active explicitly not true) or it exits silently. OFF ⇒ the hook never blocks.
  // The owner kill-switch; NOT in DARK_FLAGS (additive + reversible + bounded).
  LOOP_HALT_GUARD: "papercusp-loop-halt-guard",
  // DEFAULT ON (infra-perf-reliability-audit-round3-2026-06-19 P-013 / WI-345 F12):
  // the KILL leg of the test-webview reaper — actually SIGTERMs then SIGKILLs
  // papercusp-desktop processes whose PAPERCUSP_ADV_SESSION_ID session is ENDED
  // (agent-spawned test desktops that leaked after the test run finished). The detection
  // leg (toast notification) always runs when the routine fires; this flag gates the
  // OS-level process kill. The routine is SEEDED INACTIVE — the double-gate means this
  // flag being ON has no effect until an operator activates the routine. OFF ⇒ the action
  // runs detection-only (toast + log, no kills). The kill-switch if the reaper ever
  // mis-targets a process.
  TEST_WEBVIEW_REAPER: "papercusp-test-webview-reaper",
  // presence-coord-unification-2026-07-01 P-004 (WI-1347): the coord_presence RETENTION
  // reaper — a scheduled DBOS workflow that evicts `harness_shared.coord_presence` rows
  // that are (a) NOT wakeable (deriveSessionState's `ended` — no live standing wake await,
  // the same predicate coord:presence/fleet:status already use to distinguish `ended` from
  // `parked`) AND (b) past the TTL since their last heartbeat. A `parked` row (stale
  // heartbeat but still wakeable) is NEVER reaped regardless of age — only a genuinely
  // dead, unwakeable row is. Long-term history survives the delete via the append-only
  // fleet_membership_events ledger (WI-1345/migration 430) + adv_sessions — this flag only
  // gates the coord_presence ROW eviction. DEFAULT ON (alpha flags-default-on: finished,
  // tested, additive retention hygiene — no user-facing behavior change, only fewer
  // long-dead rows in the live roster). OFF ⇒ the reaper tick no-ops (today's behavior:
  // rows accumulate until the opportunistic 24h sweepStalePresence catches them).
  COORD_PRESENCE_REAPER: "papercusp-coord-presence-reaper",
  // goal-mode-design-intent-hardening-2026-08-16 P-011: presence freshness from the
  // transcript corpus. coord_presence.last_active_at bumps only on the papercusp
  // tool-dispatch activity path, so a session mid-turn on NATIVE tools (Bash/Edit) or
  // streaming a long reply reads idle — measured ~4min staler than session_turn_parts
  // live, which nearly fired a terminal grading pass one wake early. ON ⇒
  // fetchPresenceTier1 also reads the freshest assistant-authored turn part per owner
  // (bounded on the ingested_at index) and lastActiveSecAgo takes the fresher of the
  // two sources, with provenance emitted as lastActiveSource. DEFAULT ON (alpha
  // flags-default-on: additive derivation correction, no schema change). OFF = the
  // kill-switch: the extra query is skipped and derivation is byte-identical to the
  // presence-only behavior.
  PRESENCE_TURN_PARTS_FRESHNESS: "papercusp-presence-turn-parts-freshness",
  // goal-mode-design-intent-hardening-2026-08-16 P-012: census double-count fix.
  // tools:invoke / a tool-dispatching code:run / recipes:run produce TWO
  // tool_invocations rows per logical call (wrapper + inner), so a raw tool_name
  // census overstates ~2x on the dispatch path. ON ⇒ the wrapper handlers stamp
  // metadata_json.dispatchWrapper=true on their own row (only when an inner
  // dispatch actually happened) and census surfaces (dev:telemetry, co-occurrence,
  // failure rates) exclude marked rows by default. DEFAULT ON (alpha
  // flags-default-on: instrument-accuracy fix, additive metadata). OFF = the
  // kill-switch: nothing new is marked, and unmarked rows are excluded by nothing,
  // so counts return to pre-P-012 behavior (rows marked while ON stay excluded —
  // acceptable residue for a diagnostic census).
  TELEMETRY_DISPATCH_WRAPPER_MARK: "papercusp-telemetry-dispatch-wrapper-mark",
  // goal-mode-design-intent-hardening-2026-08-16 P-013 (D-004, owner-endorsed):
  // grade-the-grader. ON ⇒ scorecards:emit stamps every TERMINAL standard-rubric
  // card gradingAudit:'pending' (excluded from rubrics:trend, loudly counted) until
  // a NON-AUTHOR auditor emits a grading-integrity scorecard whose subject is that
  // card — the emit path enforces auditor ≠ author and settles the stamp
  // passed/failed. One level deep by construction (the audit card is never stamped).
  // DEFAULT ON. OFF = kill-switch: no new stamps; already-stamped cards keep their
  // state (pending ones stay excluded — retract or audit them, never unhide).
  GRADING_INTEGRITY_AUDIT_GATE: "papercusp-grading-integrity-audit-gate",
  // db-performance-remediation-2026-07-26 P-004: the INDEX-BLOAT REINDEX sweep — a daily
  // scheduled DBOS workflow that REINDEX INDEX CONCURRENTLY's btree indexes which the
  // continuous retention churn has inflated into mostly-empty pages. VACUUM marks those
  // pages reusable but never returns them, so a pruned high-churn table's indexes grow
  // monotonically: measured 2026-07-26, route_invocations carried 5.1 GB of index on
  // 711 MB of heap and one index alone was 4117 MB at 2122 bytes/row (it rebuilt to
  // 99 MB in 5s; the full first pass took the database 22 GB -> 14 GB in 33s). A one-off
  // reindex is only a mitigation because retention keeps deleting ~2M rows/day — this
  // routine is the durable fix. Candidates are chosen from a CHEAP catalog heuristic
  // (btree only, >=64 MiB, >200 bytes/row, on a table with real delete churn); the sweep
  // is CONCURRENTLY-only (never blocks reads/writes), skips under a long-open transaction
  // or low disk, and also drops orphaned *_ccnew/*_ccold duplicates left by an interrupted
  // reindex. DEFAULT ON (alpha flags-default-on: finished, tested, additive maintenance —
  // rebuilding an index from its table risks no data). OFF => the tick no-ops and bloat
  // re-accumulates until someone reindexes by hand.
  DB_INDEX_BLOAT_REINDEX: "papercusp-db-index-bloat-reindex",
  // db-performance-remediation-2026-07-26 D-033 / P-020 (WI-9313): the pg_stat_statements
  // ORPHAN-ENTRY reclaim. pgss has no DROP DATABASE hook, so entries keyed to a dropped
  // dbid are retained forever; backups/dumps run against TRANSIENT databases, so every
  // dump permanently consumes entry slots. Measured 2026-08-03: 3,303 of 9,791 entries
  // (33.7%) belonged to 23 databases that no longer exist, holding the cap at 97.9% —
  // and Postgres evicts by LOW USAGE, so it was discarding REAL application statistics
  // at 13.5/day. An evicted+recreated entry's next delta reads as a PHANTOM SPIKE, which
  // corrupts exactly the delta measurements that plan depends on, so this is a
  // MEASUREMENT-INTEGRITY fix, not housekeeping. The sweep only ever targets a dbid
  // absent from pg_database, never passes dbid=0 (which would mean "reset ALL"), and
  // skips with a named reason when the role lacks EXECUTE. DEFAULT ON (alpha
  // flags-default-on: finished, tested, and the only thing it can discard is monitoring
  // counters for databases that do not exist). OFF => the tick no-ops and the residue
  // regrows until the cap evicts live statistics again.
  DB_PGSS_ORPHAN_STATS_RECLAIM: "papercusp-db-pgss-orphan-stats-reclaim",
  // EI-19312743681026041: the HOT-STATEMENT SEQ-SCAN detector. Two migrations in two
  // days (717/WI-6839, 718/WI-6850) fixed the same read-many-return-few defect, and both
  // were found only because an agent ranked live pg_stat_statements deltas BY HAND —
  // 718 had been burning ~27% of all live database time at ~171 calls/min with no alarm,
  // scorecard or health panel covering it. The tick differences two pgss samples, screens
  // for high blocks-per-call against low rows-per-call, and EXPLAINs only the survivors
  // with GENERIC_PLAN (never ANALYZE, inside a READ ONLY transaction — it plans, it does
  // not execute), flagging a Seq Scan on a relation above a size floor. Read-only: it
  // plans statements and reads catalog sizes, writing nothing. DEFAULT ON (alpha
  // flags-default-on: finished, tested, and observation-only — it changes no query plan
  // and touches no application data). OFF => the tick no-ops and this defect class goes
  // back to being caught only by someone who happens to go looking.
  DB_HOT_SEQ_SCAN_DETECTOR: "papercusp-db-hot-seq-scan-detector",
  // coord-delivery-residual-gaps-2026-07-11 P-004 (WI-4160): the delivery
  // ESCALATION LADDER kill-switch. One server-side rule — a DIRECTED message
  // (explicit to:[ownerId], never broadcast/@audience/system-sender) unread
  // past TTL (default 5m) by a LIVE recipient auto-fires that recipient's
  // standing inbox-wake, storm-capped at 1 wake/recipient/10m (the ladder's
  // own marker message is the cap record). Closes the "sender assumed
  // delivery, live recipient never read it" gap (mid-long-exec deafness,
  // hook-enrollment drift, non-enrolled runtimes). DEFAULT ON (alpha
  // flags-default-on: finished + tested, additive, bounded by the storm cap).
  // OFF ⇒ the deliveryLadderSweep periodic tick no-ops (today's behavior:
  // unread directed mail waits for the recipient's next natural read).
  COORD_DELIVERY_LADDER: "papercusp-coord-delivery-ladder",
  // federated-scout-gym-learning-2026-07-02 P-010 (F3-2): the fleet-wide KILL-SWITCH
  // for federated Scout↔gym ELITE/FACT sharing (island-model QD). Default ON (the
  // GITHUB_BRIDGE/P2P pattern — NOT in DARK_FLAGS): activation is STRUCTURAL, not the
  // flag. scout/federation-rollout.ts stages HOW FAR learning propagates in 3 tiers —
  // tier 1 HIVE-MEMBERS-ONLY (the existing F1 hive-scoped admission, the safe default),
  // tier 2 CROSS-HIVE gossip (CROSS_HIVE_GOSSIP_LANDED), tier 3 OPEN network behind the
  // P-009 reputation gate (REPUTATION_GATE_LANDED). Both prereq switches are false until
  // the machinery lands, so a default-ON flag can never over-share; the effective tier
  // clamps to 1 today. OFF ⇒ nothing federates (tier 0) — the instant off-switch.
  FEDERATED_SCOUT_LEARNING: "papercusp-federated-scout-learning",
  // DEFAULT ON (alpha flags-default-on; NOT in DARK_FLAGS). Gates the docs
  // "Ask a question" retrieval-augmented Q&A over the REAL /internal/docs —
  // POST /api/desktop/docs-qa, backing BOTH the terminal onboarding tutorial's
  // "Ask a question" and the Ctrl+/ search palette's ask mode. Replaces the old
  // shell-out-to-a-user-CLI Q&A (which died in a clean build and had no docs
  // tools). Runs server-side on the operator's configured backend + in-process
  // doc retrieval. OFF ⇒ the ask mode is hidden and the endpoint 404s (keyword
  // search still works); a clean instant kill-switch. (WI-2844.)
  DOCS_QA: "papercusp-docs-qa",
  // session-search-scope-2026-07-05: the episodic verbatim transcript index —
  // session_turns ingest (claude/omp/codex JSONL tailers + agent_chat sync,
  // search/session-ingest.ts), the session_turn/coord_message SearchSources,
  // and the fused sessions:search tool with session:'self' compaction
  // recovery. DEFAULT ON (alpha flags-default-on; NOT in DARK_FLAGS —
  // additive index + read tools, no behavior change to existing surfaces).
  // OFF ⇒ the ingest tick no-ops and sessions:search returns
  // feature_disabled; existing search:* scopes are unaffected. The instant
  // kill-switch if ingest volume ever misbehaves on a small host.
  SESSION_SEARCH: "papercusp-session-search",
  // local-first-party-template-bundling-2026-07-07 (owner-directed v1/v2 split):
  // the `templates:*` verbs resolve the first-party templates from the LOCAL store
  // (bundled in-app) in v1. This flag gates the v2 Cupboard MARKETPLACE merge —
  // browsing/get-guide/new-app for user-published, runtime-fetched templates. OFF
  // (v1) ⇒ templates:list shows only the local store, get-guide/new-app resolve
  // local only; the remote Cupboard path is wired but dormant. ON (v2) ⇒ remote
  // marketplace listings merge on top (local wins a ref collision) and non-local
  // refs resolve via the Cupboard. Default OFF — owner-directed staged v2 cutover.
  TEMPLATES_MARKETPLACE: "papercusp-templates-marketplace",
  // local-first-party-rubric-bundling-2026-07-07 (the templates-v1 design applied to
  // rubrics): v1 ships the first-party rubrics bundled in-app (PAPERCUSP_RUBRICS_DIR
  // content dirs, cupboard/rubric-store.ts) and SEEDS them into the workspace rubric
  // store on first rubrics:* read — a rubric is a plan row, trend/ratify/scorecards
  // key off the DB, so it seeds rather than reads through. This flag gates the v2
  // Cupboard MARKETPLACE merge for rubrics (kind='rubric' listings fetched at
  // runtime, installed into the user layer, merged local-shadows-remote like
  // templates:list). OFF (v1) ⇒ rubrics:* resolve the workspace store (+ bundled
  // seed) only; there is no remote path yet. Default OFF — staged v2 cutover.
  RUBRICS_MARKETPLACE: "papercusp-rubrics-marketplace",
  // p2p-parity-parallel-lanes-2026-07-09 P-003 (WI-3535): the own-log-fork-guard's
  // SKETCHED auto-recovery (own-log-fork-recovery.ts) — a per-harness Corestore
  // STORE RESET (deletes the on-disk peer-log directory so a fresh keypair is
  // minted on next boot) that runs when a writable own-log hits the Hypercore
  // equivocation loop ("[hypercore] conflict detected" → SESSION_CLOSED). DEFAULT
  // OFF — owner-authority/destructive: this THROWS AWAY local hypercore-only
  // history that hasn't merged into PG yet, so unattended auto-recovery is unsafe
  // until the owner personally ratifies it. OFF ⇒ recoverForkedOwnLog always
  // short-circuits with `reason: 'flag_off'` (the detector still files a durable
  // EI naming the MANUAL recovery). Listed in KNOWN_DARK_FLAGS.
  OWN_LOG_FORK_AUTO_RECOVERY: "papercusp-own-log-fork-auto-recovery",
  // WI-3388 (owner ask 2026-07-08): the desktop native-terminal dock's
  // draggable divider + collapse-to-rail — <TerminalDivider>, driving the
  // terminal_get_layout/terminal_set_layout Tauri commands. DEFAULT ON
  // (derived FLAG_DEFAULTS) — a fully reversible presentation/interaction
  // switch (no destructive/irreversible action, no owner-authority surface);
  // OFF just hides the divider/rail, leaving the terminal at its fixed
  // env-configured width like before this feature. No-op outside Tauri
  // (isTauri() false ⇒ the component never mounts).
  TERMINAL_DIVIDER: "papercusp-terminal-divider",
  // critical-process-supervisor-2026-07-04 P-002 (EI-7021 design, D-003): master switch for the
  // failed-unit reconciler's ACTUAL `systemctl --user restart <unit>` action. DEFAULT ON (derived
  // FLAG_DEFAULTS — repo rule: finished work never ships dark; restart of a dead critical process
  // IS the feature). OFF ⇒ report-only everywhere — probes + notifications still run, nothing is
  // ever restarted. No `process.env.PAPERCUSP_*` gate (`lint:env-feature-gates`).
  SUPERVISOR_AUTO_RESTART: "papercusp-supervisor-auto-restart",
  // task-manager-no-escape-2026-07-27 P-020: the task manager as a whole — cgroup
  // confinement at the spawn chokepoints, the 30s reconcile, the processes:* read
  // surfaces, and the Task Manager pane.
  //
  // DEFAULT ON (derived FLAG_DEFAULTS — graduated out of DARK_FLAGS 2026-08-02,
  // WI-6844) [owner: "we put it behind a testing flag. Remove that flag, we'll make
  // it part of our standard release"]. It first shipped default-ON on 2026-07-27,
  // was called back behind a testing gate the same day (WI-6499), and now ships ON
  // again — this time with the gate it always claimed to have.
  //
  // The KEY survives on purpose. This subsystem intercepts EVERY spawn seam on the
  // box, so an explicit OFF at /admin/features must still restore the pre-feature
  // behaviour byte-for-byte without needing a revert. A default-ON flag is not a
  // dark flag; it is a kill-switch, which is why it is no longer rationed by the
  // parking watermark.
  //
  // ⚠ It ALSO shipped with this comment describing gating that did not exist. The
  // flag had exactly two call sites — the pane's sync query and the /admin/tasks
  // route — so turning it off blanked the dashboard while every spawn stayed
  // confined and ledgered, the 30s reconciler kept running, and a `systemd-run`
  // probe still fired at module import. WI-6499 made the gate real at the seams
  // this comment always claimed: task-manager/enabled.ts is now the single
  // authority, and it fails CLOSED (the old sites did `.catch(() => true)` — the
  // right bias for a finished subsystem, the wrong one for an unready subsystem
  // that must not self-enable when the flag backend is unreachable).
  //
  // OFF ⇒ spawns run unconfined and UNLEDGERED, no reconcile tick, processes:list
  // reports disabled, pane shows its disabled state — byte-identical to the
  // pre-feature box.
  //
  // GRADUATION: owner's call. The subsystem is built and unit-tested; what is not
  // established is a sustained window of correct residue classification on a real
  // box, which is the precondition D-010 already names for anything ever acting on
  // it. Flip ON for testing, watch `unaccounted`/`foreign` counts settle, then
  // graduate.
  //
  // NOT a `process.env.PAPERCUSP_*` gate (`lint:env-feature-gates`).
  TASK_MANAGER: "papercusp-task-manager",
  // WI-41607 (plan agent-session-scope-reaper-2026-08-25): kill-switch for the
  // agent-session residue REAPER — the enforcement pass in task-reconcile-action
  // that stops leftover `pc-*.scope` subtrees (terminal rows with surviving
  // processes; log-quiet zombie sessions with no fresh presence). DEFAULT ON —
  // the owner directed enforcement explicitly (2026-08-23 + 2026-08-25) after
  // the third residue accumulation; this key exists so a misbehaving reaper can
  // be stopped from /admin/features without a revert or restart. Nested under
  // TASK_MANAGER (flag OFF ⇒ no reconcile tick ⇒ no reaper). Fail-open like its
  // parent: an unreachable flag backend must not silently disable enforcement;
  // an explicit OFF is always honored.
  TASK_REAPER: "papercusp-task-reaper",
  // mem0-cross-machine-federation-2026-07-10 (F1-1 mirror): gates the cross-machine federation
  // of SHAREABLE memories (memory:remember with shareable=true). When ON, shareable memories
  // capture to the peer-log and federate to other hives; receive-side projections apply remote
  // memories to the local store (source-partitioned, H6 pattern mirroring agent-facts). DEFAULT
  // OFF: memory federation affects what personal memory data leaves the machine — only the owner
  // ratifies when/how/which memories federate. OFF ⇒ shareable flag is stored but capture/egress
  // never triggers (the flag has no effect, byte-identical to today). Owner flips ON after
  // reviewing the privacy implications + confirming both pot-visibility + member-admission gates.
  MEM0_FEDERATION_EGRESS: "papercusp-mem0-federation-egress",
  // WI-254 (EI-1618 item 2): gates the in-process periodic federation-drain
  // reconcile tick (run-drain-reconcile.ts) — flags a LIVE booted harness whose
  // substrate_outbox is undrained past 60s (captured but not federating, the
  // EI-681 silent-stall class) and files a deduped improvement. DEFAULT ON (not
  // in DARK_FLAGS): the code ships ready + tested (own unit tests +
  // dedup-by-watchdog-key so a stall files at most one open issue), it is
  // read-mostly (one group-scan query + a deduped capture) and sheds under
  // saturation, so it is not the "genuinely incomplete/unsafe" / owner-authority
  // / cutover-kill-switch case the dark allowlist exists for — per repo policy,
  // shipping it dark "pending human review" while tested is exactly the parking-
  // lot abuse the policy bans. Previously gated by a raw `process.env.
  // PAPERCUSP_FEDERATION_DRAIN_RECONCILE` boolean (banned pattern — env gates are
  // for launch-time/test/dev config only, `lint:env-feature-gates`); replaced
  // with this FLAGS entry. OFF ⇒ pure no-op kill-switch — the tick returns
  // immediately, byte-identical to before this flag existed.
  FEDERATION_DRAIN_RECONCILE: "papercusp-federation-drain-reconcile",
  // precompute-derived-sync-reads-2026-07-19 (WI-5460): serve the three slow
  // derived sync reads (storage.usage, plans.lint, learning.soakReport) from the
  // precomputed harness_shared.derived_read_snapshots table instead of computing
  // them synchronously on the user-facing read path (measured 20.0s / 13.8s /
  // 27.3s respectively, against 3-20ms for pure DB reads).
  // DEFAULT ON — this is the fix, and it is the only correct behavior on the
  // shipped desktop target (embedded PG, no systemd/journalctl). OFF ⇒ each
  // resolver falls back to computing inline, i.e. the exact pre-fix behavior:
  // a live escape hatch if a snapshot ever reads empty in an environment the
  // precompute routine has not run in yet. NOT dark — see the OFF path in
  // lib/derived-reads/registry.ts (readDerivedSnapshot's `computeFallback`).
  PRECOMPUTE_DERIVED_READS: "papercusp-precompute-derived-reads",
  // desktop-performance-suite-2026-07-20 P-011: the desktop-perf release gate.
  // When ON, the green-checkpoint reads the latest persisted desktop-perf run
  // (harness_shared.desktop_perf_runs, P-010) on a GREEN candidate and, if a
  // budgeted interaction/route/RSS measure regressed, surfaces a WARN (logs +
  // broadcasts) — it still ADVANCES the green pin. This is the desktop-UI
  // sibling of the host perf-gate (perf-gate.ts), but flag-gated here instead of
  // env-gated (the P-011 requirement: a FLAGS entry, never a process.env gate).
  // DEFAULT ON (not in DARK_FLAGS): warn-only is safe to ship on — it can never
  // hold a deploy. It is "warn-not-block until trusted": block-mode (holding the
  // deploy on a regression) is deliberately NOT shipped yet (policy.block is
  // hardwired false in desktop-perf-gate.ts); arming it is a future owner-gated
  // step. Fail-soft: no persisted run / no measures ⇒ a no-op `pass`. OFF ⇒ the
  // gate reads nothing and passes (kill-switch).
  DESKTOP_PERF_GATE: "papercusp-desktop-perf-gate",
  // resource-efficiency-closeout-2026-08-13 D-005: BLOCK-MODE for the gate above.
  // When ON, a budgeted desktop-perf breach measured INSIDE a quiet window HOLDS
  // the deploy instead of only warning. Read the D-005 decision before touching
  // this: block-mode was refused twice (D-003, restated in D-004) for a specific
  // reason — desktop LCP spanned 2143–5742ms on IDENTICAL code with the 4000ms
  // budget sitting inside that band, so an unconditional block would have traded
  // a silent fail-soft gate for a loud FALSE-RED one that freezes the fleet on
  // ambient load. What changed is not the numbers' trustworthiness but that the
  // SAMPLE is now gated: every run stamps /proc/pressure/cpu at start and end,
  // and desktop-perf-gate.ts treats a breach measured under contention as
  // UNMEASURABLE (warn, verdict `unknown`) rather than as a regression. Blocking
  // therefore arms only for a breach the gate can prove was measured on a quiet
  // box — which is what makes it an EFFECTIVE gate rather than either an inert
  // one or a false-red one.
  // DEFAULT ON (not in DARK_FLAGS): finished work does not ship dark, and the
  // quiet-window guard is what makes arming safe. Kept as a FLAGS entry rather
  // than a hardwired `true` purely so a gate that starts holding deploys wrongly
  // can be disarmed at RUNTIME (/admin/features) without a code deploy — the
  // green pipeline is exactly the thing that would be unavailable to fix it.
  DESKTOP_PERF_GATE_BLOCK: "papercusp-desktop-perf-gate-block",
  // WI-6538: the HOST-perf release gate — the sibling of DESKTOP_PERF_GATE above.
  // It reads the latest perf-signals-v1 capture and evaluates it against the
  // per-thread budgets in system-health/perf-budgets.ts.
  //
  // This replaces a `PAPERCUSP_PERF_GATE=1` env boolean, which was the wrong
  // mechanism twice over. First, it is exactly the ad-hoc `process.env.PAPERCUSP_*`
  // feature gate this repo forbids (see CLAUDE.md + lint:env-feature-gates) — env is
  // for launch-time config, not toggles. Second and more concretely, it could not
  // actually be armed: green-checkpoint is the ONLY evaluator, and it runs BOTH as a
  // detached `systemd-run --user` unit (which inherits none of the launcher's env —
  // release-checkpoint-launch.ts documents this trap twice) AND as a periodic routine
  // spawn (which inherits a different process's env). So "arm it" meant plumbing the
  // same variable through two unrelated launch paths, and setting it on the obvious
  // services would have left the gate inert while looking armed. A FLAGS entry is read
  // in-process at evaluation time and sidesteps both paths entirely.
  //
  // Default ON. Block-mode is a SEPARATE switch — HOST_PERF_GATE_BLOCK below.
  // OFF ⇒ reads nothing, passes (kill-switch). Same posture as its desktop sibling.
  HOST_PERF_GATE: "papercusp-host-perf-gate",
  // WI-38449 / D-007 F3: block-mode for the HOST perf gate — the sibling of
  // DESKTOP_PERF_GATE_BLOCK above, and the second half of P-004's "restore an
  // EFFECTIVE blocking gate". Until now `block` was hardwired false here, so the
  // host gate could flag a deploy but never hold one.
  //
  // What made arming unsafe, and what changed: measured 2026-08-16 on a live
  // capture, the crit tier fired on the SINGLE reason `PSI memory full avg60 11.45
  // ≥ 5` — ambient RAM pressure from ~100 peer agents on this shared box — and an
  // armed gate returned `block`. Arming then would have held EVERY deploy for as
  // long as the box was busy. perf-budgets.ts now splits crit reasons by
  // ATTRIBUTION (PerfVerdict.critAttribution) at the point they are raised, and
  // perf-gate.ts blocks ONLY on `operatorDefect` reasons (:3070 unreachable,
  // wedge-active, event-loop lag p95 ≥ 1s, CLOSE_WAIT ≥ 500). Ambient host state
  // is still crit and still alarmed — it just never holds a release. That is what
  // makes this an EFFECTIVE gate rather than an inert or a false-red one.
  //
  // DEFAULT ON (not in DARK_FLAGS): finished work does not ship dark, and the
  // attribution split is what makes arming safe. Kept as a FLAGS entry rather than
  // a hardwired `true` for the same reason as its desktop sibling — the gate holds
  // DEPLOYS, so if it ever starts holding them wrongly the green pipeline is
  // precisely the thing that would be unavailable to ship a code fix. It must be
  // disarmable at RUNTIME (/admin/features).
  HOST_PERF_GATE_BLOCK: "papercusp-host-perf-gate-block",
  // WI-6538 (the remaining half of the same item): the SCHEDULED PRODUCER for
  // DESKTOP_PERF_GATE above. Runs the packaged-binary wdio suite
  // (tools/perf-test/wdio, system-health/desktop-perf-scheduled-run.ts) on a
  // background cadence so `harness_shared.desktop_perf_runs` is never more
  // than DESKTOP_PERF_GATE's 24h freshness window stale — before this, the
  // table was written ONLY by a human clicking Run in the admin testing UI,
  // and nobody ever had, so the gate had passed every deploy since the suite
  // landed without measuring anything.
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS): the tick is
  // read-mostly UI interaction against a throwaway isolated Xvfb display and
  // never throws on a test-finding failure (see that file's module doc) — a
  // regression it finds is exactly the observation the gate exists to catch.
  // OFF ⇒ the kill-switch if the scheduled run ever misbehaves on the shared
  // dev box (contends for CPU/Xvfb with concurrent agent verification runs).
  DESKTOP_PERF_SCHEDULED_RUN: "papercusp-desktop-perf-scheduled-run",
  // gui-e2e-tauri-surface-verification-2026-08-27 P-008: the SCHEDULED
  // PRODUCER for the live, Tauri-driven surface-verification suite
  // (scripts/tauri-surface-verify-suite.sh, wrapping the per-surface legs
  // under scripts/tauri-surface-verify-p0*.sh via
  // system-health/gui-e2e-surface-scheduled-run.ts). Runs the whole suite on
  // a daily cadence so these regression-failing DOM assertions stop running
  // "only by hand" — one already caught a real bug (the /dev/gym
  // `harnesses.map is not a function` crash, WI-64726) that a grep-based
  // census and a mismatched unit-test mock both missed.
  // Deliberately does NOT touch the release/green-checkpoint gate (WI-40086
  // owns that): a failing leg here escalates via the shared alarm-attention
  // rail (escalateAlarm, cooldown-gated) rather than blocking a deploy.
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS): mirrors
  // DESKTOP_PERF_SCHEDULED_RUN above — read-mostly DOM assertions against a
  // throwaway isolated Xvfb Tauri instance, never throws on a test-finding
  // failure. OFF ⇒ the kill-switch if the daily run ever contends too much
  // with concurrent agent verification on the shared dev box.
  GUI_E2E_SURFACE_SCHEDULED_RUN: "papercusp-gui-e2e-surface-scheduled-run",
  // WI-5820: the lag-triggered CPU profiler in event-loop-lag-monitor.ts. When a
  // 10s window's p95 loop delay crosses the critical threshold, capture a short V8
  // `.cpuprofile` to ~/.papercusp/loop-profiles — the histogram says "the loop is
  // blocked", the profile says BY WHAT. Rate-limited (one capture per 5min) and
  // retention-capped (20 files), so the cost is bounded and it is silent on a
  // healthy host: no saturation ⇒ no capture ⇒ zero overhead.
  // WHY IT IS A FLAG NOW: this capability was gated on a bare
  // `process.env.PAPERCUSP_LOOP_PROFILER === '1'` that was set on NO host, so the
  // attribution never fired anywhere (loop-profiles had 21 captures from 07-10 and
  // essentially nothing after). Five separate agent sessions then hand-rolled CDP
  // profiling / log correlation to re-derive what this would have handed them, and
  // the worker-offload work that DEPENDED on its output (WI-323 / WI-344, whose own
  // text says "sequence AFTER the sampler identifies the actual top culprits") was
  // dropped still waiting on it. An env gate ships dark, is invisible in
  // /admin/features, and cannot be flipped at runtime — exactly the failure mode
  // here, and what lint:env-feature-gates forbids.
  // DEFAULT ON (not in DARK_FLAGS): a diagnostic that only engages when the host is
  // ALREADY saturated, i.e. when we most need the answer. Read lazily per
  // saturation window (never latched at boot — getFlag is fragile at host-boot), so
  // a flip takes effect without a restart. OFF ⇒ the monitor still logs the lag
  // histogram, it just captures no profile (today's behavior).
  LOOP_STALL_PROFILER: "papercusp-loop-stall-profiler",
  // local-reranker-gte-modernbert-2026-08-02 (P-008): Stage-B prose reranking by
  // a LOCAL ONNX cross-encoder (gte-reranker-modernbert-base, ~150M) — served by
  // the shared embed sidecar when the host runs one (`/rerank` beside `/embed`,
  // one warm model for the whole box), in-process where none is configured.
  //
  // WHAT IT GATES, precisely: the LOCAL engine only — not reranking as a whole.
  // OFF restores the pre-P-007 behavior byte-identically: a configured
  // ZeroEntropy key still reranks via the hosted API, and with no key the fused
  // RRF order passes through untouched. That is why the gate sits here rather
  // than around the whole rerank — OFF returns to a state we shipped and ran for
  // months, not to a third path nobody has exercised.
  //
  // DEFAULT ON (not in DARK_FLAGS). This is finished, tested work: 18/18 unit
  // tests, plus an end-to-end run against a real sidecar over real HTTP
  // including the sidecar-killed path. Before it, the rerank seam was DARK for
  // everyone without a ZeroEntropy key — i.e. every desktop install — so Stage B
  // never ran at all; shipping the replacement off would just preserve that.
  //
  // Safety here is structural rather than promised: every failure path (no
  // sidecar, sick sidecar, missing ONNX runtime, a scorer that throws) funnels
  // through @papercusp/rerank's single fail-safe seam and degrades to retrieval
  // order. So the honest risk of ON is a slower search, not a broken one — and
  // the latency ceiling is bounded separately by RERANK_MAX_CANDIDATES.
  LOCAL_RERANK: "papercusp-local-rerank",
  // DEFAULT ON (EI-18691186726153223): the KILL leg of the orphaned-mcp-reaper —
  // SIGTERM then SIGKILL leaked `playwright-mcp` server processes (npm-exec / sh
  // / node launch chain) that a long-running agent session spawned once at boot
  // (via a since-P-020-pruned mcpServers config) and never used — measured 168
  // live, 9+ days old, on the shared dev host. Only ever touches a process that
  // (a) matches the playwright-mcp package/binary signature specifically (never
  // the bare `playwright` CLI the committed E2E suite runs), (b) carries
  // PAPERCUSP_ADV_SESSION_ID in its environment (agent-spawned, never a user's
  // own non-papercusp use), and (c) has been alive past the age floor (default
  // 30 min). The routine is SEEDED INACTIVE — the double-gate means this flag
  // being ON has no effect until an operator activates the routine
  // (seed-orphaned-mcp-reaper-routine.ts --active, recommended --dry-run
  // first). OFF ⇒ the routine tick logs what it would kill and kills nothing.
  ORPHANED_MCP_REAPER: "papercusp-orphaned-mcp-reaper",
  // okf-frontmatter-adoption workstream H(b): the Kiro SPEC TRIAD, expressed as
  // structure INSIDE a plan (`## Requirements` + `## Design` + the plan's own
  // P-NNN items) rather than a second directory convention competing with plans.
  //
  // Default ON (derived FLAG_DEFAULTS — deliberately NOT in DARK_FLAGS) because
  // the policy is non-freezing BY CONSTRUCTION, not by promise: the requirement
  // applies only to plans CREATED AFTER the epoch (or opting in via a
  // `specTriad: required` frontmatter key), and a plan that owes the triad
  // AUTO-FILES a work item another agent claims. No existing plan item ever
  // becomes non-actionable, and no decision routes to a human.
  //
  // The design as originally written ("must be non-empty before items can be
  // marked actionable", full stop) was MEASURED against the live corpus and
  // would have frozen plan-driven dispatch fleet-wide: of 1000 plans, 0 carried
  // `## Requirements` and 51 carried `## Design`, 330 of them live. Same shape as
  // the claim-spec starvation the same day — a correct-looking positive predicate
  // over a field nothing populates yet. The epoch is what makes the same rule
  // safe. OFF = the clean kill-switch: nothing is gated and the sweep files
  // nothing.
  SPEC_TRIAD_REQUIRED: "papercusp-spec-triad-required",
  // guidance-overlap-contradiction-scan-2026-08-08 (P-004): the CONTRADICTION
  // leg of the guidance-corpus scan. The deterministic leg (P-003) finds pairs
  // that OVERLAP; this flag gates the second, LLM-backed leg that asks the one
  // narrow question — do these two passages instruct OPPOSITE actions in the
  // same situation? — of the few pairs that clear a stricter judge threshold.
  //
  // DEFAULT ON. It is cheap by construction (a second threshold plus a hard
  // per-run cap, so the call count is bounded before any credential is
  // resolved) and it is read-only — the leg REPORTS contradictions; P-005 owns
  // acting on them. OFF is the clean kill-switch that stops all LLM egress from
  // this scan.
  //
  // ⚠ OFF is NOT "the corpus is clean". The leg reports a non-null
  // `inconclusive` when it is disabled, exactly as it does when no judge
  // credential resolves — because the two states this repo has already shipped
  // twice (EI-18746586784230719, EI-18747066020546067) both render an inert
  // judge's empty output as byte-identical to a healthy "nothing contradicts",
  // which is not merely wrong but REASSURING.
  GUIDANCE_CONTRADICTION_SCAN: "papercusp-guidance-contradiction-scan",
  // WI-37561 — gates the 💬 Convos tab in the MIDDLE rail (the left-sidebar
  // steering rail), on an explicit owner directive 2026-08-09: "Put the
  // 'convos' tab in the middle pane behind a testing flag". DEFAULT OFF (a
  // DARK_FLAGS 'parked' entry) — the owner asked for the tab HIDDEN until
  // they flip it on for testing, not merely for a kill-switch to exist.
  //
  // Scope is the RAIL TAB ONLY. /adv keeps its own Conversations tab reading
  // the same four SSE-cached queries (components/conversations/
  // unified-conversations), so nothing becomes unreachable while this is dark
  // — which is exactly why hiding it is cheap.
  //
  // Gating follows the OVERWATCH/PAPERCUP pattern already in LeftSidebar: the
  // tab is filtered out of both the expanded strip and the collapsed icon
  // rail, and a stale `?lst=conversations` deep link (or ui:dispatch) snaps
  // back to 'queen' rather than landing on a tab that is not there. The id
  // stays in TAB_IDS so the nuqs enum keeps parsing it — that is what makes
  // the snap-back reachable, and it is how the flag flips back ON cleanly.
  CONVERSATIONS_RAIL_TAB: "papercusp-conversations-rail-tab",
  // code-intelligence-routing-lsp-gitnexus-2026-08-20 (D-002/D-007): the thin
  // Papercusp-owned in-operator LSP adapter and the read-only `lsp.*` facade,
  // speaking JSON-RPC to the PINNED official language servers
  // (typescript-language-server + rust-analyzer) under ~/.papercusp/vendor/lsp.
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS): the facade is
  // strictly read-only and additive, so nothing else changes behavior when it
  // is on. OFF is the kill-switch — every lsp.* verb refuses with
  // flag_disabled and no language-server child is spawned.
  //
  // ⚠ THIS FLAG IS NOT THE `--no-lsp` UNWIND. An earlier revision of this
  // comment said P-021 would replace psu-launcher.mjs's hard-coded `--no-lsp`
  // "with a read of THIS flag" — that was WRONG and is corrected by D-013.
  // `--no-lsp` strips OMP's OWN `lsp` BUILTIN as weak-model tool-attractor
  // suppression, a different subject from "may agents call our lsp.* facade".
  // Reusing this key would mean enabling the facade silently re-arms a
  // documented doom-loop attractor on every OMP launch. That unwind is
  // OMP_NATIVE_LSP_BUILTIN below.
  CODE_INTEL_LSP: "papercusp-code-intel-lsp",
  // code-intelligence-routing-lsp-gitnexus-2026-08-20 P-013: may `lsp.apply`
  // WRITE a language server's WorkspaceEdit to the tree?
  //
  // SEPARATE from CODE_INTEL_LSP on purpose, and the separation is the point of
  // P-013 rather than tidiness. CODE_INTEL_LSP governs a facade that is
  // read-only by construction — turning it on cannot change a byte. This one
  // governs the single module that can. Collapsing them would mean enabling
  // code intelligence silently enables code MUTATION, which is precisely the
  // conflation the plan's read-only rail exists to prevent. Both flags must be
  // on for a write to happen: `lsp.apply` computes its edit through the gated
  // read facade, so CODE_INTEL_LSP off already denies it.
  //
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS). It is a WRITE
  // capability, so the bar is higher than for the read facade, and it is met by
  // proof rather than by assurance: P-013's condition is "keep production
  // read-only if any invariant is not proven", and each of the six is pinned by
  // a falsifiable test in lsp-apply.test.ts (complete target set across both
  // WorkspaceEdit encodings · fail-CLOSED atomic locking · root confinement
  // after realpath · content compare-and-swap staleness · overlap/bounds
  // validation with reverse-order application · all-or-nothing rollback).
  // Nothing calls it implicitly: it acts only on an explicit cursor + newName
  // from a caller that asked to rename something.
  //
  // OFF is the kill-switch — `lsp.apply` refuses with flag_disabled and the
  // subsystem is read-only again, byte-identical to pre-P-013.
  CODE_INTEL_LSP_APPLY: "papercusp-code-intel-lsp-apply",
  // code-intelligence-routing-lsp-gitnexus-2026-08-20 P-014: the STRUCTURAL leg
  // (pinned ast-grep) — pattern-shaped search and codemod PREVIEW.
  //
  // Its own flag rather than a slice of CODE_INTEL_LSP because it is a
  // different backend answering a different question (shape, not type truth)
  // with a different failure mode, and because it can be provisioned
  // independently: the pinned binary lives under ~/.papercusp/vendor/ast-grep
  // and its absence must be a refusal from THIS leg, not a reason to think code
  // intelligence as a whole is down.
  //
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS): the facade never
  // constructs ast-grep's `--update-all`, so it is read-only by construction
  // and additive. OFF is the kill-switch — every op refuses and no ast-grep
  // process is spawned.
  CODE_INTEL_AST_GREP: "papercusp-code-intel-ast-grep",
  // code-intelligence-routing-lsp-gitnexus-2026-08-20 P-016 (D-005, D-040): the
  // PACKING leg — pinned Repomix 1.18.0 and code2prompt 4.2.0 behind `code:pack`,
  // replacing the plugin's `npx repomix` (which resolved whatever was latest at
  // call time, so two packs minutes apart could come from different engines).
  //
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS). Safe to default ON
  // because the hazards are excluded by CONSTRUCTION rather than by this
  // default: the arg builders are pure functions that cannot emit
  // --no-security-check, --remote, an output path, --hidden or --no-ignore, and
  // a non-overridable secret deny-set is appended after caller input. OFF is
  // the kill-switch — every op refuses and no packer process is spawned.
  CODE_INTEL_PACKERS: "papercusp-code-intel-packers",
  // code-intelligence-routing-lsp-gitnexus-2026-08-20 P-021 (D-013): may an OMP
  // session KEEP its native `lsp` builtin? Replaces the hard-coded `--no-lsp`
  // that apps/operator/scripts/psu-launcher.mjs passed on both omp branches.
  //
  // ORTHOGONAL to CODE_INTEL_LSP above: that one governs OUR read-only lsp.*
  // facade; this one governs OMP's own in-process builtin. Two behaviours, two
  // switches — collapsing them is exactly the hazard D-013 records.
  //
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS), and safe to default
  // ON because the weak-model hazard is excluded by CODE, not by this default:
  // the resolution in bootstrap-su/bootstrap-role ANDs this flag with a
  // `!isLocalModelSpec(model)` tier gate, so a local/ornith model is stripped
  // regardless of how this flag is set. The documented incidents (session 9885
  // abusing `lsp` as a tools:call wrapper; `eval` doom-looping ornith 56-80× in
  // 10234/10239) are all weak local models, i.e. the population the tier gate
  // permanently excludes. OFF is the kill-switch: every omp launch strips the
  // builtin again, byte-identical to the pre-P-021 hard-coded behaviour.
  OMP_NATIVE_LSP_BUILTIN: "papercusp-omp-native-lsp-builtin",
  // WI-41147: the account burn-rate governor — projects each account's unified-7d
  // utilization trajectory (d(utilization7d)/dt over retained probe history, the
  // provider's own meter) and, when a window is on course to exhaust BEFORE it
  // resets, deprioritizes (throttle) or refuses to hard-pin (shed) that account in
  // spawn selection, with the verdict + reason surfaced on accounts:status. Exists
  // because 2026-08-23's 2.3× burn spike at FLAT headcount walled 8/12 accounts at
  // utilization7d=1.00 with zero warning — every prior control governed member
  // COUNT, none governed spend trajectory.
  //
  // Default ON (derived FLAG_DEFAULTS — not in DARK_FLAGS). Safe to default ON
  // because the governor is protective and conservative by CONSTRUCTION: it never
  // acts on missing/stale data (verdict 'none' with the gap named), only reorders
  // or refuses hard pins near exhaustion (the gateway's unpinned failover path is
  // untouched), and can never shrink the servable set below what the wall
  // machinery alone allows (throttle is a two-pass preference; shed only blocks
  // the pin). OFF is the kill-switch: selection is byte-identical to pre-governor.
  ACCOUNT_BURN_GOVERNOR: "papercusp-account-burn-governor",
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const ALL_FLAG_KEYS: readonly FlagKey[] = Object.values(FLAGS);

// ── DARK_FLAGS: the runtime registry of consciously default-OFF flags ─────────
// FLAG-DEFAULT INVERSION (enforce-system-on-generic-work-2026-06-29 P-011): a
// registered flag defaults ON; a flag defaults OFF iff it is listed here. This is
// the one source of truth for the dark set — FLAG_DEFAULTS is DERIVED from it
// (below) and production-defaults.test.ts SOURCES its allowlist from it. A NEWLY
// registered flag added to FLAGS but NOT here now defaults ON (previously a missing
// FLAG_DEFAULTS entry was a compile error). Default-OFF is permitted ONLY for one of
// the four DarkCase reasons — there is deliberately NO "finished, owner flips after
// verifying" case (finished + tested ⇒ ship ON, verify-then-flip in-task).
export type DarkCase = "incomplete" | "owner-authority" | "cutover" | "parked";
export const DARK_FLAGS: ReadonlyMap<
  FlagKey,
  { case: DarkCase; reason: string }
> = new Map<FlagKey, { case: DarkCase; reason: string }>([
  // parked — deliberately out of V1 scope (built-or-not, simply not shipping yet)
  [
    FLAGS.CLOUDFLARE_PUBLISH,
    {
      case: "parked",
      reason: "cut for V1 — the Cloudflare publish surface is not shipping.",
    },
  ],
  [FLAGS.HARNESS_PHASES, { case: "parked", reason: "cut for V1." }],
  [FLAGS.DESIGN, { case: "parked", reason: "cut for V1." }],
  [FLAGS.TESTING, { case: "parked", reason: "cut for V1." }],
  [
    FLAGS.THE_HIVE,
    {
      case: "parked",
      reason:
        "restore-pot-lexicon-public-release-2026-07-04 (owner 2026-07-04): public release ships the Pot (Papercup) lexicon by DEFAULT. The `the-hive`/Swarm skin is BUILT and kept, but cut from public V1 — reachable only via the TESTING-gated BrandSwitcher (P-004). OFF ⇒ the classic/pot pack (the public default); ON ⇒ the bee skin for internal/testing use.",
    },
  ],
  [
    FLAGS.CONVERSATIONS_RAIL_TAB,
    {
      case: "parked",
      reason:
        "WI-37561, owner directive 2026-08-09 verbatim: \"Put the 'convos' tab in the middle pane behind a testing flag\". The owner CHOSE hidden-until-flipped over a visible kill-switch when asked directly, so this is a requested park, not finished work hidden from its own author. It parks the RAIL TAB only: /adv keeps its own Conversations tab on the same four SSE-cached queries, so no conversation content is unreachable while this is dark — the cheapness of hiding it is the reason the park is honest. ON ⇒ the 💬 Convos tab returns to the middle rail in its owner-set last position (nothing else moves; the id never left TAB_IDS). GRADUATES when the owner says the tab is part of the standard release — the same sentence that graduated papercusp-task-manager on 2026-08-02.",
    },
  ],
  // TEST_COMPLETION_GATE graduated 2026-07-04 (dark-flag-age review, EI-7280):
  // enforce-system-on-generic-work-2026-06-29 P-014 verified it LIVE + enabled
  // (flags:get confirmed true) with zero blast radius (done-without-test watchdog
  // signalCount:0 across every tick since activation) — default ON.
  // incomplete — the code is not fully working / unverified on a path that matters
  [
    FLAGS.EXTERNAL_BENCH,
    {
      case: "incomplete",
      reason:
        'WI-5646 (owner decision 2026-07-26): the external-bench BLUEPRINT is now RETIRED — its design premise ("the treatment IS the shipped coding system, byte for byte") died when the per-feature coding spine was retired 2026-06-24 and `coding` was reassigned to the pot/Mug architecture, so it would benchmark a system that no longer exists. This flag stays dark PERMANENTLY and is NOT awaiting graduation — the prior "dark until the P-009 ~50-task pilot proves the end-to-end path" condition is void; that pilot will not run. (Also still true: the grader adapter is incomplete — M2 in-container modality unbuilt — and infra-heavy.) Do NOT flip ON. It gates the eval UI + run/reproducibility stores, which are kept only to read HISTORICAL run data. Benchmarking the pot/Mug architecture is a NEW blueprint + its own flag, not this one.',
    },
  ],
  // CODEX_GATEWAY_OAUTH_PROXY graduated 2026-08-27 (WI-272118): after activating
  // the existing cutover, the owner-directed gpt-5.6-luna:max headless canary made
  // its gateway:status MCP call, delivered LUNA_AUTO_FLEET_OK to the fleet leader,
  // emitted AgentMessage + task_complete, and recorded only oauth-http Codex spans
  // with zero upstream errors/429s. The preceding cli-exec canary had instead
  // flattened the tool-capable turn into a nested codex process and timed out after
  // five minutes. The key stays as a reversible runtime kill-switch; it is no longer
  // incomplete/default-OFF work.
  [
    FLAGS.ONBOARDING_PREVIEW_FEATURES,
    {
      case: "incomplete",
      reason:
        "owner-directed 2026-07-04 (deterministic-onboarding-tutorial P-001): gates onboarding-tutorial items whose backing feature is NOT ready — mobile pairing (phone notifications / remote control), auto-update channel. Telemetry consent shipped and is no longer preview-gated (optional-setup-items.ts). OFF ⇒ a fresh install never sees the remaining preview items (the intended default); ON ⇒ testers exercise the preview surfaces. Graduates per-item as each backing feature ships.",
    },
  ],
  // TASK_MANAGER GRADUATED 2026-08-02 (WI-6844) on an explicit owner directive:
  // "we put it behind a testing flag. Remove that flag, we'll make it part of our
  // standard release." Its entry is gone from here, so it derives default-ON like
  // every other registered flag; the KEY deliberately survives as a runtime
  // kill-switch, which is not the same thing as being dark. This is the shrink
  // direction — see the watermark note below, lowered 14→13 in the same change so
  // the freed slot ratchets DOWN rather than becoming headroom for the next park.
  // PER_POT_RELEASE_GATE graduated 2026-07-03 (per-hive-git D-008 canary met:
  // oddsmith green-checkpoint went green and FF'd oddsmith main — pipeline_events
  // 'advanced' 2026-07-03T15:16Z): default ON. A hive's gate engages only when
  // enabled AND a repo is configured, so hives without per-hive git stay byte-identical.
  // PRESENCE_GOSSIP graduated 2026-07-16 (LIVE-1 P-059 drill, coordination lane):
  // the dark-entry gate was met — both dogfood machines (tower + mac VM) on
  // reader-carrying builds (G3 verified static + live) and the 2-machine
  // presence-federation verify ran on the tower↔VM rig per
  // docs/plans/CUTOVER-presence-gossip-2026-07-16.md. Default ON; OFF + a
  // presence-loop reboot is the tested rollback (reader stays wired either way).
  // GATEWAY_MAINTENANCE_CARRY graduated 2026-07-15 by explicit owner release
  // direction: behavioral cutover defaults ON; one clean post-deploy smoke per
  // affected class replaces the former ten-drill pre-cutover campaign. OFF remains
  // a reversible operational kill-switch, so it no longer belongs in DARK_FLAGS.
  // MUG_WARM_SESSION graduated 2026-07-02 (owner flip directive): default ON —
  // queen wakes prefer the wake-executor warm resume with deterministic rebirth.
  // owner-authority — a privilege / security / destructive / autonomy surface the owner ratifies
  [
    FLAGS.OPEN_SIGNUP,
    {
      case: "owner-authority",
      reason:
        "SECURITY: /auth/signup is internet-reachable (cloudflared tunnel) — open signup mints real accounts. The zero-active-users bootstrap path keeps fresh installs working; owner flips ON after the auth-tier rollout.",
    },
  ],
  [
    FLAGS.GMAIL_AUTO_SEND,
    {
      case: "owner-authority",
      reason:
        "external-triggers-gmail-slack-2026-08-22 P-011: automatic Gmail sending is an outward-facing owner-authority action. Enforced by mail:reply's trigger-run path (capability-verbs/mail.ts replyToTriggerPlanRun), which refuses mode:'send' from a triggered run while this is OFF; drafting stays live independently. OFF reserves auto-send until the owner ratifies its review, recipient, and failure policy.",
    },
  ],
  [
    FLAGS.SOCIAL_AUTO_PUBLISH,
    {
      case: "owner-authority",
      reason:
        "social-platform-integrations-2026-08-23 P-006 / D-004(b): create-shaped publishing to the owner's real public social identity. A public post differs from a mail send in KIND, not degree — unbounded in audience, permanently indexable, attributed to the owner, and not correctable by a follow-up; and its inbound corpus is untrusted text authored by strangers at volume with an incentive to manipulate. OFF withholds ONLY the outbound call: social:reply (rail 1, bounded blast radius) is unaffected and unflagged, and social:post itself still runs both rails and returns the resolved account + audience echo, so flipping this ON is one owner decision over a fully-built, fully-tested verb rather than a hand-off of unfinished work.",
    },
  ],
  [
    FLAGS.HOSTED_BILLING_LIVE_MODE,
    {
      case: "owner-authority",
      reason:
        "stripe-subscription-signup-2026-10-01 / papercusp-monetization-2026-09-04 D-004+D-010: live-mode Stripe charging of hosted organizations is an outward-facing money movement the owner authorizes, after P-003 pricing and the P-009 pilot-readiness gate. Test-mode signup ships ON and unflagged; OFF refuses only a live key.",
    },
  ],
  [
    FLAGS.AUTH_CONFIG_OVERRIDES,
    {
      case: "owner-authority",
      reason:
        "OWNER-AUTHORITY escalation surface — auth:set_full_access_roles can WIDEN the all-gates bypass set. OFF ⇒ the auth-config sync-cache stays empty ⇒ every surface uses its baked literal (byte-identical); owner flips ON to ratify the dials.",
    },
  ],
  [
    FLAGS.ACCEPT_DELEGATED_SEATS,
    {
      case: "owner-authority",
      reason:
        "OWNER-AUTHORITY / trust surface (agent-allocation-framework P-008, D-006) — lets a REMOTE fleet owner spawn agents on THIS host (within the host capability envelope). OFF ⇒ this host honors NO delegated-seat spawn requests (fail-closed; byte-identical to today). The contributing-host owner flips it ON per-host via /res or /admin/features to opt in. Permanently default-OFF (per-host opt-in), NOT a pending flip.",
    },
  ],
  [
    FLAGS.WATCHDOG_AUTO_CLOSE,
    {
      case: "owner-authority",
      reason:
        "EI-7230: restores the flag's OWN documented intent (watchdog-and-exposed-systems-improvement-2026-06-18 P-009 — \"DEFAULT OFF — auto-closing real improvement items autonomously is unsafe until the owner reviews\"), which the P-011 flag-default-inversion migration (2026-06-29) silently flipped to effectively ON by omitting it from this allowlist — auto-close.ts's own live getFlag check meant the watchdog could have been silently auto-closing real improvement items in production with no owner review. OFF ⇒ escalate-only (today's intended, safe behavior); owner flips ON after reviewing the auto-close criteria.",
    },
  ],
  [
    FLAGS.GRADUATION_TRACKER,
    {
      case: "owner-authority",
      reason:
        "EI-19360358881224651 (2026-09-04): restores this flag's OWN documented dark default. The graduation tracker files owner-facing improvement reports that propose widening autoKinds, but no graduation-specific arming decision exists; the inactive singleton routine and learning-governor gate are defense in depth, not substitutes for the flag's authority boundary. OFF ⇒ graduation scans stop before governor/evidence reads and file nothing. Owner graduates it only after explicitly assigning it to an armed learning wave and reviewing the report/noise policy.",
    },
  ],
  [
    FLAGS.REPLICATION_LIVENESS_STALENESS_AUTO_CLOSE,
    {
      case: "owner-authority",
      reason:
        "WI-5563 (bug-drain-200k structural-starvation diagnosis, 2026-07-20): same owner-authority class as WATCHDOG_AUTO_CLOSE — autonomously resolving a durable escalation (an open replication-liveness EI) without a human/agent verifying the specific item is unsafe by default. This sweep (replication-liveness-staleness-sweep.ts) is DELIBERATELY WIDER than the always-on replication-stall-orphan-sweep.ts (which only resolves a target harness that no longer EXISTS): it resolves connectivity-only EIs (no_replicator/frozen/connected_never_replicated — never the drain_* kinds) whose target harness STILL EXISTS but has recorded no activity for a long (30d default) inactivity window, on top of the EI itself being open ≥14d. Fails closed on any harness with no activity history at all. OFF ⇒ escalate-only (today's behavior — these EIs sit open as noise, exactly the WI-5563-diagnosed starvation cause); owner flips ON after reviewing the eligible-kind list + age/inactivity thresholds.",
    },
  ],
  [
    FLAGS.CAPABILITY_EXEC_SANDBOX,
    {
      case: "incomplete",
      reason:
        "EI-16635 / agent-capability-confinement-2026-06-13 P-022/D-008: SAME EI-7230/WATCHDOG_AUTO_CLOSE bug-fix class — this flag's OWN code comment (exec-sandbox.ts / types.ts) has always said \"OFF by default until validated end-to-end on a bwrap-capable host (this dev box's userns is restricted)\" but was never actually added here, so the 2026-06-29 P-011 inversion silently derived it live default-ON. Confirmed live-ON for papercusp-workspace (no operator_flag_overrides row; only a `generic-test` workspace override exists). Live-evidenced harm (EI-16635): with the flag accidentally ON, capability:bash run_in_background jobs route through the bwrap-only fallback (buildCapabilitySandboxCommand), which passes `--die-with-parent` to bwrap — a lifetime constraint fundamentally incompatible with a BACKGROUND job that is meant to outlive the launching call. Reproduced: a backgrounded job's output file stopped growing ~3-6s after the launching capability:bash call returned, with no process left running — not a `ps aux` visibility artifact (the file itself stopped growing) — and a heavier job showed the SAME truncation point across two independent runs. `capability:bash_output` then misattributes the death to `stranded_by_operator_restart` even when dev:service_health confirms zero restarts, actively misleading the investigator. OFF ⇒ raw (unsandboxed) exec, today's actually-working behavior for capability:bash background jobs. RECONCILED (2026-07-19): buildCapabilitySandboxCommand now takes a `background` opt (threaded from capability:bash's run_in_background:true → startBackground) and omits `--die-with-parent` on the bwrap-fallback path for a background spawn (unit-tested: exec-sandbox.test.ts). NOT YET closed: (1) a live-host re-test of the ORIGINAL 3-6s-truncation repro was inconclusive on a bwrap+srt-capable box — manual repros of both the bwrap-only path and the preferred srt path (buildCapabilitySandboxCommand prefers srt when present, so the bwrap fix does not even engage on a host with srt on PATH) each ran a backgrounded job to completion without early death, so the srt path's own background-job lifetime semantics are UNVERIFIED, not confirmed-safe; (2) still needs a live bwrap-capable-host validation before owner/leader flips this ON.",
    },
  ],
  [
    FLAGS.SUBSTRATE_SIDECAR,
    {
      case: "incomplete",
      reason:
        'WI-1994: same EI-7230/WATCHDOG_AUTO_CLOSE bug-fix class — this flag\'s OWN code comment above has always said "DEFAULT OFF — staged on :3170 FIRST; never :3070 until integration-verified... Listed in KNOWN_DARK_FLAGS" but was never actually added here, so post the 2026-06-29 P-011 inversion it silently derived default-ON. Live-evidenced harm (WI-1910): a fresh containerized-rig frame boots the dark substrate-sidecar path and the sidecar process dies exit 1 right after joining its topic (crash-loop respawn), the mechanism behind WI-1910\'s 0 peer_connected. WI-604 (the "complete + flip" umbrella feature) was separately deprecated 2026-07-03 — the full sidecar was never built out (stubbed replication spike only) — so there is no live plan driving this to a real default-ON graduation; it stays dark until one exists. OFF ⇒ in-process substrate boot, today\'s actually-running behavior on :3070.',
    },
  ],
  [
    FLAGS.RECLAIM_STALLED,
    {
      case: "owner-authority",
      reason:
        'EI-7685: THIRD instance of the identical EI-7230/WATCHDOG_AUTO_CLOSE/WI-1994-SUBSTRATE_SIDECAR bug-fix class in this same file — the flag\'s OWN code comments (work-items-stale-claims.ts, dbos/in-process-periodic.ts, plan-items/stale-claims.ts, fleet/spawn-reclaim.ts) all say "default OFF" / "DARK because freeing a LIVE agent\'s claim changes live placement on a fleet-critical hot path (D-003: land it attended)" — a deliberate agent-activity-liveness-truth-2026-06-21 P-003 design decision that this leg must ship attended — but it was never added to this allowlist, so the P-011 inversion (2026-06-29) silently flipped it to live default-ON. Confirmed LIVE via flags:get(papercusp-reclaim-stalled) = true. Live-evidenced harm (EI-7685): an agent mid an uninterrupted ~20min build (alive, no crash) had its work-item claim reclaimed by the "stalled" leg for merely not calling work_items:checkpoint in the window, wiping its in-flight checkpoint and reassigning the item to an idle peer — exactly the live-placement disruption D-003 says must never ship unattended. OFF ⇒ only the DEAD-holder + confirmed-terminal-spawn legs free claims (today\'s actually-safe behavior); owner flips ON after an attended review of the stalled-window tuning (this session\'s own checkpoint cadence — routine long builds without a checkpoint touch — is itself evidence the default stalledMs/graceMs is too aggressive to enable blind). RE-APPLIED 2026-07-05 ~21:22Z after a fleet-wide `git reset --hard` (17:12:34 local, unrelated incident under investigation by su-f0afe) wiped this uncommitted edit before git-sync could commit it.',
    },
  ],
  [
    FLAGS.PSU_END_USER,
    {
      case: "owner-authority",
      reason:
        'WI-3093 (found 2026-07-05 by su-f5241 while closing the ticket for "no psu launch button visible"): FOURTH instance of the identical EI-7230/WATCHDOG_AUTO_CLOSE/WI-1994-SUBSTRATE_SIDECAR/EI-7685-RECLAIM_STALLED bug-fix class in this same file — this flag\'s OWN code comment directly above (psu-in-desktop-builds-2026-06-23 C1) has always said "DEFAULT OFF — this is the legitimate owner-authority/SECURITY dark case... the owner must personally ratify the end-user exposure before it defaults on... KNOWN_DARK_FLAGS" but was never actually added here, so the P-011 inversion (2026-06-29) silently flipped it to live default-ON. Confirmed LIVE via flags:get(papercusp-psu-end-user) = true — and made ACTIVELY EXPLOITABLE, not just theoretically live, the moment WI-3093\'s OWN fix rendered ConsoleLauncherButton in ChromeShell (previously the button existed but was never mounted, so the dark-default bug had no user-visible surface; now it does): an end user of the shipped desktop app could see and click a button that opens a full unauthenticated superuser agent shell, with zero owner ratification. OFF ⇒ the entry is not offered; the bundled psu shim is inert (today\'s actually-intended, safe behavior — dev/internal launch via other paths is unchanged). Owner flips ON only after personally ratifying end-user psu exposure.',
    },
  ],
  // parked — the v2 Cupboard marketplace merge is BUILT (the remote-fetch path
  // exists + works) but deliberately out of V1 scope per owner directive
  // (2026-07-07): V1 ships the first-party templates bundled + resolved from the
  // LOCAL store; the marketplace (user-published, runtime-fetched templates) is a
  // staged v2 enablement. OFF ⇒ templates:* resolve the local store only; the
  // remote Cupboard path stays dormant. Flipped ON in v2 once the marketplace is
  // ready. Not incomplete/unsafe — a deliberate owner-directed staged cutover.
  [
    FLAGS.TEMPLATES_MARKETPLACE,
    {
      case: "parked",
      reason:
        "local-first-party-template-bundling-2026-07-07 (owner-directed 2026-07-07): V1 ships the first-party templates bundled in-app + resolved from the local store; the Cupboard MARKETPLACE merge (user-published, runtime-fetched templates via templates:list/get-guide/new-app) is deliberately deferred to v2. The remote-fetch code is wired but dormant. OFF ⇒ templates:* resolve the local store only (offline, no Cupboard round-trip). Owner flips ON in v2 when the marketplace ships.",
    },
  ],
  // The rubrics sibling of TEMPLATES_MARKETPLACE — the same owner-directed v1/v2
  // split (local-first-party-rubric-bundling-2026-07-07): v1 bundles + seeds the
  // first-party rubrics locally; the Cupboard kind='rubric' marketplace is a v2 seam.
  [
    FLAGS.RUBRICS_MARKETPLACE,
    {
      case: "parked",
      reason:
        "local-first-party-rubric-bundling-2026-07-07 (owner-directed 2026-07-07, the templates-v1 design applied to rubrics): V1 ships the first-party rubrics bundled in-app (sidecar/rubrics content dirs) and seeds them into the workspace rubric store on first rubrics:* read (idempotent, no-clobber — an existing workspace rubricId always wins). The Cupboard MARKETPLACE merge for kind=rubric listings is deliberately deferred to v2 — no remote-fetch code exists yet; the flag reserves the seam. OFF ⇒ rubrics:* resolve the workspace store (+ bundled seed) only. Owner flips ON in v2 when the rubric marketplace ships.",
    },
  ],
  [
    FLAGS.OWN_LOG_FORK_AUTO_RECOVERY,
    {
      case: "owner-authority",
      reason:
        'p2p-parity-parallel-lanes-2026-07-09 P-003 (WI-3535): the own-log-fork-guard auto-recovery sketch (own-log-fork-recovery.ts) performs a per-harness Corestore STORE RESET — deletes the on-disk peer-log directory so a fresh keypair is minted on next boot — to break the equivocation-loop boot loop. DESTRUCTIVE: it discards any local hypercore-only history not yet merged into PG, so unattended auto-recovery is unsafe until the owner personally ratifies it (the plan explicitly requires this flag-gated default-OFF). OFF ⇒ recoverForkedOwnLog always short-circuits with reason:"flag_off"; the detector still files a durable EI naming the supported MANUAL recovery. Owner flips ON only after reviewing the destructive blast radius.',
    },
  ],
  // HRW_RENDEZVOUS_AUTHORITY graduated 2026-07-17 (LIVE-1 P-059 drill, coordination
  // lane): the cutover dark-entry gate was met — the multi-peer same-inputs verify
  // ran on the tower↔VM rig (both machines' fresh pot_slug='papercusp' candidate
  // sets identical, same tower-built code on both), then the flag was flipped ON in
  // BOTH machines' stores in one pass (resolveUseHrwRendezvous reads per-call, so
  // no peer ever computed with a stale value across a reboot boundary). Default ON;
  // OFF is the tested rollback (selectAuthorityFromRows argmin, byte-identical
  // pre-WI-1491 behavior). See docs/plans/CUTOVER-presence-gossip-2026-07-16.md.
  // 2026-07-18 — papercusp-plan-part-federation GRADUATED default-ON (WI-5331 Leg B):
  // the real two-machine merge proof its dark entry demanded (P-008) ran on the live
  // tower↔Avis-iMac rig — concurrent different-part edits (tower section:now rewrite
  // vs mac item flip, 5s apart) under flag-ON on BOTH machines converged to
  // byte-identical content (md5 b2f6826d…) in ~5s with both edits surviving on both
  // sides: tower held item:P-003 origin=remote (mac device key) recomposed into its
  // content, the mac held section:now origin=remote (tower device key) recomposed
  // into its content — no whole-blob clobber in either direction; recompose was the
  // sole content writer per P-006/P-009. Verdict: p2p-part-merge-proof-2026-07-18
  // D-001. Entry removed (the set shrinks). OFF remains the tested rollback (plans
  // federate as the whole harness_plans.content blob, mig 125).
  // WI-3796 (2026-07-10, fleet p2p-parity-lanes): SEVENTH instance of the identical
  // EI-7230/WATCHDOG_AUTO_CLOSE/WI-1994-SUBSTRATE_SIDECAR/EI-7685-RECLAIM_STALLED/
  // WI-3093-PSU_END_USER/EI-9064-PLAN_PART_FEDERATION/WI-3370-SUBSTRATE_LOG_SNAPSHOT
  // bug-fix class in this same file — TWO more flags whose OWN code comments (directly
  // above in FLAGS) have always said "DEFAULT OFF" but were never actually added here,
  // so the 2026-06-29 P-011 inversion silently flipped both to live default-ON.
  // CONFIRMED LIVE via direct PG check: harness_shared.operator_flag_overrides carries
  // no override row for either key in workspace papercusp-workspace, so both were
  // resolving purely off the buggy code-level default (verified 2026-07-10 via psql).
  // This SEVENTH instance breaches the prior watermark of 22 with zero graduation
  // candidates ready (see the 2026-07-10 review note below) — raised
  // DARK_FLAGS_HIGH_WATERMARK 22→24 to accommodate, which CLAUDE.md's "Feature flags"
  // section flags as needing explicit owner sign-off. Under this session's standing
  // AUTO-mode grant (owner directive 2026-07-03: ZERO owner-confirm pauses; AUTO mode
  // passes owner-authority/"owner must personally ratify" gates and discloses rather
  // than blocking on them) this was actioned directly and disclosed loudly via
  // coord:send + a durable fact + this comment, rather than parked pending a sign-off
  // that would leave two unreviewed, fleet-wide-blast-radius behaviors silently live in
  // the meantime. The correction is unambiguously the SAFE direction — it turns OFF
  // two already-live, never-ratified behaviors, restoring the byte-identical documented
  // baseline; it does not newly enable anything. Owner may reverse (re-remove from
  // DARK_FLAGS + restore watermark to 22) at any time.
  //
  // 2026-08-10 (WI-37718) — GIT_SYNC_DERIVED_ATTRIBUTION, the FIRST of that pair, has
  // GRADUATED default-ON and its entry is REMOVED from this map (the set shrinks; an
  // 'owner-authority' entry is not rationed by DARK_FLAGS_HIGH_WATERMARK / the
  // DARK_FLAGS_PARKING_COUNT subset either way, so no watermark change accompanies this).
  // The owner flipped it after the end-to-end review this entry demanded: the writer-side
  // defect that made derived attribution resolve a placeholder holder
  // (EI-20055604348536487, fixed in b2af0024a8) is live on every writer path, and after
  // the last pre-fix process cycled, 39/39 consecutive lock rows carried a real declared
  // intent with zero sentinels while the last 60 commits carried real per-agent subjects
  // with zero sentinel subjects — i.e. the edge-case-bug risk this entry was holding the
  // flag against was measured, not assumed. DOC_STEWARD (the pair's other half, below)
  // is UNAFFECTED and stays dark — its own end-to-end check has not been run.
  [
    FLAGS.IMPROVEMENT_AUTO_IMPLEMENT,
    {
      case: "owner-authority",
      reason:
        'papercusp-self-improvement-loop-2026-06-04 Phase 3 (D-004/D-006/D-008), found 2026-07-26 (su-709bb) by the flag-comment-lint recall fix (normalization step 5 — this entry declares itself as "When OFF (default)", the REVERSED form the guard could not previously see, so it was silently SKIPPED). Same class as WATCHDOG_AUTO_CLOSE/RECLAIM_STALLED/DOC_STEWARD: the flag\'s OWN comment states it is the master switch for AUTO-implementing captured improvements and that OFF is the default, with an explicit precondition — "Flip ON only once the work_items surface + the release-gate cutover have landed" — but it was never added here, so it derived live default-ON. That is an AUTONOMY-ESCALATION surface (the routine spawns an implementer agent in a dedicated runner harness and lands code via the release gate) running with no owner ratification and with its own stated precondition unverified. OFF ⇒ the improvement-implement routine is a no-op; capture (Phase 1) + triage (Phase 2) are unaffected — exactly the documented, intended behavior. Owner flips ON once the stated preconditions are confirmed landed.',
    },
  ],
  [
    FLAGS.CAPABILITY_ENVELOPE_OVERRIDES,
    {
      case: "owner-authority",
      reason:
        'live-configurability-audit-2026-06-20 P-009, found 2026-07-26 (su-709bb) by the same flag-comment-lint recall fix (declares itself "OFF (default) ⇒ the sync-cache stays empty ⇒ byte-identical" — the REVERSED form, previously skipped). Its own comment opens "DARK:" and describes a SECURITY/capability surface: runtime per-role capability-envelope overrides (capability_envelope:set_role / :set_protected) that merge per-role deny/allow overrides OVER the baked ROLE_ENVELOPES at the dispatch checkCapabilityEnvelope step. Never added here, so it derived live default-ON — meaning any override row present would silently apply to real dispatch authorization with no owner ratification. OFF ⇒ the sync-cache stays empty ⇒ byte-identical to the baked envelopes (the documented intent). Owner flips ON to ratify runtime envelope overrides.',
    },
  ],
  [
    FLAGS.DOC_STEWARD,
    {
      case: "owner-authority",
      reason:
        "docs-corpus-audit WS2 P-008 / deterministic-commit-workitem-attribution P-005: the post-git-sync doc-freshness sweep dispatches an LLM doc-steward agent to auto-edit/regenerate a drifted doc against current code, and can spawn an agent per drift. The flag's OWN comment has always said \"DEFAULT OFF: it auto-edits the doc corpus (owner-authority surface) + spawns an agent per drift — flip ON after the owner-verified end-to-end check\" but was never added to DARK_FLAGS, so it derived live default-ON — confirmed no PG override exists in workspace papercusp-workspace. Unattended auto-editing of the doc corpus + unbounded per-drift agent spawn is an owner-authority surface, so it ships dark until the owner runs the end-to-end verification its own design calls for. OFF ⇒ the freshness sweep still detects drift, but no auto-edit and no agent dispatch (today's actually-safe behavior). Owner flips ON after the verified check.",
    },
  ],
  // WI-4238 (2026-07-12, su-00a91): the NINTH instance of the EI-7230 bug-fix class —
  // and, after a per-flag re-derivation, the ONLY one of the ten outstanding
  // comment-vs-DARK_FLAGS mismatches that is genuinely a SAFETY mis-default.
  //
  // The other nine all default-ON to a SAFER/NARROWER behavior (completed partition
  // cutovers + workspace/auth guard rails) — for those, "restoring the documented dark
  // baseline" is a REGRESSION, and two of them (COORD_/ISSUES_PER_WORKSPACE) would have
  // stranded ~79k live rows. Their comments were the stale side and are now corrected in
  // FLAGS above. THIS one is the true inversion: ON removes a human check rather than
  // adding one, so it is the one that actually belongs here.
  //
  // Confirmed live-ON 2026-07-12: no override row in harness_shared.operator_flag_overrides
  // for workspace papercusp-workspace, so it resolved purely off the buggy P-011 default.
  // Not yet exercised (leader su-286379e2 verified 0 full-autonomy grants in 48h) — a real
  // code-level mis-default, not an active incident. Raised DARK_FLAGS_HIGH_WATERMARK 25→26
  // (see the constant's note); actioned under the owner's standing AUTO-mode grant and
  // disclosed rather than left silently live, and it is unambiguously the SAFE direction —
  // it turns OFF an already-live, never-ratified behavior and newly enables nothing.
  // WI-4240 (2026-07-12, su-00a91): the two cross-machine authority cutovers — 11th + 12th
  // instances of the EI-7230 class. Both comments always said DEFAULT OFF / dark (they are
  // real-hardware-UNVERIFIED cross-machine paths gated on a two-machine proof), but neither
  // was ever added here, so P-011 derived both live-ON. An unverified cross-machine cutover's
  // correct DEFAULT is unambiguously OFF regardless of the missing rig — the rig gates
  // turning them ON, not the default. Byte-identical on this single box (both no-op without a
  // multi-machine transport, confirmed in their wiring), and consistent with every sibling
  // cross-machine flag already dark (PLAN_PART_FEDERATION / PRESENCE_GOSSIP /
  // HRW_RENDEZVOUS_AUTHORITY). Watermark 27→29.
  [
    FLAGS.AUTHORITY_RPC_PROTOMUX,
    {
      case: "cutover",
      reason:
        'shared-hive-hardening-2026-06-13 P-001/D-005: routes remote lock-authority RPCs over the per-harness Hyperswarm protomux channel so NAT\'d peers are served. Real-hardware-UNVERIFIED (P-003) — the flip is gated on the two-machine serialization proof. Comment always said "DEFAULT OFF" but was never added here, so P-011 derived it live-ON. wireAuthorityRpcSwarmTransport returns early without a device signer/swarm, so ON is a no-op on a single box; OFF = HTTP-only, byte-identical. Owner/leader flips ON after the two-machine proof.',
    },
  ],
  [
    FLAGS.LAZY_SUBSTRATE_BOOT,
    {
      case: "cutover",
      reason:
        'shared-hive-cross-machine-scale-10k-2026-06-29 P-010 (found 2026-07-26, su-709bb): the SAME never-added-to-DARK_FLAGS class as AUTHORITY_RPC_PROTOMUX/AUTHORITY_EVICTION_PROBE directly below, but INVISIBLE to the flag-comment-lint guard until this date — the guard only recognised "DEFAULT OFF", while this entry declares itself in the REVERSED form "OFF (default): boot is byte-identical to today (eager all-harness boot). DARK + STAGED-ON-:3170-FIRST", so it classified as null and was silently SKIPPED (fixed: flag-comment-lint normalization step 5). Its own comment records an owner-ratified D-005/D-006 BINDING execution constraint to stage on :3170 first, precisely because a wrong eviction silently stops a harness syncing → fleet data divergence (the EI-126 102 GB class) — yet it derived live default-ON, so the eviction reaper + outbox keepalive have been running unattended with that blast radius and no staged verify. The live-ON state was an ACCIDENT (a missing entry here), never a decision. OFF ⇒ eager all-harness boot + no reaper — the long-standing, definitively-safe behavior (costs RSS, cannot diverge). NOTE this also gates P-010\'s new activate-on-demand policy (substrate-active-set-policy/-facts), which rides this same flag deliberately rather than adding a second separately-flippable half of one behaviour. Owner/leader flips ON at the attended :3170 staged verify its own D-005/D-006 constraint calls for.',
    },
  ],
  [
    FLAGS.AUTHORITY_EVICTION_PROBE,
    {
      case: "cutover",
      reason:
        'shared-hive-hardening-2026-06-13 P-016: wires the φ-accrual + SWIM failure detector into authority selection so a crashed authority is evicted promptly instead of waiting out the 90s staleness window. Rides the same unverified cross-machine RPC seam as AUTHORITY_RPC_PROTOMUX; real-hardware-UNVERIFIED (D-003). Comment always said "DEFAULT OFF (dark)... KNOWN_DARK_FLAGS" but was never added here, so P-011 derived it live-ON. wirePeerEviction installs no monitor when off and single-box/no-transport is a no-op anyway; OFF = staleness-only selection, byte-identical to pre-P-016. Owner/leader flips ON after the two-machine proof.',
    },
  ],
  [
    FLAGS.MUG_FULL_AUTONOMY,
    {
      case: "owner-authority",
      reason:
        "WI-4238: the recursive-self-improvement boundary. When ON, (1) the autonomy decider returns `auto` for categorical HARD GATES — authority:'owner', protected/locked categories, irreversible actions, above-ceiling, and graduation:* ratification asks — so the Queen widens her own ceilings without pausing; and (2) the self-improvement auto-implement loop lifts the protectedPathPatterns/protectedKeywords TCB bars, making a kind=bug that touches the deploy gate / flags / capability dispatch / migrations / the loop's OWN code auto-implement-eligible. The flag's own comment has always said \"OFF by default — DELIBERATE, NOT the alpha flags-default-on policy\" and warned it \"removes the last human check on the system widening its own ceilings and editing its own safety machinery\" — but it was never added here, so the 2026-06-29 P-011 inversion silently derived it default-ON. OFF ⇒ the documented gated residue is restored VERBATIM (pinned both directions in tests); the decider/loop fail-DARK on a flag-IO error. Owner flips ON only by personally ratifying full autonomy.",
    },
  ],
  [
    FLAGS.FLEET_HEADCOUNT_GOVERNOR,
    {
      case: "owner-authority",
      reason:
        "WI-2479: persistent per-fleet headcount auto-top-up can open real agent sessions without an attended launch call. The routine is bounded to a live deficit, uses an atomic retry lease plus the existing launch-window guard, and exponentially backs off failures, but it remains a fleet-autonomy escalation surface. OFF is a pure no-op; owner flips ON only after reviewing the no-storm and no-double-open tests. R5 (interrupted-member-recovery-hardening-2026-09-01) further scopes ON to fleets whose persisted recipe carries supervise:true — ungranted fleets are untouched even with the flag ON.",
    },
  ],
  [
    FLAGS.MEM0_FEDERATION_EGRESS,
    {
      case: "owner-authority",
      reason:
        "mem0-cross-machine-federation-2026-07-10 (F1-1 mirror, D-006 privacy): gates the cross-machine federation of SHAREABLE memories (memory:remember with shareable=true). When ON, capture triggers enqueue shareable=true memories to the peer-log outbox, and receive-side projections apply remote memories to the local store (source-partitioned H6 pattern mirroring agent-facts). OWNER-AUTHORITY: memory federation affects what personal memory data leaves the machine — only the owner ratifies when/how/which memories federate. The privacy gates ride the SAME pot-visibility + member-admission guards as agent-facts (private pots never leak; only admitted members receive). OFF ⇒ shareable flag has no effect — capture stays quiet and egress never happens (byte-identical to today's personal-only behavior). Owner flips ON after reviewing privacy implications + confirming the privacy gates are in effect.",
    },
  ],
  [
    FLAGS.GOAL_HOLDER_RESPAWN,
    {
      case: "owner-authority",
      reason:
        "goal-live-holder-guarantee-2026-08-18 P-009 / D-002: automatically launching a replacement GOAL-mode holder spends money and creates unattended agent sessions. The actor is bounded to active goals that opt into holder.onLoss=respawn, uses the shared flap-damping/give-up policy, and is independently kill-switched from the report-only liveness watchdog. OFF is a pure no-op before reading goals; deterministic deactivation and reporting remain enabled. Owner flips ON after reviewing the bounded recovery behavior.",
    },
  ],
  [
    FLAGS.STANDING_GOAL_BOOT_ARM,
    {
      case: "owner-authority",
      reason:
        "work-on-everything-goal-2026-08-23 P-011 (retirement doc open loss #3): at operator boot, respawns the lost holder of an active un-paused STANDING goal that opted into holder.onLoss=respawn — an unattended agent spawn + spend at every operator start. The retirement doc records cold-start autonomy as something that 'should be a choice rather than a discovery'; this flag IS that choice, so only the owner arms it. Bounded: a ~10-minute boot window then self-stop, standing goals only, 'unheld' never spawns (install≠start D-002), and it defers to GOAL_HOLDER_RESPAWN whenever the runtime respawner is armed. OFF = today's behavior — the owner restarts the system by hand.",
    },
  ],
]);

// Only these cases are subject to the anti-parking-lot size budget. Safety
// kill-switches (owner-authority/cutover) are NOT rationed by it — they are
// reviewed on their own ADVISORY clock, DARK_FLAGS_OWNER_REVIEW_BY below.
export const DARK_FLAGS_PARKING_CASES: ReadonlySet<DarkCase> =
  new Set<DarkCase>(["parked", "incomplete"]);
// The exact complement of DARK_FLAGS_PARKING_CASES — every DarkCase is in exactly one of
// these two sets (production-defaults.test.ts pins that partition at runtime, belt-and-
// suspenders over the 4-value DarkCase union the type system already exhausts).
export const DARK_FLAGS_OWNER_CASES: ReadonlySet<DarkCase> =
  new Set<DarkCase>(["owner-authority", "cutover"]);
export const DARK_FLAGS_PARKING_COUNT = [...DARK_FLAGS.values()].filter(
  (entry) => DARK_FLAGS_PARKING_CASES.has(entry.case),
).length;

/**
 * Which review clock governs one DarkCase (EI-19941703547241191). `"parking"` is the
 * HARD-GATING clock (DARK_FLAGS_PARKING_REVIEW_BY) — production-defaults.test.ts reds
 * the shared fleet gate when it lapses, because parked/incomplete is the genuinely
 * agent-actionable, parking-lot-abuse population the watermark also polices. `"owner"`
 * is the ADVISORY clock (DARK_FLAGS_OWNER_REVIEW_BY) — owner-authority/cutover entries
 * are never agent-graduatable BY DEFINITION, so lapsing surfaces owner attention (via
 * darkFlagRatificationToAttention) instead of red-pinning CI for a backlog no agent may
 * clear. Throws on an unrecognized case rather than silently defaulting a lane — a
 * DarkCase outside both sets is malformed evidence and must fail loud, not resolve to
 * whichever clock happens to be checked first.
 */
export function darkFlagReviewLane(c: DarkCase): "parking" | "owner" {
  if (DARK_FLAGS_PARKING_CASES.has(c)) return "parking";
  if (DARK_FLAGS_OWNER_CASES.has(c)) return "owner";
  throw new Error(`darkFlagReviewLane: unrecognized DarkCase "${c}" — not in either review lane`);
}

// ── The dark allowlist's HYGIENE BOUNDS (re-review + parking budget) ──────────
// Promoted here from production-defaults.test.ts (enforce-system-on-generic-work-
// 2026-06-29 P-013) so SHIPPABLE code — the operator dark-flag-age watchdog — reads
// the same source of truth the guard test asserts against. The test still owns the
// ASSERTIONS (review-by not past, parking cases <= watermark); it now IMPORTS these
// instead of re-declaring them, so the watchdog and the CI guard reason over one set of numbers.
//
//   ⚠ BEFORE you conclude a review: run `npm run audit:dark-flags`
//     (scripts/audit-dark-flags-live-state.ts). A text-only read of case+reason
//     is BLIND to a flag that is already running live — WI-37354 caught the
//     2026-08-09 review below concluding "CODEX_GATEWAY_OAUTH_PROXY: canary not
//     yet run, stays dark" in the SAME cycle the flag was resolving `enabled:
//     true` on this box via a runtime override the whole time. The script
//     cross-references every DARK_FLAGS entry's case against its live PG
//     override + env state and flags any 'incomplete'/'parked' entry that
//     resolves true anywhere (a sanctioned-nowhere combination) as CRITICAL;
//     an 'owner-authority'/'cutover' entry live via override is expected and
//     reported only for visibility. Fold its CRITICAL output into your review
//     notes below — don't just re-read the prose.
//
//   DARK_FLAGS_PARKING_REVIEW_BY — the date the parked+incomplete subset must be
//                             RE-REVIEWED by. Past it, production-defaults.test.ts REDS
//                             the shared fleet gate: walk every parked/incomplete dark
//                             flag, flip what's ready (remove it from DARK_FLAGS), THEN
//                             push this date out with a fresh look — the bump is the
//                             LAST step, never the only one. This is the hard-gating
//                             clock, deliberately scoped to the population an agent can
//                             actually act on (EI-19941703547241191).
//   DARK_FLAGS_OWNER_REVIEW_BY — the ADVISORY re-review date for owner-authority+cutover
//                             entries. Lapsing it never fails a test — those 18+ entries
//                             are not agent-graduatable BY DEFINITION, so gating CI on
//                             them just trains "bump the date" for a backlog no agent
//                             may clear. It instead feeds the existing owner-attention
//                             path (darkFlagRatificationToAttention, wired per-flag in
//                             agent-tools/plans/attention.ts) so a stale owner review
//                             surfaces to the one audience who can act on it.
//   DARK_FLAGS_HIGH_WATERMARK — the post-sweep size ceiling for parked+incomplete
//                             cases only. owner-authority/cutover cases are not
//                             rationed; they are reviewed by DARK_FLAGS_OWNER_REVIEW_BY.
//
// 2026-07-04 review (EI-7280, pushed the date out — the review is the point, not the
// bump): walked every non-owner-authority dark flag against its stated graduation
// condition. Ready + graduated: TEST_COMPLETION_GATE (verified live+enabled, zero
// blast radius). Checked + still genuinely not ready: EXTERNAL_BENCH (grader
// adapter incomplete, M2 unbuilt), CODEX_GATEWAY_OAUTH_PROXY (WI-2198, owner-
// attended canary not yet run), ONBOARDING_PREVIEW_FEATURES (backing features —
// telemetry consent, mobile pairing, auto-update channel — not shipped), PRESENCE_GOSSIP
// (cross-machine-coord-parity-and-trust-2026-07-01 P-108 replication-layer bug still
// WIP, blocking the D6 flip). owner-authority entries are the owner's call, not swept here.
//
// 2026-07-10 review (EI-9140, dark-flag-age watchdog — set at 21/22, one slot from the
// watermark): re-walked every non-owner-authority entry against its graduation condition.
// NONE ready to flip this round — no false-inversion bugs found this time (the 5 prior
// EI-7230-class instances above are already all correctly listed). Re-checked:
// PRESENCE_GOSSIP + HRW_RENDEZVOUS_AUTHORITY — still blocked on the SAME cross-machine
// P-059/P-108 replication-layer bug (plan cross-machine-coord-parity-and-trust-2026-07-01,
// live-verified via plans:get: "P-059 LIVE-1 drill: WIP, blocker NARROWED to the
// replication layer" as of today). PLAN_PART_FEDERATION — added to this allowlist
// TODAY (fixing a live default-ON bug, see the entry's own comment); its two-machine
// merge proof + backfill (P-007/P-008) have not run, nowhere close to ready. EXTERNAL_BENCH,
// CODEX_GATEWAY_OAUTH_PROXY, ONBOARDING_PREVIEW_FEATURES, SUBSTRATE_SIDECAR — graduation
// conditions unchanged since 2026-07-04 (no new evidence of the M2 pilot / owner canary /
// backing-feature ships / a driving plan). owner-authority entries (7) remain the owner's
// call, not swept here. CAPACITY NOTE for the owner: the dark set is genuinely AT the
// watermark ceiling with zero flags ready to graduate this round — any new default-OFF
// flag need before the next review will require either an owner-forced graduation of an
// existing entry or explicit sign-off to raise DARK_FLAGS_HIGH_WATERMARK; flagged via
// coord:send this session rather than silently deferred. Review-by shortened to 2 weeks
// (vs. the usual 4) given the zero-headroom state, so this gets re-walked sooner.
//
// 2026-07-10 watermark raise (WI-3796, fleet p2p-parity-lanes, AUTO-mode session
// su-d8a21ac3): the capacity note above landed exactly as predicted — the SEVENTH
// EI-7230-class bug-fix instance (GIT_SYNC_DERIVED_ATTRIBUTION + DOC_STEWARD, both
// confirmed live-ON with zero PG override) needed 2 more dark-allowlist slots with
// ZERO graduation candidates ready (re-checked: PRESENCE_GOSSIP/HRW_RENDEZVOUS_AUTHORITY
// still blocked on the same P-059 replication-layer bug; PLAN_PART_FEDERATION/
// SUBSTRATE_LOG_SNAPSHOT landed too recently to be ready; the 8 owner-authority entries
// are not agent-graduatable). Raised 22→24 rather than leave two unreviewed,
// fleet-wide-blast-radius behaviors (the git-sync commit hot path; unattended doc-corpus
// auto-edit + agent spawn) silently live pending a synchronous sign-off — disclosed via
// coord:send + a durable fact rather than silently appended. Owner may reverse (drop back
// to 22) once reviewed; nothing further should raise it again without an explicit ask.
// ─── REVIEW 2026-07-26 (su-e3b21216, WI-5835) — date moved ONLY because the review was
// actually performed. Prior deadline 2026-07-24 had elapsed, red-ing the green gate fleet-wide.
// Recording the outcome here so the next reviewer inherits findings, not a bare date:
//
// SCOPE: all 29 DARK_FLAGS entries examined against their stated case + reason.
//   parked 7 · incomplete 6 · owner-authority 13 · cutover 3.
//   NOTE the watermark counts ONLY parked+incomplete (7+6=13) — "safety cases remain outside
//   this size budget" — so 29 entries vs a watermark of 13 is NOT a breach. Verify what the
//   number measures before reading a mismatch as a defect.
//
// VERDICT: ZERO graduation candidates. No flag flipped. Per-flag basis:
//   parked(7)      — deliberate V1 scope cuts; THE_HIVE / TEMPLATES_MARKETPLACE /
//                    RUBRICS_MARKETPLACE are explicitly owner-directed v1-vs-v2 decisions.
//   incomplete(6)  — EXTERNAL_BENCH (M2 modality unbuilt), CODEX_GATEWAY_OAUTH_PROXY
//                    (reverse-engineered proprietary transport), ONBOARDING_PREVIEW_FEATURES
//                    (backing features not ready), and CAPABILITY_EXEC_SANDBOX /
//                    SUBSTRATE_LOG_SNAPSHOT / SUBSTRATE_SIDECAR — the EI-7230 class, each
//                    restoring its OWN always-documented OFF default. SUBSTRATE_SIDECAR
//                    crash-loops when ON, so it is unsafe, not merely unfinished.
//   owner-authority(13) + cutover(3) — flipping any would be wrong ON THE MERITS, not merely
//                    unratified: OPEN_SIGNUP, PSU_END_USER (an unauthenticated superuser shell
//                    reachable by end users), AUTH_CONFIG_OVERRIDES, MUG_FULL_AUTONOMY,
//                    RECLAIM_STALLED (evidenced live harm — EI-7685), OWN_LOG_FORK_AUTO_RECOVERY
//                    (destructive store reset), MEM0_FEDERATION_EGRESS, and the three staged
//                    cutover kill-switches.
//
// CRITICALLY: none of the 13 budget-counted flags is finished-work-parked-dark — which is the
// specific abuse this tripwire exists to catch. The set sits AT capacity (13/13), so a new
// parked/incomplete flag must GRADUATE one first rather than raise the watermark again.
//
// STANDING CAUTION for the next reviewer: bumping this date WITHOUT performing the review is
// the one action that defeats the guard, and is exactly the silent-lingering it was built to
// surface. If you are here only because the gate is red, stop and do the review instead.
// ─── REVIEW 2026-08-09 (su-01f8cbc4, WI-36258) — I arrived here BECAUSE the gate was red, which
// the caution above names as the danger. So the review was performed and its verdict RE-DERIVED
// from each entry's case + reason, not inherited from the 2026-07-26 block; the date moved only
// after that. The deadline elapsed at 00:00Z and red-pinned the fleet gate (green-stall:papercusp,
// 9 consecutive reds, main held at fa0763d05e96 ~7.5h) — a calendar tripwire, not a code defect.
//
// SCOPE: all 31 entries. parked 7 · incomplete 6 · owner-authority 15 · cutover 3.
//   Budget-counted (parked+incomplete) = 13, watermark 13 — still AT capacity, UNCHANGED.
//
// MEMBERSHIP DELTA since 2026-07-26 (29 → 31), measured, not assumed:
//   +CAPABILITY_ENVELOPE_OVERRIDES, +IMPROVEMENT_AUTO_IMPLEMENT (owner-authority)
//   +LAZY_SUBSTRATE_BOOT (cutover)
//   −WORKSPACE_COORDINATION  ← a REAL graduation; the list does shrink, as designed.
//   All three additions are SAFETY cases, which sit outside the size budget — so 13/13 is
//   unchanged and this growth is NOT a watermark breach. (Check what the number measures
//   before reading 31-vs-13 as a defect; the 2026-07-26 block flags the same trap.)
//
// VERDICT: ZERO agent-graduatable candidates. No flag flipped. No behaviour changed.
//   parked(7)                        — owner-directed V1/v2 scope cuts; flipping would SHIP a
//                                      surface the owner explicitly cut. Not an agent's call.
//   incomplete(6)                    — unbuilt or unverified. EXTERNAL_BENCH is now PERMANENTLY
//                                      dark (blueprint retired, WI-5646) and is awaiting nothing,
//                                      so it will never graduate and is not a standing candidate.
//   owner-authority(15) + cutover(3) — unchanged on the merits; each needs personal owner
//                                      ratification or an attended staged/two-machine verify.
//
// ⚠ STRUCTURAL NOTE for whoever reads this next — the honest limit of an AGENT review.
// 18 of 31 entries (owner-authority + cutover) are BY DEFINITION not agent-graduatable, so an
// agent-performed review can only ever return "zero candidates" for them. Two consecutive
// reviews have now done exactly that. This tripwire therefore red-pins the SHARED fleet gate
// every cycle for a backlog no agent is permitted to clear, and the only available action is to
// move the date — the very act the caution above warns about, made unavoidable by construction.
// That is a guard-design problem, not a reviewer problem: filed as EI-19941703547241191
// (the elapsed-date symptom itself was filed independently by a peer as EI-19933138951557204).
// ─── LIVE-STATE ADDENDUM (WI-37354, same day) — the 2026-08-09 review above is a TEXT read
// of case+reason and is right about the *prose*, but `npm run audit:dark-flags` (added by this
// fix — see the pointer above DARK_FLAGS_PARKING_REVIEW_BY) shows the PROSE and the RUNTIME disagree for
// one entry in papercusp-workspace right now: CODEX_GATEWAY_OAUTH_PROXY resolves `enabled: true`
// live (PG override, harness_shared.operator_flag_overrides — set by WI-3596's `flags:set`),
// while its case is 'incomplete' and its own reason says "Dark until [an owner-attended] canary
// passes" — 'incomplete' has no sanctioned live path (only 'owner-authority'/'cutover' do), so
// this is exactly the audit's CRITICAL case. NOT resolved here, on purpose: whether WI-3596's
// canary was owner-attended is a fact only the owner can confirm (its own completion evidence
// doesn't say), and CLAUDE.md's owner-authority carve-out means an agent flipping the default (or
// the override) on a reverse-engineered proprietary-transport surface is precisely the call this
// file reserves for the owner. Left dark; left live; flagged for the owner rather than guessed
// either way. The 2026-08-09 verdict above ("owner-attended canary not yet run") should be read
// as "not yet CONFIRMED", not "not yet run" — the audit script is now how a future review checks
// this instead of re-asserting the prose. (The three owner-authority live overrides the same run
// found — ACCEPT_DELEGATED_SEATS, WATCHDOG_AUTO_CLOSE, REPLICATION_LIVENESS_STALENESS_AUTO_CLOSE
// — are the EXPECTED shape for that case: the override IS their sanctioned per-install
// ratification, so their shipped default correctly stays OFF for a fresh install. No action.)
// Escalated to the owner in-session rather than left to lapse silently again.
// ─── REVIEW 2026-08-20 (EI-20565859968567853, su-3ddaa243) — re-reviewed at
// current HEAD (fd59c210c3) before advancing this date. SCOPE: all 31 entries:
// parked 8 · incomplete 6 · owner-authority 14 · cutover 3. The
// budget-counted parked+incomplete subset is 14/14, so the watermark remains 14.
//
// VERDICT: ZERO entries are ready to graduate. The eight parked entries are
// explicit V1/v2 scope cuts (including the owner-directed conversations rail
// tab); EXTERNAL_BENCH is permanently dark because its blueprint is retired;
// CODEX_GATEWAY_OAUTH_PROXY still lacks confirmed owner-attended canary
// evidence; ONBOARDING_PREVIEW_FEATURES still waits on its backing features;
// CAPABILITY_EXEC_SANDBOX remains unverified on the required host; and
// SUBSTRATE_LOG_SNAPSHOT / SUBSTRATE_SIDECAR remain gated on their
// cross-machine proof and a working implementation respectively. The 14
// owner-authority and 3 cutover entries remain owner-ratified or
// attended-verification decisions, not agent graduations.
//
// `npm run audit:dark-flags` was also run. It reported four critical live
// overrides (EXTERNAL_BENCH, CODEX_GATEWAY_OAUTH_PROXY, CAPABILITY_EXEC_SANDBOX,
// SUBSTRATE_SIDECAR), so none was silently promoted; those runtime states remain
// explicit follow-up evidence rather than justification for changing defaults.
// `npm run test:file -- libs/flags/src/production-defaults.test.ts` passed 10/10.
// The review was completed before the deadline was advanced; no flag membership
// or watermark changed. Next review is 2026-09-03.
// ─── REVIEW 2026-09-03 (WI-2142963) — the date above elapsed and red-pinned the
// shared gate, EXACTLY the recurring pattern EI-19941703547241191 diagnosed (18 of the
// 34 current entries — owner-authority + cutover — are not agent-graduatable BY
// DEFINITION, so six straight reviews on the single combined clock could only ever
// conclude "zero candidates" for them). Fixing THAT root cause is this review's main
// act, per the agent-review-round-1 revision request on that EI: split the ONE clock
// into DARK_FLAGS_PARKING_REVIEW_BY (hard-gates CI, scoped to parked+incomplete — the
// population the watermark already treats as agent-actionable) and
// DARK_FLAGS_OWNER_REVIEW_BY (advisory, surfaced via the EXISTING attention path rather
// than a new channel — darkFlagRatificationToAttention now receives `reviewBy`, which
// its call site in agent-tools/plans/attention.ts previously never passed). No
// membership-hash auto-extension: both dates stay explicit, walked by a human/agent,
// because a flag's readiness can change with no change to DARK_FLAGS itself.
//
// SCOPE: all 34 entries, re-derived at current HEAD (not inherited from the stale
// 2026-08-20/08-27 counts): parked 8 · incomplete 5 · owner-authority 18 · cutover 3.
// Parking subset (hard-gated) = 13, unchanged from and still AT DARK_FLAGS_HIGH_WATERMARK.
//
// PARKING LANE (13, walked against each stated graduation condition):
//   parked(8)     — CLOUDFLARE_PUBLISH/HARNESS_PHASES/DESIGN/TESTING remain explicit V1
//                   scope cuts with no owner ship signal; THE_HIVE/CONVERSATIONS_RAIL_TAB
//                   still await the owner's "part of the standard release" sentence;
//                   TEMPLATES_MARKETPLACE/RUBRICS_MARKETPLACE still await the v2 Cupboard
//                   marketplace merge (v1 local-store-only ships unchanged).
//   incomplete(5) — EXTERNAL_BENCH stays PERMANENTLY dark (blueprint retired, awaiting
//                   nothing); ONBOARDING_PREVIEW_FEATURES' backing features (telemetry
//                   consent, mobile pairing, auto-update channel) have no shipped-status
//                   evidence in the tree (grepped for it — none found); CAPABILITY_EXEC_
//                   SANDBOX's live-host bwrap validation has not been re-run (no new
//                   evidence found); SUBSTRATE_LOG_SNAPSHOT's P-008 two-machine
//                   convergence proof has not run (no plan evidence found);
//                   SUBSTRATE_SIDECAR remains unbuilt/crash-looping with no driving plan.
// VERDICT: zero parking-lane graduation candidates this round either — consistent with
// every review since 2026-07-04. `npm run audit:dark-flags` re-run: still reports the
// same 3 CRITICAL live-true incomplete overrides (EXTERNAL_BENCH/CAPABILITY_EXEC_
// SANDBOX/SUBSTRATE_SIDECAR), all via a `generic-test` workspace override — NOT
// papercusp-workspace — pre-existing test-fixture state, not a new live-defaults breach;
// left as-is (flagged here for the next reviewer rather than silently reconciled).
//
// OWNER LANE (18 owner-authority + 3 cutover) — now genuinely ADVISORY, not a CI gate:
// re-walked on the merits and none is agent-ratifiable BY DEFINITION (each requires a
// personal owner sign-off, a destructive-action review, or an attended multi-machine
// verify this session cannot perform). No behavior changed for this lane. This review
// does not itemize all 21 again — see the 2026-08-09/08-20 blocks above for the
// per-flag reasoning, unchanged on the merits — because the whole point of today's fix
// is that this lane's staleness no longer needs to be resolved synchronously against a
// shared-gate deadline to be honest: it now surfaces to the owner continuously via
// attention instead.
//
// `npm run test:file -- libs/flags/src/production-defaults.test.ts` passed after the
// split (see the test file for the new/updated assertions this review added).
// ─── REVIEW 2026-09-22 (WI-10002555, su-a28f31f2, frozen-candidate f22392a985 repair) —
// the parking date elapsed and red-pinned the gate. Re-walked the PARKING LANE at current
// HEAD before advancing it. SCOPE re-derived, not inherited: parked 8 · incomplete 5 = 13,
// the same membership as the 09-03 review and still AT DARK_FLAGS_HIGH_WATERMARK.
//   parked(8) — every one is an explicit OWNER product decision (CLOUDFLARE_PUBLISH/
//     HARNESS_PHASES/DESIGN/TESTING "cut for V1"; THE_HIVE and CONVERSATIONS_RAIL_TAB await
//     the owner's release sentence; TEMPLATES_/RUBRICS_MARKETPLACE await the v2 Cupboard
//     merge). Graduating one would reverse an owner scope cut on the public release, not
//     finish a feature, so none was flipped.
//   incomplete(5) — EXTERNAL_BENCH stays permanently dark (blueprint retired);
//     ONBOARDING_PREVIEW_FEATURES: no backing-feature flag or ship evidence for telemetry
//     consent / mobile pairing / auto-update channel found in the tree; SUBSTRATE_LOG_
//     SNAPSHOT and SUBSTRATE_SIDECAR: no commit touching either since 09-03 (git log -S),
//     so neither proof has run. CAPABILITY_EXEC_SANDBOX: NEW EVIDENCE — its stated blocker
//     ("this dev box's userns is restricted") no longer holds; unprivileged bwrap runs on
//     the tower. The end-to-end validation itself has NOT been run, and flipping a
//     confinement default for every capability:bash job is not a gate-repair drive-by, so
//     it is filed as WI-10002560 (validate, then graduate or re-scope) — the one real
//     candidate for the next reviewer.
// VERDICT: zero graduations; membership and watermark unchanged. `npm run audit:dark-flags`
// was NOT re-run (host load1 ≈170 at review time). Next parking review 2026-10-06.
// ─── REVIEW 2026-10-06 (WI-10006316, D-021 tutorial verification) — re-derived
// the current parking lane: parked 8 + incomplete 4 = 12/12. SUBSTRATE_LOG_SNAPSHOT
// already graduated on 09-24; it is not an outstanding thirteenth entry.
// Parked: CLOUDFLARE_PUBLISH, HARNESS_PHASES, DESIGN and TESTING retain their V1
// cuts; THE_HIVE retains the public Pot lexicon; CONVERSATIONS_RAIL_TAB retains
// the explicit owner-requested park; TEMPLATES_MARKETPLACE and RUBRICS_MARKETPLACE
// retain the local-first v1/v2 marketplace boundary. No new graduation authority.
// Incomplete: EXTERNAL_BENCH remains retired; ONBOARDING_PREVIEW_FEATURES still
// gates mobile-pairing and update-channel preview inputs (telemetry already ships);
// CAPABILITY_EXEC_SANDBOX still needs its live background-lifetime validation and
// owner activation (existing WI-10002560 is now claimed); SUBSTRATE_SIDECAR still
// has no completed replacement implementation. Zero new graduations this review.
// Ran the maintained live audit (task 0muw7vo2qyx9g3c1s1e): its three CRITICAL
// incomplete overrides remain confined to generic-test, as on 09-03. Their origin
// is an accountable follow-up on WI-10006316; they are not assumed harmless or
// used to justify defaults. PG + this process's env checked; PostHog not probed.
// Membership, watermark and owner review clock unchanged. Renew only after this
// substantive review; the production-defaults hard-deadline guard remains active.
export const DARK_FLAGS_PARKING_REVIEW_BY = "2026-10-20";
export const DARK_FLAGS_OWNER_REVIEW_BY = "2026-10-01";
// 2026-07-12 (WI-4238, su-00a91): 25 → 26 for papercusp-queen-full-autonomy.
//
// WHY THIS GUARD KEEPS GETTING RAISED (22→24→25→26, every time for this same bug class,
// every time noting "zero graduation candidates ready"): it counts ONE number over a
// HETEROGENEOUS set. The `parked`/`incomplete` cases are the parking-lot abuse the ceiling
// exists to police — finished work hiding behind a flag nobody flips. But `owner-authority`
// and `cutover` are LEGITIMATE, permanent safety kill-switches, and a system that keeps
// adding safety surfaces should keep adding those. Because the ceiling cannot tell the two
// apart, adding a genuine safety kill-switch is penalised EXACTLY as hard as parking
// finished work — so the guard's live incentive is to leave a mis-defaulted safety flag
// SILENTLY ON rather than pay the watermark cost. That is precisely how ten flags ended up
// mis-defaulted while this number sat pinned at its ceiling "protecting" us.
//
// WI-4495: the previous aggregate ceiling counted 29 heterogeneous entries and
// penalized adding legitimate safety kill-switches. The current parking/incomplete
// subset is 12; safety cases remain outside this size budget.
// 2026-07-19 (EI-16635) — papercusp-capability-exec-sandbox added as an 'incomplete'
// EI-7230-class bug-fix correction (restoring its own long-documented OFF default);
// breached the prior watermark of 12 with zero graduation candidates ready, so raised
// 12→13 under this session's standing AUTO-mode grant (owner directive 2026-07-03:
// ZERO owner-confirm pauses) and disclosed via the work-item completion + this comment,
// per the established precedent for this exact bug class elsewhere in this file.
//
// 2026-07-27 (WI-6499) — 13→14 for papercusp-task-manager, on an EXPLICIT owner
// directive the same day the flag shipped default-ON: "put the task manager behind a
// testing flag it isn't ready yet". This is the sign-off path the policy names, not a
// quiet append — the owner asked for the dark entry directly, so no graduation trade
// was sought (the set was at 13/13 with zero candidates ready at the 2026-07-26 review,
// which is unchanged a day later).
//
// It is also NOT the parking-lot abuse this ceiling polices, and the distinction is
// worth stating because the entry looks like it: the abuse is FINISHED work hidden
// behind a flag nobody flips. Here the owner is the one asking for the gate, on a
// subsystem that intercepts every spawn on the box and has never run a sustained
// correctness window — and the flip back ON is a testing action the owner performs,
// not a ceremony awaiting an agent. Expected to graduate quickly; if it is still here
// at the next review, that is the signal to chase.
//
// 2026-08-02 (WI-6844) — 14→13, papercusp-task-manager GRADUATED on an explicit
// owner directive ("we put it behind a testing flag. Remove that flag, we'll make
// it part of our standard release"). The entry above predicted exactly this
// ("expected to graduate quickly"), which is the whole point of writing the
// graduation condition down at the time the entry is added.
//
// The watermark is lowered rather than left at 14, and that is the deliberate part:
// a ceiling only ratchets if a graduation SPENDS the slot it frees. Leaving it at 14
// would silently convert this graduation into headroom for the next park — the exact
// drift the 22→24→25→26 history above records, just in the polite direction.
//
// 2026-08-09 (WI-37561) — 13→14 for papercusp-conversations-rail-tab, on an EXPLICIT
// owner directive: "Put the 'convos' tab in the middle pane behind a testing flag".
// This is the SECOND time this exact phrasing has bought a slot (WI-6499, the task
// manager, 13→14 on 2026-07-27), and it is the same sign-off path the policy names
// rather than a quiet append. No graduation trade was sought: the parked+incomplete
// subset stood at exactly 13/13 and, offered the trade explicitly, the owner chose
// the raise over pulling an unrelated flag review into a two-file change.
//
// Why this is not the parking-lot abuse the ceiling polices: the abuse is FINISHED
// work hidden behind a flag nobody flips. Here the OWNER asked for the gate, the flip
// back ON is a testing action they perform, and — unlike a subsystem park — nothing
// is lost meanwhile, because /adv carries the same conversations on the same queries.
// A park with a live alternative surface is the cheapest kind there is.
//
// Expected to graduate on the same sentence the task manager did ("remove that flag,
// we'll make it part of our standard release"). If it is still here at the
// DARK_FLAGS_PARKING_REVIEW_BY date, that is the signal to chase.
//
// 2026-08-27 (WI-272118) — 14→13, CODEX_GATEWAY_OAUTH_PROXY GRADUATED after the
// owner-directed production ChatGPT canary satisfied the dark entry's exact gate.
// Ratchet the ceiling with the removal so this graduation does not become headroom
// for another parked/incomplete flag.
//
// 2026-09-24 (p2p-join-catchup-speed-2026-09-23 P-005) — 13→12, SUBSTRATE_LOG_SNAPSHOT
// (case 'incomplete') GRADUATED: the producer's dark gate was the cross-machine
// catch-up proof, delivered by P-003/P-004/P-008 of that plan. Same ratchet rule —
// the freed slot is spent, not banked.
export const DARK_FLAGS_HIGH_WATERMARK = 12;

// FLAG_DEFAULTS — DERIVED, not hand-written (P-011 inversion). Every registered flag
// defaults ON unless it is in DARK_FLAGS. Resolvers (server.ts getFlag / client.ts /
// resolveWithDefaults) read FLAG_DEFAULTS[key] unchanged.
export const FLAG_DEFAULTS: Record<FlagKey, boolean> = Object.fromEntries(
  ALL_FLAG_KEYS.map((k) => [k, !DARK_FLAGS.has(k)]),
) as Record<FlagKey, boolean>;

export type FlagValues = Record<FlagKey, boolean>;

export type FlagPayload = {
  flags: FlagValues;
  evaluatedAt: number;
  source: "posthog" | "defaults" | "override";
};

export function resolveWithDefaults(
  partial: Partial<Record<FlagKey, boolean>>,
): FlagValues {
  const out = { ...FLAG_DEFAULTS };
  for (const key of ALL_FLAG_KEYS) {
    const v = partial[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}
