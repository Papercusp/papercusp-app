# Voice mode (v4) — PARTIALLY SUPERSEDED

> **2026-07-01 (voice-unified-papercup-pipeline):** the architecture has moved
> substantially since this doc. The current design is ONE Papercup pipeline —
> the pane Papercup is the single brain for text AND voice; ElevenLabs Conv-AI
> is a relay front-end; pane answers are synthesized server-side and fanned over
> the voice bus; hard thinking is delegated to ephemeral background agents. Read
> `/internal/docs/agent-insights/one-papercup-voice-pipeline` FIRST. The engine
> catalog below (STT/TTS adapters, keys, spend, commands) is still broadly
> accurate, but the code moved from `apps/operator/lib/voice-*` to
> `packages/operator-core/lib/voice-*` (engines, voice-node, prefs, spend).

The voice modality on top of the v5 Operator. Local-first STT/TTS with
opt-in cloud upgrades. For the architectural deep-dive, see the rendered
docs at `/spec/voice-mode-v4` (source lives in
`apps/operator-docs/src/content/docs/spec/voice-mode-v4.mdx`).

## Quick start (end-user)

1. Start Voicemode services:
   ```sh
   mcp__voicemode__service whisper start    # STT, port 2022
   mcp__voicemode__service kokoro  start    # TTS, port 8880
   ```
2. Visit `/settings/voice` to confirm engines are detected.
3. Click the voice button (top chrome) to toggle voice mode on.
4. Grant microphone permission when prompted.
5. Optional: add ElevenLabs / OpenAI / Cartesia API keys for cloud TTS.
6. Optional: tune feature toggles + per-role + per-slug voices.

## What's available

**STT**: Voicemode (Whisper, local) | Web Speech (browser cloud, opt-in) | Off

**TTS** (5 engines):
- **Kokoro** (Voicemode local) — default when reachable, ~250-350MB RAM
- **Browser** (Web Speech) — universal fallback, OS-shipped voices
- **ElevenLabs** (cloud, BYO key) — best quality, MSE streaming, ~$0.18/1k chars
- **OpenAI tts-1 / tts-1-hd** (cloud, BYO key) — 6 preset voices, ~$0.015/1k chars
- **Cartesia Sonic-2** (cloud, BYO key) — sub-100ms first-byte, ~$0.05/1k chars

API keys live in `~/.papercusp/credentials.json` (file mode 0600,
masked on GET, preserve-missing on PUT). Never travel on snapshots.

## Voice commands

In-panel (when Operator panel is open):
```
cancel                       # close active toast
dispatch [<ordinal>]         # dispatch first / Nth pending card
dismiss [<ordinal>]          # dismiss
scan [<query>] | rescan      # trigger a manual scan
pause | resume | unpause     # toggle background scanning
<anything else>              # treated as a freeform scan request
```

Wake-word (anywhere; requires `wakeWordIntents` toggle on):
```
operator open                # open the panel
operator scan                # open + trigger scan
operator status              # open + trigger scan
operator what's pending      # open + trigger scan
operator approve <slug>      # standing-approval shortcut (single match)
operator approve <slug> <cap># explicit cap pick
operator across workspaces   # speak per-workspace card counts
```

Cap normalization: voice approve restricted to 2-segment alphabetic
caps (`tasks:write` ✓, `secrets:read:OPENAI_KEY` ✗). Multi-segment
caps refuse with "use settings" prompt.

## CLI

The existing `operator` CLI (apps/operator/scripts/operator.ts) covers
status / scan / pause / budget / candidates / approve / config /
prefs / dismiss-clear. Voice-specific subcommands ride on top of the
HTTP endpoints — invoke directly via curl if needed:

```sh
# Voice prefs
curl http://localhost:3055/api/agent-mcp/operator-voice-prefs
curl -X PUT -H 'content-type: application/json' \
  -d '{"ttsEngine":"elevenlabs"}' \
  http://localhost:3055/api/agent-mcp/operator-voice-prefs

# Credentials
curl http://localhost:3055/api/agent-mcp/operator-credentials   # masked
curl -X PUT -H 'content-type: application/json' \
  -d '{"elevenlabsApiKey":"sk_..."}' \
  http://localhost:3055/api/agent-mcp/operator-credentials

# Connection tests
curl -X POST http://localhost:3055/api/agent-mcp/operator-elevenlabs-test
curl -X POST http://localhost:3055/api/agent-mcp/operator-openai-test
curl -X POST http://localhost:3055/api/agent-mcp/operator-cartesia-test

# TTS spend
curl http://localhost:3055/api/agent-mcp/operator-tts-spend
```

## What lives where

```
packages/operator-core/lib/voice-*        prefs, credentials, engine framework,
                                          spend/cost tracking, health monitor
packages/operator-core/lib/voice-engines/ TTS adapters (kokoro/EL/openai/cartesia)
                                          + STT engines (whisper/deepgram/webspeech)
                                          + EL Conv-AI + OpenAI Realtime
packages/operator-core/lib/voice-node/    the SERVER voice host: one shared EL
                                          session, bus fan-out, lease election,
                                          says-pump, transcript log, P2P relay
packages/operator-core/lib/sentinel/      pane-input mechanics + deep delegation
app/_components/voice/       VoiceAppBridge (priority registry), voice-mode
                             (speak, STT capture), voice-leader (BroadcastChannel),
                             AriaLiveRegions (dual polite/assertive),
                             OperatorVoiceAnnouncer (closed-panel cadence),
                             VoiceLeaderBootstrap, voice-prefs-client cache,
                             stt-voicemode (MediaRecorder + VAD loop)
app/api/agent-mcp/           7 routes: voice-prefs, credentials, tts-spend,
                             elevenlabs-test, openai-test, cartesia-test,
                             nudge, audit (extended for actor_method)
app/settings/voice/          Full v4 UI (engines, ElevenLabs/OpenAI/Cartesia
                             config, cost widgets, 7 toggles, per-role +
                             per-slug voice pickers, precedence matrix)
content/docs/spec/voice-mode-v4.mdx   Architecture docs
```

## Tests

```sh
cd apps/operator
npx vitest run \
  lib/voice-commands.test.ts \
  lib/voice-prefs.test.ts \
  lib/tts-spend.test.ts \
  lib/voice-engine-health.test.ts \
  lib/voice-nudges.test.ts \
  lib/voice-intents.test.ts \
  lib/voice-engines/cancel-race.test.ts \
  lib/operator-stats.test.ts \
  app/_components/voice/voice-consumers.test.ts \
  app/_components/voice/voice-leader.test.ts
```

82+ tests covering parser, intents, prefs, credentials, engine health,
cost methodology, leader election, cancel-race, nudge dedup, voice
provenance breakdown.

## Operational pre-flight

1. `mcp__voicemode__service whisper start` (default :2022)
2. `mcp__voicemode__service kokoro start`  (default :8880)
3. Optional: paste API keys at `/settings/voice`
4. Mic permission prompt
5. Toggle voice mode on (top chrome voice button)

## What's NOT in v4 (per plan §9)

- Voice cloning (no audio model bundling)
- Server-side TTS spend aggregation across machines
- Cloud TTS providers beyond Kokoro/ElevenLabs/OpenAI/Cartesia
- Cloud STT engines beyond Voicemode/Web Speech
- NLU / intent classifier (strict literal first)
- Partial-results "can-" preemption (fragile across STT providers)
- Wake-word + dispatch in one utterance (race condition cost)
- Voice during first-run tutorial (permanently gated)
