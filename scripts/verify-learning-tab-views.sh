#!/usr/bin/env bash
# scripts/verify-learning-tab-views.sh — WI-6383, EI-18818262219163661,
# EI-18819790444425845.
#
# Opens EVERY Learning-tab view in a real webview and reports, per view, whether
# it actually painted or tripped the tab's error boundary.
#
# WHY THIS EXISTS. On 2026-07-27 the Throughput view crashed the whole Learning
# tab with React #185 ("Maximum update depth exceeded") while 86 jsdom tests —
# including render tests asserting that exact view mounted — were green. jsdom
# cannot see a render LOOP: it reports zero layout (scrollWidth === clientWidth
# === 0) and our suites install a no-op ResizeObserver, so every
# measure -> setState -> re-measure path is inert there. A passing render test
# proves a view renders ONCE, not that it renders.
#
# The second half of that lesson is why this script asserts what it does. An
# error-boundary trip is INVISIBLE to "is my element on screen" probing:
# querySelector returns null and getByRole throws whether the view is broken or
# merely absent. So the check is two-sided — the view's own root must be PRESENT
# *and* the boundary's text must be ABSENT.
#
# ── EI-18819790444425845: WHAT "PAINTED" USED TO MEAN, AND WHY THAT WAS WRONG ──
#
# Until 2026-07-27 this script drove every view at `?scope=all` — i.e. with NO
# pot selected — and asserted a bare `.pc-learning__viewpane`. Three separate
# holes, all of them the SAME defect class this gate exists to catch:
#
#  1. NO POT SCOPE. The five pot-scoped views (HIVE_AWARE_VIEWS) legitimately
#     render their EMPTY state when no pot is selected. WI-6410 existed because
#     six views rendered a FAILED read as a confident EMPTY state — so the gate
#     guarding that class was verifying every pot-scoped view in exactly the
#     empty state it is supposed to tell apart from a failure. It could not have
#     caught the bug it was written for.
#  2. FIRST-FRAME RACE. `improvements` is the tab's DEFAULT view, so on a fresh
#     load its pane exists before nuqs has hydrated `?slug=`. A probe that only
#     waits for the pane wins that race and measures the pre-scope frame.
#     Observed directly: driven via `?lview=gym` (a client-side param rewrite, no
#     reload) Improve rendered "156 ideas / 433 in the queue"; driven via
#     `?lview=improvements` (a full reload) the SAME view in the SAME session
#     reported "0 ideas". Same build, same data — different frame.
#  3. LOADING SKELETON COUNTED AS PAINTED. `pipeline` and `frontier` were both
#     captured mid-load ("Loading cycle artifacts…", "Loading frontier lanes…")
#     and reported ok. A view that never FINISHES loading was indistinguishable
#     from one that rendered.
#
# So the settle condition is now four-sided, and each clause is reported
# separately so a failure names its own cause:
#   · the pane for the view under test is the VISIBLE one (`data-view`),
#   · the pot lens is APPLIED   (`.pc-learning__hivepick`, hive-aware views only),
#   · the view is not still on a LOADING placeholder,
#   · and the boundary text is absent.
#
# ── WHICH view rendered, not just THAT one did ──
#
# `data-view` on the visible pane is the app's own answer to "which view is
# this", so the gate reads it instead of guessing from copy (a text probe would
# red the gate on every heading reword — a checker that breaks when the prose
# changes teaches people to ignore it). A view that silently degrades to another
# is now reported as DEGRADED, not ok: `?lview=gym` with FLAGS.TESTING off lands
# on Improvements by design (LearningTab's `view` fallback), which the old
# version passed as a clean `gym ok`. Declared degrades are listed in
# `declared_degrade_for` — an UNDECLARED one fails.
#
# USAGE
#   scripts/verify-learning-tab-views.sh                 # every view
#   scripts/verify-learning-tab-views.sh throughput ekg  # just these
#
# It boots its OWN isolated instance via scripts/verify-tauri-headless.sh (own X
# display, own port, own sidecar) and tears it down after. It never touches the
# owner's desktop or a peer's shell — see apps/operator-docs/.../testing/agent-e2e.mdx
# §1.3. READS ONLY: it navigates and inspects, it clicks nothing.
#
# ENV
#   VERIFY_LEARNING_POT          pot slug to scope to (default: papercusp). The
#                                gate is only as meaningful as this pot's data —
#                                point it at one that HAS learning-loop history.
#   VERIFY_LEARNING_SCOPE        harness scope axis (default: expanded)
#   VERIFY_LEARNING_WORKSPACE    workspace id (default: papercusp-workspace)
#   VERIFY_LEARNING_PAINT_TIMEOUT_MS / _ATTEMPTS   settle budget + retries
#   VERIFY_LEARNING_MAXIMIZE     0 = skip the window maximize (default: 1)
#   VERIFY_LEARNING_HARNESS      path to the harness launcher — overridden by the
#                                unit test to execute the GENERATED drive against
#                                a stub. See the note on that at the bottom.
#
# EXIT: 0 when every probed view painted, 1 when any crashed, degraded
# undeclared, never appeared, never finished loading, or was never pot-scoped
# (so it is usable as a release gate, not just an eyeball check).
#
# WHAT IT STILL DOES NOT CHECK — do not over-trust an `ok`. It asks "did THIS
# view render, pot-scoped, without crashing or hanging". It does not check that
# the CONTENT is correct, and an honest empty state ("No bake-offs") is an ok:
# emptiness is only a defect when it is standing in for a failed read, and that
# is what the resolvers' own `unavailable` provenance (WI-6410) reports.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The `?lview=` values, kept in the SAME order the stage catalog offers them.
# Deliberately a literal list rather than a parse of LearningTab.tsx: this script
# is the independent check, and a checker that derives its expectations from the
# thing it is checking cannot catch a view being dropped from the catalog. The
# reachability guard (learning-view-reachability.guard.test.ts) is what keeps the
# two lists honest in the other direction.
#
# ⚠ THE COST OF THAT INDEPENDENCE IS DRIFT, AND IT HAS BITTEN ONCE (WI-4366).
# `wake-efficiency` (MugWakeEfficiencyPanel) was deleted with the Mug/Kettle tier
# on 2026-08-09 (retire-mug-kettle-su-only-2026-08-09 P-059 / D-074 / D-076) and
# nobody removed it here. For ~3.5 weeks this gate probed a view that no longer
# exists, read LearningTab's intentional fallback as "WRONG VIEW ... (undeclared
# degrade)", and exited 1 on a HEALTHY tree — a permanently-red gate for a
# non-defect, which is exactly how a gate gets ignored. So do NOT hand-maintain
# this list against your memory of the app: learning-sweep-view-list-drift.guard
# .test.ts parses THIS array and fails in ~20ms if it names a view LVIEWS does
# not, or misses one it does. It reports the divergence; it does not generate
# this list, so the independence above is intact.
ALL_VIEWS=(
  signals observations rubrics
  pipeline
  gym improvements
  learnings
  benchmark orchestration bakeoff ekg red-queen experiments frontier throughput
)

# Mirrors HIVE_AWARE_VIEWS in LearningTab.tsx — the views whose reads take the
# pot lens, and therefore the only ones for which "the lens is applied" is a
# meaningful precondition. A literal mirror for the same reason ALL_VIEWS is one.
hive_aware() {
  case "$1" in
    improvements|gym|learnings|frontier|throughput) return 0 ;;
    *) return 1 ;;
  esac
}

# The view a given id is ALLOWED to fall back to, and why. Anything not listed
# here that renders a different view than the one requested is a failure.
declared_degrade_for() {
  case "$1" in
    # FLAGS.TESTING off ⇒ LearningTab's `view` fallback lands on the default.
    gym) echo improvements ;;
    *) echo "" ;;
  esac
}

VIEWS=("$@")
[ ${#VIEWS[@]} -eq 0 ] && VIEWS=("${ALL_VIEWS[@]}")

POT="${VERIFY_LEARNING_POT:-papercusp}"
POT_SCOPE="${VERIFY_LEARNING_SCOPE:-expanded}"
WORKSPACE="${VERIFY_LEARNING_WORKSPACE:-papercusp-workspace}"
HARNESS="${VERIFY_LEARNING_HARNESS:-$REPO_DIR/scripts/verify-tauri-headless.sh}"

DRIVE="$(mktemp -t learning-views-drive.XXXXXX.sh)"
trap 'rm -f "$DRIVE"' EXIT

# EI-18818262219163661: both were hardcoded. 45s is comfortable for a small view
# and thin for the heaviest one (`improvements` aggregates the funnel plus the
# full idea/work lists), and a loaded box stretches every one of them.
PAINT_TIMEOUT_MS="${VERIFY_LEARNING_PAINT_TIMEOUT_MS:-45000}"
PAINT_ATTEMPTS="${VERIFY_LEARNING_PAINT_ATTEMPTS:-3}"
# Consecutive satisfying polls required before a view counts as settled — see
# the debounce note on SETTLED below. 1 restores the old instantaneous check.
SETTLE_POLLS="${VERIFY_LEARNING_SETTLE_POLLS:-3}"

# ── the drive ────────────────────────────────────────────────────────────────
# Every emitted token is SPACE-FREE and NEWLINE-FREE on purpose. The bridge
# pretty-prints JSON results across lines, so anything JSON-shaped has to be
# de-newlined AND de-spaced before it can be matched — a compact pattern silently
# never fires against pretty output, which would burn every retry and mislabel
# healthy views as "recovered on attempt 2" (caught by negative control, not by
# reading). A flat `k=v~k=v` token has no such failure mode: it survives
# concatenation intact and stays greppable in the raw log for a human.
{
  echo 'set -u'
  echo 'P="$VERIFY_TAURI_PID"; PORT="$VERIFY_TAURI_PORT"'
  # The frame is only evidence if a human can read it, and at the default window
  # size the Learning content is a narrow right-hand dock RAIL rather than a
  # pane (EI-18819790444425845). Xvfb is 1920x1080, so maximizing gives the
  # layout a user actually sees. Best-effort: a missing wmctrl must not fail a
  # DOM gate that does not depend on it.
  if [ "${VERIFY_LEARNING_MAXIMIZE:-1}" = "1" ]; then
    echo 'if command -v wmctrl >/dev/null 2>&1; then DISPLAY="${VERIFY_TAURI_DISPLAY:-$DISPLAY}" wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz >/dev/null 2>&1 || true; fi'
  fi
  # Wait for the SPA to mount at all before judging any view, or the first probe
  # measures a blank document and reports a false crash.
  echo 'tauri-agent-tools wait --pid "$P" --eval "document.querySelectorAll('"'"'[role=tab]'"'"').length > 0" --timeout 120000 >/dev/null 2>&1 || echo "MOUNT-TIMEOUT"'

  IDX=0
  for V in "${VIEWS[@]}"; do
    IDX=$((IDX + 1))
    # A navigation NONCE, not the view id, is what pins the probe to the
    # incoming page. Navigation here is a FULL reload, so for a moment the
    # PREVIOUS view's pane is still in the DOM; a wait satisfied by the outgoing
    # page measures whatever the reload happens to be mid-way through (observed:
    # the same view probed twice returned a clean verdict and then a blank one).
    # The obvious pin — `lview=<view>` — is NOT sufficient here: LearningTab
    # rewrites the raw param to the RESOLVED view, so `?lview=gym` becomes
    # `lview=improvements` and the pin evaporates exactly on the views whose
    # degrade behaviour we most want to observe. A nonce is untouched by that
    # rewrite because nothing in the app owns the key.
    NONCE="vn${IDX}"
    URL="http://127.0.0.1:\$PORT/adv?tab=learning&ws=$WORKSPACE&slug=$POT&scope=$POT_SCOPE&lview=$V&vnonce=$NONCE"

    # The pot lens is a PRECONDITION for the hive-aware views, not a nice-to-
    # have: without it their reads run unscoped and the verdict is about the
    # empty state. `.pc-learning__hivepick` is the tab's own rendering of the
    # inherited pot, so its presence is the app telling us the lens resolved.
    if hive_aware "$V"; then
      SCOPE_CLAUSE="if(!document.querySelector('.pc-learning__hivepick'))ok=false;"
    else
      SCOPE_CLAUSE=""
    fi

    # DEBOUNCED, and that is load-bearing rather than defensive. The pot lens
    # resolves BEFORE the scoped read fires, so there is a window in which the
    # chip is present and the view is not YET loading — an instantaneous check
    # passes there and the probe a moment later lands on "Loading what the loop
    # produced…". Observed on exactly the two pot-scoped, data-heavy views
    # (improvements, gym) while every other view passed. So the condition must
    # hold across CONSECUTIVE polls, not once. A full reload clears the counter
    # for free, so it never carries across navigations.
    SETTLED="location.href.indexOf('vnonce=$NONCE')>=0&&(/hit an error/.test(document.body.innerText)||(function(){var p=document.querySelector('.pc-learning__viewpane:not([hidden])');var ok=true;if(!p)ok=false;else if(/Loading [^\\n]*…/.test(p.innerText))ok=false;else if(p.innerText.trim().length===0)ok=false;${SCOPE_CLAUSE}if(!ok){window.__pcSettled=0;return false;}window.__pcSettled=(window.__pcSettled||0)+1;return window.__pcSettled>=$SETTLE_POLLS;})())"

    PROBE="(function(){var p=document.querySelector('.pc-learning__viewpane:not([hidden])');var t=p?p.innerText:'';return ['VERDICT~$V','pane='+(p?1:0),'visible='+(p?p.getAttribute('data-view'):'-'),'boundary='+(/hit an error/.test(document.body.innerText)?1:0),'scoped='+(document.querySelector('.pc-learning__hivepick')?1:0),'loading='+(/Loading [^\\n]*…/.test(t)?1:0),'chars='+t.trim().length].join('~');})()"

    # EI-18818262219163661: the wait's exit status used to be thrown away with
    # `|| true`, so a view that simply had not settled YET at the deadline was
    # reported in the SAME words as a genuine crash ("NEVER PAINTED"), and the
    # run exited 1. That is the most expensive possible ambiguity: a one-view red
    # points at whatever you most recently edited, which is exactly when you can
    # least afford to wave it off. Observed 2026-07-27 — `improvements` came back
    # NEVER PAINTED, and a direct drive then painted it in 5s (nine times inside
    # the budget). Two runs of the SAME build failed DIFFERENT views. So: keep the
    # status, and RETRY in-session before believing it.
    #
    # The retry is inside the drive on purpose — the instance is already booted,
    # so a second attempt costs seconds, where a second harness run costs a full
    # ~2min boot. A real defect still fails every attempt; only a flake recovers.
    # RENAV distinguishes the two reasons an attempt can fail, because they want
    # opposite remedies. A TIMEOUT means the page never arrived — re-navigate. A
    # probe that came back `loading=1` means the page arrived and is mid-fetch —
    # re-navigating there just restarts the same race (and the first version of
    # this loop did exactly that, reporting x1 because it treated a successful
    # wait as settled without consulting the probe that contradicted it). Wait
    # and re-probe instead; a view that genuinely never finishes still fails
    # every attempt, which is the outcome we want.
    echo "V_SETTLED=0; V_TIMEDOUT=true; V_RESULT=''; RENAV=1"
    echo "for attempt in \$(seq 1 $PAINT_ATTEMPTS); do"
    echo "  [ \"\$RENAV\" = 1 ] && tauri-agent-tools eval --pid \"\$P\" \"location.href='$URL'; 'go'\" >/dev/null 2>&1"
    echo "  if tauri-agent-tools wait --pid \"\$P\" --eval \"$SETTLED\" --timeout $PAINT_TIMEOUT_MS >/dev/null 2>&1; then V_TIMEDOUT=false; else V_TIMEDOUT=true; fi"
    echo "  V_RESULT=\"\$(tauri-agent-tools eval --pid \"\$P\" \"$PROBE\" 2>&1 | tr -d ' \\n\"')\""
    # A boundary trip is DEFINITIVE — retrying a crash just burns the budget.
    echo "  case \"\$V_RESULT\" in *'boundary=1'*) V_SETTLED=1 ;; esac"
    # The PROBE is the authority, not the wait: settled means the wait concluded
    # AND the measurement agrees the view is not still loading.
    echo "  if [ \"\$V_SETTLED\" != 1 ] && [ \"\$V_TIMEDOUT\" = false ]; then"
    echo "    case \"\$V_RESULT\" in *'loading=1'*) RENAV=0 ;; *) V_SETTLED=1 ;; esac"
    echo "  else"
    echo "    [ \"\$V_SETTLED\" = 1 ] || RENAV=1"
    echo "  fi"
    echo "  [ \"\$V_SETTLED\" = 1 ] && break"
    echo "done"
    echo "echo \"TIMEDOUT:$V:\$V_TIMEDOUT ATTEMPTS:$V:\$attempt\""
    echo "echo \"\$V_RESULT\""
  done
} > "$DRIVE"

# Drive-only mode: emit the generated drive and stop. The unit test asserts
# against THIS, because the near-miss that motivated it (a compact pattern that
# could never match pretty-printed output) lived entirely in generated text that
# no test executed — parser tests that stub the harness never see it.
if [ "${VERIFY_LEARNING_PRINT_DRIVE:-0}" = "1" ]; then
  cat "$DRIVE"
  exit 0
fi

RAW="$(mktemp -t learning-views-raw.XXXXXX)"
"$HARNESS" -- bash "$DRIVE" 2>&1 | tee "$RAW"

# The verdicts are read from the RAW log, NOT from a de-newlined copy of it.
# The previous version flattened the whole transcript because the bridge
# pretty-prints JSON across lines — but flattening also welds each view's token
# onto the NEXT view's markers, and a `grep -o key=[^~]* | tail -1` over that
# soup can silently answer with a different view's field. The drive already
# strips whitespace from the result before echoing it, so every verdict is one
# space-free line and needs no flattening at all: matching `[^ ]*` on the raw
# line is both simpler and cannot cross a view boundary.
field() { # field <token-line> <key>  → the value, or empty
  printf '%s' "$1" | grep -o "$2=[^~]*" | tail -1 | sed "s/^$2=//"
}

echo
echo "── Learning tab: per-view render verdict ─────────────────────────────"
echo "   pot=$POT scope=$POT_SCOPE workspace=$WORKSPACE"
FAILED=0
for V in "${VIEWS[@]}"; do
  LINE="$(grep -o "VERDICT~$V~[^ ]*" "$RAW" | tail -1)"
  if [ -z "$LINE" ]; then
    printf '  %-16s INCONCLUSIVE — no verdict captured\n' "$V"
    FAILED=1
    continue
  fi
  # EI-18818262219163661: a check that never CONCLUDED must not be reported in
  # the same words as one that concluded negatively (the mirror of the
  # a-check-that-never-ran-must-not-read-as-passed insight). The drive emits its
  # own timeout marker because the verdict token cannot carry it.
  ATTEMPTS="$(grep -o "ATTEMPTS:$V:[0-9]*" "$RAW" | tail -1 | sed "s/.*://")"
  RETRIED=""
  [ -n "$ATTEMPTS" ] && [ "$ATTEMPTS" -gt 1 ] 2>/dev/null && RETRIED=" (recovered on attempt $ATTEMPTS)"

  PANE="$(field "$LINE" pane)"
  VISIBLE="$(field "$LINE" visible)"
  BOUNDARY="$(field "$LINE" boundary)"
  SCOPED="$(field "$LINE" scoped)"
  LOADING="$(field "$LINE" loading)"
  CHARS="$(field "$LINE" chars)"
  DEGRADE="$(declared_degrade_for "$V")"

  if [ "$BOUNDARY" = "1" ]; then
    printf '  %-16s CRASHED — the tab error boundary tripped\n' "$V"; FAILED=1; continue
  fi
  if [ "$PANE" != "1" ]; then
    if grep -q "TIMEDOUT:$V:true" "$RAW"; then
      printf '  %-16s TIMED OUT after %ss x%s — never painted, never errored. NOT proof of a defect: re-drive this one view before believing it (fact: learning-view-sweep-single-view-flake).\n' \
        "$V" "$((PAINT_TIMEOUT_MS / 1000))" "${ATTEMPTS:-?}"
    else
      printf '  %-16s NEVER PAINTED — no view pane, no boundary\n' "$V"
    fi
    FAILED=1; continue
  fi
  if [ "$VISIBLE" != "$V" ] && [ "$VISIBLE" != "$DEGRADE" ]; then
    printf '  %-16s WRONG VIEW — rendered %s instead (undeclared degrade)\n' "$V" "$VISIBLE"; FAILED=1; continue
  fi
  if [ "$LOADING" = "1" ]; then
    printf '  %-16s STILL LOADING after %ss x%s — a loading placeholder is not a render\n' \
      "$V" "$((PAINT_TIMEOUT_MS / 1000))" "${ATTEMPTS:-?}"; FAILED=1; continue
  fi
  if hive_aware "$V" && [ "$SCOPED" != "1" ]; then
    printf '  %-16s UNSCOPED — pot lens never applied, so this verdict is about the empty state (EI-18819790444425845)\n' "$V"
    FAILED=1; continue
  fi
  if [ "${CHARS:-0}" -le 0 ] 2>/dev/null; then
    printf '  %-16s EMPTY PANE — mounted but rendered nothing\n' "$V"; FAILED=1; continue
  fi
  if [ "$VISIBLE" != "$V" ]; then
    printf '  %-16s ok — DEGRADED to %s (declared)%s\n' "$V" "$VISIBLE" "$RETRIED"
  elif hive_aware "$V"; then
    printf '  %-16s ok — pot-scoped%s\n' "$V" "$RETRIED"
  else
    printf '  %-16s ok%s\n' "$V" "$RETRIED"
  fi
done
echo "──────────────────────────────────────────────────────────────────────"
if [ "$FAILED" -eq 0 ]; then
  rm -f "$RAW"
  echo "ALL PROBED VIEWS PAINTED"
else
  # A gate that fails and then deletes its own evidence makes the next agent
  # re-run a 2min boot to see what it already had.
  echo "AT LEAST ONE VIEW IS BROKEN — see above (raw drive log kept at $RAW)"
fi
exit "$FAILED"
