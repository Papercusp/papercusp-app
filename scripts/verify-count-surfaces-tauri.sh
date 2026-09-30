#!/usr/bin/env bash
# Deterministic, read-only Tauri acceptance drive for
# corpus-accurate-counts-and-facets-2026-08-21 P-014.
#
# Run only through scripts/verify-tauri-headless.sh. The wrapper supplies the
# provenance-checked PID and bounded poll helper; this script names every route,
# selector, visible/accessible-copy invariant, capture, and failure exit.
set -euo pipefail

P014_TAURI_TOOL="${VERIFY_TAURI_AGENT_TOOLS_BIN:-}"
P014_TAURI_PID="${VERIFY_TAURI_PID:-}"
P014_TAURI_POLL="${VERIFY_TAURI_POLL:-}"
P014_TAURI_DISPLAY="${VERIFY_TAURI_DISPLAY:-}"
P014_ACCEPTANCE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
P014_ACCEPTANCE_OUTPUT="${VERIFY_COUNT_SURFACES_OUTPUT:-/tmp/papercusp-p014-tauri-${P014_ACCEPTANCE_STAMP}}"

[ -n "$P014_TAURI_TOOL" ] && [ -x "$P014_TAURI_TOOL" ] || {
  echo "P014_TAURI_FAIL missing executable VERIFY_TAURI_AGENT_TOOLS_BIN" >&2
  exit 64
}
[ -n "$P014_TAURI_PID" ] || {
  echo "P014_TAURI_FAIL missing provenance-checked VERIFY_TAURI_PID" >&2
  exit 64
}
[ -n "$P014_TAURI_DISPLAY" ] || {
  echo "P014_TAURI_FAIL missing provenance-checked VERIFY_TAURI_DISPLAY" >&2
  exit 64
}
[ -n "$P014_TAURI_POLL" ] && [ -x "$P014_TAURI_POLL" ] || {
  echo "P014_TAURI_FAIL missing executable VERIFY_TAURI_POLL" >&2
  exit 64
}
[ -n "${PAPERCUSP_SID:-}" ] || {
  echo "P014_TAURI_FAIL missing PAPERCUSP_SID provenance" >&2
  exit 64
}

mkdir -p "$P014_ACCEPTANCE_OUTPUT"

P014_WINDOW_INVENTORY="$P014_ACCEPTANCE_OUTPUT/windows.json"
P014_SELECTED_WINDOW="$P014_ACCEPTANCE_OUTPUT/window-selected.json"
P014_TAURI_WINDOW_ID="$(
  DISPLAY="$P014_TAURI_DISPLAY" \
    "$P014_TAURI_TOOL" list-windows --json |
    node - "$P014_TAURI_PID" "$P014_WINDOW_INVENTORY" "$P014_SELECTED_WINDOW" 3<&0 <<'NODE'
const fs = require('node:fs');

const [pidText, inventoryFile, selectedFile] = process.argv.slice(2);
const targetPid = Number(pidText);
const SAFE_WINDOW_KEYS = ['windowId', 'pid', 'name', 'x', 'y', 'width', 'height', 'tauri'];

function fail(reason) {
  console.error(`P014_TAURI_WINDOW_INVALID pid=${pidText} reason=${reason}`);
  process.exit(1);
}

let rawWindows;
try {
  rawWindows = JSON.parse(fs.readFileSync(3, 'utf8'));
} catch (error) {
  fail(`inventory-json:${error instanceof Error ? error.message : String(error)}`);
}
if (!Array.isArray(rawWindows) || !Number.isInteger(targetPid)) {
  fail('inventory-shape');
}

// list-windows includes a live bridge token used by tauri-agent-tools itself.
// Acceptance artifacts are durable forensic bundles, so persist only the
// non-credential fields this selector and its reviewers actually consume.
const windows = rawWindows.map((window) => {
  const projected = {};
  for (const key of SAFE_WINDOW_KEYS) {
    if (Object.prototype.hasOwnProperty.call(window, key)) projected[key] = window[key];
  }
  return projected;
});
fs.writeFileSync(inventoryFile, JSON.stringify(windows, null, 2));

const candidates = windows
  .filter((window) => Number(window?.pid) === targetPid)
  .filter((window) => Number.isFinite(window?.width) && Number.isFinite(window?.height))
  .filter((window) => window.width > 0 && window.height > 0)
  .sort((a, b) => (b.width * b.height) - (a.width * a.height));
if (candidates.length === 0) {
  fail('no-owned-window');
}

const selected = candidates[0];
if (!/^\d+$/.test(String(selected.windowId))) {
  fail(`window-id=${JSON.stringify(selected.windowId)}`);
}

fs.writeFileSync(
  selectedFile,
  JSON.stringify({ targetPid, selected, candidates }, null, 2),
);
process.stdout.write(String(selected.windowId));
NODE
)"

P014_CAPTURE_NAMES=(
  work-items
  learning-observations
  learning-improve
  learning-retain
  git-history
  logs
  coordination-history
  cupboard
)

p014_navigate() {
  local expression="$1"
  "$P014_TAURI_TOOL" eval --pid "$P014_TAURI_PID" --strict "$expression" >/dev/null
}

# tauri-agent-tools 0.9.1 `type` assigns through the element instance's value
# setter. React tracks that setter, so the synthetic input event can be treated
# as a no-op even though the command reports success (WI-40609). Drive the same
# browser primitive through the native prototype setter, then require BOTH the
# controlled value and its URL-backed state to settle before reading counts.
p014_type_controlled() {
  local selector="$1"
  local text="$2"
  local query_key="$3"
  local selector_json text_json query_key_json
  selector_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$selector")"
  text_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$text")"
  query_key_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$query_key")"
  p014_assert "(() => { const el = document.querySelector(${selector_json}); if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false; const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (!setter) return false; el.focus(); setter.call(el, ${text_json}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value === ${text_json}; })()"
  "$P014_TAURI_POLL" \
    --eval "document.querySelector(${selector_json})?.value === ${text_json} && new URLSearchParams(location.search).get(${query_key_json}) === ${text_json}"
}

p014_assert() {
  local expression="$1"
  "$P014_TAURI_TOOL" check --pid "$P014_TAURI_PID" --strict --eval "$expression"
}

# Catalog buttons contain both their human label and their panel type (for
# example "Run log" plus "adv:logs"), so matching the button's complete
# textContent can never find an entry. Resolve the exact label node, click its
# owning button, and require the click expression itself to return true.
p014_open_catalog_panel() {
  local label="$1"
  local label_json
  label_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$label")"
  p014_assert "(() => { const label = [...document.querySelectorAll('.pc-add-panel__label')].find((node) => node.textContent?.trim() === ${label_json}); const button = label?.closest('button'); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()"
}

p014_console_clean() {
  "$P014_TAURI_TOOL" check \
    --pid "$P014_TAURI_PID" \
    --strict \
    --no-errors \
    --duration 2500
}

p014_validate_capture_result() {
  local name="$1"
  local result_file="$2"
  local capture_dir="$3"

  node - "$name" "$result_file" "$capture_dir" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [name, resultFile, captureDir] = process.argv.slice(2);

function fail(reason) {
  console.error(`P014_TAURI_CAPTURE_INVALID name=${name} reason=${reason}`);
  process.exit(1);
}

let result;
try {
  result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
} catch (error) {
  fail(`result-json:${error instanceof Error ? error.message : String(error)}`);
}

if (!Number.isInteger(result?.errorCount) || result.errorCount !== 0) {
  fail(`errorCount=${String(result?.errorCount)}`);
}

const screenshot = result?.files?.['screenshot.png'] ?? result?.files?.screenshot;
if (typeof screenshot !== 'string' || screenshot.length === 0 || screenshot.startsWith('error:')) {
  fail(`screenshot=${JSON.stringify(screenshot)}`);
}

const expectedScreenshot = path.resolve(captureDir, 'screenshot.png');
const reportedScreenshot = path.resolve(screenshot);
if (reportedScreenshot !== expectedScreenshot) {
  fail(`screenshot-path=${JSON.stringify(screenshot)}`);
}

let stat;
try {
  stat = fs.lstatSync(reportedScreenshot);
} catch (error) {
  fail(`screenshot-stat:${error instanceof Error ? error.message : String(error)}`);
}
if (!stat.isFile() || stat.size <= 8) {
  fail(`screenshot-file type=${stat.isFile() ? 'file' : 'non-file'} size=${stat.size}`);
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const actualSignature = Buffer.alloc(pngSignature.length);
const fd = fs.openSync(reportedScreenshot, 'r');
try {
  fs.readSync(fd, actualSignature, 0, actualSignature.length, 0);
} finally {
  fs.closeSync(fd);
}
if (!actualSignature.equals(pngSignature)) {
  fail('screenshot-not-png');
}
NODE
}

p014_validate_screenshot_set() {
  node - "$P014_ACCEPTANCE_OUTPUT" "${P014_CAPTURE_NAMES[@]}" <<'NODE'
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [artifactDir, ...names] = process.argv.slice(2);

function fail(reason) {
  console.error(`P014_TAURI_SCREENSHOT_SET_INVALID reason=${reason}`);
  process.exit(1);
}

if (names.length !== 8) {
  fail(`capture-count=${names.length}`);
}

const byPixelSignature = new Map();
for (const name of names) {
  let result;
  try {
    result = JSON.parse(
      fs.readFileSync(path.join(artifactDir, `${name}-result.json`), 'utf8'),
    );
  } catch (error) {
    fail(`${name}:result-json:${error instanceof Error ? error.message : String(error)}`);
  }
  const screenshot = result?.files?.['screenshot.png'] ?? result?.files?.screenshot;
  if (typeof screenshot !== 'string') {
    fail(`${name}:missing-screenshot`);
  }
  const decoded = spawnSync(
    'convert',
    [screenshot, '-alpha', 'on', '-depth', '8', 'rgba:-'],
    {
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (decoded.error || decoded.status !== 0 || decoded.stdout.length === 0) {
    fail(
      `${name}:pixel-decode:${decoded.error?.message ?? decoded.stderr.toString().trim() ?? `exit=${decoded.status}`}`,
    );
  }
  const pixelSignature = crypto
    .createHash('sha256')
    .update(decoded.stdout)
    .digest('hex');
  const duplicates = byPixelSignature.get(pixelSignature) ?? [];
  duplicates.push(name);
  byPixelSignature.set(pixelSignature, duplicates);
}

const duplicate = [...byPixelSignature.entries()].find(
  ([, namesForSignature]) => namesForSignature.length > 1,
);
if (duplicate) {
  fail(`duplicate-pixels=${duplicate[0]} routes=${duplicate[1].join(',')}`);
}

console.log(`P014_TAURI_SCREENSHOT_SET_OK uniquePixels=${byPixelSignature.size}`);
NODE
}

p014_capture() {
  local name="$1"
  local expression="$2"
  local result_file="$P014_ACCEPTANCE_OUTPUT/$name-result.json"
  local capture_dir="$P014_ACCEPTANCE_OUTPUT/$name"
  DISPLAY="$P014_TAURI_DISPLAY" "$P014_TAURI_TOOL" capture \
    --pid "$P014_TAURI_PID" \
    --strict \
    --window-id "$P014_TAURI_WINDOW_ID" \
    --output "$capture_dir" \
    --dom-depth 8 \
    --logs-duration 2500 \
    --eval "$expression" \
    --json >"$result_file"
  p014_validate_capture_result "$name" "$result_file" "$capture_dir"
}

# Frozen-bundle/process identity. The outer verifier has already matched both
# PAPERCUSP_SID and its launch-provenance marker against /proc before exporting
# VERIFY_TAURI_PID; capture the page/process identity again in the evidence set.
"$P014_TAURI_TOOL" page-state --pid "$P014_TAURI_PID" --strict --json \
  >"$P014_ACCEPTANCE_OUTPUT/page-state-initial.json"
"$P014_TAURI_TOOL" process-tree --pid "$P014_TAURI_PID" --strict --deep --json \
  >"$P014_ACCEPTANCE_OUTPUT/process-tree.json"

# 1. Work -> papercusp -> Work items. The deterministic setup is the real
# papercusp harness and its authoritative rows+summary writers; the observed
# exact values are captured and the visible label must be a lossless prefix of
# the accessible population statement. A page-only "loaded" label is refused.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "harnesses", slug: "papercusp", scope: "self", welcome: 0 } })'
if ! "$P014_TAURI_POLL" --quiet --selector '[data-testid="wi-count"]'; then
  # A customized dock may not have the panel mounted. Use the real Add-panel
  # catalogue and click the exact existing Work items entry; no backend write.
  p014_navigate '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Add panel"); if (!b) return false; b.click(); return true; })()'
  "$P014_TAURI_POLL" --selector '[role="dialog"][aria-label="Panel catalog"]'
  p014_open_catalog_panel 'Work items'
  "$P014_TAURI_POLL" --selector '[data-testid="wi-count"]'
fi
p014_assert '(() => { const e = document.querySelector("[data-testid=wi-count]"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; if (!visible || !aria || /loaded/i.test(visible + " " + aria)) return false; if (visible === "—") return /^Count (?:loading…|updating…|unavailable)$/.test(aria); if (/^Count (?:loading…|updating…|unavailable)$/.test(visible)) return aria === visible; return aria.includes(visible) && /(?:full corpus|all work items|match|item)/i.test(aria); })()'
p014_console_clean
p014_capture work-items 'JSON.stringify({ route: location.pathname + location.search, selector: "[data-testid=wi-count]", visible: document.querySelector("[data-testid=wi-count]")?.textContent?.trim(), aria: document.querySelector("[data-testid=wi-count]")?.getAttribute("aria-label"), expected: "visible count is corpus-scoped or explicit unknown/updating; accessible text carries the same value and population; loaded/page-only copy is forbidden" })'

# 2. Learning -> Observe -> Observations. The lview query is the route-level
# fixture; exact current values come from the paired page+summary writer and are
# captured. Visual and accessible copy must agree, including unknown/updating.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "learning", lview: "observations" } })'
"$P014_TAURI_POLL" --selector '[data-testid="observations-count"]'
p014_assert '(() => { const e = document.querySelector("[data-testid=observations-count]"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; if (!visible || !aria || /loaded/i.test(visible + " " + aria)) return false; if (visible === "—") return /^Count (?:loading…|updating…|unavailable)$/.test(aria); if (/^Count (?:loading…|updating…|unavailable)$/.test(visible)) return aria === visible; return aria.includes(visible) && /(?:full corpus|observation|match)/i.test(aria); })()'
p014_console_clean
p014_capture learning-observations 'JSON.stringify({ route: location.pathname + location.search, selector: "[data-testid=observations-count]", visible: document.querySelector("[data-testid=observations-count]")?.textContent?.trim(), aria: document.querySelector("[data-testid=observations-count]")?.getAttribute("aria-label"), stage: document.querySelector("[role=tab][aria-selected=true]")?.getAttribute("aria-label"), expected: "paired Observations count is corpus-scoped or explicit unknown/updating; loaded-page copy is forbidden" })'

# 3. Learning Improve under a deterministic impossible-match predicate. The
# unique session id is a fixture value that cannot be present in an authored
# idea/work-item row unless this exact verifier run wrote it (this script is
# read-only). The server-authored companion must therefore settle at 0 of 0;
# the title records the full Improve corpus and the 500-row wire cap. Scope the
# count to the inline tools: the scope banner intentionally reuses the visual
# match-count class, so a document-wide query selects the wrong element when
# the default `loop` scope is active.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "learning", lview: "improvements" } })'
"$P014_TAURI_POLL" --selector 'input[aria-label="Search ideas and work"]'
P014_IMPROVE_SENTINEL="p014-no-match-${PAPERCUSP_SID}"
p014_type_controlled \
  'input[aria-label="Search ideas and work"]' \
  "$P014_IMPROVE_SENTINEL" \
  impq
if ! "$P014_TAURI_POLL" \
  --eval 'document.querySelector(".pc-learning__improvebar .pc-advpanel__count")?.textContent?.trim() === "0 of 0"'; then
  echo "P014_TAURI_DIAG learning-improve did not converge" >&2
  "$P014_TAURI_TOOL" eval \
    --pid "$P014_TAURI_PID" \
    --strict \
    'JSON.stringify({ route: location.pathname + location.search, query: document.querySelector("input[aria-label=\"Search ideas and work\"]")?.value, count: (() => { const e = document.querySelector(".pc-learning__improvebar .pc-advpanel__count"); return { visible: e?.textContent?.trim(), title: e?.getAttribute("title") }; })(), allMatchCounts: [...document.querySelectorAll(".pc-advpanel__count")].map((e) => ({ visible: e.textContent?.trim(), title: e.getAttribute("title") })) })' >&2 || true
  exit 1
fi
p014_assert '(() => { const e = document.querySelector(".pc-learning__improvebar .pc-advpanel__count"); if (!e) return false; const visible = (e.textContent || "").trim(); const title = e.getAttribute("title") || ""; return visible === "0 of 0" && /^Exact server-authored match count over \d[\d,]* merged Improve rows; at most 500 rows cross the sync wire\.$/.test(title); })()'
p014_console_clean
p014_capture learning-improve 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-learning__improvebar .pc-advpanel__count", query: document.querySelector("input[aria-label=\"Search ideas and work\"]")?.value, visible: document.querySelector(".pc-learning__improvebar .pc-advpanel__count")?.textContent?.trim(), title: document.querySelector(".pc-learning__improvebar .pc-advpanel__count")?.getAttribute("title"), expected: "unique impossible-match predicate settles to exact server-authored 0 of 0 over the full Improve corpus; at most 500 rows cross the wire" })'

# 4. Learning Retain uses the same impossible-match fixture. Its shared count
# formatter must expose exact zero against the complete selected Retain corpus;
# neither a loaded-row badge nor an inapplicable outcome count is admissible.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "learning", lview: "learnings" } })'
"$P014_TAURI_POLL" --selector 'input[aria-label="Filter retained items"]'
P014_RETAIN_SENTINEL="p014-no-match-${PAPERCUSP_SID}"
p014_type_controlled \
  'input[aria-label="Filter retained items"]' \
  "$P014_RETAIN_SENTINEL" \
  rq
"$P014_TAURI_POLL" \
  --eval 'document.querySelector(".pc-learning__retained .pc-advpanel__count")?.textContent?.trim()?.startsWith("0 of ") === true'
p014_assert '(() => { const e = document.querySelector(".pc-learning__retained .pc-advpanel__count"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; return /^0 of \d[\d,]* match$/.test(visible) && aria.startsWith(visible) && /complete selected Retain corpus/i.test(aria) && !/loaded/i.test(aria); })()'
p014_console_clean
p014_capture learning-retain 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-learning__retained .pc-advpanel__count", query: document.querySelector("input[aria-label=\"Filter retained items\"]")?.value, visible: document.querySelector(".pc-learning__retained .pc-advpanel__count")?.textContent?.trim(), aria: document.querySelector(".pc-learning__retained .pc-advpanel__count")?.getAttribute("aria-label"), expected: "unique impossible-match predicate settles to exact zero over the complete selected Retain corpus; loaded-page fallback is forbidden" })'

# 5. Git bounded-history disclosure. The exact visible and aria values must
# encode the same match count and selected 100/300/500/1,000-commit window.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "git", slug: "papercusp", scope: "self" } })'
"$P014_TAURI_POLL" --selector '.pc-adv-gitgrid__count'
p014_assert '(() => { const e = document.querySelector(".pc-adv-gitgrid__count"); if (!e) return false; const visible = (e.textContent || "").trim(); const aria = e.getAttribute("aria-label") || ""; const v = /^(\d[\d,]*) · latest (100|300|500|1,000) commits$/.exec(visible); const a = /^(\d[\d,]*) matches in latest (100|300|500|1,000) commits$/.exec(aria); return !!v && !!a && v[1] === a[1] && v[2] === a[2]; })()'
p014_console_clean
p014_capture git-history 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-adv-gitgrid__count", visible: document.querySelector(".pc-adv-gitgrid__count")?.textContent?.trim(), aria: document.querySelector(".pc-adv-gitgrid__count")?.getAttribute("aria-label"), expected: "N · latest L commits and aria N matches in latest L commits with identical N and L" })'

# 6. Run-log bounded-history disclosure. A customized Work dock may not carry
# the Run log panel, so mount the exact catalog entry and assert the filter
# engine's screen-reader scope against the canonical latest-300 window.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/adv", search: { tab: "harnesses", slug: "papercusp", scope: "self", welcome: 0 } })'
if ! "$P014_TAURI_POLL" --quiet --selector '.pc-adv-logs .pc-advpanel__filterbar[data-count-evidence="window"]'; then
  p014_navigate '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Add panel"); if (!b) return false; b.click(); return true; })()'
  "$P014_TAURI_POLL" --selector '[role="dialog"][aria-label="Panel catalog"]'
  p014_open_catalog_panel 'Run log'
  "$P014_TAURI_POLL" --selector '.pc-adv-logs .pc-advpanel__filterbar[data-count-evidence="window"]'
fi
p014_assert '(() => { const bar = document.querySelector(".pc-adv-logs .pc-advpanel__filterbar[data-count-evidence=window]"); const scope = bar?.querySelector(".pc-sr-only")?.textContent?.trim(); return scope === "Filter option counts cover latest 300 events."; })()'
p014_console_clean
p014_capture logs 'JSON.stringify({ route: location.pathname + location.search, selector: ".pc-adv-logs .pc-advpanel__filterbar[data-count-evidence=window]", evidence: document.querySelector(".pc-adv-logs .pc-advpanel__filterbar")?.getAttribute("data-count-evidence"), accessibleScope: document.querySelector(".pc-adv-logs .pc-advpanel__filterbar .pc-sr-only")?.textContent?.trim(), expected: "window evidence; Filter option counts cover latest 300 events." })'

# 7. Coordination history is a separate /coord route, not the curated
# Conversations feed. It must state the returned latest-match population and
# its fixed 200-row ceiling in the visible text.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/coord", search: { panel: "history" } })'
"$P014_TAURI_POLL" \
  --eval '[...document.querySelectorAll("span")].some((e) => /^\d[\d,]* latest matches · up to 200$/.test((e.textContent || "").trim()))'
p014_assert '(() => { const e = [...document.querySelectorAll("span")].find((n) => /^\d[\d,]* latest matches · up to 200$/.test((n.textContent || "").trim())); return !!e; })()'
p014_console_clean
p014_capture coordination-history 'JSON.stringify({ route: location.pathname + location.search, visible: [...document.querySelectorAll("span")].find((e) => /^\d[\d,]* latest matches · up to 200$/.test((e.textContent || "").trim()))?.textContent?.trim(), expected: "N latest matches · up to 200" })'

# 8. Cupboard flat browse. The live worker response is the deterministic
# authority for this read-only run: All-facet count must equal the sum of every
# visible per-kind server facet, and the pagination label must expose the same
# exact total as "Showing loaded of total" rather than a page-one inference.
p014_navigate 'window.__TSR_ROUTER__?.navigate({ to: "/cupboard", search: {} })'
"$P014_TAURI_POLL" --selector '[data-testid="cupboard-results"]'
"$P014_TAURI_POLL" --selector '[data-testid="cupboard-pagination"]'
p014_assert '(() => { const pagination = document.querySelector("[data-testid=cupboard-pagination] span"); const all = document.querySelector("[data-testid=cupboard-kind-count-all]"); if (!pagination || !all) return false; const m = /^Showing (\d[\d,]*) of (\d[\d,]*)$/.exec((pagination.textContent || "").trim()); const total = Number((all.textContent || "").replaceAll(",", "")); if (!m || !Number.isFinite(total)) return false; const loaded = Number(m[1].replaceAll(",", "")); const exact = Number(m[2].replaceAll(",", "")); const facets = [...document.querySelectorAll("[data-testid^=cupboard-kind-count-]")].filter((e) => e.getAttribute("data-testid") !== "cupboard-kind-count-all").map((e) => Number((e.textContent || "").replaceAll(",", ""))).filter(Number.isFinite); return loaded >= 0 && loaded <= exact && exact === total && facets.reduce((a, b) => a + b, 0) === total; })()'
p014_console_clean
p014_capture cupboard 'JSON.stringify({ route: location.pathname + location.search, pagination: document.querySelector("[data-testid=cupboard-pagination] span")?.textContent?.trim(), all: document.querySelector("[data-testid=cupboard-kind-count-all]")?.textContent?.trim(), kindFacets: Object.fromEntries([...document.querySelectorAll("[data-testid^=cupboard-kind-count-]")].map((e) => [e.getAttribute("data-testid"), e.textContent?.trim()])), expected: "Showing loaded of exact total; All equals exact total and sum of visible server-authored kind facets" })'

p014_validate_screenshot_set

"$P014_TAURI_TOOL" page-state --pid "$P014_TAURI_PID" --strict --json \
  >"$P014_ACCEPTANCE_OUTPUT/page-state-final.json"

echo "P014_TAURI_ACCEPTANCE_OK pid=$P014_TAURI_PID output=$P014_ACCEPTANCE_OUTPUT"
