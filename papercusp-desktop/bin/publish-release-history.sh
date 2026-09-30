#!/usr/bin/env bash
#
# publish-release-history.sh — push the generated release-history site to the
# release host, alongside the installers it links to.
#
# WI-4446. Sibling of upload-release.sh (which ships the ARTIFACTS + latest.json);
# this ships the PAGE that beta testers actually read. Separate on purpose: a fix
# to the page must be publishable without re-uploading 11 GB of installers, and a
# re-cut must not depend on the page being regenerated.
#
#   Usage:  bin/publish-release-history.sh [version]
#           DRY_RUN=1 bin/publish-release-history.sh     # gate + print, upload nothing
#           FULL=1 bin/publish-release-history.sh        # gate + upload EVERY file
#           ONLY=index.html,history.json ONLY_REASON="<why>" bin/publish-release-history.sh
#                                                         # force: gate + upload just these
#
# INCREMENTAL BY DEFAULT (WI-10003694). The site is ~29k files / ~2 GB, and a full publish
# costs ~8 min of gate + ~30 min of upload. release-site-delta.ts compares the site with a
# manifest of what the LAST VERIFIED publish put live and gates + uploads only what changed,
# so a one-page edit publishes in seconds. With no manifest (or another bucket/prefix, or
# FULL=1) it runs the full publish and records the manifest for next time. ONLY= is the
# caller-judged force for when you KNOW which files changed: it never hashes the rest.
#
# Generate the site first (it reads the release registry in Postgres):
#   npx tsx apps/operator/lib/release/record-release-cli.ts --regenerate
#
# Layout it writes (relative to the bucket root):
#   <secret>/index.html            ← THE LINK WE SHARE WITH BETA TESTERS
#   <secret>/plans/<slug>.html     ← one page per plan that shipped
#   <secret>/work-items/<id>.html  ← one page per user-facing work item
#
# It lands at the SAME secret path as the installers, which is what makes the
# page's relative download links resolve: index.html links `desktop-v0.0.8-alpha/…`,
# and upload-release.sh puts exactly that there. One secret, one blast radius, and
# the secret is never written into the HTML.
#
# ⛔ THE IDENTITY GATE IS THE POINT OF THIS SCRIPT, not a formality.
# The page is rendered from OUR OWN Postgres — work-item titles and plan bodies,
# written by agents running on the owner's machine. That content carries his home
# path, his name, and (via plan frontmatter) his personal email addresses. The
# renderer scrubs it; this gate re-reads the FINISHED BYTES and refuses to upload
# if anything got through. The scrub is the fix, the gate is the proof — and it has
# already caught two leaks the scrub missed. Never bypass it "just this once": an
# upload is public and irreversible, and the whole point of the page is that only
# people we hand the link to ever see it.
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd)"

# Bind the generated site to the release being published. The explicit
# argument/env override is useful for re-publishing a known cut; the desktop
# Tauri manifest is the normal source of truth after release-local.sh bumps it.
VERSION="${1:-${PAPERCUSP_RELEASE_VERSION:-}}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node - "$DESKTOP_ROOT/src-tauri/tauri.conf.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
try {
  const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  if (typeof version === 'string' && version.trim()) process.stdout.write(version.trim());
} catch {
  // The explicit error below names the missing source of truth.
}
NODE
)"
fi
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not resolve the current desktop release version — pass [version] or set PAPERCUSP_RELEASE_VERSION." >&2
  exit 1
fi

# EI-18103803991060000: this MUST match record-release-cli's default `--out`
# (<desktopRoot>/src-tauri/target/release/bundle/release-history) — record generates
# the site, this uploads it, and a divergence silently publishes a DIFFERENT (stale)
# index than the one just generated. The old default pointed at
# ${CARGO_TARGET_DIR:-$HOME/.cargo-target}/release/bundle, which bin/build-linux-local.sh
# MOVES the linux artifacts out of; a stale release-history/ still sits there, so the
# `index.html` existence check below passed and uploaded the wrong site.
BUNDLE="${PAPERCUSP_BUNDLE_DIR:-$DESKTOP_ROOT/src-tauri/target/release/bundle}"
SITE_DIR="${PAPERCUSP_RELEASE_SITE_DIR:-${BUNDLE}/release-history}"

if [[ ! -f "$SITE_DIR/index.html" ]]; then
  echo "ERROR: no generated site at $SITE_DIR" >&2
  echo "       Generate it first:" >&2
  echo "         npx tsx apps/operator/lib/release/record-release-cli.ts --regenerate" >&2
  exit 1
fi
if [[ ! -d "$SITE_DIR/work-items" ]]; then
  echo "ERROR: no generated work-item pages at $SITE_DIR/work-items" >&2
  echo "       Regenerate with the current record-release-cli before publishing." >&2
  exit 1
fi

# A holding page intentionally contains no release heading or work-item link;
# detect it once and preserve that deliberate publish mode through the checks
# below. Normal pages must bind BOTH projections to the release being shipped:
# an old site can have perfectly valid index.html/history.json/work-items and
# still publish yesterday's release with a zero exit code.
HOLDING_MARKER='<meta name="papercusp-page-mode" content="holding">'
IS_HOLDING_PAGE=0
if grep -Fq "$HOLDING_MARKER" "$SITE_DIR/index.html"; then
  IS_HOLDING_PAGE=1
fi

if [[ "$IS_HOLDING_PAGE" == "0" ]]; then
  for required in "assets/project-history.js" "assets/project-history.css" "assets/vditor/dist/js/lute/lute.min.js"; do
    if [[ ! -f "$SITE_DIR/$required" ]]; then
      echo "ERROR: missing shared Project History asset $required — regenerate before publishing." >&2
      exit 1
    fi
  done
  if [[ ! -f "$SITE_DIR/history.json" ]]; then
    echo "ERROR: no history.json in $SITE_DIR — regenerate; the app's Update Center needs it." >&2
    exit 1
  fi

  node - "$SITE_DIR/history.json" "$SITE_DIR/index.html" "$VERSION" <<'NODE'
const fs = require('node:fs');

const [historyPath, indexPath, expectedVersion] = process.argv.slice(2);
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

let history;
try {
  history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
} catch (error) {
  fail(`could not parse ${historyPath}: ${error instanceof Error ? error.message : String(error)}`);
}

const releases = history && Array.isArray(history.releases) ? history.releases : null;
const historyVersion = releases?.[0]?.version;
const index = fs.readFileSync(indexPath, 'utf8');
// WI-10003687: each release card declares the newest release it carries. The
// card HEADING is not that version when a platform-only hotfix folds into it
// (the 0.0.22 card carries Windows 0.0.23), so the guard reads the attribute.
const indexVersion = index.match(/<section class="rel" data-newest-release="([^"]+)"/)?.[1];
if (historyVersion !== expectedVersion || indexVersion !== expectedVersion) {
  fail(
    `generated release-history is not bound to current release ${expectedVersion}. ` +
      `history.json newest=${historyVersion ?? '<missing>'}, index.html newest=${indexVersion ?? '<missing>'}, ` +
      `site=${indexPath.replace(/\\/g, '/')}`,
  );
}
NODE
else
  echo "==> release version guard: holding page detected — history/index version check intentionally skipped"
fi

# Pick a detail page through the INDEX LINK itself. That proves the generated
# navigation and the uploaded object agree; choosing an arbitrary file from the
# directory would miss a broken href in the page testers actually open.
DETAIL_PAGE=""
if [[ "$IS_HOLDING_PAGE" == "0" ]]; then
  DETAIL_PAGE="$(
    node - "$SITE_DIR/index.html" <<'NODE'
const fs = require('node:fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const match = html.match(/href="(work-items\/[A-Za-z0-9._-]+\.html)"/);
if (match) process.stdout.write(match[1]);
NODE
  )"
  if [[ -z "$DETAIL_PAGE" || ! -f "$SITE_DIR/$DETAIL_PAGE" ]]; then
    echo "ERROR: index.html does not link to a generated work-item detail page." >&2
    echo "       Regenerate; every listed user-facing item must have an explicit detail link." >&2
    exit 1
  fi
fi

# ── Where it goes: the same secret path as the installers ────────────────────
RELEASE_HOST_ENV="${HOME}/.papercusp/release-host.env"
if [[ ! -f "$RELEASE_HOST_ENV" ]]; then
  echo "ERROR: $RELEASE_HOST_ENV not found — no release host configured." >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a; . "$RELEASE_HOST_ENV"; set +a
BASE="${PAPERCUSP_UPDATE_BASE_URL:-${PAPERCUSP_RELEASE_HOST:-}}"
if [[ -z "$BASE" ]]; then
  echo "ERROR: neither PAPERCUSP_UPDATE_BASE_URL nor PAPERCUSP_RELEASE_HOST set in $RELEASE_HOST_ENV" >&2
  exit 1
fi
KEY_PREFIX="$(printf '%s' "$BASE" | sed -E 's#^https?://[^/]+/?##; s#/$##')"
if [[ -z "$KEY_PREFIX" ]]; then
  echo "ERROR: base URL has no path segment — the secret must live in the PATH (D-002)." >&2
  exit 1
fi

# ── The Instructions are NOT part of this site [owner 2026-09-28, #868] ──────
# index.html loads them from <secret>/instructions.html, which only
# bin/publish-release-instructions.sh writes — so a release can never roll them back.
# This script never uploads that file. Refuse to publish an index whose Instructions
# section would load nothing.
if [[ "$IS_HOLDING_PAGE" == "0" ]]; then
  INSTR_HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "${BASE}/instructions.html" 2>/dev/null)" || true
  if [[ "$INSTR_HTTP_CODE" != "200" ]]; then
    echo "ERROR: the live instructions.html is missing (HTTP ${INSTR_HTTP_CODE:-000}) — the index's Instructions section would be empty." >&2
    echo "       Publish it first (separately from any release):  bin/publish-release-instructions.sh" >&2
    exit 1
  fi
  echo "==> instructions : live (published separately by publish-release-instructions.sh)"
fi

# ── Credentials ──────────────────────────────────────────────────────────────
# Loaded before the delta plan: the publish manifest is keyed to the bucket + prefix.
R2_ENV="${HOME}/.papercusp/r2.env"
if [[ ! -f "$R2_ENV" ]]; then
  echo "ERROR: $R2_ENV not found — R2 credentials are owner-provisioned." >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a; . "$R2_ENV"; set +a
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in $R2_ENV}"
: "${R2_BUCKET:?set R2_BUCKET in $R2_ENV}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID in $R2_ENV}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY in $R2_ENV}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# ── What changed since the last VERIFIED publish (WI-10003694) ───────────────
FULL="${FULL:-0}"
ONLY="${ONLY:-}"
ONLY_REASON="${ONLY_REASON:-}"
MANIFEST="${PAPERCUSP_RELEASE_PUBLISH_MANIFEST:-$HOME/.papercusp/release-history-publish-manifest.json}"
# Sibling of the site, so staging is a hard link on the same filesystem, never a 2 GB copy.
WORK_DIR="$(mktemp -d "${SITE_DIR%/}.publish-XXXXXX")"
TMP_PAGE="$(mktemp -d)"
TMP_HISTORY="$(mktemp)"
trap 'rm -rf "$WORK_DIR" "$TMP_PAGE"; rm -f "$TMP_HISTORY"' EXIT
DELTA_ARGS=(plan "$SITE_DIR" --manifest "$MANIFEST" --bucket "$R2_BUCKET"
  --out "$WORK_DIR/plan.json" --gate-list "$WORK_DIR/gate.list"
  --remove-list "$WORK_DIR/remove.list" --stage "$WORK_DIR/stage")
if [[ -n "$ONLY" ]]; then
  DELTA_ARGS+=(--only "$ONLY" --reason "$ONLY_REASON")
elif [[ "$FULL" == "1" ]]; then
  DELTA_ARGS+=(--full)
fi
echo "==> publish delta: comparing the site with the last verified publish"
# The secret prefix travels in the ENVIRONMENT, never argv (argv is in the process table).
PAPERCUSP_PUBLISH_KEY_PREFIX="$KEY_PREFIX" \
  npx tsx "${REPO_ROOT}/apps/operator/lib/release/release-site-delta.ts" "${DELTA_ARGS[@]}"
DELTA_MODE="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).mode)' "$WORK_DIR/plan.json")"
node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(p.upload.join("\n") + (p.upload.length ? "\n" : ""))' \
  "$WORK_DIR/plan.json" > "$WORK_DIR/upload.list"

# In an ONLY publish, files outside the named set were NOT re-uploaded, so the public-path
# checks below prove they are reachable but do not demand they match the local copy.
uploaded_by_this_run() {
  [[ "$DELTA_MODE" != "only" ]] || grep -Fxq -- "$1" "$WORK_DIR/upload.list"
}

# ── THE GATE — run BEFORE anything is uploaded ───────────────────────────────
# Calls the SAME findIdentityLeaks() the renderer's scrub is built on (one
# implementation, one behaviour — a gate that re-implements the rule it is
# checking eventually disagrees with it, and then it is guarding nothing).
# Full publish: every file. Otherwise: exactly what the delta will upload (or every file,
# when the identity rules changed since the last publish — release-site-delta decides).
echo "==> identity gate: scanning the finished bytes in $SITE_DIR ($DELTA_MODE)"
# The gate distinguishes 1 (FOUND LEAKS) from 2 (COULD NOT CHECK), and this caller must
# too. Collapsing them re-creates, one layer up, the exact defect the split was made to
# kill (EI-20583328178472869): a blind gate reported as a leak sends you hunting the
# pages for a name that is not there, while the real fault is that nothing was hunted.
set +e
if [[ "$DELTA_MODE" == "full" ]]; then
  npx tsx "${REPO_ROOT}/apps/operator/lib/release/gate-release-site.ts" "$SITE_DIR"
else
  npx tsx "${REPO_ROOT}/apps/operator/lib/release/gate-release-site.ts" "$SITE_DIR" --files-from "$WORK_DIR/gate.list"
fi
_gate_rc=$?
set -e
if [[ $_gate_rc -eq 2 ]]; then
  echo >&2
  echo "⛔ REFUSING TO UPLOAD — the gate COULD NOT CHECK (it did not find a leak)." >&2
  echo "   Almost always: no owner-name literal resolved, because git user.name is" >&2
  echo "   unset or belongs to an automation. A CLEAN verdict would have been" >&2
  echo "   meaningless, so it refused instead of certifying." >&2
  echo "   Fix: put PAPERCUSP_RELEASE_OWNER_NAME=<the owner's name> in" >&2
  echo "        ~/.papercusp/release-identity.env — the gate reads that file itself, so" >&2
  echo "        this is a one-time setup, not a per-run incantation. Exporting the" >&2
  echo "        variable for a single run still takes precedence over it." >&2
  echo "        (PAPERCUSP_RELEASE_OWNER_EMAIL too, for email coverage; both accept a" >&2
  echo "        comma-separated list.) Never write either into a SOURCE file — that" >&2
  echo "        commits the owner's name to git forever, and would BE the leak." >&2
  exit 2
elif [[ $_gate_rc -ne 0 ]]; then
  echo >&2
  echo "⛔ REFUSING TO UPLOAD — this box's identity is present in the pages above." >&2
  echo "   Fix the SOURCE of the leak (the scrub / the renderer), regenerate, re-run." >&2
  echo "   Do not edit the generated HTML by hand: the next --regenerate would undo it" >&2
  echo "   and the leak would return silently." >&2
  exit 1
fi

command -v aws >/dev/null 2>&1 || { echo "ERROR: aws CLI not on PATH." >&2; exit 1; }

# R2 rejects the trailing-checksum headers newer aws-cli v2 sends by default.
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

PAGES="$(find "$SITE_DIR" -name '*.html' | wc -l)"
echo
echo "==> release host : ${BASE%/*}/<secret>"
# NEVER print the raw KEY_PREFIX — it is the unguessable path segment that keeps
# the bucket unlisted (D-002/D-003), so it is a masked secret (must never reach a
# transcript / PG / a shared log). This preview must be safe to paste into a
# status update, INCLUDING under DRY_RUN, so it self-masks the same way
# upload-release.sh's preview does (EI-15305: this sibling script's own preview
# line still leaked the raw prefix even after that fix landed — the "pipe it
# through a mask-sed" guidance was never reliable here either, since KEY_PREFIX
# is derived from PAPERCUSP_UPDATE_BASE_URL, not a grep-able env var).
echo "==> bucket       : s3://${R2_BUCKET}/<secret>/"
echo "==> pages        : $PAGES"
echo "==> publish mode : $DELTA_MODE ($(wc -l < "$WORK_DIR/upload.list" | tr -d ' ') file(s) to upload, $(wc -l < "$WORK_DIR/remove.list" | tr -d ' ') to remove)"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1 — gate passed, nothing uploaded."
  exit 0
fi

# Upload the plan + work-item pages FIRST, index.html LAST. index.html is what a
# tester opens; publishing it before the pages it links to would serve 404 links.
# (Same ordering rule as upload-release.sh: the thing that ADVERTISES goes last.)
if [[ "$DELTA_MODE" == "full" ]]; then
  echo
  echo "==> uploading plan pages"
  aws s3 sync "$SITE_DIR/plans" "s3://${R2_BUCKET}/${KEY_PREFIX}/plans" \
    --endpoint-url "$ENDPOINT" \
    --content-type 'text/html; charset=utf-8' \
    --cache-control 'no-cache, max-age=0' \
    --delete --only-show-errors

  echo "==> uploading work-item pages"
  aws s3 sync "$SITE_DIR/work-items" "s3://${R2_BUCKET}/${KEY_PREFIX}/work-items" \
    --endpoint-url "$ENDPOINT" \
    --content-type 'text/html; charset=utf-8' \
    --cache-control 'no-cache, max-age=0' \
    --delete --only-show-errors

  # Shared History documents and their self-hosted renderer must be available
  # before the release index advertises its new change-history links.
  for directory in assets changes; do
    if [[ -d "$SITE_DIR/$directory" ]]; then
      echo "==> uploading shared Project History $directory"
      aws s3 sync "$SITE_DIR/$directory" "s3://${R2_BUCKET}/${KEY_PREFIX}/$directory" \
        --endpoint-url "$ENDPOINT" --cache-control 'no-cache, max-age=0' --only-show-errors
    fi
  done
  UPLOAD_FROM="$SITE_DIR"
else
  # Only the delta, from hard links of exactly the changed files — same headers per
  # directory as the full path. `cp --recursive`, not `sync`: the delta was decided by
  # content hash, so nothing here should second-guess it with mtimes.
  STAGE="$WORK_DIR/stage"
  echo
  echo "==> uploading only what changed ($DELTA_MODE)"
  for directory in plans work-items; do
    if [[ -d "$STAGE/$directory" ]]; then
      echo "==> uploading changed $directory pages"
      aws s3 cp --recursive "$STAGE/$directory" "s3://${R2_BUCKET}/${KEY_PREFIX}/$directory" \
        --endpoint-url "$ENDPOINT" \
        --content-type 'text/html; charset=utf-8' \
        --cache-control 'no-cache, max-age=0' --only-show-errors
    fi
  done
  for directory in assets changes; do
    if [[ -d "$STAGE/$directory" ]]; then
      echo "==> uploading changed shared Project History $directory"
      aws s3 cp --recursive "$STAGE/$directory" "s3://${R2_BUCKET}/${KEY_PREFIX}/$directory" \
        --endpoint-url "$ENDPOINT" --cache-control 'no-cache, max-age=0' --only-show-errors
    fi
  done
  UPLOAD_FROM="$STAGE"
fi

# history.json is what the INSTALLED APP's Update Center fetches (the same rail as
# latest.json). It is not optional: without it every user's update history is empty.
if [[ -f "$UPLOAD_FROM/history.json" ]]; then
  echo "==> uploading history.json (the in-app Update Center reads this)"
  aws s3 cp "$UPLOAD_FROM/history.json" "s3://${R2_BUCKET}/${KEY_PREFIX}/history.json" \
    --endpoint-url "$ENDPOINT" \
    --content-type 'application/json' \
    --cache-control 'no-cache, max-age=0' --only-show-errors
fi

if [[ -f "$UPLOAD_FROM/index.html" ]]; then
  echo "==> uploading index.html (LAST — this is the page we share)"
  aws s3 cp "$UPLOAD_FROM/index.html" "s3://${R2_BUCKET}/${KEY_PREFIX}/index.html" \
    --endpoint-url "$ENDPOINT" \
    --content-type 'text/html; charset=utf-8' \
    --cache-control 'no-cache, max-age=0' --only-show-errors
fi

# Pages that disappeared from a MIRRORED directory (plans/, work-items/) are removed AFTER
# the index stops linking them — the incremental twin of the full path's `sync --delete`.
if [[ -s "$WORK_DIR/remove.list" ]]; then
  echo "==> removing $(wc -l < "$WORK_DIR/remove.list" | tr -d ' ') page(s) no longer in the site"
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    aws s3 rm "s3://${R2_BUCKET}/${KEY_PREFIX}/$key" --endpoint-url "$ENDPOINT" --only-show-errors
  done < "$WORK_DIR/remove.list"
fi

# ── Verify what actually landed ──────────────────────────────────────────────
# Fetch the published objects back over the PUBLIC path — the same way a beta
# tester (and the installed app) will — and re-run the gate on what the host
# actually serves. Verifying the local files proves nothing about the bytes now
# sitting on a CDN. history.json is part of this proof: it is the Update Center's
# feed, not an incidental sidecar, so a stale/cache-served history must fail the
# publish just like a stale index or detail page.
echo
echo "==> verifying the public read path"
HTTP_CODE="$(curl -sS -o "$TMP_PAGE/index.html" -w '%{http_code}' --max-time 30 "${BASE}/index.html" 2>/dev/null)" || true

if [[ -z "$HTTP_CODE" || "$HTTP_CODE" == "000" ]]; then
  HOSTNAME_ONLY="$(printf '%s' "$BASE" | sed -E 's#^https?://([^/]+).*#\1#')"
  echo "  ⚠ ${HOSTNAME_ONLY} is not reachable — the pages ARE uploaded, but the bucket is" >&2
  echo "    not published at this hostname yet, so nobody can open the link." >&2
  exit 2
fi
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "  ✗ GET index.html returned HTTP $HTTP_CODE" >&2
  exit 1
fi
if ! uploaded_by_this_run index.html; then
  echo "  ✓ index.html served (not part of this ONLY publish, so not compared)"
elif ! diff -q "$SITE_DIR/index.html" "$TMP_PAGE/index.html" >/dev/null; then
  echo "  ✗ the served page does NOT match what we uploaded" >&2
  exit 1
else
  echo "  ✓ index.html served and byte-identical"
fi

# history.json is what every installed app reads for its Update Center. A
# successful authenticated upload does not prove that the public hostname (or
# its CDN cache) serves those same bytes, so fetch and compare it explicitly.
# Keep the connection-level split identical to the index check above: HTTP 000
# means the domain is not reachable yet (expected before the one-time custom
# domain binding), while any HTTP response other than 200 is a real publish
# failure.
echo
echo "==> verifying the public history feed"
HISTORY_HTTP_CODE="$(curl -sS -o "$TMP_HISTORY" -w '%{http_code}' --max-time 30 "${BASE}/history.json" 2>/dev/null)" || true
if [[ -z "$HISTORY_HTTP_CODE" || "$HISTORY_HTTP_CODE" == "000" ]]; then
  HOSTNAME_ONLY="$(printf '%s' "$BASE" | sed -E 's#^https?://([^/]+).*#\1#')"
  echo "  ⚠ ${HOSTNAME_ONLY} is not reachable for history.json — the pages ARE uploaded," >&2
  echo "    but the public Update Center feed is not yet available at this hostname." >&2
  echo "    Re-run this script after the custom domain is bound." >&2
  exit 2
fi
if [[ "$HISTORY_HTTP_CODE" != "200" ]]; then
  echo "  ✗ GET history.json returned HTTP $HISTORY_HTTP_CODE" >&2
  exit 1
fi
if uploaded_by_this_run history.json && ! diff -q "$SITE_DIR/history.json" "$TMP_HISTORY" >/dev/null; then
  echo "  ✗ served history.json does NOT match what we uploaded" >&2
  echo "    The installed app would show stale or incomplete release history; refusing to certify this publish." >&2
  exit 1
fi
cp "$TMP_HISTORY" "$TMP_PAGE/history.json"
if uploaded_by_this_run history.json; then
  echo "  ✓ history.json served and byte-identical"
else
  echo "  ✓ history.json served (not part of this ONLY publish, so not compared)"
fi

if [[ "$IS_HOLDING_PAGE" == "0" ]]; then
  # Follow the current release's actual link, then verify its document and the
  # main renderer assets through the same public HTTPS path a browser uses.
  CHANGE_PAGE="$(node - "$TMP_PAGE/index.html" <<'NODE'
const fs = require('node:fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const match = html.match(/href="(changes\/[A-Za-z0-9._-]+\.html)"/);
if (!match) process.exit(1);
process.stdout.write(match[1]);
NODE
)"
  for relative in "$CHANGE_PAGE" "${CHANGE_PAGE%.html}.json" assets/project-history.js assets/project-history.css assets/vditor/dist/js/lute/lute.min.js; do
    mkdir -p "$TMP_PAGE/$(dirname "$relative")"
    if ! curl -fsS --max-time 60 "${BASE}/${relative}" -o "$TMP_PAGE/$relative" 2>/dev/null || \
       { uploaded_by_this_run "$relative" && ! cmp -s "$SITE_DIR/$relative" "$TMP_PAGE/$relative"; }; then
      echo "ERROR: served Project History file differs or is unavailable: $relative" >&2
      exit 1
    fi
  done
  if [[ "$DELTA_MODE" == "only" ]]; then
    echo "  ✓ shared Project History page, data, renderer and plan assets served (compared only where this ONLY publish uploaded them)"
  else
    echo "  ✓ shared Project History page, data, renderer and plan assets served byte-identically"
  fi
fi

# Follow one REAL link from the served index and compare that detail page too.
# Holding pages intentionally have no release/detail links, so the index-only
# public verification is the correct proof for that publish mode.
if [[ "$IS_HOLDING_PAGE" == "0" ]]; then
  # This is the minimal public-path proof that index → work item is not a local-only
  # success caused by forgetting to sync the new directory.
  mkdir -p "$TMP_PAGE/$(dirname "$DETAIL_PAGE")"
  DETAIL_HTTP_CODE="$(curl -sS -o "$TMP_PAGE/$DETAIL_PAGE" -w '%{http_code}' --max-time 30 "${BASE}/${DETAIL_PAGE}" 2>/dev/null)" || true
  if [[ "$DETAIL_HTTP_CODE" != "200" ]]; then
    echo "  ✗ GET $DETAIL_PAGE returned HTTP ${DETAIL_HTTP_CODE:-000}" >&2
    exit 1
  fi
  if ! uploaded_by_this_run "$DETAIL_PAGE"; then
    echo "  ✓ linked work-item detail page served (not part of this ONLY publish, so not compared)"
  elif ! diff -q "$SITE_DIR/$DETAIL_PAGE" "$TMP_PAGE/$DETAIL_PAGE" >/dev/null; then
    echo "  ✗ the served work-item detail page does NOT match what we uploaded" >&2
    exit 1
  else
    echo "  ✓ linked work-item detail page served and byte-identical"
  fi
else
  echo "  ✓ holding page served; detail-page verification intentionally skipped"
fi

# The gate again, on ALL served page/feed objects. Belt and braces, and it is
# nearly free: what we uploaded and what the host serves are two different
# facts, and history.json carries the same agent-written content as the HTML.
if ! npx tsx "${REPO_ROOT}/apps/operator/lib/release/gate-release-site.ts" "$TMP_PAGE"; then
  echo "  ✗ the SERVED page contains identity — it is live. Take it down NOW." >&2
  exit 1
fi

# Record what is now live — only after every check above passed — so the next publish
# uploads just what changes after this one.
npx tsx "${REPO_ROOT}/apps/operator/lib/release/release-site-delta.ts" commit \
  --plan "$WORK_DIR/plan.json" --manifest "$MANIFEST"

echo
echo "==> done — the release-history page is LIVE."
echo "    Share the link (the base URL + /index.html) ONLY with beta testers."
echo "    Visits are recorded with their REFERRER, so a leak shows up as a visit"
echo "    arriving from a page we never shared the link with."
