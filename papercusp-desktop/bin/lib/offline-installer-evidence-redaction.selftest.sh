#!/usr/bin/env bash
# offline-installer-evidence-redaction.selftest.sh — regression guard for WI-10004119:
# the P-521 offline-installer journey's evidence JSON must never carry the operator's
# home directory or username, in ANY spelling.
#
# THE BUG THIS GUARDS (silent, and it strands evidence):
#   bin/offline-installer-journey.sh writes docs/evidence/p521-offline-installer-*.json,
#   and that file is committed and ships in the release source drop. Its `command`
#   field is the driver's own argv. When the driver ran from the agent's scratchpad,
#   the argv carried the client's DASH-ENCODED scratch dir
#   (/tmp/pcv/claude-1000/-home-<user>-papercupai-workspace-papercusp/<sid>/scratchpad/…).
#   git-sync's identity-leak content-lint matched the username and QUARANTINED six
#   0.0.25 evidence files. They never committed, and nothing said so until the
#   content-fixer's budget ran out (WI-10004119). A '/home/<user>/' replace alone misses
#   the dash-encoded spelling, and so does a check that only looks for '/home/'.
#
# WHAT THIS RUNS: the REAL evidence writer. It extracts the driver's `python3 - … <<'PY'`
# heredoc (the shipping code, not a copy), feeds it fixture legs/ids/logs whose values
# carry a fake operator's home in every spelling, with HOME/USER/LOGNAME pointed at that
# fake operator, and asserts the written JSON names the operator nowhere. It needs no VM,
# no network and no install, and runs in under a second.
#
# CALIBRATION: the guest VM's own user (/home/tester/…) must SURVIVE verbatim. A writer
# that blanked every /home/ path would pass the leak assertions while destroying the
# evidence the journey exists to record.
#
#   bash bin/lib/offline-installer-evidence-redaction.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Fixture seam, defaulting to the SHIPPING driver. It exists so this guard's own
# non-vacuity can be shown against a deliberately-broken COPY (scripts/mutation-probe.sh
# points it at one), without ever reintroducing the leak into the shared tree.
DRIVER="${OIJ_REDACTION_SELFTEST_DRIVER:-$DIR/../offline-installer-journey.sh}"

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

echo "offline-installer evidence redaction (WI-10004119)"
[ -f "$DRIVER" ] || { echo "  ✗ driver not found: $DRIVER"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "  ✗ python3 is required (the evidence writer is python)"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oij-redaction-selftest.XXXXXX")" || { echo "  ✗ mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# ── Extract the evidence writer ─────────────────────────────────────────────
# The writer is the heredoc opened by the `python3 - "$LEGS" "$IDS" …` line and closed by
# a bare `PY`. An empty extraction is a FAILURE, never a skip: if the driver changes
# shape, this guard must go red rather than silently guarding nothing.
awk '
  /^python3 - "\$LEGS" "\$IDS" / { grab = 1; next }
  grab && /^PY$/                 { exit }
  grab                           { print }
' "$DRIVER" > "$WORK/writer.py"
if grep -q 'operational-test-evidence' "$WORK/writer.py"; then
  ok "extracted the evidence writer ($(wc -l < "$WORK/writer.py" | tr -d ' ') lines)"
else
  bad "could not extract the evidence writer heredoc from $DRIVER (did the driver change shape?)"
  echo "FAIL ($FAILS)"; exit 1
fi

# ── Fixtures: a fake operator, named in every spelling the driver can emit ──
U=zzleakoperator
H="/home/$U"
ENC="-home-$U-papercupai-workspace-papercusp"      # the client's dash-encoded scratch dir
printf '%s\t%s\t%s\t%s\t%s\n' \
  install pass 2026-01-01T00:00:00Z "installed from $H/debs" "$H/run/logs/install.log" \
  offline pass 2026-01-01T00:00:01Z "egress denied" "" > "$WORK/legs.tsv"
printf '%s\t%s\t%s\n' \
  join evidencePath "/tmp/pcv/claude-1000/$ENC/sid/scratchpad/join.json" \
  candidate expectedVersion 0.0.99 \
  target owner "$U" \
  target guestHome /home/tester/.papercusp/logs/serve.log > "$WORK/ids.tsv"
printf '%s\t%s\n' "$H/run/logs/install.log" deadbeef > "$WORK/logs.tsv"
CMD="/tmp/pcv/claude-1000/$ENC/sid/scratchpad/oij-driver.sh --platform linux --gui-artifact $H/debs/gui.deb"

OUT="$WORK/evidence.json"
( cd "$WORK" && env -u PAPERCUSP_SID HOME="$H" USER="$U" LOGNAME="$U" \
    python3 - "$WORK/legs.tsv" "$WORK/ids.tsv" "$WORK/logs.tsv" "$OUT" schema-v1 linux \
      2026-01-01T00:00:00Z 2026-01-01T00:00:02Z "$H/run" "$CMD" < "$WORK/writer.py" ) \
  > "$WORK/writer.out" 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ -s "$OUT" ]; then
  ok "writer produced evidence"
else
  bad "writer failed (exit $rc): $(tail -3 "$WORK/writer.out" | tr '\n' ' ')"
  echo "FAIL ($FAILS)"; exit 1
fi

# Capture first, then match: under pipefail an early-exiting `grep -q` consumer can SIGPIPE
# its producer and turn a real match into a false miss (EI-21150574805906545).
BODY="$(cat "$OUT")"

# ── The operator is named NOWHERE ───────────────────────────────────────────
case "$BODY" in
  *"$U"*) bad "the operator's username '$U' survives in the evidence: $(grep -o ".\{0,40\}$U.\{0,20\}" "$OUT" | head -3 | tr '\n' ' ')" ;;
  *)      ok "the username appears in no spelling (/home/<u>/, -home-<u>-, bare token)" ;;
esac
case "$BODY" in
  *"$H"*) bad "the operator's home dir '$H' survives in the evidence" ;;
  *)      ok "the home dir is gone" ;;
esac

# ── Redacted, not deleted: each value is still there, in its redacted form ────
python3 - "$OUT" > "$WORK/fields.txt" 2>&1 <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print('runDir=' + str(d.get('runDir')))
print('command=' + ' '.join(d.get('command') or []))
print('join=' + str((d.get('join') or {}).get('evidencePath')))
print('guest=' + str((d.get('target') or {}).get('guestHome')))
print('owner=' + str((d.get('target') or {}).get('owner')))
print('redactions=' + str(len(d.get('redactions') or [])))
PY
field() { sed -n "s/^$1=//p" "$WORK/fields.txt"; }
[ "$(field runDir)" = "~/run" ] && ok "runDir is '~/run'" || bad "runDir is '$(field runDir)', expected '~/run'"
case "$(field command)" in
  *"/tmp/pcv/claude-1000/-~-papercupai-workspace-papercusp/sid/scratchpad/oij-driver.sh"*"--gui-artifact ~/debs/gui.deb"*)
    ok "command keeps its shape with the dash-encoded home as '-~-' and the path as '~/'" ;;
  *) bad "command lost its shape: '$(field command)'" ;;
esac
case "$(field join)" in
  *"-~-papercupai-workspace-papercusp/sid/scratchpad/join.json") ok "an ids value with the dash-encoded home is redacted" ;;
  *) bad "join evidencePath is '$(field join)'" ;;
esac
[ "$(field owner)" = "<user>" ] && ok "a bare username token becomes '<user>'" || bad "owner is '$(field owner)', expected '<user>'"
[ "$(field redactions)" -ge 1 ] 2>/dev/null && ok "the evidence declares its redactions" || bad "no 'redactions' declaration in the evidence"

# ── Calibration: the GUEST's own user is evidence, not a leak ────────────────
[ "$(field guest)" = "/home/tester/.papercusp/logs/serve.log" ] \
  && ok "calibration: the guest VM path /home/tester/… survives verbatim" \
  || bad "calibration: the guest path was altered to '$(field guest)' (over-redaction destroys evidence)"

if [ "$FAILS" -eq 0 ]; then echo "PASS"; exit 0; fi
echo "FAIL ($FAILS)"; exit 1
