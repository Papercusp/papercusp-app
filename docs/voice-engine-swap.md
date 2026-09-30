# Voice engine swap — local (kokoro/whisper) ↔ ElevenLabs

The operator voice stack is **single-sourced**: there is exactly one server-side
TTS synthesis registry and one STT transcription helper. Switching a provider —
e.g. local **kokoro** ↔ **ElevenLabs** — is a **config (voice-prefs) change**, not
a code change. There is no second implementation to keep in sync.

> History: a parallel client-side `detectEngines()` adapter framework
> (`voice-engines.ts`) used to shadow the server registry. It read server-only
> API keys and so was never viable client-side; its only caller was its own test.
> It was removed 2026-07-09 (WI-3448). If you go looking for "the other voice
> implementation" — there isn't one anymore, and that's the point.

## The two independent axes

Voice-prefs (PUT `/api/agent-mcp/operator-voice-prefs`) drive everything. Two
axes matter, and **`fullAgentEngine` wins when it is not `off`**:

| pref | values | what it controls |
| --- | --- | --- |
| `fullAgentEngine` | `off` \| `openai-realtime` \| `gemini-live` \| `elevenlabs-conv` | The bundled **conversational transport** (a single WebRTC/streaming session that does STT+LLM+TTS end-to-end). When ≠ `off` it **overrides** `sttEngine`/`ttsEngine`. |
| `sttEngine` | `voicemode` \| `webspeech` \| `deepgram` \| `off` | Per-utterance **speech-to-text** (only consulted when `fullAgentEngine === 'off'`). |
| `ttsEngine` | `kokoro` \| `browser` \| `elevenlabs` \| `openai` \| `cartesia` | Per-utterance **text-to-speech** (only consulted when `fullAgentEngine === 'off'`). |

So there are two genuinely different code paths, and EL can plug into **either**:

1. **Per-utterance pipeline** (`fullAgentEngine: 'off'`): STT and TTS are separate
   calls. TTS goes through the one registry — `ttsEngine: 'elevenlabs'` is a
   drop-in swap for `'kokoro'`. **This is the recommended EL integration** — it
   reuses the whole pipeline and only the synthesis endpoint changes.
2. **Conversational transport** (`fullAgentEngine: 'elevenlabs-conv'`): a distinct
   bundled EL Conversational session that **bypasses** the per-utterance pipeline.
   Use only if you specifically want EL's turn-taking/barge-in transport rather
   than local STT + EL TTS.

## The single TTS registry

`packages/operator-core/lib/endpoint-route/routes/agent-mcp/tts-synth.ts` exports
one function:

```ts
synthesize(engine, text, voiceId, prefs, opts?) => { ok, bytes, contentType } | { ok:false, status }
```

Both server routes call it, so they can never drift:

- `operator-tts.ts` — the live speak endpoint (re-exports the same `synthesize`
  reference; a test pins `synthesizeFromRoute === synthesize`).
- `operator-tts-preview.ts` — the /settings voice preview.

Providers and their config source:

| `ttsEngine` | endpoint | model | voice | key (server-side) |
| --- | --- | --- | --- | --- |
| `kokoro` (local) | `http://127.0.0.1:8880/v1/audio/speech` | `kokoro` | `af_bella` | none |
| `elevenlabs` | `api.elevenlabs.io/.../text-to-speech/{voice}/stream` | `eleven_turbo_v2_5` | `prefs.elevenlabsVoiceId` | `xi-api-key` |
| `openai` | `api.openai.com/v1/audio/speech` | `prefs.openaiModel` | `prefs.openaiVoice` | `Authorization: Bearer` |
| `cartesia` | `api.cartesia.ai/tts/bytes` | `prefs.cartesiaModel` | `prefs.cartesiaVoiceId` | `X-API-Key` |

Contract: missing cloud key → `{ ok:false, status:404 }` (no upstream call);
unknown engine → `400`; upstream non-ok → `502`. **Keys never leave the server** —
the client only ever sends prefs + text and receives audio bytes.

STT is the mirror: `voice-engines/whisper.ts` `transcribeChunk(baseUrl, audio)`
POSTs to the OpenAI-compatible `/v1/audio/transcriptions` (local whisper on
`:2022`).

## Recipe: switch local → ElevenLabs

1. **Fund + save the EL key** (server-side, never in the tree): the key is read by
   `voice-credentials.readElevenLabsKey()`. Save it via the /settings voice panel
   (validated by the `operator-elevenlabs-test` route) or the credential store.
   Once the key is saved, the panel's voice dropdown **auto-populates from your EL
   account library** via `GET /api/agent-mcp/operator-elevenlabs-voices` (a
   loopback route that reads the key server-side — the browser holds only a masked
   key, so it can't call `/v1/voices` itself). Pick a voice there instead of
   hand-typing an id.
2. **Flip the pref.** For per-utterance TTS (recommended):

   ```
   PUT /api/agent-mcp/operator-voice-prefs
   { "ttsEngine": "elevenlabs", "elevenlabsVoiceId": "21m00Tcm4TlvDq8ikWAM" }
   ```

   Leave `fullAgentEngine: 'off'` and `sttEngine: 'voicemode'` (local whisper) to
   keep STT free and local while only TTS goes to EL. Or, for the full EL
   conversational transport, set `fullAgentEngine: 'elevenlabs-conv'` instead
   (needs the funded key too; overrides stt/tts).
3. **That's it** — no rebuild, no code edit. `elevenlabsVoiceId` is preserved in
   prefs across swaps, so flipping `ttsEngine` back to `kokoro` (all-local, free)
   and later to `elevenlabs` again is lossless.

## Recipe: switch ElevenLabs → local (the current default)

```
PUT /api/agent-mcp/operator-voice-prefs
{ "fullAgentEngine": "off", "sttEngine": "voicemode", "ttsEngine": "kokoro" }
```

Requires the local services running: kokoro TTS on `:8880`, whisper STT on `:2022`
(managed under `.voicemode/services/`). No API keys, no per-char spend.

## What the status codes mean

`synthesize()` classifies the provider's response so the UI can tell a
**user-fixable credential problem** from a **provider outage**. (Before
2026-07-09 every upstream failure collapsed onto `502`, so a defunded ElevenLabs
account looked exactly like ElevenLabs being down.)

| status | meaning | who fixes it |
| --- | --- | --- |
| `200` | audio bytes | — |
| `404` `no-key` | no key configured for that engine | add a key |
| `401` | provider **rejected** the key — invalid, or out of credits | fix/fund the key |
| `429` | rate-limited / quota exhausted | wait, or upgrade the plan |
| `400` | bad request — unknown engine, bad voice id, bad model | fix the request |
| `502` | provider 5xx, unreachable, or a timeout | infrastructure |

`404` is produced **only** for "key not configured" — never passed through from a
provider — so the `no-key` contract stays unambiguous.

## Verify a swap

- **"Re-detect engines"** (the /settings voice button) live-probes the local
  engines and reports real per-engine status:
  `GET /api/agent-mcp/operator-voice-engine-health` runs `Promise.all` over a
  kokoro health probe, a voicemode `/v1/models` probe (`probeVoicemodeHealth`),
  and key-presence for elevenlabs/openai/cartesia — so the button reflects what's
  actually reachable, not just the saved prefs (its pre-2026-07-09 behaviour).
- Preview endpoint proves wiring without touching the live speak path:
  `POST /api/agent-mcp/operator-tts-preview { "engine": "kokoro" }` → `200` + WAV.
  `{ "engine": "elevenlabs" }` → `200` with a funded key; `404 no-key` with no key
  at all; `401` when a key is present but rejected (this still proves EL is fully
  wired — only the money is missing).
- Server-side edits have **no hot-reload**: restart the host
  (`dev:restart { target: 'staging', confirm: true, authorize: true, reason: 'reload the staging operator with updated code' }` for :3170 — never a raw
  `systemctl restart`, which bypasses the drain + WI-4221 debounce) before
  probing.

## Automated tests

Most voice tests stub `fetch` — they prove the wiring. Two suites hit the **real**
local services and will catch a real API change:

```bash
# Unit layer: live kokoro + whisper, incl. a TTS→STT round trip.
# Auto-skips when the services are down; PAPERCUSP_VOICE_LIVE=1 makes that a hard fail.
cd packages/operator-core
PAPERCUSP_VOICE_LIVE=1 npx vitest run lib/endpoint-route/routes/agent-mcp/voice-local-live.test.ts

# Browser layer: Chrome plays a kokoro-synthesized WAV into getUserMedia via
# --use-file-for-fake-audio-capture, records it with MediaRecorder, POSTs it to
# /api/agent-mcp/operator-stt, and asserts whisper transcribes the sentence back.
cd apps/operator
OPERATOR_E2E_REUSE_SERVER=1 OPERATOR_E2E_BASE_URL=http://127.0.0.1:3170 \
  npx playwright test e2e/voice-live-e2e.spec.ts
```

A third layer drives the **real settings surface inside the shipping Tauri
shell**, which is where the swap actually happens:

```bash
VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- scripts/verify-voice-settings.sh
```

`VERIFY_TAURI_ISOLATED_DB=1` is **not optional and the script enforces it**
(hard exit 9): the run switches an engine, which POSTs
`/api/agent-mcp/operator-voice-prefs` — a real write that against the shared DB
silently rewrites *your own* STT/TTS engine as a side effect of running a test.

It covers four failure modes the two suites above cannot reach by construction:
the engine pickers are Radix selects rendered through a **portal** (jsdom calls
`onChange` directly and never opens anything); kokoro and whisper are **real
services** every unit test mocks; the aria-live regions are fed by a
**cross-module bus** whose hops are unit-tested individually and never together;
and **WebKitGTK is not Chrome** (see the last troubleshooting entry).

## Troubleshooting

**"Local TTS worked, then silently stopped and never came back."**
The compatibility Kokoro unit is a **single model-bearing uvicorn process**. Do
not set `UVICORN_LIMIT_MAX_REQUESTS`: that setting is a worker-pool control, and
on a single process it turns a small request budget into a full model reload (the
old `25` setting caused the observed outage). The runtime launcher is now offline
only; dependency installation and model downloads live in an explicit one-time
provision command. `Restart=always` remains the process-failure contract, while
`RestartPreventExitStatus=78` keeps an unprovisioned install from restart-looping.

On a developer host, provision once and then restart the unit:

```bash
~/.voicemode/services/kokoro/provision-gpu.sh
systemctl --user daemon-reload
systemctl --user restart voicemode-kokoro.service
systemctl --user show voicemode-kokoro.service -p Restart -p RestartPreventExitStatus -p NRestarts
```

The service contract is checked by `apps/operator/scripts/voice-stack-check.mjs`
and by `packages/operator-core/lib/voice-node/kokoro-service-contract.test.ts`:
the hot path must contain no `uv pip install`, `download_model.py`, `curl`, or
`wget`, and it must verify the model/config/voice files before `exec`-ing uvicorn.

**Preview returns `502`.** That now means a genuine outage — check
`curl http://127.0.0.1:8880/health` (kokoro) and `:2022/health` (whisper). A
credential problem reports `401`/`404`, not `502`.

**A scripted engine swap "clicks" the option and nothing changes.** The pickers
are `@radix-ui/react-select` (`apps/operator/app/harness/Select.tsx`), and two of
its mechanics defeat the obvious automation. Both are read from
`node_modules/@radix-ui/react-select/dist/index.js`, not inferred:

- **Pick the option by `data-state`, never by comparing its text to the
  trigger's.** `SelectItem` stamps `data-state="checked" | "unchecked"`, so
  "an option that is not the current one" is exactly
  `[data-state="unchecked"]`. Text comparison does *not* give you that: the
  trigger renders `RS.Value` alone while the item renders `RS.ItemText` **plus**
  an `RS.ItemIndicator`, so the currently-selected item can compare as
  "different", get picked, and re-select the value that was already set — the
  trigger never changes and the run looks like broken selection.
  `aria-selected` is no substitute either; Radix sets it to
  `isSelected && isFocused`, so it is `false` for the selected item whenever
  focus is elsewhere.
- **A synthetic pointer burst must carry `pointerType: "mouse"`.** `SelectItem`
  keeps a `pointerTypeRef` that **defaults to `"touch"`** and has two mutually
  exclusive selection paths: `onPointerUp` selects only when the ref is
  `"mouse"`, `onClick` only when it is not. A `new PointerEvent(...)` with no
  `pointerType` sets the ref to the empty string — the one value landing in
  *neither* path — so the event fires, nothing throws, and nothing is selected.
  There are no `isTrusted` guards, so a correctly-shaped synthetic event is
  enough. Dispatching the mouse burst *and* a bare `.click()` is safe: the two
  paths cannot both run.
- **Do not target Web Speech (or Deepgram): they are consent-gated and will
  not persist.** `setSttEngine` opens the privacy modal and returns *without
  saving* while `prefs.webSpeechLeakAcked` is false — correct behaviour, since
  Web Speech ships audio to the browser vendor's cloud. The trap is that the
  option is `unchecked` and not `aria-disabled`, so it looks like any other
  choice: a script picking "the first unchecked option" selects it, nothing
  saves, and the failure is indistinguishable from a broken picker. It is also
  **deterministic under `VERIFY_TAURI_ISOLATED_DB=1`**, whose fresh profile
  always starts with that ack false — and correspondingly invisible against a
  shared DB where it has already been acknowledged. Pick an ungated option, and
  assert the gate itself separately (`verify-voice-settings.sh` step 6c does
  both).

**STT works in every unit test but is dead in the desktop app.** This webview is
**WebKitGTK, not Chrome, and has no `window.SpeechRecognition`.** Any STT path
that quietly falls back to the Web Speech API is green in jsdom and broken in the
shipping app. `scripts/verify-voice-settings.sh` pins this explicitly, which is
why that assertion exists even though it looks like it is testing the browser
rather than us.
