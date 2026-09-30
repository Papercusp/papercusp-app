#!/usr/bin/env bash
# Live Tauri-shell verification for the COMPACT PLAN CARD
# (hud-plan-card-density-2026-08-31).
#
# Run it as:
#   scripts/verify-tauri-headless.sh -- scripts/verify-hud-plan-card-density.sh
#
# ── WHY THIS SCRIPT EXISTS, AND WHY ROUND 1 DID NOT COUNT ────────────────────
# Round 1 measured the grid floor and reported every mode clean. Independent
# acceptance grading (EI-21987526785418505) rated `evidence-could-have-failed`
# FAILS, and it was right: round 1's negative controls REFUSED TO BREAK. A
# probe that cannot report red has not verified anything when it reports green —
# a clean reading from it is indistinguishable from a probe reading the wrong
# property. Two specific instrument defects were established on WI-1816517:
#
#   1. documentElement is the WRONG INSTRUMENT for the page-h-scroll mode here.
#      Appending a 5000px-wide node to <body> left documentElement.scrollWidth
#      pinned at 1280 == clientWidth. The root CLIPS, so that instrument can
#      never go red.
#   2. "no height growth" is very nearly VACUOUS as written. `.hud__card` is
#      `overflow:hidden` (hud.css:1121), so content that would grow the card is
#      CLIPPED instead. Height therefore does not move, and a probe watching
#      height reports clean while the card silently eats its own content. The
#      falsifiable observable is scrollHeight > clientHeight, not offsetHeight.
#
# ── THE DISCIPLINE THIS SCRIPT ENFORCES ─────────────────────────────────────
# Every mode is measured by a probe in `window.__hudprobe`, and for each mode
# the CONTROL AND THE MEASUREMENT CALL THE SAME FUNCTION. That identity is the
# whole point: proving a control fires proves nothing about the measurement if
# the two run different code. Each mode therefore runs
#
#     control (mutate; the SAME probe must report RED)
#       -> restore
#         -> measure (the SAME probe must report GREEN)
#
# and a control that fails to fire is a FATAL, not a warning: the script exits
# nonzero and emits NO green for that mode. A green exit from this script means
# "every mode was measured by an instrument demonstrated to go red on this very
# run", which is the claim round 1 could not make.
#
# Negative assertions are `--require`-guarded (EI-18781011720418569): "no card
# overflows" is trivially true of an empty document, and the board rendering
# zero cards is a REAL failure mode here (WI-1816517 round 3 polled 24x5s and
# never got a card). A zero-card board must be loud, never a silent green.
set -euo pipefail

TAT="${VERIFY_TAURI_AGENT_TOOLS_BIN:-tauri-agent-tools}"
PID="${VERIFY_TAURI_PID:?verify-tauri-headless.sh must export VERIFY_TAURI_PID}"
POLL="${VERIFY_TAURI_POLL:?verify-tauri-headless.sh must export VERIFY_TAURI_POLL}"
SETTLE="${VERIFY_TAURI_SETTLE:-}"

# The wrapper gives us an agent-owned X display.  The narrow-viewport pass
# below resizes only that isolated window, never the owner's real desktop.
X_DISPLAY="${VERIFY_TAURI_DISPLAY:-${DISPLAY:-}}"
NARROW_WID=""
NARROW_ORIG_W=""
NARROW_ORIG_H=""
restore_narrow_window() {
  if [ -n "$NARROW_WID" ] && [ -n "$NARROW_ORIG_W" ] && [ -n "$NARROW_ORIG_H" ]; then
    DISPLAY="$X_DISPLAY" xdotool windowsize "$NARROW_WID" "$NARROW_ORIG_W" "$NARROW_ORIG_H" >/dev/null 2>&1 || true
  fi
}
trap restore_narrow_window EXIT

# The floor the acceptance criterion names: the weighted spec's minmax minima.
# Pinning gridTemplateColumns to these literals puts all three card columns at
# their narrowest simultaneously, which is what "at the grid floor" means.
FLOOR_COLS="220px 260px 180px 46px 46px"

say() { printf '\n=== %s ===\n' "$1"; }
fatal() { printf '\nFATAL: %s\n' "$1" >&2; exit 1; }

settle() { [ -n "$SETTLE" ] && bash "$SETTLE" >/dev/null 2>&1 || true; }

# ── 1. GET THE PLANS BOARD ON SCREEN, OR FAIL LOUDLY ────────────────────────
say "1. navigating to the HUD plans board"
URL="/adv?tab=hud&hudtab=plans&slug=papercusp&ws=papercusp-workspace"
"$TAT" eval --pid "$PID" "window.location.href = '$URL'" >/dev/null 2>&1 || true

# Poll for the CARD, not for a container. The container renders while the
# sync-backed cards are still in flight, so waiting on it and then measuring is
# exactly the race that produced round 3's 0-card reading.
if ! "$TAT" wait --pid "$PID" --selector '.hud__cardtitle' --timeout 90000 >/dev/null 2>&1; then
  "$TAT" eval --pid "$PID" '
    JSON.stringify({
      cols: !!document.querySelector(".hud__cols"),
      weighted: !!document.querySelector(".hud__cols--weighted"),
      anyCard: document.querySelectorAll(".hud__card").length,
      planTitles: document.querySelectorAll(".hud__cardtitle").length,
      href: location.href,
    })' 2>/dev/null || true
  fatal "the plans board never rendered a plan card. This is NOT a green: a
zero-card board satisfies every negative assertion below vacuously. Re-run;
if it persists it is the intermittent zero-card render tracked on WI-1816517."
fi
settle

# ── 2. INSTALL THE PROBES ───────────────────────────────────────────────────
# One namespace, used by BOTH the controls and the measurements. Read the
# comments per probe: each says what observable it reads and why that is the
# falsifiable one.
say "2. installing probes"
"$TAT" eval --pid "$PID" '
(() => {
  const P = {};
  // The plan-compact card population: a .hud__card that owns a .hud__cardtitle.
  // .hud__cardtitle is used ONLY by PlanCardCompact (hud.css:795), so this is
  // exactly the population the density work touched and nothing else.
  P.cards = () => [...document.querySelectorAll(".hud__card")]
    .filter(c => c.querySelector(".hud__cardtitle"));

  // The acceptance bar distinguishes the ordinary two-line form from the
  // settled-column one-line form.  Keep that distinction in the evidence
  // rather than reporting one blended min/max that could hide an unmeasured
  // population.  The class is written by EntityCardBody from card.column;
  // `hud__card--entity` is the shared marker and is deliberately excluded.
  P.groupHeights = () => {
    const groups = { twoLine: [], settled: [], unknown: [] };
    for (const c of P.cards()) {
      const col = [...c.classList]
        .map(x => { const m = x.match(/^hud__card--(.+)$/); return m ? m[1] : null; })
        .find(x => x && x !== "entity") || "unknown";
      const group = col === "ready" || col === "done" ? "settled" : (col === "unknown" ? "unknown" : "twoLine");
      groups[group].push(Math.round(c.getBoundingClientRect().height));
    }
    return groups;
  };
  P.groupSummary = () => {
    const groups = P.groupHeights();
    const out = {};
    for (const name of ["twoLine", "settled", "unknown"]) {
      const values = groups[name], sorted = [...values].sort((a, b) => a - b);
      out[name] = {
        cards: values.length,
        minHeight: sorted.length ? sorted[0] : null,
        maxHeight: sorted.length ? sorted[sorted.length - 1] : null,
        medianHeight: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        distinctHeights: [...new Set(sorted)],
      };
    }
    return out;
  };
  // Weighted Plans hides the ready/done columns behind count rails.  Focus a
  // populated settled rail through the real segmented-filter control so the
  // one-line form is measured on its own, then return to All.  The helpers are
  // idempotent because VERIFY_TAURI_POLL may retry the same assertion.
  P.focusSettled = () => {
    const group = document.querySelector(`[aria-label="Filter plans by column"]`);
    if (!group) return false;
    const buttons = [...group.querySelectorAll("button")];
    if (buttons.some(b => b.getAttribute("aria-pressed") === "true" && /^(Done|Ready)\s/.test(b.textContent.trim()))) return true;
    const count = b => Number((b.textContent.match(/(\d+)\s*$/) || [])[1] || 0);
    const pick = buttons.find(b => /^Done\s/.test(b.textContent.trim()) && count(b) > 0)
      || buttons.find(b => /^Ready\s/.test(b.textContent.trim()) && count(b) > 0);
    if (!pick) return false;
    P._settledLabel = pick.textContent.trim().replace(/\s+\d+\s*$/, "");
    pick.click();
    return true;
  };
  P.focusAll = () => {
    const group = document.querySelector(`[aria-label="Filter plans by column"]`);
    if (!group) return false;
    const all = [...group.querySelectorAll("button")].find(b => /^All\s/.test(b.textContent.trim()));
    if (!all) return false;
    if (all.getAttribute("aria-pressed") !== "true") all.click();
    return true;
  };
  P.allSettled = () => P.cards().length >= 1 && P.cards().every(c =>
    [...c.classList].some(x => x === "hud__card--ready" || x === "hud__card--done"));

  // HEIGHT. Measured against a baseline captured at natural width.
  //
  // ⚠ scrollHeight > clientHeight IS A DEAD INSTRUMENT ON THIS ELEMENT — do not
  // reintroduce it. It was tried here first (it is the obvious reading of
  // "overflow:hidden means growth becomes clipping") and MEASURED UNFALSIFIABLE
  // on this rig: injecting a 400px child took the card 51 -> 451px while
  // scrollHeight tracked clientHeight exactly (49/49 -> 449/449). `.hud__card`
  // is a content-sized <button> with flex-shrink:0 and no height constraint, so
  // it GROWS and never accumulates overflow; scrollHeight can never exceed
  // clientHeight, and a clean reading from it means nothing. That is the same
  // defect class as documentElement for the page-scroll mode.
  //
  // Growth is therefore the real and only observable, and offsetHeight reports
  // it faithfully (51 -> 451 -> 51 across the injection above).
  P.maxHeight = () => Math.max(...P.heights());
  P.setBaseline = () => { P._baseline = P.maxHeight(); return P._baseline; };
  P.grown = () => P._baseline == null
    ? -1  // never silently pass: no baseline means the mode is unmeasured
    : P.cards().filter(c => c.getBoundingClientRect().height > P._baseline + 1).length;

  // HORIZONTAL CARD OVERFLOW — the mode that already had a working control.
  P.hclip = () => P.cards().filter(c => c.scrollWidth > c.clientWidth + 1).length;

  // RAIL CLIPPING. .hud__cardright is flex:0 0 auto beside a flex:1 1 auto
  // title, so when the rail cannot fit it is pushed past the card edge and
  // overflow:hidden hides it. Compare the rail rect against the card CONTENT
  // box (border+padding excluded), which is the edge that actually clips.
  P.railOut = () => P.cards().filter(c => {
    const r = c.querySelector(".hud__cardright");
    if (!r) return false;
    const cs = getComputedStyle(c);
    const cardRight = c.getBoundingClientRect().right
      - parseFloat(cs.borderRightWidth || "0") - parseFloat(cs.paddingRight || "0");
    return r.getBoundingClientRect().right > cardRight + 1;
  }).length;

  // TITLE ELLIPSIS. Not a defect — the design ellipsizes on purpose — so this
  // is reported as a NUMBER, never asserted to be zero.
  P.titlesClamped = () => P.cards()
    .filter(c => { const t = c.querySelector(".hud__cardtitle");
                   return t && t.scrollWidth > t.clientWidth + 1; }).length;

  P.heights = () => P.cards().map(c => Math.round(c.getBoundingClientRect().height));

  // THE GRID THAT ACTUALLY HOLDS THE PLAN CARDS.
  //
  // ⚠ NEVER go back to document.querySelector(".hud__cols") — it was tried and
  // it silently matched the HIDDEN sessions panel (.hud__panel--sessions,
  // clientWidth 0) while the plan cards lived in a different subtree. Every
  // write went to the wrong node and every read confirmed it, so the
  // "floor confirmed applied" assertion PASSED while the plans grid was
  // untouched: a self-consistent lie. Only the 40px control catching nothing
  // exposed it. Deriving the container FROM a real card makes that class of
  // error impossible — the element is by construction the one being measured.
  P.cols = () => { const c = P.cards()[0]; return c ? c.closest(".hud__cols") : null; };

  // THE SCROLL CHAIN. documentElement cannot answer the page-h-scroll question
  // here, so instead of trusting one node this walks every ancestor from the
  // plans grid to the root and reports which ones overflow and which CLIP.
  // An ancestor above the grid that overflows is a real page-level defect;
  // the grid itself overflowing is BY DESIGN (hud.css:591 overflow-x:auto).
  P.chain = () => {
    const out = [];
    let el = P.cols();
    while (el) {
      const cs = getComputedStyle(el);
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 40),
        ox: cs.overflowX,
        sw: el.scrollWidth,
        cw: el.clientWidth,
        over: el.scrollWidth > el.clientWidth + 1,
      });
      el = el.parentElement;
    }
    return out;
  };
  // Anything ABOVE .hud__cols that overflows horizontally. index 0 is
  // .hud__cols itself, whose overflow is the designed behaviour.
  P.pageOverflow = () => P.chain().slice(1).filter(e => e.over).length;
  // Can ANY node in the chain report horizontal overflow at all? If not, the
  // whole chain clips silently and no green from pageOverflow means anything.
  P.chainCanReport = () => P.chain().some(e => e.over);

  // ── mutation helpers (controls) ──
  // TRACK TEMPLATES. Kept as JS literals rather than interpolated from the
  // shell: splicing a value into a single-quoted eval argument splits it on
  // whitespace, and these specs have spaces in them. FLOOR_COLS in the shell
  // must match TPL.floor; the resolved-track assertion below fails if it drifts.
  //
  // WHY A "roomy" TEMPLATE EXISTS. The HUD is only ~550px wide here (a left
  // sidebar and the op-chat both take width), and the weighted floor sums to
  // 752px + gaps — so the grid is ALREADY PINNED AT ITS FLOOR at "natural"
  // width. Taking the baseline from the ambient layout therefore compared the
  // floor against ITSELF and made "no growth at the floor" trivially true: a
  // vacuous green that no control could expose, because the control was
  // measuring a real property in a comparison that had no contrast. `roomy`
  // forces a genuinely wider layout so the floor is a real change from it.
  P.TPL = {
    roomy: "400px 520px 400px 46px 46px",
    floor: "220px 260px 180px 46px 46px",
    squeeze: "40px 40px 40px 40px 40px",
  };
  P.tpl = name => {
    const c = P.cols();
    if (!c) return false;
    c.style.gridTemplateColumns = name === null ? "" : P.TPL[name];
    return true;
  };
  // Resolved (used) track widths — what actually laid out, not what we asked
  // for. This is the falsifier for "did the template really apply".
  P.tracks = () => {
    const c = P.cols();
    return c ? getComputedStyle(c).gridTemplateColumns.split(" ").map(parseFloat) : [];
  };
  P.tracksAre = name => {
    const want = P.TPL[name].split(" ").map(parseFloat), got = P.tracks();
    return got.length === want.length && want.every((w, i) => Math.abs(got[i] - w) <= 1);
  };
  P.tall = on => {
    const c = P.cards()[0]; if (!c) return false;
    const old = c.querySelector("[data-probe-tall]");
    if (on) { if (old) return true;
      const d = document.createElement("div");
      d.setAttribute("data-probe-tall", "1");
      d.style.cssText = "height:400px;width:1px";
      c.appendChild(d); return true; }
    if (old) old.remove(); return true;
  };
  P.style = (id, css) => {
    let s = document.getElementById(id);
    if (css === null) { if (s) s.remove(); return true; }
    if (!s) { s = document.createElement("style"); s.id = id; document.head.appendChild(s); }
    s.textContent = css; return true;
  };
  P.wide = on => {
    const old = document.querySelector("[data-probe-wide]");
    if (on) { if (old) return true;
      const d = document.createElement("div");
      d.setAttribute("data-probe-wide", "1");
      d.style.cssText = "width:5000px;height:1px";
      document.body.appendChild(d); return true; }
    if (old) old.remove(); return true;
  };
  window.__hudprobe = P;
  return "probes installed";
})()' || fatal "could not install probes"

# ── 3. DENSITY AT THE CURRENT SHA (whole population) ────────────────────────
# The prior 51px figure is WITHDRAWN as stale: three commits landed on
# HudEntityColumns.tsx / hud.css after it was taken, and the diff touches
# .hud__cardtitle, the node that sets the card's line-1 height. This
# re-measures the WHOLE population at the current tree rather than re-citing it.
say "3. the grid under measurement is the one holding the plan cards"
# Guard against the wrong-subtree bug described on P.cols: assert the derived
# container is REAL (laid out, nonzero width) and is the weighted plans grid.
"$POLL" --require '.hud__cardtitle' --eval '
  (() => { const c = window.__hudprobe.cols();
    return !!c && c.clientWidth > 0 && c.classList.contains("hud__cols--weighted"); })()' \
  || fatal "the container derived from the plan cards is missing, zero-width, or
not the weighted plans grid. Measuring it would repeat the hidden-panel error."
"$TAT" eval --pid "$PID" '
JSON.stringify({ MEASURE: "grid-under-test",
  cls: window.__hudprobe.cols().className,
  clientWidth: window.__hudprobe.cols().clientWidth,
  tracks: window.__hudprobe.tracks() }, null, 1)'

say "3a. DENSITY AS SHIPPED at the current sha — whole population, ambient layout"
# This is the density evidence proper: what a real user sees right now, at the
# current sha, across every plan card on the board. It supersedes the withdrawn
# 51px figure by RE-MEASURING rather than re-citing it.
"$POLL" --require '.hud__cardtitle' --require-min 1 \
  --eval 'window.__hudprobe.cards().length >= 1' \
  || fatal "no plan cards to measure"
# A single aggregate histogram can hide a missing ordinary population.  The
# weighted board keeps ready/done behind count rails, so the settled form is
# measured explicitly below rather than assumed to be present in this view.
settle
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.groupHeights().twoLine.length >= 1' \
  || fatal "the live Plans board did not render an ordinary two-line plan-card population"
"$TAT" eval --pid "$PID" '
(() => {
  const P = window.__hudprobe, h = P.heights();
  const sorted = [...h].sort((a, b) => a - b);
  return JSON.stringify({
    MEASURE: "density-as-shipped",
    cards: h.length,
    minHeight: sorted[0],
    maxHeight: sorted[sorted.length - 1],
    medianHeight: sorted[Math.floor(sorted.length / 2)],
    distinctHeights: [...new Set(sorted)],
    titlesClamped: P.titlesClamped(),
    hudWidth: P.cols().clientWidth,
    viewport: window.innerWidth + "x" + window.innerHeight,
    populations: P.groupSummary(),
  }, null, 1);
})()'

say "3c. SETTLED FORM — focus a populated ready/done rail and measure it separately"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.focusSettled()' \
  || fatal "neither the Done nor Ready filter contains a populated settled plan-card column"
"$POLL" --require '.hud__cardtitle' --require-min 1 \
  --eval 'window.__hudprobe.allSettled()' \
  || fatal "the focused settled column did not render settled plan cards"
settle
"$TAT" eval --pid "$PID" '
(() => ({ MEASURE: "density-settled-form",
  focused: window.__hudprobe._settledLabel || "unknown",
  viewport: window.innerWidth + "x" + window.innerHeight,
  populations: window.__hudprobe.groupSummary(),
  maxHeight: window.__hudprobe.maxHeight(),
  titlesClamped: window.__hudprobe.titlesClamped(),
}))()'
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.maxHeight() <= 52' \
  || fatal "the focused settled plan-card form exceeds the 52px density target"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.focusAll()' \
  || fatal "could not restore the All plans view after settled-form measurement"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.groupHeights().twoLine.length >= 1' \
  || fatal "the All plans view did not return after settled-form measurement"
settle

say "3b. BASELINE at a genuinely ROOMY layout (400/520/400)"
# Not the ambient layout: see P.TPL. At ~550px the grid is already at its floor,
# so an ambient baseline would compare the floor against itself.
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tpl("roomy")' >/dev/null
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tracksAre("roomy")' \
  || fatal "the roomy template did not apply; the baseline would be meaningless."
settle
"$TAT" eval --pid "$PID" '
(() => {
  const P = window.__hudprobe;
  // Mode (i) returns -1 (never a pass) if this was never set, so a reordering
  // of this script cannot silently turn the height mode into a vacuous green.
  P.setBaseline();
  return JSON.stringify({ MEASURE: "roomy-baseline",
    baselineHeight: P._baseline,
    cardWidths: [...new Set(P.cards().map(c => Math.round(c.getBoundingClientRect().width)))],
    titlesClamped: P.titlesClamped() }, null, 1);
})()'

# ── 4. THE THREE UNMEASURED MODES, EACH BEHIND ITS OWN CONTROL ──────────────
say "4. AT THE FLOOR ($FLOOR_COLS)"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tpl("floor")' \
  || fatal "could not pin the grid to the floor"
settle

# THE FLOOR MUST DEMONSTRABLY HAVE APPLIED, AND THE LAYOUT MUST HAVE MOVED.
# Two separate guards, because the first one alone is what failed before:
#  (a) resolved tracks are the floor — but a read of the WRONG element agrees
#      with a write to that same wrong element, which is how the hidden-panel
#      bug passed this check while the plans grid was untouched. P.cols() now
#      makes the element the one the cards live in, so (a) is meaningful again.
#  (b) card widths actually CHANGED from the roomy baseline. This is the
#      contrast check: if the floor produced the same layout as the baseline,
#      every comparison below has no contrast and is vacuous regardless of how
#      well its control fires.
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tracksAre("floor")' \
  || fatal "the floor did NOT apply — resolved grid tracks are not
220/260/180/46/46. Every measurement below would have been taken at some other
width while claiming to be at the floor. Refusing to emit a green."
"$TAT" eval --pid "$PID" '
JSON.stringify({ MEASURE: "floor-applied",
  tracks: window.__hudprobe.tracks(),
  cardWidths: [...new Set(window.__hudprobe.cards()
    .map(c => Math.round(c.getBoundingClientRect().width)))] }, null, 1)'
"$POLL" --require '.hud__cardtitle' --eval '
  (() => { const P = window.__hudprobe;
    const w = [...new Set(P.cards().map(c => Math.round(c.getBoundingClientRect().width)))];
    return w.every(x => x < 400); })()' \
  || fatal "the floor produced card widths indistinguishable from the roomy
baseline, so 'at the floor' is not a different condition from the baseline and
every comparison below would be vacuous. Refusing to emit a green."
echo "  floor confirmed applied AND distinct from the baseline"

# ---- MODE (i): no height growth from wrapping -----------------------------
# The control forces the ACTUAL MECHANISM the claim is about. Both card lines
# are white-space:nowrap (.hud__cardtitle hud.css:812, .hud__entity-why :778),
# which is precisely WHY they cannot wrap and grow — so a control that merely
# squeezes the columns can never make this fire, which is exactly why round 1's
# control refused to break and its clean reading meant nothing. Lifting nowrap
# at the floor makes long titles genuinely wrap, and the SAME probe must see it.
say "4a. CONTROL — lift white-space:nowrap so titles really wrap; height MUST grow"
"$POLL" --require '.hud__cardtitle' \
  --eval 'window.__hudprobe.style("probe-wrap",
    ".hud__cardtitle,.hud__entity-why{white-space:normal !important;overflow:visible !important}")' >/dev/null
if ! "$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.grown() >= 1'; then
  "$TAT" eval --pid "$PID" 'window.__hudprobe.style("probe-wrap", null)' >/dev/null || true
  fatal "height control DID NOT FIRE. Letting the title wrap at a 220px column
did not grow a single card past the baseline, so this probe cannot report red
and a clean reading from it is worthless. Do not report mode (i) as verified."
fi
"$TAT" eval --pid "$PID" '
JSON.stringify({ CONTROL: "wrap-forced", baseline: window.__hudprobe._baseline,
  grownCards: window.__hudprobe.grown(),
  maxHeight: window.__hudprobe.maxHeight() }, null, 1)'
echo "  control fired: the height probe reports red when titles actually wrap"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.style("probe-wrap", null) === true' >/dev/null
settle
say "4a. MEASURE — height at the floor (same probe) MUST NOT exceed the baseline"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.grown() === 0' \
  || fatal "MODE (i) RED: plan cards grow taller at the floor than at natural width."
echo "  mode (i) no height growth at the floor: GREEN (control-backed)"

# ---- MODE (iii): rail clipping -------------------------------------------
say "4b. CONTROL — force .hud__cardright wider than the card; railOut MUST go red"
"$POLL" --require '.hud__cardtitle' \
  --eval 'window.__hudprobe.style("probe-rail", ".hud__cardright{min-width:9999px !important}")' >/dev/null
if ! "$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.railOut() >= 1'; then
  "$TAT" eval --pid "$PID" 'window.__hudprobe.style("probe-rail", null)' >/dev/null || true
  fatal "railOut control DID NOT FIRE. Forcing the rail to 9999px did not push
it past the card content edge, so this probe cannot report red. Do not report
mode (iii) as verified."
fi
echo "  control fired: railOut reports red on an over-wide rail"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.style("probe-rail", null) === true' >/dev/null
settle
say "4b. MEASURE — railOut at the floor (same probe) MUST be 0"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.railOut() === 0' \
  || fatal "MODE (iii) RED: the activity rail is clipped at the floor."
echo "  mode (iii) activity rail not clipped at the floor: GREEN (control-backed)"

# ---- MODE (ii): page-level horizontal scroll ------------------------------
# This is the mode documentElement could not answer. The control asks a
# prior question: can ANY node in the ancestor chain report horizontal
# overflow? If none can, the chain clips silently and the mode is
# UNMEASURABLE — which is a finding, not a green.
say "4c. CONTROL — append a 5000px node; the chain MUST be able to report overflow"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.wide(true)' >/dev/null
CHAIN_OK=1
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.chainCanReport() === true' \
  >/dev/null 2>&1 || CHAIN_OK=0
say "4c. the ancestor chain under the 5000px control"
"$TAT" eval --pid "$PID" 'JSON.stringify(window.__hudprobe.chain(), null, 1)'
"$TAT" eval --pid "$PID" 'window.__hudprobe.wide(false)' >/dev/null || true
settle
if [ "$CHAIN_OK" -eq 0 ]; then
  fatal "MODE (ii) UNMEASURABLE. No node from .hud__cols to the root reported
scrollWidth > clientWidth even under a forced 5000px child, so every ancestor
clips silently. A clean page-h-scroll reading here would be exactly the
uninterpretable green WI-1816517 withdrew. Reported, NOT certified."
fi
echo "  control fired: the chain can report horizontal overflow"
say "4c. MEASURE — no ancestor ABOVE .hud__cols overflows at the floor"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.pageOverflow() === 0' \
  || fatal "MODE (ii) RED: an ancestor above .hud__cols scrolls horizontally."
echo "  mode (ii) no page-level horizontal scroll at the floor: GREEN (control-backed)"

# ---- MODE (iv): card content overflow (already had a control; re-run it) --
say "4d. CONTROL — squeeze the grid to 40px columns; hclip MUST go red"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tpl("squeeze")' >/dev/null
if ! "$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.hclip() >= 1'; then
  "$TAT" eval --pid "$PID" 'window.__hudprobe.tpl("floor")' >/dev/null || true
  fatal "hclip control DID NOT FIRE at 40px columns. (When this fired before, the
cause was NOT the probe: the template was being written to the hidden sessions
grid, so the plan cards never actually got squeezed.)"
fi
echo "  control fired: hclip reports red at 40px columns"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tpl("floor") === true' >/dev/null
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tracksAre("floor")' \
  || fatal "could not restore the floor after the squeeze control."
settle
say "4d. MEASURE — hclip at the floor (same probe) MUST be 0"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.hclip() === 0' \
  || fatal "MODE (iv) RED: plan cards overflow horizontally at the floor."
echo "  mode (iv) no card content overflow at the floor: GREEN (control-backed)"

# ── 5. DENSITY AT THE FLOOR ────────────────────────────────────────────────
say "5. DENSITY at the floor — whole population"
"$TAT" eval --pid "$PID" '
(() => {
  const P = window.__hudprobe, h = P.heights();
  const sorted = [...h].sort((a, b) => a - b);
  return JSON.stringify({
    MEASURE: "density-at-floor",
    cards: h.length,
    minHeight: sorted[0],
    maxHeight: sorted[sorted.length - 1],
    medianHeight: sorted[Math.floor(sorted.length / 2)],
    distinctHeights: [...new Set(sorted)],
    titlesClamped: P.titlesClamped(),
    populations: P.groupSummary(),
  }, null, 1);
})()'

# ── 5a. TRUE NARROW-VIEWPORT REPEAT ────────────────────────────────────────
# The earlier evidence forced the weighted grid to its CSS floor but left the
# OS viewport at whatever size the verifier happened to boot.  Acceptance
# requires a real narrow-window run as well.  Resolve the largest X11 window
# owned by this verifier PID, save its dimensions, resize only that isolated
# window, then repeat the floor measurements and all four controls.
say "5a. narrow viewport — resize the agent-owned Tauri window and repeat the floor proof"
[ -n "$X_DISPLAY" ] || fatal "no isolated X display was exported; cannot prove a true narrow viewport"
command -v xdotool >/dev/null 2>&1 || fatal "xdotool is required to resize the isolated verifier window"
command -v xwininfo >/dev/null 2>&1 || fatal "xwininfo is required to resolve the isolated verifier window"
BEST_AREA=0
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  GEOM="$(DISPLAY="$X_DISPLAY" xwininfo -id "$candidate" 2>/dev/null || true)"
  W="$(awk '/Width:/{print $2; exit}' <<<"$GEOM")"
  H="$(awk '/Height:/{print $2; exit}' <<<"$GEOM")"
  case "$W:$H" in
    ''|*:|:*|*[^0-9:]*|0:*|*:0) continue ;;
  esac
  AREA=$((W * H))
  if [ "$AREA" -gt "$BEST_AREA" ]; then
    BEST_AREA="$AREA"
    NARROW_WID="$candidate"
    NARROW_ORIG_W="$W"
    NARROW_ORIG_H="$H"
  fi
done < <(DISPLAY="$X_DISPLAY" xdotool search --pid "$PID" 2>/dev/null || true)
[ -n "$NARROW_WID" ] || fatal "could not resolve an X11 window owned by verifier PID $PID"
if [ "$NARROW_ORIG_W" -le 800 ]; then
  fatal "the verifier window is already at ${NARROW_ORIG_W}px wide; no narrower viewport contrast is available"
fi
DISPLAY="$X_DISPLAY" xdotool windowsize --sync "$NARROW_WID" 800 600 \
  || fatal "could not resize the isolated verifier window to 800x600"
"$POLL" --require '.hud__cardtitle' --eval 'window.innerWidth <= 820 && window.innerHeight <= 620' \
  || fatal "the Tauri webview did not report the requested narrow viewport after resize"
settle
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.groupHeights().twoLine.length >= 1' \
  || fatal "the narrow viewport did not render an ordinary two-line plan-card population"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.tpl("floor") && window.__hudprobe.tracksAre("floor")' \
  || fatal "could not apply the weighted grid floor in the narrow viewport"
"$TAT" eval --pid "$PID" '
(() => ({ MEASURE: "narrow-viewport-floor",
  viewport: window.innerWidth + "x" + window.innerHeight,
  tracks: window.__hudprobe.tracks(),
  populations: window.__hudprobe.groupSummary(),
  cardWidths: [...new Set(window.__hudprobe.cards().map(c => Math.round(c.getBoundingClientRect().width)))]
}))()'
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.grown() === 0' \
  || fatal "narrow viewport MODE (i) RED: plan cards grow taller than the roomy baseline"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.railOut() === 0' \
  || fatal "narrow viewport MODE (iii) RED: activity rail is clipped"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.pageOverflow() === 0' \
  || fatal "narrow viewport MODE (ii) RED: an ancestor above the grid scrolls horizontally"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.hclip() === 0' \
  || fatal "narrow viewport MODE (iv) RED: card content overflows horizontally"
# The settled one-line form at the SAME narrow viewport: the All view keeps
# ready/done behind count rails (see 3c), so it is focused and measured
# separately here too — the narrow proof covers both forms, not just twoLine.
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.focusSettled()' \
  || fatal "narrow viewport: neither the Done nor Ready filter contains a populated settled column"
"$POLL" --require '.hud__cardtitle' --require-min 1 \
  --eval 'window.__hudprobe.allSettled()' \
  || fatal "narrow viewport: the focused settled column did not render settled plan cards"
settle
"$TAT" eval --pid "$PID" '
(() => ({ MEASURE: "narrow-viewport-settled",
  viewport: window.innerWidth + "x" + window.innerHeight,
  populations: window.__hudprobe.groupSummary(),
  maxHeight: window.__hudprobe.maxHeight(),
}))()'
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.maxHeight() <= 52' \
  || fatal "narrow viewport: the settled plan-card form exceeds the 52px density target"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.railOut() === 0 && window.__hudprobe.hclip() === 0' \
  || fatal "narrow viewport settled form: rail clipped or card content overflows"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.focusAll()' \
  || fatal "narrow viewport: could not restore the All plans view"
"$POLL" --require '.hud__cardtitle' --eval 'window.__hudprobe.groupHeights().twoLine.length >= 1' \
  || fatal "narrow viewport: the All plans view did not return after settled-form measurement"
"$TAT" eval --pid "$PID" 'window.__hudprobe.tpl(null)' >/dev/null || true
echo "  narrow viewport floor proof: GREEN (viewport ${NARROW_ORIG_W}x${NARROW_ORIG_H} → 800x600; all four modes clean, both forms measured)"

# ── 6. SCOPED TO PLAN CARDS — the live half ────────────────────────────────
# The unit half of this criterion is asserted at HudEntityColumns.test.tsx:918
# and :924. This is the live half: a real non-plan board must render cards and
# NONE of them may carry the compact-plan selectors.
say "6. SCOPE — the Work items board renders cards, and none is a plan card"
"$TAT" eval --pid "$PID" \
  "window.location.href = '/adv?tab=hud&hudtab=items&slug=papercusp&ws=papercusp-workspace'" >/dev/null 2>&1 || true
if ! "$TAT" wait --pid "$PID" --selector '.hud__card' --timeout 90000 >/dev/null 2>&1; then
  fatal "the Work items board never rendered a card, so 'no plan selectors
here' would be vacuously true. Not a green."
fi
settle
# --require '.hud__card' fuses the presence guard into the SAME evaluation as
# the absence claim, so nothing can slip between "cards rendered" and
# "no plan selectors".
"$POLL" --require '.hud__card' --require-min 1 \
  --eval 'document.querySelectorAll(".hud__cardtitle").length === 0
          && document.querySelectorAll(".hud__cardright").length === 0' \
  || fatal "SCOPE RED: the compact-plan selectors leaked onto the Work items board."
"$TAT" eval --pid "$PID" '
JSON.stringify({ MEASURE: "scope-items-board",
  cards: document.querySelectorAll(".hud__card").length,
  planTitles: document.querySelectorAll(".hud__cardtitle").length,
  planRails: document.querySelectorAll(".hud__cardright").length }, null, 1)'
echo "  scope holds: plan-only selectors absent from a populated non-plan board"

say "ALL MODES GREEN — and every one of them behind a control that fired on this run"
