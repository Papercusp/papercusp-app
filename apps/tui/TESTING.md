# Testing — `pui` (Papercusp terminal workbench)

Rust crate (`apps/tui`, binary `pui`). Tests are Cargo `#[cfg(test)]` modules —
the canonical home for Rust per the repo's four-framework convention.

Audio hardware is isolated in the sibling `pui-audio` binary. `pui` must not
link `libasound.so.2`; `package-release.sh` enforces that with `readelf`, while
the helper/proxy protocol and the exit-127 ALSA remedy are covered by Cargo tests.

## Run

```bash
cd apps/tui
cargo test            # all unit/integration tests (fast, offline) — the default
cargo clippy          # lint; the bar is 0 warnings
cargo test -- --ignored --nocapture   # live operator smokes; audio stays opt-in
```

## Install/update contract

The single supported local install/update path is:

```bash
./apps/tui/scripts/install-update.sh
```

It builds `pui` and `pui-companion.wasm` from one source generation, embeds the
generation in both, writes `~/.papercusp/pui-install.json`, and runs `pui doctor`.
It never stops a process or zellij session. Doctor detects stale long-lived PUI
panes and prints a pane/session-scoped relaunch instruction. The old plugin-only
`apps/pui-zellij-plugin/scripts/build-install.sh` path delegates to this script.

`cargo test` is fully offline (no operator, no network) and is what CI/`test:affected`
should run. The non-audio `#[ignore]`d live smokes require the operator running (an
`~/.papercusp/endpoint-ipc.json` socket present) and exercise the real wire.

## SU-session acceptance (real backends)

### Installed first-party composer (Claude)

Install the matched binary and companion using the installer above, then drive
the installed binary in an isolated PTY with the real structured Claude engine:

```bash
PUI_REAL_ENGINE=1 \
PUI_BIN="$HOME/.cargo/bin/pui" \
PUI_INSTALL_MANIFEST="$HOME/.papercusp/pui-install.json" \
PAPERCUSP_TEST_FILE_TIMEOUT_MS=900000 \
PC_HEAVY_KEY_ENV=PUI_REAL_ENGINE,PUI_BIN,PUI_INSTALL_MANIFEST \
npm run test:file -- packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts
```

This opt-in spends real provider tokens. It uses the normal configured Claude
model and default account, a production Hono host with a migrated test database,
and a separate PUI profile. All owner turns and the interrupt are keystrokes in
PUI. It checks a unique greeting, an unpredictable fixture file's actual Read
result, interruption of a running tool, a correlated follow-up in the same
session, installation hashes, and pipe-based engine processes with no native
terminal. The `PUI_INSTALLED_REAL_ENGINE_ACCEPTANCE` log preserves the terminal
frames, command and tool correlations, identities, and process observations.

Without `PUI_REAL_ENGINE=1`, the same file runs the deterministic protocol-peer
fault cases; those cases do not establish real-provider acceptance. The selected
live case and the intentionally excluded fault cases must be reported separately.

### Native backend matrix

PUI creates and reattaches Claude, Codex, and OMP sessions through the shared
SU-session host (`launch-su` plus the typed session stream). It does not fall back
to the removed PUI owned-loop/ModelPort provider-chat path. The opt-in matrix runs
the exact deferred pane argv under a PTY, then proves create, ready, attach, an
owner turn with a real tool result, identity stability, interrupt/resume, PUI
restart/reattach, end, and orphan-free reconciliation:

```bash
PAPERCUSP_REAL_BACKEND_MATRIX=1 \
PAPERCUSP_REAL_BACKEND_MATRIX_BACKENDS=claude,codex,omp \
PAPERCUSP_REAL_BACKEND_MATRIX_CLAUDE_ACCOUNT=<eligible-claude-route> \
PAPERCUSP_REAL_BACKEND_MATRIX_CODEX_ACCOUNT=<eligible-codex-route> \
PAPERCUSP_REAL_BACKEND_MATRIX_OMP_ACCOUNT=<eligible-omp-route> \
PAPERCUSP_TEST_FILE_TIMEOUT_MS=1800000 \
npm run test:file -- packages/operator-core/lib/su-session-real-backend-matrix.integration.test.ts
```

Use only account routes that both `accounts:status` and `psu`'s session-override
policy admit. The matrix defaults to the staging operator (`:3170`) and refuses
to spend tokens unless that operator's `launch-su.ts` blob matches the working
tree. A memory-pressure admission skip is **not measured**, never a backend pass.
The three-backend durable restart/reconciliation journey is separate and does not
spawn agents:

```bash
npm run test:file -- packages/operator-core/lib/su-session-restart-journey.integration.test.ts
```

## What's covered

- **`app.rs` — the reducer (pure, no I/O).** Tab switching, `j/k` nav + clamping,
  selection-after-refetch clamping, command palette capture, help overlay,
  harness cycling + Harnesses column focus toggle, docs scroll, presence-sidebar
  toggle, notifications (push → toast/badge/seq, history backfill, `N`/Esc/inbox
  clear, history cap), and the multi-step tutorial (advance/Esc-skip/F1-reopen).
- **`ui.rs` — rendering (pure `draw(&App)` over a ratatui `TestBackend`).** Each
  tab view + every overlay (help, palette, tutorial, toast, notifications, the
  change-card diff) is asserted by rendering to a fixed-size buffer and checking
  content. Includes the presence sidebar (online-only) and the Inbox
  notification badge. The change-card group carries its own calibrations: that
  the overlay honours `scroll` (the same fixture painted at two offsets — an
  overlay ignoring `scroll` cannot pass both), that it paints in the pinned dock
  pane whose early return is a separate wiring site, and that the transcript's
  "N change cards" hint names `{`/`}` rather than `Enter` when no cursor is set,
  since `effective_chat_focus()` resolves to the newest block either way and
  Enter there opens the composer.
- **`change_card.rs` — the diff surface (P-007), pure.** Detection across every
  seam spelling (`capability:edit`, the MCP-mangled `capability_edit`, `Edit`,
  `str_replace`, `str_replace_editor`, `Write`, `create_file`, `MultiEdit`,
  `NotebookEdit`); the LCS line diff, real hunk context recovered from
  `old_string`, hunk splitting, and the bounded degradations (`LCS_MAX_LINES`
  → whole-block replace that says so, `MAX_CARD_LINES` truncation that keeps
  the `+N -M` counts describing the whole edit); that the header never
  fabricates file line numbers; redaction of both copy forms; and that the
  cheap `is_change_card` predicate the renderer calls admits exactly what
  `card_for_tool` admits, over a fixture table asserted to exercise both
  answers.
- **`models.rs` — serde DTOs.** Each operator-API shape is parsed from a
  live-probed JSON fixture (plans, roster, attention, features, issues, projects,
  activity, testing domains, claude-settings, docs, toast-log), with null/missing
  fields defaulting (shape drift never hard-fails a deserialize).
- **`reap.rs` — leaked-session reaping (EI-186).** Owner-pid parsing of
  app-managed session names (`pui-<kind>-<pid>`), and the reap `plan()` over
  `zellij list-sessions --no-formatting` fixtures: dead-owner sessions are
  killed, EXITED husks deleted, foreign (non `pui-*`) sessions never touched.
  Liveness is injected, so decisions are tested without spawning zellij; the
  exec path is smoke-tested live via `pui reap` against a planted session.
- **`framing.rs` / `ipc.rs` — the IPC transport.** Frame encode/decode
  (round-trip, partial, oversize, unknown type) + an end-to-end client over a
  **fake Unix-socket server**: `sys_http` body reassembly, non-2xx errors, and
  `invoke_stream` streaming-then-terminal.
- **`sse.rs` — the SSE parser.** Frame splitting, partial-frame remainder,
  incremental reassembly, CRLF + multi-line `data:`.
- **`http.rs` — the HTTP transport.** Incremental UTF-8 decode (multibyte split
  across chunks) + an end-to-end client over a **fake TCP HTTP server**: bearer
  header sent, body parsed, non-2xx errors, and streamed SSE frames.
- **`mux.rs` / `layout.rs` — zellij control.** `zellij action`/`zellij pipe`
  command construction (pure argv, incl. the dockview swap-layout/float CLI
  fallbacks) + the workbench KDL contract (stacked-by-default base + the four
  `swap_tiled_layout` presets, `SWAP_PRESETS` cycle order) + `materialize`.
  Dockview dock-verbs (Brief 50): the palette parse (`:stack`/`:float`/`:dock`/
  `:layout`), the reducer resolving them against the live topology into
  `Action::Dock` (work-set/HUD computation, target resolution, no-companion error
  paths), and the palette's preset-label rendering are in the `app.rs`/`ui.rs`
  tests. The full proto→plugin→zellij path is the plugin's `dock-verbs-smoke.py`.
- **`tutorial.rs` — first-run state.** `pui-state.json` seen/mark round-trip,
  key-preserving merge, malformed-file → unseen.
- **`companion.rs` — companion zellij plugin link (P-004 / D-008).** The pure
  helpers: the `zellij pipe` child argv, the `file:` plugin URL, `PaneSpec` →
  `OpenCommandPane`, and `PluginEvent` → `Event` mapping. The reducer arms for
  the companion events live in the `app.rs` tests: topology stored;
  `workbench_summary` (incl. the `▶ <focused>` focus-follow indicator); pane-exit
  → notification + `r`-to-relaunch arming (`relaunch_spec` re-runs the exited
  command via `sh -c`, one-shot); a plain shell exit does NOT arm relaunch;
  pane-close → topology prune. The status-bar indicator render is in the `ui.rs`
  tests. The live process spawn + duplex is covered by the plugin crate's live
  smoke (see below), not here.
- **`install.rs` / `tests/install_contract.rs` — artifact generation (P-021).**
  Manifest/hash/source-generation checks, selected-operator source comparison,
  safe stale-pane guidance, the binary+WASM single-installer contract, and a
  source guard that forbids process/session-kill commands in the installer.

## Live smokes (`-- --ignored`, need a running operator)

`cargo test -- --ignored` runs the non-audio operator/IPC smokes, but the three
`voice.rs` device smokes require an explicit `PUI_LIVE_AUDIO=1` opt-in. This keeps
the ignored suite green on headless development and CI hosts instead of treating
missing audio hardware as a product failure. When the opt-in is absent, the voice
tests print `SKIP` and return without opening an audio device.

- `ipc::live_ipc_smoke` — `sys:http` GET over the real socket returns plans.
- `ipc::live_sse_subscription_smoke` — raw `invoke_stream` of the SSE route.
- `ui::live_client_subscribe_sse` — the transport-agnostic `subscribe_sse` gets a
  live heartbeat frame.
- `ui::live_toast_log_fetch` — `recent_toasts` over the real wire.
- `ui::live_presence_sidebar_render` — renders the real roster into the sidebar.

## Audio device smokes (`voice.rs`, isolated null-sink — no running operator)

The `#[ignore]`d hardware smokes in `src/voice.rs` exercise the REAL cpal capture +
rodio playback path (not faked): `smoke_record_yields_16k_wav`, `smoke_play_tone`,
and `smoke_loopback_tone_roundtrip` (plays a 440 Hz tone and captures it back,
asserting the tone survived). They need an audio device, so run them through a
PipeWire **null-sink** that isolates them — zero audible sound, the Brio mic / HDMI
out defaults untouched:

```bash
scripts/audio-loopback-smoke.sh   # loads a null-sink, runs the 3 smokes, unloads it
```

The wrapper sets `PUI_LIVE_AUDIO=1` and routes both cpal and rodio through the
temporary null-sink. It exits 0 when PipeWire/PulseAudio or the null-sink module
is unavailable (an environmental skip), and always unloads its temporary module.
To invoke the tests directly, export `PUI_LIVE_AUDIO=1` yourself and set
`PUI_VOICE_INPUT` / `PUI_VOICE_OUTPUT` to the cpal device-name substrings you
intend to exercise.

This is the device-level complement to the deterministic, no-hardware **synthetic-voice**
bus E2Es at `packages/operator-core/lib/voice-node/operator-voice-{multiclient,synthetic-audio}.test.ts`
(synthetic voice through the real socket + `OperatorVoiceSession`, fake EL). It needs
PipeWire + `pactl`, so it's a local dev smoke, not CI. (Agent memory:
`isolated-audio-e2e-null-sink`.)

### Live real-EL E2E (`scripts/live-operator-voice-e2e.mjs`)

The full P-011/P-013 leg — synthetic speech (espeak-ng) streamed at real-time pace
into the RUNNING operator's voice host, through **real ElevenLabs** (STT → relay
ack → Papercup pane answer via `voice:say`), with two bus clients asserting the
shared-session contract (both get the input transcript, the relay ack, the later
pane answer, and response audio; exactly one elected player):

```bash
node scripts/live-operator-voice-e2e.mjs ["utterance"]   # exit 0 pass · 2 EL-unconfigured · 1 fail
```

Requires a running operator + espeak-ng + ffmpeg, AND ElevenLabs configured
(`/settings/voice` → `fullAgentEngine=elevenlabs-conv` + agent ID; `/settings/api-keys`
→ EL API key). Burns one short EL session — run deliberately, not in CI. Without EL
config it exits 2 after proving the host's graceful error path.

## What's NOT covered (known gaps)

- **Interactive TTY behaviour** — actual terminal rendering, raw-mode input, and
  the crossterm event loop are not exercised (the reducer + `draw` are tested in
  isolation; the alternate-screen/raw-mode shell in `main.rs` is not). First
  human-interactive run still pending.
- **HTTP transport live** — only unit-tested via a fake server; never run against
  a real operator (the dev box resolves IPC, has no `operator.json`). The remote
  path needs an SP1 `serve` instance to verify end-to-end.
- **zellij live** — only command construction is tested here; spawning/driving a
  real zellij session (and the `pui workbench` layout) is unverified in this
  crate. The companion plugin's live duplex (open/focus/close panes, pane-exit
  detection) IS verified end-to-end by `apps/pui-zellij-plugin/scripts/live-smoke.py`
  against an isolated zellij session.
- **OS notifications** — `notify::os_notify` is best-effort (no D-Bus assertion);
  delivery isn't tested, only that it never panics.
- **coord_inbox listener (P-002)** — not built (gated on the TUI coord
  owner-identity decision + an operator SSE route).

## After editing

Run `cargo test` + `cargo clippy` (0 warnings) before declaring done. If you
touched the wire (`ipc.rs`/`http.rs`/`client.rs`/`sse.rs`/`models.rs`), also run
the live smokes against a running operator to confirm the real shapes still parse.
