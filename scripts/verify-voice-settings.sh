#!/usr/bin/env bash
# Live Tauri-shell verification for the VOICE SETTINGS surface (/settings/voice).
# WI-3527 Phase 4 (plan voice-thorough-test-2026-07-09).
#
# Run it as:
#   VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- scripts/verify-voice-settings.sh
# For the unsupported saved-engine regression without audio-service checks:
#   VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- scripts/verify-voice-settings.sh --gemini-unavailable
#
# ⚠ VERIFY_TAURI_ISOLATED_DB=1 IS NOT OPTIONAL HERE, AND THE SCRIPT ENFORCES IT.
# Step 6 switches an engine, which POSTs /api/agent-mcp/operator-voice-prefs —
# a real write. Against the shared live DB that mutates the OWNER'S ACTUAL voice
# configuration (their STT/TTS engine) as a side effect of running a test, and
# nothing about a green run would reveal it. The isolated rig also makes the
# reload assertion in step 6 honest: it is reading back state THIS run wrote.
#
# WHY THIS EXISTS SEPARATELY FROM THE VITEST SUITE. The voice suites (541 unit /
# 27 integration / 192 UI, all green) prove the units in jsdom. Four of this
# surface's real failure modes are invisible there by construction:
#
#   1. The engine pickers are RADIX selects rendered through a PORTAL. jsdom
#      exercises the onChange prop directly; only a real webview can say whether
#      the trigger opens, whether the portalled listbox lands on screen, and
#      whether picking an option round-trips through the server and survives a
#      reload. That whole path is the feature.
#   2. Kokoro and Whisper are REAL LOCAL SERVICES. Every unit test mocks them.
#      Only a live run can say the app's own fetch reaches kokoro:8880 and gets
#      playable audio back.
#   3. The aria-live regions are fed by a cross-module BUS (voice-mode.ts →
#      aria-live-bus → AriaLiveRegions). Unit tests assert each hop; nothing
#      asserts the hops are connected in a shipping build.
#   4. WebKitGTK is NOT Chrome. This webview has NO window.SpeechRecognition
#      (step 2 pins that), so any STT path that quietly depended on the Web
#      Speech API would be dead here and green in jsdom.
#
# EVIDENCE DISCIPLINE. Every assertion runs through $VERIFY_TAURI_POLL, which
# pins the verified PID and EXITS NONZERO when the assertion stays false. `eval`,
# `click` and `dom` exit 0 regardless of what happened, so they appear here only
# to set up or to narrate — never as evidence. Every assertion carries a
# `--require` naming a subject that must be PRESENT, because "no error shown"
# and "engine changed" are both trivially true of an empty document (the vacuous
# green of EI-18781011720418569).
set -euo pipefail

TAT="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
PID="${VERIFY_TAURI_PID:?verify-tauri-headless.sh must export VERIFY_TAURI_PID}"
POLL="${VERIFY_TAURI_POLL:?verify-tauri-headless.sh must export VERIFY_TAURI_POLL}"
PORT="${VERIFY_TAURI_PORT:?verify-tauri-headless.sh must export VERIFY_TAURI_PORT}"

say() { printf '\n=== %s ===\n' "$1"; }

MODE=full
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 1 ] && [ "$1" = --gemini-unavailable ] || {
    echo "FATAL: expected no arguments or --gemini-unavailable" >&2
    exit 2
  }
  MODE=gemini
fi

# Keep these expressions executable in the conventional desktop node:test suite.
# A different alert elsewhere on the page must not mask the settings alert.
GEMINI_ALERT='(() => { const page = document.querySelector(".pc-settings-page--voice"); return !!page && Array.from(page.querySelectorAll("[role=alert]")).some(a => (a.textContent || "").includes("Gemini Live is not supported")); })()'
GEMINI_DISABLED='Array.from(document.querySelectorAll("[role=option]")).some(o => (o.textContent || "").includes("Gemini Live") && o.hasAttribute("data-disabled") && o.getAttribute("aria-disabled") === "true")'
GEMINI_OPEN_PICKER='(() => { const trigger = document.querySelector("button.h-select-trigger[aria-label=\"Full-agent engine\"]"); if (!trigger) return false; trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); return true; })()'
GEMINI_DIAGNOSTIC='({ href: location.href, readyState: document.readyState, settingsPresent: !!document.querySelector(".pc-settings-page--voice"), alerts: Array.from(document.querySelectorAll("[role=alert]")).map(a => (a.textContent || "").slice(0, 500)), fullAgentLabel: document.querySelector("button.h-select-trigger[aria-label=\"Full-agent engine\"]")?.textContent || null, geminiOptions: Array.from(document.querySelectorAll("[role=option]")).filter(o => (o.textContent || "").includes("Gemini Live")).map(o => ({ text: o.textContent, disabled: o.hasAttribute("data-disabled"), ariaDisabled: o.getAttribute("aria-disabled") })) })'

# ── STEP 0: PROVE WE ARE DRIVING OUR OWN APP ────────────────────────────────
# NOT ceremony. On 2026-09-02, inside a CORRECTLY-booted rig, a bare
# tauri-agent-tools call auto-discovered and attached to the OWNER'S LIVE
# DESKTOP (a 5.4h-old GNOME Terminal instance) and a navigate drove their real
# window off the page they were on. Using the wrapper is NOT sufficient
# protection — the auto-discovery ignores it. Escalated as EI-21610450109267093;
# until that lands, --pid on EVERY call plus these two controls IS the mitigation.
# Both controls hard-exit 9, so a clean exit is itself the isolation evidence.
say "0. isolation controls — this must be OUR app, on OUR port"
APP_PID="$("$TAT" probe --pid "$PID" 2>/dev/null | sed -n 's/^App PID:[[:space:]]*//p' | head -1)"
if [ "$APP_PID" != "$PID" ]; then
  echo "FATAL: tauri-agent-tools attached to PID '$APP_PID' but our verifier is '$PID'."
  echo "That is very likely the OWNER'S live desktop. Refusing to drive it. (EI-21610450109267093)"
  exit 9
fi
echo "app pid $APP_PID == verifier pid $PID ✓"

if [ "${VERIFY_TAURI_ISOLATED_DB:-0}" != "1" ]; then
  echo "FATAL: run this with VERIFY_TAURI_ISOLATED_DB=1."
  echo "Step 6 writes voice prefs; against the shared DB that silently rewrites the owner's"
  echo "real STT/TTS engine configuration. See the header."
  exit 9
fi
echo "isolated throwaway DB ✓ — engine writes cannot touch the owner's real prefs"

if [ "$MODE" = gemini ]; then
  # Install the diagnostic only AFTER PID/isolation controls. Never inspect an
  # unverified desktop, and never lose the original failing exit status.
  trap 'status=$?; if [ "${status:-0}" -ne 0 ]; then "$TAT" eval --pid "$PID" "$GEMINI_DIAGNOSTIC" 2>&1 || true; fi' EXIT
  # Read the raw bridge response: the installed CLI schema strips newer fields.
  # This follows the proved PID/isolation controls, and never prints its token.
  node <<'NATIVE_HEALTH'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
(async () => {
  const pid = Number(process.env.VERIFY_TAURI_PID);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid verifier PID");
  const bridge = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `tauri-dev-bridge-${pid}.token`), "utf8"));
  if (bridge.pid !== pid) throw new Error("bridge token PID mismatch");
  const response = await fetch(`http://127.0.0.1:${bridge.port}/health`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bridge.token }), signal: AbortSignal.timeout(5000),
  });
  const health = await response.json();
  console.log("NATIVE_HEALTH_DIAGNOSTIC", JSON.stringify(health));
  if (!response.ok || !health.operator_probe) throw new Error("current native health diagnostics are unavailable");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NATIVE_HEALTH
  "$TAT" health --pid "$PID" --json
  say "Gemini regression: seed and assert the stored legacy preference"
  "$TAT" eval --pid "$PID" 'fetch("/api/agent-mcp/operator-voice-prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fullAgentEngine: "gemini-live" }) }).then(async r => { const prefs = await r.json(); window.__voiceGeminiSeed = { status: r.status, engine: prefs.fullAgentEngine }; return window.__voiceGeminiSeed; })'
  "$POLL" --require body --eval '!!window.__voiceGeminiSeed && window.__voiceGeminiSeed.status === 200 && window.__voiceGeminiSeed.engine === "gemini-live"'
fi

"$TAT" eval --pid "$PID" "window.location.href = '/settings/voice'" >/dev/null 2>&1 || true
"$TAT" wait --pid "$PID" --selector '.pc-settings-page--voice' --timeout 60000 >/dev/null 2>&1 \
  || echo "DIAG: voice settings page never appeared"

# The URL control: prove the page we are about to assert against is served from
# OUR dev port, not port 3270 (the owner's desktop).
"$POLL" --require '.pc-settings-page--voice' --eval "
  location.href.includes(':${PORT}') && location.pathname.startsWith('/settings/voice')"
echo "page URL on our port ${PORT} ✓"

if [ "$MODE" = gemini ]; then
  say "Gemini regression: the saved engine has an explicit unsupported alert"
  "$POLL" --require '.pc-settings-page--voice' --eval "$GEMINI_ALERT"
  say "Gemini regression: the actual portalled option is disabled"
  # Radix opens on keydown; a bare DOM click can leave the picker closed.
  "$TAT" eval --pid "$PID" "$GEMINI_OPEN_PICKER"
  "$POLL" --require '[role=option]' --eval "$GEMINI_DISABLED"
  say "Gemini regression: the unsupported saved preference remains intact"
  "$TAT" eval --pid "$PID" 'fetch("/api/agent-mcp/operator-voice-prefs").then(async r => { const prefs = await r.json(); window.__voiceGeminiReadback = { status: r.status, engine: prefs.fullAgentEngine }; return window.__voiceGeminiReadback; })'
  "$POLL" --require '.pc-settings-page--voice' --eval '!!window.__voiceGeminiReadback && window.__voiceGeminiReadback.status === 200 && window.__voiceGeminiReadback.engine === "gemini-live"'
  echo "PASS: Gemini unavailable regression (native settings UI; no microphone acceptance)"
  exit 0
fi

# ── STEP 1: THE SURFACE IS REALLY THERE ─────────────────────────────────────
# The anti-vacuous-green guard for everything below. Each later step asserts
# something about a control; if the page were empty, several of those would pass
# by being trivially true. Name the real controls once, up front.
say "1. the voice surface mounted with its real controls"
"$POLL" --require '.pc-settings-page--voice' --eval '
  (() => {
    const labels = [...document.querySelectorAll("button.h-select-trigger[aria-label]")]
      .map(b => b.getAttribute("aria-label"));
    const need = ["Full-agent engine", "STT engine", "TTS engine"];
    const btns = [...document.querySelectorAll("button")].map(b => (b.textContent || "").trim());
    return need.every(n => labels.includes(n))
        && btns.some(t => t.startsWith("▶ Preview"))
        && btns.includes("Test voice")
        && btns.includes("Re-detect engines");
  })()'

# ── STEP 2: THE WEBKITGTK TRAP ──────────────────────────────────────────────
# This webview has no Web Speech API. A wake-word or STT path written against
# window.SpeechRecognition would be dead in the SHIPPING app and perfectly green
# in jsdom, where the test author supplies the mock. Pin both halves: the API is
# genuinely absent, AND the app selected a real engine anyway.
say "2. no window.SpeechRecognition here — and the app does not depend on it"
"$POLL" --require 'button.h-select-trigger[aria-label="STT engine"]' --eval '
  (() => {
    const absent = typeof window.SpeechRecognition === "undefined"
                && typeof window.webkitSpeechRecognition === "undefined";
    const stt = document.querySelector("button.h-select-trigger[aria-label=\"STT engine\"]");
    const label = (stt.textContent || "").toLowerCase();
    // Not merely "something is selected": it must not have fallen back to the
    // engine this webview cannot run.
    return absent && label.length > 0 && !label.includes("web speech");
  })()'

# ── STEP 3: THE ARIA-LIVE BUS IS CONNECTED END TO END ───────────────────────
# "Test voice" calls speak(...,'polite',{force:true}) → voice-mode.ts:2571 →
# publishAriaLive → AriaLiveRegions' role=status node. Three modules, three
# separately-unit-tested hops, and nothing asserts they are wired together in a
# real build.
#
# Capture through a MutationObserver rather than polling the node: the regions
# are cleared after announcing, so a poll can arrive after the text is gone and
# report a working bus as broken.
say "3. 'Test voice' announces through the live region (bus wired end to end)"
"$TAT" eval --pid "$PID" '
  (() => {
    window.__voiceLiveSeen = [];
    const regions = [...document.querySelectorAll("[aria-live]")];
    window.__voiceLiveRegionCount = regions.length;
    for (const r of regions) {
      new MutationObserver(() => {
        const t = (r.textContent || "").trim();
        if (t) window.__voiceLiveSeen.push({ role: r.getAttribute("role"), text: t });
      }).observe(r, { childList: true, subtree: true, characterData: true });
    }
    return String(regions.length);
  })()' >/dev/null

# The regions must exist and be EMPTY now, or "it filled" proves nothing.
"$POLL" --require '[aria-live]' --require-min 2 --eval '
  window.__voiceLiveRegionCount >= 2
    && [...document.querySelectorAll("[aria-live]")].every(r => !(r.textContent || "").trim())'

"$TAT" click --pid "$PID" --text 'Test voice' >/dev/null 2>&1 \
  || "$TAT" eval --pid "$PID" '
       (() => {
         const b = [...document.querySelectorAll("button")]
           .find(x => (x.textContent || "").trim() === "Test voice");
         if (b) b.click();
         return !!b;
       })()' >/dev/null

# The exact string onTestVoice passes to speak(). Asserting the TEXT, not merely
# "something appeared", is what distinguishes a working bus from an unrelated
# announcement that happened to land in the same region.
"$POLL" --require '[aria-live]' --eval '
  (window.__voiceLiveSeen || []).some(e => /voice mode is working/i.test(e.text))'

# ── STEP 4: THE LOCAL ENGINES ARE REALLY REACHED ────────────────────────────
# "Re-detect engines" fetches /api/agent-mcp/operator-voice-engine-health, which
# probes kokoro :8880 and voicemode whisper :2022 server-side and renders the
# result. Every unit test mocks this. This is the assertion that says the two
# local engines this app depends on are actually up and actually reachable FROM
# THE APP — not merely from a curl the test author ran by hand.
say "4. 'Re-detect engines' reports the LIVE local engines healthy"
"$TAT" click --pid "$PID" --text 'Re-detect engines' >/dev/null 2>&1 \
  || "$TAT" eval --pid "$PID" '
       (() => {
         const b = [...document.querySelectorAll("button")]
           .find(x => (x.textContent || "").trim() === "Re-detect engines");
         if (b) b.click();
         return !!b;
       })()' >/dev/null

# The toast carries "Local: Kokoro ✓ · Voicemode ✓". Assert BOTH ticks: a ✗ here
# is a real finding (an engine is down) and must not pass as "a toast appeared".
"$POLL" --require '.pc-settings-page--voice' --eval '
  (() => {
    const t = document.body.innerText || "";
    return /Kokoro\s*✓/.test(t) && /Voicemode\s*✓/.test(t);
  })()'

# ── STEP 5: A REAL TTS SYNTHESIS ROUND TRIP ─────────────────────────────────
# Instrument fetch rather than watching the button, DELIBERATELY. The preview
# path is: POST /operator-tts-preview → blob → new Audio(url) → a.play(). On a
# headless Xvfb box with no audio sink, play() can legitimately reject and the
# component shows "audio playback failed" — which would fail a naive "no error"
# assertion for a reason that has nothing to do with kokoro. What we actually
# want to know is whether the app reached kokoro and got real audio BACK, and
# that is exactly what the response says.
say "5. '▶ Preview' really synthesises audio through kokoro"
"$TAT" eval --pid "$PID" '
  (() => {
    window.__ttsProbe = null;
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      const res = await orig.apply(window, args);
      if (url.includes("operator-tts-preview")) {
        try {
          const buf = await res.clone().arrayBuffer();
          window.__ttsProbe = { status: res.status, bytes: buf.byteLength };
        } catch (e) {
          window.__ttsProbe = { status: res.status, bytes: -1, err: String(e) };
        }
      }
      return res;
    };
    return "instrumented";
  })()' >/dev/null

"$TAT" eval --pid "$PID" '
  (() => {
    const b = [...document.querySelectorAll("button")]
      .find(x => (x.textContent || "").trim().startsWith("▶ Preview"));
    if (b) b.click();
    return !!b;
  })()' >/dev/null

# 200 with real bytes. The size floor rejects the empty/short body an errored or
# stubbed engine returns while still answering 200; a second of speech is tens
# of KB, so 2000 is a floor no plausible failure clears.
"$POLL" --require '.pc-settings-page--voice' --eval '
  (() => {
    const p = window.__ttsProbe;
    return !!p && p.status === 200 && p.bytes > 2000;
  })()'

# ── STEP 6: AN ENGINE CHANGE SURVIVES A RELOAD ──────────────────────────────
# THE headline assertion, and the one no unit test can make. The full round trip
# is: Radix trigger → portalled listbox → onChange → POST operator-voice-prefs →
# server persists → voicePrefs.effective sync query re-reads → UI rehydrates. A
# reload is the only thing that proves the middle of that chain ran, because an
# in-memory cache satisfies everything short of it.
#
# The option is chosen RELATIVELY (first option whose text differs from the
# current value), so this never hardcodes an engine list that will drift.
say "6. switching the STT engine persists across a full reload"
"$TAT" click --pid "$PID" 'button.h-select-trigger[aria-label="STT engine"]' >/dev/null 2>&1 || true
"$TAT" wait --pid "$PID" --selector '.h-select-item' --timeout 20000 >/dev/null 2>&1 \
  || echo "DIAG: the portalled listbox never opened"

# The listbox must really be open with a choice to make, or the "changed" half
# below could pass on a page that never opened anything.
"$POLL" --require '.h-select-item' --require-min 2 --eval '
  document.querySelectorAll(".h-select-item").length >= 2'

# HOW RADIX 2.2.6 ACTUALLY SELECTS, because guessing this costs a boot per guess.
# SelectItem (node_modules/@radix-ui/react-select/dist/index.js, the block around
# the onPointerUp at ~:931) has TWO MUTUALLY EXCLUSIVE selection paths, chosen by
# a `pointerTypeRef` that DEFAULTS TO "touch":
#
#   onPointerDown / onPointerMove → pointerTypeRef.current = event.pointerType
#   onPointerUp                   → handleSelect() ONLY IF ref === "mouse"
#   onClick                       → handleSelect() ONLY IF ref !== "mouse"
#
# A synthetic `new PointerEvent(...)` with no `pointerType` sets that ref to the
# empty string, which is the one value that lands cleanly in NEITHER path. That
# is why the obvious pointerdown/pointerup/click burst silently selects nothing.
# There are no isTrusted guards (grepped: 0), so a properly-shaped synthetic
# event is enough.
#
# So: drive the mouse path explicitly with pointerType "mouse", and keep the bare
# click as the fallback for a webview with no PointerEvent constructor (where the
# ref stays "touch" and the click path is the live one). The two paths are
# mutually exclusive BY CONSTRUCTION, so running both cannot double-select.
#
# CAPTURE THE RETURN VALUE. This used to be `>/dev/null`, which threw away the
# one word ("dispatched" / "no-alternative") that says which branch ran — and
# `2>&1 || echo` means a CLI-level failure reports itself instead of aborting
# the script through `set -e` before any of it is printed.
STT_PICK="$("$TAT" eval --pid "$PID" '
  (() => {
    const trig = document.querySelector("button.h-select-trigger[aria-label=\"STT engine\"]");
    const before = (trig.textContent || "").trim();
    const items = [...document.querySelectorAll(".h-select-item")];
    // Pick by RADIX STATE, never by text. Radix stamps data-state="checked" on
    // the selected item (SelectItem: `"data-state": isSelected ? "checked" :
    // "unchecked"`), so "an option that is not the current one" is exact.
    // Comparing item text against the trigger text does NOT give that: the
    // trigger renders RS.Value alone while the item renders ItemText PLUS an
    // ItemIndicator, so the CURRENTLY-SELECTED item can compare as "different"
    // and get re-picked — clicking it selects the value that was already set,
    // the trigger never changes, and the run reds as though selection is broken.
    // aria-selected is no substitute: Radix sets it to `isSelected && isFocused`,
    // so it is false for the selected item whenever focus is elsewhere.
    // ...and EXCLUDE THE CONSENT-GATED ENGINES, which are unchecked and
    // enabled yet deliberately do not persist on selection. page.tsx
    // setSttEngine early-returns and opens a privacy modal for "webspeech" /
    // "deepgram" while prefs.webSpeechLeakAcked is false, saving nothing:
    //     if ((kind === "webspeech" || kind === "deepgram") && !acked) {
    //       setShowLeakWarning(true); return; }
    // The isolated DB this rig ENFORCES starts every run with that ack false,
    // so "the first unchecked option" deterministically chose the one engine
    // that cannot persist — a red that looked exactly like broken selection
    // and could never reproduce against a shared DB where the owner had
    // already acknowledged. Step 6c below asserts that gate deliberately;
    // this step needs an ordinary, ungated state change.
    const GATED = /web speech|deepgram/i;
    const target = items.find(i => i.getAttribute("data-state") === "unchecked"
                                && i.getAttribute("aria-disabled") !== "true"
                                && !GATED.test(i.textContent || ""));
    window.__stt = {
      before,
      pickedItemText: target ? (target.textContent || "").trim() : null,
      gatedSkipped: items.filter(i => GATED.test(i.textContent || ""))
                         .map(i => (i.textContent || "").trim()),
      pointerCtor: typeof PointerEvent === "function",
      itemStates: items.map(i => ({ t: (i.textContent || "").trim().slice(0, 40),
                                    s: i.getAttribute("data-state") })),
    };
    if (!target) return "no-alternative";
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
                pointerType: "mouse", button: 0 };
    try {
      target.dispatchEvent(new PointerEvent("pointerdown", o));
      target.dispatchEvent(new PointerEvent("pointermove", o));
      target.dispatchEvent(new PointerEvent("pointerup", o));
    } catch (e) { window.__stt.pointerErr = String(e); }
    try { target.click(); } catch (e) { window.__stt.clickErr = String(e); }
    return "dispatched";
  })()' 2>&1 || echo "pick-eval-command-failed")"
printf 'STT PICK: %s\n' "$STT_PICK"

# Assert the TRIGGER'S VALUE CHANGED — deliberately NOT that it equals the item's
# text. The trigger renders RS.Value while the item renders ItemText PLUS an
# ItemIndicator, so the two strings can differ for reasons that have nothing to
# do with whether selection worked. An earlier revision of this script required
# that equality and failed on a run whose selection may well have succeeded,
# which is a false red — and worse, an undiagnosable one.
# NARRATE BEFORE ASSERTING. The dump has to happen in its own call ahead of the
# POLL, because POLL exits nonzero under `set -e` and would kill the script
# before any diagnostic placed after it could run — so the one run that needs
# the evidence is precisely the run that prints none. (Learned the expensive
# way: two boots produced a bare red with no way to tell whether the picker
# found no alternative or the click failed to take.)
# THREE ways this dump used to destroy its own evidence, all fixed here:
#   1. `| tail -1` — `eval` PRETTY-PRINTS a JSON string result (commands/eval.js:
#      `console.log(JSON.stringify(parsed, null, 2))`), so the output is
#      MULTI-LINE and `tail -1` could only ever have printed the closing "}".
#   2. `2>/dev/null` — swallowed the CLI's own error text, the single most
#      useful line when the page-side eval is the thing that failed.
#   3. `window.__stt.after` unguarded — if the picker eval above threw, __stt is
#      undefined, THIS eval throws too, and under `set -euo pipefail` the script
#      dies here with nothing printed. The instrument then fails in exactly the
#      case it exists for, and its silence looks like the app's silence.
# The JS try/catch means the page can no longer throw; `2>&1 || echo` means the
# command can no longer abort the run. A diagnostic must not be able to fail.
STT_DIAG="$("$TAT" eval --pid "$PID" '
  (() => {
    try {
      const trig = document.querySelector("button.h-select-trigger[aria-label=\"STT engine\"]");
      if (!window.__stt) window.__stt = { note: "picker eval never ran or threw before assigning" };
      window.__stt.sttWasDefined = window.__stt.note === undefined;
      window.__stt.after = trig ? (trig.textContent || "").trim() : "(no trigger)";
      return JSON.stringify(window.__stt);
    } catch (e) {
      return JSON.stringify({ diagError: String(e), sttType: typeof window.__stt });
    }
  })()' 2>&1 || echo '{"diagError":"diag eval command itself failed"}')"
printf 'STT DIAG: %s\n' "$STT_DIAG"

"$POLL" --require 'button.h-select-trigger[aria-label="STT engine"]' --eval '
  (() => {
    const trig = document.querySelector("button.h-select-trigger[aria-label=\"STT engine\"]");
    const now = (trig.textContent || "").trim();
    window.__stt.after = now;
    return !!window.__stt.pickedItemText && now !== window.__stt.before;
  })()'

# Carry the expected value across the reload in sessionStorage — it survives a
# reload, where a JS global does not. Deliberately NOT interpolated through the
# shell: an engine label contains spaces, parentheses and commas, and shell
# quoting one into a JS string literal is a corruption waiting to happen.
# sessionStorage is written by THIS harness, never by the app, so it carries the
# expectation without weakening what is being proved: the trigger's value after
# reload still has to come from the server round trip.
"$TAT" eval --pid "$PID" '
  sessionStorage.setItem("__sttExpected", (window.__stt && window.__stt.after) || "")' >/dev/null
"$TAT" eval --pid "$PID" 'window.location.reload()' >/dev/null 2>&1 || true
"$TAT" wait --pid "$PID" --selector 'button.h-select-trigger[aria-label="STT engine"]' --timeout 60000 \
  >/dev/null 2>&1 || echo "DIAG: page did not come back after reload"

"$POLL" --require 'button.h-select-trigger[aria-label="STT engine"]' --eval '
  (() => {
    const expected = sessionStorage.getItem("__sttExpected");
    const trig = document.querySelector("button.h-select-trigger[aria-label=\"STT engine\"]");
    const now = (trig.textContent || "").trim();
    // The empty guard matters: if the pick never happened, expected is "" and a
    // missing trigger would also read "" — that pair must FAIL, not pass.
    return !!expected && now === expected;
  })()'

# ── STEP 6c: THE WEB-SPEECH PRIVACY GATE ACTUALLY HOLDS ─────────────────────
# The mirror image of 6b, and a real privacy invariant rather than a workaround
# for it. Web Speech ships audio to the browser vendor's cloud, so page.tsx
# refuses to select it silently: setSttEngine opens the leak modal and returns
# WITHOUT saving until webSpeechLeakAcked is true. Assert BOTH halves — the
# warning appears AND the engine did not change — because "nothing happened" on
# its own is also what a broken picker looks like, which is precisely the
# ambiguity that made 6b expensive to diagnose.
say "6c. selecting Web Speech warns and does NOT silently change the engine"
"$TAT" click --pid "$PID" 'button.h-select-trigger[aria-label="STT engine"]' >/dev/null 2>&1 || true
"$TAT" wait --pid "$PID" --selector '.h-select-item' --timeout 20000 >/dev/null 2>&1 \
  || echo "DIAG: the portalled listbox never reopened for 6c"

WEBSPEECH_PICK="$("$TAT" eval --pid "$PID" '
  (() => {
    try {
      const trig = document.querySelector("button.h-select-trigger[aria-label=\"STT engine\"]");
      const item = [...document.querySelectorAll(".h-select-item")]
        .find(i => /web speech/i.test(i.textContent || ""));
      if (!item) return JSON.stringify({ skipped: "no Web Speech option offered" });
      window.__ws = { before: (trig.textContent || "").trim() };
      const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
                  pointerType: "mouse", button: 0 };
      item.dispatchEvent(new PointerEvent("pointerdown", o));
      item.dispatchEvent(new PointerEvent("pointermove", o));
      item.dispatchEvent(new PointerEvent("pointerup", o));
      return JSON.stringify(window.__ws);
    } catch (e) { return JSON.stringify({ wsError: String(e) }); }
  })()' 2>&1 || echo '{"wsError":"webspeech eval command failed"}')"
printf 'WEBSPEECH PICK: %s\n' "$WEBSPEECH_PICK"

# The modal's own copy, and the engine still unchanged. Asserting the exact
# sentence (not merely "a dialog exists") is what distinguishes the privacy
# warning from any other modal that might be open.
"$POLL" --require '.pc-settings-page--voice' --eval '
  (() => {
    const t = document.body.innerText || "";
    const warned = /Web Speech sends audio to the cloud/i.test(t);
    const trig = document.querySelector("button.h-select-trigger[aria-label=\"STT engine\"]");
    const unchanged = !!trig && (trig.textContent || "").trim() === (window.__ws && window.__ws.before);
    return warned && unchanged;
  })()'

# Dismiss it so step 7 inspects the settled page rather than a modal.
"$TAT" eval --pid "$PID" '
  (() => {
    const b = [...document.querySelectorAll("button")]
      .find(x => (x.textContent || "").trim() === "Cancel");
    if (b) b.click();
    return !!b;
  })()' >/dev/null 2>&1 || true

# ── STEP 7 ──────────────────────────────────────────────────────────────────
say "7. no console errors were raised while driving the surface"
"$POLL" --require '.pc-settings-page--voice' --no-errors

say "ALL VOICE-SETTINGS LIVE ASSERTIONS PASSED"
