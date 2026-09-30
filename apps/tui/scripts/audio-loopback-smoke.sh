#!/usr/bin/env bash
# Isolated audio loopback smoke for the pui voice stack
# (universal-voice-interface-2026-06-05, P-011 — the autonomous real-audio half).
#
# Runs the #[ignore]d hardware smokes in apps/tui/src/voice.rs (real cpal capture
# + rodio playback + a 440 Hz tone loopback) through a PipeWire **null-sink**, so
# the actual audio device path is exercised with SYNTHETIC audio while:
#   • NO real sound is emitted (playback lands in the null-sink), and
#   • the box's real defaults (Brio mic / HDMI out) are never touched
#     (we route this process via PULSE_SINK/PULSE_SOURCE only — see the agent
#     memory `isolated-audio-e2e-null-sink`).
#
# This is the device-level complement to the deterministic, no-hardware
# `operator-voice-{multiclient,synthetic-audio}.test.ts` bus E2Es. It needs
# PipeWire + pactl (a dev box), so it is NOT a CI test — run it locally:
#
#   apps/tui/scripts/audio-loopback-smoke.sh
#
# Exits 0 on pass or an unavailable local audio stack (environmental skip),
# non-zero on a smoke failure; always unloads the null-sink.
set -uo pipefail

SINK="pui_voice_test_$$"
MODID=""
cleanup() {
  if [ -n "$MODID" ]; then
    pactl unload-module "$MODID" >/dev/null 2>&1 || true
    echo "[audio-smoke] unloaded null-sink (module $MODID)"
  fi
}
trap cleanup EXIT

command -v pactl >/dev/null 2>&1 || { echo "[audio-smoke] SKIP: pactl not found (needs PipeWire/PulseAudio)"; exit 0; }
pactl info >/dev/null 2>&1 || { echo "[audio-smoke] SKIP: no reachable PipeWire/PulseAudio server"; exit 0; }

echo "[audio-smoke] loading isolated null-sink '$SINK' (real Brio/HDMI defaults untouched)…"
MODID=$(pactl load-module module-null-sink "sink_name=$SINK" "sink_properties=device.description=$SINK") || {
  echo "[audio-smoke] SKIP: could not load module-null-sink"; exit 0;
}
echo "[audio-smoke] module $MODID → sink=$SINK  monitor=$SINK.monitor"

cd "$(dirname "$0")/.."  # apps/tui
export PUI_LIVE_AUDIO=1

# The device stack lives in a sibling executable; the tests below exercise the
# PUI proxy through that freshly built process, not only the backend in isolation.
cargo build --bins || exit $?

# Route the test process at the null-sink: cpal's ALSA host exposes a `pulse`
# device (in + out) that honors PULSE_SINK/PULSE_SOURCE per-process. Playback →
# the null-sink; capture ← its monitor → a real loopback with zero audible sound.
PULSE_SINK="$SINK" PULSE_SOURCE="$SINK.monitor" \
PUI_VOICE_INPUT=pulse PUI_VOICE_OUTPUT=pulse \
  cargo test --bin pui -- --ignored --test-threads=1 \
    smoke_record_yields_16k_wav smoke_play_tone smoke_loopback_tone_roundtrip \
  2>&1 | grep -vE "jack|JackShm|ALSA lib|Cannot (connect|open)|snd_pcm_jack"
rc=${PIPESTATUS[0]}

if [ "$rc" -eq 0 ]; then
  echo "[audio-smoke] PASS — real cpal capture + rodio playback verified with synthetic audio (no sound, no focus steal)."
else
  echo "[audio-smoke] FAIL (cargo rc=$rc)"
fi
exit "$rc"
