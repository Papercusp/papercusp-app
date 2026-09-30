# MCP transport resilience — client-side death detection + in-place heal (2026-07-13)

**Owner directive (2026-07-13, interactive):** after a live incident
(su-39f079d3's papercusp-su MCP transport severed by a Claude Code self-relaunch;
session ran tool-less ~5h, monitor loop silently dead, undetected):
*"I'd rather just have /mcp inject — that's better than having my session suddenly
die on me and not knowing why. The session kill and resume could make sense for a
headless session but not for a headed session."*

## The gap this closes

The system has strong SERVER-side MCP resilience (mcp-host-availability-resilience
2026-06-22: permanent URLs · sticky approval · the :9071 proxy) and a Layer-4
safety net (`mcp-dark-watchdog`) — but that watchdog structurally cannot see the
incident class that hit today:

1. It scans only `spawned_agents` (nursery bees). **Interactive psu sessions are
   invisible to it** — no supervisor row, no `last_output_at`.
2. Its darkness test is pinned to `restartAt` = operator boot. A **client-side**
   transport death (Claude Code self-re-exec: auto-update relaunch or TUI
   fullscreen switch drops the HTTP-MCP binding and rebuilds argv) happens hours
   after boot; `presence_heartbeat >= restartAt` stays true → never dark.
3. Gate (c) requires actively-generating output. A **headed session idle at its
   prompt between loop wakes** — the common interactive case — never matches.
4. On detection it only **notifies**. No heal.

Blast radius of a client-side transport death is worse than "tools gone": the
session's `loop:checkpoint` / `facts:assert` carry surfaces AND the armed loop's
`events:await` re-registration all ride the same transport, so **the monitor loop
silently dies with it** — the exact silent-halt class the compaction playbook
exists to prevent.

## Design (five pieces)

### P-001 — Kill the main trigger: no mid-session self-update re-exec
`psu-launcher.mjs` adds `DISABLE_AUTOUPDATER: '1'` to the claude spawn env
(opt-out: `PAPERCUSP_CC_AUTOUPDATE='1'`). The auto-update relaunch is the main
mid-session re-exec trigger; version freshness moves to spawn time. The TUI
fullscreen-switch re-exec remains possible (rarer, user-initiated) — P-003/P-005
cover it.

### P-002 — Persist launch flags to disk so a re-exec loses nothing
argv is ephemeral (rebuilt empty on re-exec); disk config is re-read at startup,
INCLUDING a re-exec restart. The launcher already creates a per-session isolated
`CLAUDE_CONFIG_DIR` (EI-155) — at launch, merge into its `settings.json`:
- `permissions.defaultMode` (mirrors `--permission-mode` / skip-permissions)
- `permissions.deny` (mirrors the `--disallowedTools` deny flags — the
  native-scheduler + no-subagents sets), so a re-exec re-applies them
  MECHANICALLY instead of the current honor-the-playbook fallback.
Residual (upstream, P-006): `--system-prompt-file` has no settings equivalent —
the SessionStart recovery hook remains the mitigation; `--session-id` drift is
reconciled by the supervisor path, not prevented.

### P-003 — Host-side `mode:'mcp-reconnect'` macro (the "/mcp inject")
New gated control mode in `psu-pty-host.mjs`, following the `mode:'compact'`
executor skeleton (idle gate + agent-busy gate + inject mutex + submit-verify +
`appendHostEvent` + fail-soft). The HOST runs the whole macro — it owns the pty
and sees output bytes; the operator never remote-types blind:
1. Gated entry (never mid-turn, never over a half-typed owner line).
2. Submit `/mcp` (claude backend only — other backends drop with a host event).
3. Wait for the dialog paint; tap the child-output stream into a rolling buffer,
   ANSI-stripped.
4. Navigate: find the line containing the target server name; arrow-down until
   the ❯ selection marker sits on it (parse-check after each keypress, bounded);
   Enter; on the detail view find/select the reconnect action the same way.
5. Watch for the connected marker (bounded ~20s); Esc Esc to close.
6. ANY unmet expectation → Esc Esc + `appendHostEvent('mcp-reconnect-failed')` +
   stop. Worst case is exactly today's status quo.
Advertise `caps: ['compact','mcp-reconnect']` in the discovery meta. Truth of
the heal is judged OPERATOR-side (P-005), never off screen-scraping alone.

### P-004 — Discovery/operator plumbing
`psu-pty-discovery.ts`: add `'mcp-reconnect'` to the `injectIntoHost` mode union
+ `mcpReconnectViaPty(ownerId, serverName)` mirroring `interruptViaPty`
(findLiveHost → hostSupports → injectIntoHost). Callers fall back to notify when
the host is old (no cap) or absent.

### P-005 — Watchdog: interactive sweep + heal ladder
Extend `mcp-dark-watchdog.ts` with a SECOND sweep for interactive sessions:
- **Population:** `listLiveHosts()` (live psu-pty hosts: ownerId, pid,
  lastActivityAt) — covers dock AND gnome-terminal psu sessions (the launcher
  hosts the pty inside the window; wake injection already proves reachability).
- **Signal (NOT pinned to operator boot):** host alive AND
  (owner has an ACTIVE armed loop AND presence beat stale > max(3×intervalSec,
  20min)) OR (pty activity fresh <10min AND presence beat stale >30min).
  The tool-call-coupled `coord_presence.heartbeat_at` freezing while the pty
  lives IS the transport-death signature.
- **Heal ladder (headed):** `mcpReconnectViaPty` (rate-capped 2/owner/hour) →
  poll presence beat up to ~2min → advanced ⇒ healed: inject ONE follow-up wake
  turn ("your MCP transport died at <t> and was auto-reconnected — re-verify
  loop:status and re-arm; your events:await registrations died with the old
  transport; re-park unflushed state") → not advanced ⇒ fall through to the
  existing notify + broadcast path.
- **Headless** [owner-approved]: kill+resume via the existing recycle/resume
  machinery (wake-executor channel 2 already resumes dead processes; a
  transport-dead-but-alive headless host takes `mode:'recycle'` with carry).
- Benign misfire is safe by construction: transport actually fine ⇒ dialog
  opens, all-connected, macro Esc's out — a no-op flash.

### P-006 — Agent playbook (insights doc) + upstream
Insights doc: MCP tools vanish mid-session → diagnose via bash (curl the :9071
`initialize` handshake) → server healthy = client transport dead → park state in
FILES (the MCP carry surfaces are dead too), surface to owner (`/mcp` →
reconnect); the watchdog auto-heal should land within ~5min.
Upstream (Anthropic): (a) argv preservation across self-re-exec; (b) a
non-interactive `/mcp reconnect <name>`; (c) auto-retry failed streamable-HTTP
MCP servers. None are blockers — the layers above work without them.

## Verification
- Unit: pure helpers (dialog-parse, verdict fn extension, settings merge) —
  vitest, PG-free, alongside existing test files.
- Integration: psu-pty-host integration tests already spawn real ptys — extend
  with a scripted fake-TUI dialog exercise for the macro walker.
- Live: kill a scratch session's transport (SIGSTOP the proxy path for it /
  re-exec claude) and watch detect→heal→follow-up land end-to-end.

## Status
- Authored during the 2026-07-13 incident by su-39f079d3 (MCP down — plan not
  yet registered in the plans system; import on reconnect).
- **P-001..P-005 IMPLEMENTED + unit/integration green (same session):**
  - launcher: `DISABLE_AUTOUPDATER` + `persistReExecSafePermissions` —
    psu-launcher.test.ts 407/407 (8 new);
  - host: `mode:'mcp-reconnect'` + `runMcpReconnectMacro` + output taps +
    caps — psu-pty-host.test.ts 113/113 (15 new, incl. a scripted fake-TUI
    end-to-end walk), real-pty integration 21/21;
  - discovery: mode union + `mcpReconnectViaPty` — 30/30 (wake-executor
    consumers 87/87);
  - watchdog: `evaluateInteractiveMcpDark` + `planInteractiveHeal` heal ladder
    riding the mcp-dark timer (kill-switch `PAPERCUSP_MCP_DARK_INTERACTIVE=0`)
    — 20/20 incl. the su-39f07 incident-shape regression.
- **ACTIVATION:** bg-host loads the watchdog at process start → lands on its
  next restart (do it with a fleet heads-up, not blind). Existing psu-pty hosts
  lack the 'mcp-reconnect' cap → watchdog falls back to notify for them; new
  sessions get the macro. LIVE-DIALOG CAVEAT: the walker is validated against a
  scripted fake TUI + fail-soft; run the plan's live verification (kill a
  scratch session's transport, watch detect→heal→follow-up) before trusting it
  at production cadence.
- Known v1 hardcode: interactive escalation rows use harness_slug='papercusp'.
