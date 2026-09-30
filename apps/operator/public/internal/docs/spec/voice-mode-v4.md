# Voice mode v4
URL: /internal/docs/spec/voice-mode-v4

Current Papercusp voice architecture: local STT/TTS, hosted full-agent sessions, the operator voice host, Papercup pane routing, wake-word engines, and the shared one-brain voice pipeline.

Voice mode is the operator's audio surface. As of **July 1, 2026**, the live
system is no longer "one brain per surface." Typed text, hosted voice sessions,
and the docked Papercup all converge on **one conversational brain**: the
Papercup pane. The operator voice host owns the transport; the pane owns the
thinking.

This page is the current architecture reference. The filename stayed
`voice-mode-v4` for continuity, but the content here tracks the shipped
`voice-unified-papercup-pipeline-2026-07-01` topology, not the older
`lib/voice-*` split-brain path.

## The two live voice paths

There are two distinct runtime modes:

| Path                          | When it runs                | Where STT/TTS happen                                      | Who is the brain                                                  |
| ----------------------------- | --------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| **Local browser voice mode**  | `fullAgentEngine === 'off'` | Browser + local/cloud adapters selected in prefs          | The local dispatch path in `voice-mode.ts` / `VoiceAppBridge.tsx` |
| **Hosted full-agent session** | `fullAgentEngine !== 'off'` | Operator voice host + attached desktop/TUI/mobile clients | **The Papercup pane** (relayed through the host)                  |

The second path is now the dominant one. It is what powers the shared desktop +
TUI voice session, the Herald/Papercup voice, and the deep-delegation answer
loop.

## One-brain architecture

The important invariant is:

```text
user speech
  -> transport capture
  -> operator voice host
  -> Papercup pane stdin (writeToSentinelPane)
  -> Papercup thinks / may delegate
  -> Papercup answers via voice:say
  -> papercup-says PG FIFO
  -> operator voice host pump
  -> attached clients render + speak the same answer
```

That is implemented by:

* `packages/operator-core/lib/voice-node/operator-voice-session.ts`
* `packages/operator-core/lib/voice-node/operator-voice-session-deps.ts`
* `packages/operator-core/lib/voice-node/operator-voice-host.ts`
* `packages/operator-core/lib/voice-node/sentinel-says-pump.ts`
* `packages/operator-core/lib/endpoint-route/routes/operator/sentinel-input.ts`
* `apps/operator/app/_components/voice/voice-sentinel-bridge.ts`

### Why this replaced the old model

The retired architecture let a voice surface answer through a local
`${role}:converse` path while typed text and Papercup-pane traffic followed a
different route. That created a split-brain system:

* typed text and voice could disagree
* voice-only features had their own state
* deep analysis had no way to return through the same conversational lane

The current host fixes that by treating hosted voice engines as **transport**,
not as the source of truth. In the full-agent path the user hears a short relay
ack immediately, then the real answer comes back from the pane through
`voice:say`.

## Full-agent session path

When `fullAgentEngine !== 'off'`, voice mode bypasses the per-utterance local
STT/TTS loop.

### Session owner

`packages/operator-core/lib/voice-node/operator-voice-host.ts` starts a
singleton `OperatorVoiceSession` in the operator host. That host:

* opens the provider session
* elects exactly one active player/mic holder via `voice-lease.ts`
* broadcasts state, transcripts, tags, and audio to every attached client
* relays final user transcripts to the Papercup pane
* pumps `voice:say` output back into the same shared session

### Provider contract

The full-agent engine is a **front-end**. In the ElevenLabs path, the signed URL
and prompt override come from `operator-voice-session-deps.ts`, which injects a
relay persona:

* every user turn must call the voice tool
* the tool returns a short immediate ack
* the provider must not answer from its own knowledge

The actual answer arrives later from the pane and is spoken through the same
session bus.

### Shared voice bus

Desktop and TUI are peers on the same operator-voice bus:

* desktop webview attaches through `/api/desktop/voice-config` plus the loopback
  WebSocket bridge in `voice-node/desktop-voice-ws.ts`
* TUI attaches through the local audio socket / operator-voice bus
* the host emits one stream of transcripts, tags, and response audio to all of
  them

Only the elected player renders playout and captures mic; non-elected clients
remain receive/display/control peers.

## Papercup pane ingress and egress

### Voice-in

`POST /api/operator/papercup-input` is the local text-to-pane seam.

* browser STT or host-side full-agent relay hands text to this route
* the route calls `writeToSentinelPane()`
* the target pane is discovered through the dock registration file managed by
  `psu-papercup`
* warm-up and exited-pane guards live in `papercup-pane-input.ts`

This is a **local app user** surface, not the P2P voice-channel system.

### Voice-out

The pane speaks by calling `voice:say`.

That no longer pushes into a process-local array. It lands in the shared
Postgres FIFO described in
[The Papercup's voice-out crosses processes](/internal/docs/agent-insights/papercup-voice-out-is-cross-process).

Two consumers exist, but never at the same time:

* **full-agent session live**: `papercup-says-pump.ts` drains the FIFO
  server-side and broadcasts transcript + synthesized audio on the shared voice
  bus
* **no full-agent session live**: the webview's local-mode
  `drainSentinelOutput()` poll speaks those lines itself

The `sessionLive` gate is what keeps one consumer active.

## Deep-thinking delegation lane

The unified voice pipeline also introduced a separate lane for answers that need
real investigation.

There are now three kinds of "voice action":

| User intent                 | Mechanism                                 | Result                                                                              |
| --------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| Ask for an immediate answer | Papercup answers directly                 | Spoken + written in the same pane/session                                           |
| Ask for buildable work      | `<handoff_to_mug>`                        | Work item for the Mug to place                                                      |
| Ask for sustained analysis  | `<delegate_deep>` / `voice:delegate_deep` | Background deep-analysis worker returns `[deep-answer WI-NNN] …` into the same pane |

The deep lane is implemented by:

* `packages/operator-core/lib/agent-tools/voice/delegate-deep.ts`
* `packages/operator-core/lib/sentinel/sentinel-deep-delegate.ts`

Its contract is:

1. Papercup stays conversational and acks quickly.
2. A durable `research-task` work item is created.
3. An ephemeral background analysis worker investigates.
4. The worker completes the item with `completion.summary`.
5. That answer is injected back into the Papercup pane and spoken through the
   same voice-out path.

Deep thinking therefore returns to the user as an **answer**, not as placement
work for the Mug.

## Local browser voice mode (`fullAgentEngine === 'off'`)

The local path is still supported and is what runs when the full-agent engine is
off.

### STT options

`SttEngineKind` in `voice-prefs.ts`:

* `voicemode`
* `webspeech`
* `deepgram`
* `off`

Key shipped adapters:

* `apps/operator/app/_components/voice/stt-voicemode.ts`
  * `@ricky0123/vad-web` Silero VAD
  * utterance audio converted to WAV
  * sent to `voice-engines/whisper.ts`
* `packages/operator-core/lib/voice-engines/deepgram.ts`
  * streaming Deepgram WebSocket STT
  * spend recorded through `/api/agent-mcp/operator-stt-spend`
* browser Web Speech

### TTS options

`TtsEngineKind` in `voice-prefs.ts`:

* `kokoro`
* `browser`
* `elevenlabs`
* `openai`
* `cartesia`

The browser runtime still handles:

* aria-live publication
* role-to-voice mapping
* leader election across tabs
* output mute
* processing / awaiting-response UI state

Those mechanics live primarily in `voice-mode.ts`.

## Wake-word detection

Wake-word support is configurable in `voice-prefs.ts`:

* `off`: transcript-then-string-match fallback
* `porcupine`: Picovoice Porcupine
* `openwakeword`: openWakeWord

Shipped engines:

* `packages/operator-core/lib/voice-engines/porcupine.ts`
* `packages/operator-core/lib/voice-engines/openwakeword.ts`

The local browser runtime also still carries the historical string wake phrase
(`hey papercup`) in `voice-mode.ts` for the browser-only path.

## Voice channels and the generic voice-node

Do not confuse the **local Papercup voice pipeline** with the generic P2P voice
channel system.

`libs/generic/p2p-voice/src/voice-node.ts` is the reusable channel core:

* one active channel per node
* encoded audio fan-out
* in-band presence
* per-peer frame taps
* optional video frame fan-out on the same peer connection

That system backs operator voice-channel / relay work. The Papercup voice-in/out
surfaces documented on this page are different:

* `papercup-input` is local loopback-to-pane
* `voice:say` / `sentinel_says` is local shared FIFO
* neither is an `operator_voice_channels` channel

## Voice preferences

`packages/operator-core/lib/voice-prefs.ts` is the source of truth for the voice
settings model. Important fields:

* engine selectors: `sttEngine`, `ttsEngine`, `fullAgentEngine`
* hosted-session controls:
  * `fullAgentIdleTimeoutMin`
  * `fullAgentSessionMaxMin`
  * `fullAgentMonthlyMinuteCap`
  * `voicePrivacyMode`
  * `wakeGatedIdleTimeoutSec`
  * `agentLanguage`
* wake-word controls:
  * `wakeWordEngine`
  * `porcupineKeyword`
  * `openwakewordKeyword`
* human-facing persona switch:
  * `humanFacingRole: 'operator' | 'papercup'`

`humanFacingRole` is the switch that repoints the full-agent voice brain between
the legacy operator persona and the Papercup persona.

## Desktop and TUI transport seams

### Desktop

* `/api/desktop/voice-config` returns the chosen loopback WS port plus framing
  constants
* `voice-node/desktop-voice-ws.ts` exposes the local voice socket as a loopback
  byte pipe
* `apps/operator/app/_components/voice/operator-voice-runtime.ts` captures mic
  and renders response audio in the webview

### TUI

The TUI attaches to the same shared operator voice session and therefore hears
the same answer path as the desktop client. It is not a separate conversational
brain.

## File map

```text
packages/operator-core/lib/
├── voice-prefs.ts
├── voice-lease.ts
├── voice-credentials.ts
├── voice-engines/
│   ├── deepgram.ts
│   ├── openwakeword.ts
│   ├── porcupine.ts
│   └── whisper.ts
├── endpoint-route/routes/
│   ├── operator/papercup-input.ts
│   └── desktop/voice-config.ts
├── voice-node/
│   ├── desktop-voice-ws.ts
│   ├── operator-voice-host.ts
│   ├── operator-voice-session.ts
│   ├── operator-voice-session-deps.ts
│   ├── operator-voice-bus.ts
│   └── papercup-says-pump.ts
└── papercup/
    ├── papercup-deep-delegate.ts
    └── papercup-pane-input.ts

apps/operator/app/_components/voice/
├── voice-mode.ts
├── stt-voicemode.ts
├── voice-papercup-bridge.ts
├── operator-voice-runtime.ts
└── desktop-operator-voice-client.ts

apps/operator-vite/src/routes/settings/voice.tsx
libs/generic/p2p-voice/src/voice-node.ts
```

## Operational notes

* The desktop runtime discovers its loopback bridge through
  `/api/desktop/voice-config`; never hardcode `:3076`.
* `papercup-input` and desktop voice transport are local-only surfaces; do not
  model them as bearer-authenticated harness APIs.
* If voice-out is silent during a hosted session, inspect the shared
  `sentinel_says` path and the server-side pump before debugging local TTS.
* If a question needs minutes of analysis, the correct lane is
  `voice:delegate_deep`, not handing cognition to the Mug.

## Tests

```sh
cd packages/operator-core && npx vitest run \
  lib/device-voice-ws.test.ts \
  lib/voice-lease.test.ts \
  lib/voice-node/operator-voice-session.test.ts \
  lib/voice-node/operator-voice-multiclient.test.ts \
  lib/voice-node/operator-voice-synthetic-audio.test.ts \
  lib/voice-node/operator-voice-session-deps-config.test.ts \
  lib/wake-word.test.ts

cd libs/generic/p2p-voice && npx vitest run src/voice-node.test.ts
```

See also:

* [The Papercup's voice-out crosses processes](/internal/docs/agent-insights/papercup-voice-out-is-cross-process)
* [Papercup voice-in needs a single dock](/internal/docs/agent-insights/papercup-voice-in-needs-a-single-dock)
* [Voice modality](/internal/docs/endpoint-system/voice-modality)
