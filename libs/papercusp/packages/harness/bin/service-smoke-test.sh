#!/usr/bin/env bash
# Service smoke-test gate (claudecode-orchestrator-inspired).
#
# Called by run.sh on DONE (or after each feature pass, if configured). Reads
# smokeTest.urls from .papercusp/config.json and curls each one. If any URL
# returns a status other than expectStatus, exits non-zero AND reopens the
# most recently-passed feature as failing so the orchestrator can retry.
#
# Exit codes:
#   0  all URLs passed
#   1  at least one URL failed
#   2  config error (missing URLs, invalid JSON)

set -u
HARNESS_DIR="${HARNESS_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="${PROJECT_DIR:-$PWD}"
STATE_DIR="${STATE_DIR:-$PROJECT_DIR/.harness}"
CONFIG="$STATE_DIR/config.json"

if [ ! -f "$CONFIG" ]; then
    echo "smoke-test: no config.json; skipping"
    exit 0
fi

# POST aggregated smoke result to operator's PG-write endpoint. Replaces
# the chokidar mirror that read all 4 sibling files. Background &.
_post_smoke_result() {
    local status="$1"
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local harness_token=""
    harness_token="$(jq -r '.harness_token // empty' "$CONFIG" 2>/dev/null || true)"
    [ -z "$harness_token" ] && return 0
    local pass_content="" failure_content="" startup_log="" results=""
    [ -f "$STATE_DIR/smoke-pass.md" ] && pass_content="$(cat "$STATE_DIR/smoke-pass.md")"
    [ -f "$STATE_DIR/smoke-failure.md" ] && failure_content="$(cat "$STATE_DIR/smoke-failure.md")"
    [ -f "$STATE_DIR/smoke-startup.log" ] && startup_log="$(cat "$STATE_DIR/smoke-startup.log")"
    [ -f "$STATE_DIR/smoke-results.json" ] && results="$(cat "$STATE_DIR/smoke-results.json")"
    local body
    body="$(STATUS="$status" PASS="$pass_content" FAIL="$failure_content" STARTUP="$startup_log" RESULTS="$results" python3 -c '
import json, os, sys, time
out = {"status": os.environ["STATUS"], "mtimeMs": int(time.time()*1000)}
if os.environ.get("PASS"): out["passContent"] = os.environ["PASS"]
if os.environ.get("FAIL"): out["failureContent"] = os.environ["FAIL"]
if os.environ.get("STARTUP"): out["startupLog"] = os.environ["STARTUP"]
r = os.environ.get("RESULTS", "").strip()
if r:
    try: out["results"] = json.loads(r)
    except Exception: pass
sys.stdout.write(json.dumps(out))
' 2>/dev/null)" || return 0
    curl -sS -X POST -H 'content-type: application/json' \
        -H "Authorization: Bearer $harness_token" \
        --max-time 5 \
        -d "$body" "$operator_base/api/internal/smoke-test-event" >/dev/null 2>&1 || true
}

enabled=$(python3 -c "import json,sys; c=json.load(open('$CONFIG')); print(c.get('smokeTest',{}).get('enabled',False))" 2>/dev/null)
if [ "$enabled" != "True" ]; then
    echo "smoke-test: smokeTest.enabled=false; skipping"
    exit 0
fi

urls_json=$(python3 -c "import json,sys; c=json.load(open('$CONFIG')); import json as j; print(j.dumps(c.get('smokeTest',{}).get('urls',[])))" 2>/dev/null)
if [ "$urls_json" = "[]" ] || [ -z "$urls_json" ]; then
    echo "smoke-test: no URLs configured; skipping"
    exit 0
fi

# Optional startup command — fire-and-forget if port not already bound.
startup_cmd=$(python3 -c "import json; c=json.load(open('$CONFIG')); print(c.get('smokeTest',{}).get('startupCmd') or '')" 2>/dev/null)
startup_wait=$(python3 -c "import json; c=json.load(open('$CONFIG')); print(c.get('smokeTest',{}).get('startupWaitSeconds',30))" 2>/dev/null)

if [ -n "$startup_cmd" ]; then
    # Probe the first URL's host+port to see if service is already up.
    first_url=$(python3 -c "import json; c=json.load(open('$CONFIG')); u=c.get('smokeTest',{}).get('urls',[]); print(u[0].get('url','') if u else '')")
    if [ -n "$first_url" ] && ! curl -sS --max-time 3 "$first_url" >/dev/null 2>&1; then
        echo "smoke-test: starting service via '$startup_cmd' (waiting up to ${startup_wait}s)"
        ( cd "$PROJECT_DIR" && eval "$startup_cmd" ) > "$STATE_DIR/smoke-startup.log" 2>&1 &
        startup_pid=$!
        for i in $(seq 1 "$startup_wait"); do
            if curl -sS --max-time 2 "$first_url" >/dev/null 2>&1; then
                echo "smoke-test: service up after ${i}s"
                break
            fi
            sleep 1
        done
    fi
fi

# Run each URL check.
results_file="$STATE_DIR/smoke-results.json"
failures=0
python3 -c "import json; c=json.load(open('$CONFIG')); urls=c.get('smokeTest',{}).get('urls',[]); [print(json.dumps(u)) for u in urls]" 2>/dev/null > /tmp/smoke-urls.$$
: > "$results_file.tmp"
echo "[" >> "$results_file.tmp"
first=1
while IFS= read -r line; do
    [ -z "$line" ] && continue
    url=$(python3 -c "import json,sys; u=json.loads(sys.argv[1]); print(u.get('url',''))" "$line")
    expect_status=$(python3 -c "import json,sys; u=json.loads(sys.argv[1]); print(u.get('expectStatus',200))" "$line")
    expect_text=$(python3 -c "import json,sys; u=json.loads(sys.argv[1]); print(u.get('expectText') or '')" "$line")
    if [ -z "$url" ]; then continue; fi
    resp_file="/tmp/smoke-resp.$$"
    status=$(curl -sS -o "$resp_file" -w "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000")
    body_head=$(head -c 400 "$resp_file" 2>/dev/null | tr '\n' ' ')
    ok="false"
    reason=""
    if [ "$status" = "$expect_status" ]; then
        if [ -n "$expect_text" ]; then
            if grep -qF -- "$expect_text" "$resp_file" 2>/dev/null; then
                ok="true"
            else
                reason="expected text '$expect_text' not in response"
            fi
        else
            ok="true"
        fi
    else
        reason="got status $status, expected $expect_status"
    fi
    rm -f "$resp_file"
    [ "$first" = 0 ] && echo "," >> "$results_file.tmp"
    first=0
    python3 -c "
import json, sys
print(json.dumps({'url':sys.argv[1],'expectStatus':int(sys.argv[2]),'actualStatus':sys.argv[3],'ok':(sys.argv[4]=='true'),'reason':sys.argv[5],'bodyHead':sys.argv[6]}))
" "$url" "$expect_status" "$status" "$ok" "$reason" "$body_head" >> "$results_file.tmp"
    if [ "$ok" = "true" ]; then
        echo "smoke-test: ✓ $url → $status"
    else
        echo "smoke-test: ✗ $url → $status ($reason)"
        failures=$((failures + 1))
    fi
done < /tmp/smoke-urls.$$
rm -f /tmp/smoke-urls.$$
echo "]" >> "$results_file.tmp"
mv "$results_file.tmp" "$results_file"

if [ "$failures" = 0 ]; then
    cat > "$STATE_DIR/smoke-pass.md" <<EOF_PASS
# Smoke test passed — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

All $(python3 -c "import json; print(len(json.load(open('$results_file'))))") URLs returned expected status.

See smoke-results.json for details.
EOF_PASS
    rm -f "$STATE_DIR/smoke-failure.md"
    _post_smoke_result "pass" &
    echo "smoke-test: PASS"
    exit 0
fi

# Failure: reopen the most-recently-passed feature.
total_urls=$(python3 -c "import json; print(len(json.load(open('$results_file'))))")
failures_md=$(RESULTS="$results_file" python3 - <<'PY'
import json, os
r = json.load(open(os.environ['RESULTS']))
out = []
for u in r:
    if not u['ok']:
        out.append('- ' + u['url'] + ' (HTTP ' + str(u['actualStatus']) + ', ' + u['reason'] + ')')
        if u.get('bodyHead'):
            out.append('  body head: ' + u['bodyHead'][:200])
print('\n'.join(out))
PY
)
cat > "$STATE_DIR/smoke-failure.md" <<EOF_FAIL
# Smoke test FAILED — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

$failures of $total_urls smoke URLs failed.

## Failures
$failures_md

See .papercusp/smoke-results.json for machine-readable output.
EOF_FAIL

# Reopen the last-passed feature as failing with evidence.
REOPEN=$(python3 -c "
import json, os, sys, time
try:
    p = os.path.join('$STATE_DIR','features.json')
    d = json.load(open(p))
    feats = d['features'] if isinstance(d,dict) else d
    # Find the last passed one (by attempts count + status)
    passed = [f for f in feats if f.get('status')=='passed']
    if not passed:
        sys.exit(1)
    target = passed[-1]
    target['status'] = 'failing'
    target['attempts'] = target.get('attempts',0) + 1
    target.setdefault('notes',[]).append({
        'by':'smoke-test','ts':int(time.time()),
        'text':'Smoke test failed after this feature passed. See .papercusp/smoke-failure.md'
    })
    open(p,'w').write(json.dumps(d, indent=2))
    print(target['id'])
except SystemExit: raise
except Exception as e:
    print('ERR:'+str(e), file=sys.stderr); sys.exit(1)
")
if [ -n "$REOPEN" ]; then
    echo "smoke-test: FAIL — reopened $REOPEN as failing"
fi
_post_smoke_result "fail" &
exit 1
