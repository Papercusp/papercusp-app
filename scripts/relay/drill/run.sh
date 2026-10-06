#!/usr/bin/env bash
# Live blind-relay drill (plan public-blind-relay-2026-10-01, clause AUTO-BAR-R-5-P-004).
# Two peers in separate network namespaces behind this host's single NAT with NO route between
# them (netns.sh), joined to one hyperswarm topic through the shipped sync-relay module. Neither
# arm hand-configures a relay key (PAPERCUSP_VOICE_RELAY_KEYS is unset):
#   norelay  PAPERCUSP_RELAY_DEFAULTS=0 -> no relay at all; the control, must NOT connect.
#   defaults PAPERCUSP_RELAY_DEFAULTS=1 -> only the shipped DEFAULT_RELAY_KEYS; must connect relayed.
# Needs passwordless sudo (netns, iptables, ufw) and a public-DHT-reachable host. Always tears the
# namespaces down and prints the residual rule count (expect 0).
# usage: bash scripts/relay/drill/run.sh   (NORELAY_SEC / RELAY_SEC tune each arm's client window)
#   RELAY_DRILL_OUT  per-arm JSONL output dir (default: .papercusp/scratch/relaydrill/out)
set -u
D="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$D/../../.." && pwd)"
NS="$D/netns.sh"
OUT="${RELAY_DRILL_OUT:-$ROOT/.papercusp/scratch/relaydrill/out}"
mkdir -p "$OUT" || exit 1
U="$(id -un)"
TSX="$ROOT/node_modules/.bin/tsx"
cleanup() {
  sudo -n bash "$NS" down
  echo "RULES_LEFT nat=$(sudo -n iptables -t nat -S POSTROUTING | grep -c '10.9[56].0.0/24') fwd=$(sudo -n iptables -S FORWARD | grep -c '10.9[56].0.0/24') ns=$(ip netns list | grep -c '^hp[AB]')"
}
trap cleanup EXIT
sudo -n bash "$NS" up || exit 1
# sudo resets PATH (secure_path), and tsx's shebang is `#!/usr/bin/env node`, so carry PATH in.
inns() { local N=$1; shift; sudo -n ip netns exec "$N" sudo -n -u "$U" env HOME="$HOME" PATH="$PATH" "$@"; }
arm() { # name relayDefaults(0|1) clientDurSec
  local NAME=$1 DEFAULTS=$2 DUR=$3
  local TOPIC; TOPIC="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  ( cd "$ROOT" && inns hpB env -u PAPERCUSP_VOICE_RELAY_KEYS PAPERCUSP_RELAY_DEFAULTS="$DEFAULTS" "$TSX" "$D/peer.mts" server "$TOPIC" $((DUR + 30)) ) >"$OUT/$NAME-server.jsonl" 2>&1 &
  local PS=$!
  for _ in $(seq 1 60); do grep -q '"ev":"joined"' "$OUT/$NAME-server.jsonl" 2>/dev/null && break; sleep 1; done
  # A server that never joined makes the arm meaningless (a "no connection" control would pass
  # vacuously): fail loudly instead of reading it as a result.
  if ! grep -q '"ev":"joined"' "$OUT/$NAME-server.jsonl" 2>/dev/null; then
    echo "ARM $NAME INVALID: server never joined"; head -5 "$OUT/$NAME-server.jsonl"
    kill "$PS" 2>/dev/null; wait "$PS" 2>/dev/null; return 1
  fi
  sleep 3
  ( cd "$ROOT" && inns hpA env -u PAPERCUSP_VOICE_RELAY_KEYS PAPERCUSP_RELAY_DEFAULTS="$DEFAULTS" "$TSX" "$D/peer.mts" client "$TOPIC" "$DUR" ) >"$OUT/$NAME-client.jsonl" 2>&1
  echo "ARM $NAME client_exit=$?"
  kill "$PS" 2>/dev/null; wait "$PS" 2>/dev/null
  grep -E '"ev":"(relay-config|ready|dial|dial-error|connection|data|end)"' "$OUT/$NAME-client.jsonl" | cut -c1-260
  grep -E '"ev":"(connection|data)"' "$OUT/$NAME-server.jsonl" | cut -c1-260
}
arm norelay 0 "${NORELAY_SEC:-60}"
arm defaults 1 "${RELAY_SEC:-120}"
