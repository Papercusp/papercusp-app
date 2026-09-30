# Voice mode
URL: /internal/docs/spec/voice-mode

Browser-side voice runtime for app-level + Operator-panel voice control. STT/TTS across a selectable engine matrix (Web Speech, local Whisper/Kokoro, ElevenLabs, OpenAI, Deepgram, Cartesia).

import { Aside } from '@astrojs/starlight/components';

## Why

Voice mode lets a user direct the app by speech instead of (or alongside) clicks and keystrokes. Two scopes:

1. **In-Operator-panel** — utterances drive Operator's scan loop; suggestion text is read aloud as it streams.
2. **App-level** — when the Operator panel is closed, utterances route to Oracle, whose UI-routing tools (navigate, listHarnesses, dispatchToAgent) provide whole-app control.

## Modes

```
off ──click──▶ push-to-talk ──click──▶ always-on ──click──▶ off
```

* **off**: STT/TTS disabled. Voice button shows 🚫. (The 🎤 icon is the `idle` status, once voice is on; the button styles itself via `pc-voice-btn--mode-*` / `pc-voice-btn--status-*` classes, not a border tint.)
* **push-to-talk** (PTT): hold the voice button; STT runs while held; release submits.
* **always-on**: continuous wake-word listening. When the wake phrase is detected, the runtime switches to active listening for the rest of the utterance, then submits.

## Wake word

Default: `"hey papercup"` (`DEFAULT_CONFIG.wakeWord`). Configurable per-browser at `/settings/voice`. (`"hey operator"` is only an illustrative example string in a settings hint, not the runtime default.)

A 3-syllable phrase that doesn't appear in normal speech works best. Single-word wake words misfire often (per round-2 design discussion). The phrase must be in the user's spoken sentence; everything after it is captured as the utterance.

## Barge-in

A new always-on utterance cancels any TTS that is currently playing. Implementation: `cancelAllSpeech()` runs on the always-on activation paths — the wake-word fast path and `activateListening()` — and on mode-off teardown. Push-to-talk's primary capture path (`startPushToTalk` → `maybeStartCaptureForPtt`, raw/Deepgram capture) does **not** call it directly; PTT only cancels TTS via its Web-Speech last-ditch fallback, which routes through `activateListening('')`.

## Per-role voices

Each role gets its own voice, stable across harnesses, browser sessions, and restarts. Implementation:

* The runtime hashes the role name (e.g. `system:operator`, `orchestrator`) to a stable index into the available browser voices.
* The assignment is persisted to localStorage (`papercusp.voice.config.v1`).
* `assignVoiceToRole()` (`voice-mode.ts`) remains the programmatic override API, but as of the 2026-07-09 settings cleanup **the per-role/per-slug override UI (the role→voice table + per-slug composite-key overrides) was removed from `/settings/voice`** — there is no longer a Select-per-role or a "role @ slug" override table in the page. What remains at `/settings/voice` is a **"Test all N role voices"** button (`onTestAllRoles`) that plays each `KNOWN_ROLES` entry through its auto-assigned voice in sequence (with an ElevenLabs cost-confirm when that engine is selected) — a listen-only sanity check, not an override control.

When the same role speaks (e.g. `system:operator` from two different harnesses), the same voice plays.

## Single-utterance queue

Only one utterance plays at a time, FIFO. If multiple agents emit text concurrently:

* Operator panel: only the in-focus speaker is queued (the panel routes one role at a time).
* VoiceAppBridge: speaks Oracle's deltas; queues across sentence boundaries.

This prevents overlapping voices.

The queue is hard-capped at 8 items (`SYNTH_QUEUE_MAX`); `speak()` trims to the newest 8 and drops the oldest beyond that, so a stuck TTS engine can't accumulate a runaway backlog.

## Consumer priority

The chrome runs both Operator panel and the VoiceAppBridge. Only one should consume utterances at a time:

* Operator panel calls `registerVoiceConsumer('OperatorPanel')` while open.
* VoiceAppBridge checks `hasHigherPriorityConsumer()` before routing to Oracle. Returns `true` if any registered consumer is active.

So utterances go to:

* Operator panel when open.
* Oracle (via VoiceAppBridge) when Operator is closed.

## Engines

Voice mode is **not** Web-Speech-only. STT, TTS, and the realtime full-agent shell each route through a selectable engine, chosen from `/settings/voice` and read from voice-prefs at init:

* **STT** (`prefs.sttEngine`): `web-speech` (browser `SpeechRecognition`) or `voicemode` (local Whisper server at `http://localhost:2022`). Each path falls back to wake-word Web-Speech listening if its engine is unavailable. **`deepgram` is currently non-functional** (2026-07-09 voice-engine slim-down deleted `lib/voice-engines/deepgram.ts`, but the `deepgram` option is still offered in `/settings/voice` and still selectable as `prefs.sttEngine`): both the always-on and PTT capture paths in `voice-mode.ts` now detect `sttEngine === 'deepgram'` and silently degrade to the free wake-word/voicemode path instead of streaming — no error, no cloud call, just a console warning. Tracked as WI-3510 (remove the dead option from settings, or reintroduce the engine).
* **TTS** (`prefs.ttsEngine`, via `fetchPreferredEngine()`, default `kokoro`): `kokoro` (local), `openai`, `elevenlabs`, `cartesia`, or `browser` (Web Speech `SpeechSynthesis`). The adapter route POSTs to `/api/agent-mcp/operator-tts-preview`; each engine has its own per-role voice pool (`voiceForEngineRole`).
* **Full-agent realtime** (`prefs.fullAgentEngine`): `elevenlabs-conv` (ElevenLabs Conversational AI) or `openai-realtime`.

Because the local (Voicemode/Whisper + Kokoro) and cloud engines cover runtimes that lack Web Speech (e.g. the WebKitGTK desktop webview), the runtime sets `supported: true` unconditionally — the `is-unsupported` / `cursor: not-allowed` degraded button state exists but is never reached in practice. Web Speech is one path among several, not a requirement, and server-side routes back several engines, so this is **not** a purely in-browser, no-backend runtime.

## Privacy

* The processing path depends on the selected STT/TTS engine: Web Speech routes to the browser vendor's cloud (Chrome → Google, Safari → Apple, Edge → Microsoft); Voicemode/Kokoro/Whisper run on a local server; ElevenLabs, OpenAI, and Cartesia (TTS) are cloud services reached via app routes. Deepgram (STT) is currently dead code — see the Engines section above.
* The runtime does not record or persist raw audio.
* See **Privacy modes** below for `wake-word-gated`, which keeps the mic on-device until a local wake-word engine fires.

## Privacy modes

`prefs.voicePrivacyMode = 'wake-word-gated'` runs a **local, on-device** wake-word engine (Porcupine via `@picovoice/porcupine-web`, or openWakeWord) so no audio streams to a cloud full-agent until the wake word fires:

* `startWakeWordGate()` boots the engine named by `prefs.wakeWordEngine` (`porcupine` | `openwakeword`); `off` is rejected with a toast.
* Porcupine requires a Picovoice key (bootstrapped via `/api/agent-mcp/operator-picovoice-bootstrap`); openWakeWord runs without a key.
* On wake-fire, the local listener is torn down (it shares the mic) and the ElevenLabs Conv-AI session is brought up. The mic only streams to EL **between** wake-fire and idle-disconnect.
* The gated session uses its own idle budget, `prefs.wakeGatedIdleTimeoutSec` (clamped 5–300s), instead of the always-on default.

## Session lifecycle

Realtime full-agent sessions (EL / OpenAI Realtime) are bounded so an abandoned tab can't run the meter indefinitely:

* **Idle disconnect** — auto-disconnect after `prefs.fullAgentIdleTimeoutMin` of inactivity (default 2 min).
* **Hard session-max** — a ceiling regardless of activity, `prefs.fullAgentSessionMaxMin` (default 30 min; `0` = no max). Backstop for stuck-session edge cases.
* **Single-leader-tab election** — a cross-tab voice-lease (`requestVoiceLead` / `getVoiceLeaderState`) elects one tab to own mic capture, STT, and TTS, so audio never doubles across tabs. (This is the per-tab leader, distinct from the cross-surface Model-A host below.)
* **ElevenLabs spend cap** — before opening an EL session, the runtime checks `/api/agent-mcp/operator-el-spend`; it refuses to connect when over the monthly cap and warns past 80%.

## Surfaces

* `apps/operator/app/_components/voice/voice-mode.ts` — runtime singleton (modes, queue, voice assignment).
* `apps/operator/app/_components/voice/VoiceButton.tsx` — chrome header toggle.
* `apps/operator/app/_components/voice/VoiceAppBridge.tsx` — app-level routing to Oracle when no priority consumer is registered.
* `apps/operator/app/settings/voice/page.tsx` — settings (wake word, rate, per-role voice picker, Test).
* `packages/operator-core/lib/voice-node/operator-voice-session.ts` — the shared realtime-session **host** (below); `operator-voice-host.ts` boots it.
* `packages/operator-core/lib/voice-node/operator-voice-bus.ts` — the typed session-bus codec (frame block `0x10–0x1F`).
* `apps/operator/app/_components/voice/desktop-operator-voice-client.ts` — the desktop webview's bus client.
* `apps/tui/src/voice_convai.rs` + `apps/tui/src/operator_voice_bus.rs` — the pui's bus client + Rust codec.

## Shared realtime session — desktop + tui on ONE EL/operator session

universal-voice-interface-2026-06-05 (Model A). The realtime operator voice session is **hosted once by the voice service**, not per surface, so desktop and the pui are two windows onto one conversation rather than two private sessions.

The realtime path (ElevenLabs Conv-AI shell relaying into the Sentinel pane, the one brain of record) runs as **one session hosted by the operator**; desktop and the pui (tui) both **attach as full clients**. Both see the same input transcript AND the same response (audio + transcript + control tags), and either can drive controls. (Retired: EL used to run `${role}:converse` in-process as a second, voice-only brain — a modality split-brain the one-brain relay above removed.)

* **Host.** `OperatorVoiceSession` owns the single EL WebSocket: it mints the signed URL, connects, and broadcasts input transcript + response audio/transcript/tags + session state to **every** attached client. A control (mute / PTT / start / stop / set-mode / force-host) from any client is applied **once** and the new state is broadcast back.
* **One-brain relay (voice-unified-sentinel-pipeline-2026-07-01, D-001/D-002).** The EL agent is a voice **front-end**, not a brain: it no longer runs `ask_operator` in-process. Every final user transcript is relayed to the Sentinel pane — the one brain of record — via an injected `relayToBrain` port; the EL `ask_operator` tool call returns only an instant spoken ACK (`"On it — I'll come back to you in a moment."`, capped at \~2.5s so a slow relay doesn't stall EL) or a spoken failure line (no dock / pane restarting / write failed). The pane's real answer arrives later through the sentinel-says pump (`voice:say` → synth → this same bus), so voice and typed text share one pipeline and one conversation state.
* **Bus.** Typed session messages ride the **same** `local-audio-socket` + `desktop-voice-ws` byte-pipe the P2P voice channels use (frame block `0x10–0x1F`) — no new socket. The pui attaches over the unix socket directly; the desktop webview over the loopback WS bridge.
* **Model A — single elected playout.** The cross-surface **voice-lease** elects ONE client as host + **player**: only that client renders response audio and captures the mic, so audio never doubles/echoes. Non-holders are **never refused** — they stay receive + display + control clients. `force=1` (force-host) takes over playout; a plain `start` while another client hosts does **not** steal the role. If the player drops, the host re-elects another attached client, so the session survives either UI closing.
* **One thread.** Input + response turns persist **once** to the single workspace operator conversation (the host is the sole writer), deduped by the EL conversation id — desktop, tui, and history are one thread.

## Tests

* `voice-mode.test.ts` — 7 tests: init (off state), voice listing, voice-assignment persistence across calls, per-role voice distinction, wake-word-config persistence, explicit voice assignment, and TTS-mute default+round-trip.
* `voice-consumers.test.ts` — 5 tests across two describe blocks: register returns a deregister fn, multiple consumers concurrently, deregister idempotency, back-compat name-only defaults to panel-open, and accepts explicit priority + `onUtterance` handler.

## Out of scope (deferred)

* **Multi-lingual voice** (current default is `en-US`). v1.5.
* **Voice-only login / lock-screen control**. Out of scope.
* **Per-harness voice override** (currently per-role only). A per-slug (`role@slug`) override table existed briefly in `/settings/voice` (a v1.5 experiment) but was removed in the 2026-07-09 settings cleanup along with the per-role override table — see "Per-role voices" above.
