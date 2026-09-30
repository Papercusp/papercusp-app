#!/usr/bin/env bash
# vm-federation.sh — VM-based two-instance federation proof (Phase 2 of
# linux-test-vm-and-federation-2026-06-04, P-009/P-010/P-011/P-012).
#
# Proves the packaged Papercusp Server .deb federates between SEPARATE
# MACHINES: each instance runs in its own pristine Ubuntu VM (real OS, real
# network hop over the papercusp-fedbr0 host bridge), with its own GitHub
# identity, write-free admission (attestation gist), and a deterministic
# host-run hyperdht/testnet bootstrap. The thin Papercusp GUI is attach-only;
# this runner deliberately exercises the Server-owned operator + embedded-PG
# runtime. The assert core is the same bin/lib/federation-asserts.sh the
# one-box smokes use (D-003) — only the driver differs.
#
# Modes:
#   --vms=2 (default)  fed-a VM ↔ fed-b VM                       (P-009)
#   --vms=1            host-local packaged Server sidecar ↔ fed-a VM (P-010)
#   --dht=testnet (default) host-run hyperdht/testnet on the bridge IP
#   --dht=public       no PAPERCUSP_DHT_BOOTSTRAP — the real public DHT.
#                      Best-effort (P-012): same-host VMs share one public IP
#                      and may fail to hairpin; expect INCONCLUSIVE.
#   --net=bridge (default) papercusp-fedbr0 + taps (needs passwordless sudo)
#   --net=socket       rootless qemu socket L2 between exactly two VMs;
#                      DHT bootstrap runs INSIDE fed-a (requires --vms=2 +
#                      --dht=testnet)
#   --no-reset         reuse existing overlays + installed .deb (iteration);
#                      default is a pristine `vmctl reset` per VM + fresh
#                      install (the clean-boot acceptance run)
#   --skip-install     don't (re)install the .deb (with --no-reset)
#   --keep-up          leave the VMs running after the run (debugging); also
#                      (WI-6192) leaves the host-run testnet DHT standing
#                      instead of killing it in cleanup, so a follow-up run
#                      can reuse it via --dht-bootstrap=HOST:PORT
#   --dht-bootstrap=HOST:PORT  attach to an already-running testnet (e.g. one
#                      left up by a prior --keep-up run) instead of spawning
#                      a new one
#   --deb=PATH         Server .deb to test (default: newest Package=papercusp-server)
#
# Pass criteria (the local merge proof, now cross-machine): both instances
# boot; [swarm] peer_connected in both logs (join FAILED → fail); a feature
# INSERTed on A lands in B's PG with origin='remote' within ~90s AND the
# reverse; teardown by power-off.
#
# Usage:
#   bin/vm-federation.sh [--vms=2] [--dht=testnet] [--net=bridge] [--deb=PATH]
set -uo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DESKTOP_DIR/scripts/linux-test-vm/lib/common.sh"
source "$DESKTOP_DIR/scripts/linux-test-vm/lib/fed-net.sh"
source "$DESKTOP_DIR/bin/lib/federation-asserts.sh"
VMCTL="$DESKTOP_DIR/scripts/linux-test-vm/vmctl"
# common.sh does `set -euo pipefail` — disarm the leaked `-e`: this driver (like
# the smokes) manages its OWN exit codes and EXPECTS non-zero from the discovery/
# merge asserts (they report PASS/FAIL, never abort). With -e left on, the first
# transient non-zero (e.g. a curl to the just-booted sidecar API) killed the run.
set +e

# ── args ────────────────────────────────────────────────────────────────────
EXPECTED_DEB_PACKAGE="papercusp-server"
EXPECTED_DEB_BINARY="papercusp-server"
VMS=2; DHT=testnet; NET=bridge; RESET=1; INSTALL=1; KEEP_UP=0; DEB=""; DHT_BOOTSTRAP_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --vms=1) VMS=1 ;;
    --vms=2) VMS=2 ;;
    --dht=testnet) DHT=testnet ;;
    --dht=public)  DHT=public ;;
    --net=bridge)  NET=bridge ;;
    --net=socket)  NET=socket ;;
    --no-reset)    RESET=0 ;;
    --skip-install) INSTALL=0 ;;
    --keep-up)     KEEP_UP=1 ;;
    --deb=*)       DEB="${arg#--deb=}" ;;
    # WI-6192: attach to an already-running persistent testnet (e.g. one left
    # standing by a prior --keep-up run) instead of spawning a new one.
    --dht-bootstrap=*) DHT_BOOTSTRAP_OVERRIDE="${arg#--dht-bootstrap=}" ;;
    -h|--help)     sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown arg: $arg (see --help)" ;;
  esac
done

# common.sh's default_deb() is intentionally GUI-only. The VM federation proof
# is a Server-role run after the thin-GUI split, and GUI/Server artifacts share
# a filename family, so resolve the implicit artifact by dpkg's writer-owned
# Package field rather than by filename or mtime alone.
select_server_deb() {
  local bundle candidate
  local -a candidates=()
  for bundle in \
    "$DESKTOP_DIR/src-tauri/target/release/bundle/deb" \
    "${CARGO_TARGET_DIR:-$HOME/.cargo-target}/release/bundle/deb"; do
    [ -d "$bundle" ] || continue
    while IFS= read -r -d '' candidate; do
      candidates+=("$candidate")
    done < <(find "$bundle" -maxdepth 1 -type f -name 'Papercusp*_amd64.deb' -print0 2>/dev/null)
  done
  [ "${#candidates[@]}" -gt 0 ] || {
    echo "FATAL: no Papercusp .deb candidates found; build a Server package with:" >&2
    echo "  PAPERCUSP_DISTRIBUTION_PROFILE=vm-release bin/build-linux-local.sh" >&2
    return 1
  }
  fed_select_newest_deb_by_package "$EXPECTED_DEB_PACKAGE" "${candidates[@]}"
}

if [ -z "$DEB" ]; then
  DEB="$(select_server_deb)" || die "no Server .deb available (pass --deb=PATH or build with PAPERCUSP_DISTRIBUTION_PROFILE=vm-release)"
fi
DEB="$(readlink -f "$DEB" 2>/dev/null || printf '%s' "$DEB")"
[ -f "$DEB" ] || die "selected Server .deb does not exist: $DEB"
DEB_PACKAGE="$(dpkg-deb -f "$DEB" Package 2>/dev/null || true)"
[ "$DEB_PACKAGE" = "$EXPECTED_DEB_PACKAGE" ] || die \
  "selected .deb '$DEB' has Package='${DEB_PACKAGE:-unknown}', expected Package=$EXPECTED_DEB_PACKAGE (the VM proof requires the Papercusp Server artifact)"
P_A_USER="${P_A_USER:-papercupai}"
P_B_USER="${P_B_USER:-ownerhandle}"
OPERATOR_DIR="${PAPERCUSP_OPERATOR_DIR:-/home/builduser/papercupai-workspace/papercusp/apps/operator}"
# Real PUBLIC repo for the hive create-from-repo step (the retired share/finalize
# path used a synthetic repo id; the hive model clones a real repo). Override with
# PAPERCUSP_FED_REPO_URL. Needs VM→github egress (slirp user-net provides NAT).
REPO_URL="${PAPERCUSP_FED_REPO_URL:-https://github.com/octocat/Hello-World}"
WORK="$(mktemp -d /tmp/vm-fed.XXXXXX)"
PKG="$WORK/pkg"
SLUG="vmfed${WORK##*.}"   # per-run unique → reused embedded-PG state can't false-pass the merge

if [ "$NET" = "socket" ]; then
  [ "$VMS" = 2 ] || die "--net=socket supports exactly two VMs (it is a point-to-point L2 link)"
  [ "$DHT" = testnet ] || die "--net=socket requires --dht=testnet (bootstrap runs inside fed-a)"
fi

# ── instance table ──────────────────────────────────────────────────────────
# inst 'a' / 'b'; FED_KIND decides which driver primitive serves it.
declare -gA FED_KIND FED_VM FED_IDX FED_USER FED_TOKEN FED_LOG FED_LOCAL_HONO FED_LOCAL_PG
declare -gA FED_VM_HOME FED_VM_PORT FED_VM_PG_PORT
if [ "$VMS" = 2 ]; then
  FED_KIND[a]=vm;    FED_VM[a]=fed-a; FED_IDX[a]=1
  FED_VM_HOME[a]="/home/tester/.papercusp-vm-fed/a"
  FED_VM_PORT[a]=$((18000 + FED_IDX[a]))
  FED_VM_PG_PORT[a]=$((18500 + FED_IDX[a]))
else
  FED_KIND[a]=local; FED_LOG[a]="$WORK/a.log"
fi
FED_KIND[b]=vm; FED_VM[b]=fed-b; FED_IDX[b]=2
if [ "$VMS" = 2 ]; then
  FED_VM_HOME[b]="/home/tester/.papercusp-vm-fed/b"
  FED_VM_PORT[b]=$((18000 + FED_IDX[b]))
  FED_VM_PG_PORT[b]=$((18500 + FED_IDX[b]))
else
  FED_VM[b]=fed-a
  FED_IDX[b]=1
  FED_VM_HOME[b]="/home/tester/.papercusp-vm-fed/b"
  FED_VM_PORT[b]=$((18000 + FED_IDX[b]))
  FED_VM_PG_PORT[b]=$((18500 + FED_IDX[b]))
fi
FED_USER[a]="$P_A_USER"; FED_USER[b]="$P_B_USER"
if [ "$VMS" = 1 ]; then
  # Stagger the host-side sidecar ports once and reuse them across boot retries.
  FED_LOCAL_HONO[a]="$(fed_pick_free_port 18071)"
  FED_LOCAL_PG[a]="$(fed_pick_free_port 18532)"
fi

# ── the vm/mixed driver vtable (overrides the lib's local-only default) ─────
drv_exec() {
  local inst="$1"
  case "${FED_KIND[$inst]}" in
    local) bash -s ;;
    vm)    vm_ssh "${FED_VM[$inst]}" 'bash -s' ;;
  esac
}
drv_applog() {
  local inst="$1"
  case "${FED_KIND[$inst]}" in
    local) echo "${FED_LOG[$inst]}" ;;
    vm)    echo "${FED_VM_HOME[$inst]}/papercusp-server.log" ;;
  esac
}
# The Server service's sidecar log is the authoritative boot log on VMs. Keep
# the wrapper log as drv_applog so fed_wait_boot can retain both diagnostics.
drv_sidecar_log() {
  local inst="$1"
  case "${FED_KIND[$inst]}" in
    local) echo "" ;;
    vm)    echo "${FED_VM_HOME[$inst]}/.papercusp/logs/serve.log" ;;
  esac
}
# EI-18687938054040755: the data-path capability probe needs the bundle path on
# whichever machine hosts this instance. The local driver reverse-maps its
# extracted Server sidecar; VM guests use the Server package's fixed install
# root (captured by fed_extract_deb, not guessed from the GUI layout).
drv_appbundle() {
  local inst="$1"
  case "${FED_KIND[$inst]}" in
    local) drv_appbundle_local "$inst" ;;
    vm)    printf '/usr/lib/%s/sidecar/serve.mjs\n' "${FED_APP_DIRNAME:-Papercusp Server}" ;;
  esac
}
drv_psql() {   # SQL goes over stdin — robust against nested quoting
  local inst="$1" sql="$2"
  case "${FED_KIND[$inst]}" in
    local) psql "${FED_DB[$inst]}" -tA -c "$sql" ;;
    vm)    printf '%s\n' "$sql" | vm_ssh "${FED_VM[$inst]}" \
             "psql 'postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[$inst]}/papercusp' -tA" ;;
  esac
}

# ── cleanup ─────────────────────────────────────────────────────────────────
cleanup() {
  fed_log "cleanup (scoped to $WORK)"
  # --keep-up is a DEBUGGING flag — rescue the per-instance host/local app logs
  # the diagnosis needs BEFORE fed_cleanup_scoped rm -rf's $WORK. (VM-side logs
  # live in the guest, which --keep-up leaves running, reachable via vm_ssh.)
  if [ "$KEEP_UP" = 1 ]; then
    local dest="${PAPERCUSP_FED_LOGS_DIR:-/tmp/vm-fed-logs}/$SLUG" i
    mkdir -p "$dest"
    for i in a b; do
      [ "${FED_KIND[$i]:-}" = local ] && [ -f "${FED_LOG[$i]:-/nonexistent}" ] \
        && cp "${FED_LOG[$i]}" "$dest/$i.log" 2>/dev/null || true
    done
    log "--keep-up: preserved host/local instance logs → $dest"
  fi
  fed_cleanup_scoped "$WORK"
  if [ "$KEEP_UP" = 0 ]; then
    local n
    for n in $(fed_vm_names); do "$VMCTL" down "$n" || true; done
  else
    log "--keep-up: VMs left running ($(fed_vm_names | tr '\n' ' '))"
  fi
}
fed_vm_names() { { [ "${FED_KIND[a]}" = vm ] && echo "${FED_VM[a]}"; echo "${FED_VM[b]}"; } | sort -u; }
trap cleanup EXIT

# ── 1. artifact gates (P-011 static: fail fast on an older/corrupt .deb) ───
fed_log "artifact: $DEB"
fed_extract_deb "$DEB" "$PKG" || exit 2
fed_clobber_check "$PKG" || exit 2
fed_assert_deb_swarm_support "$PKG" || exit 2

# ── 2. identities ───────────────────────────────────────────────────────────
FED_TOKEN[a]="$(gh auth token --user "${FED_USER[a]}" 2>/dev/null)" || true
FED_TOKEN[b]="$(gh auth token --user "${FED_USER[b]}" 2>/dev/null)" || true
[ -n "${FED_TOKEN[a]}" ] && [ -n "${FED_TOKEN[b]}" ] \
  || { echo "FATAL: need gh tokens for ${FED_USER[a]} + ${FED_USER[b]} (gh auth login)"; exit 1; }

# ── 3. federation network ───────────────────────────────────────────────────
if [ "$NET" = bridge ]; then
  fednet_have_root || die "bridge mode needs passwordless sudo — rerun with --net=socket (rootless)"
  fed_log "bridge $FEDBR up (host $FEDBR_HOST_IP)"
  fednet_bridge_up
  for inst in a b; do
    [ "${FED_KIND[$inst]}" = vm ] && fednet_tap_up "${FED_IDX[$inst]}"
  done
fi

# ── 4. VMs up (pristine by default) ─────────────────────────────────────────
boot_vm() {  # <inst>
  # split — one `local` evaluates all RHS before assigning, so a combined
  # `local inst=$1 name=${FED_VM[$inst]}` sees an empty $inst (bad array subscript).
  local inst="$1"; local name="${FED_VM[$inst]}"; local idx="${FED_IDX[$inst]}"
  if [ "$RESET" = 1 ]; then
    fed_log "reset $name to a pristine overlay"
    "$VMCTL" reset "$name" || die "reset $name failed"
  fi
  fed_log "boot $name (fed NIC: $NET, slirp 10.31.$idx.0/24)"
  # Distinct slirp subnet per VM: with the qemu default both VMs are 10.0.2.15,
  # and hyperswarm's holepunch local-address candidates then point a peer at
  # ITSELF — discovery stalls even though the DHT join succeeds.
  FED_NIC="$(fednet_nic_args "$NET" "$idx")" SLIRP_NET="10.31.$idx.0/24" \
    "$VMCTL" up "$name" || die "boot $name failed"
  vm_ssh "$name" true 2>/dev/null || die "SSH not reachable on $name"
  fednet_guest_configure "$name" "$idx" "$NET" || die "guest fed-NIC config failed on $name"
}
for inst in a b; do [ "${FED_KIND[$inst]}" = vm ] && boot_vm "$inst"; done

# reachability: every VM must see the DHT host; in 2-VM mode also each other
if [ "$NET" = bridge ]; then
  for inst in a b; do
    [ "${FED_KIND[$inst]}" = vm ] || continue
    r="$(fednet_guest_ping "${FED_VM[$inst]}" "$FEDBR_HOST_IP")"
    echo "  ${FED_VM[$inst]} → host $FEDBR_HOST_IP: $r"
    [ "$r" = reachable ] || { echo "FATAL: bridge reachability failed"; exit 3; }
    # WI-760: ICMP reachability is NOT federation reachability. hyperdht/udx are
    # UDP-only, and this host's ufw default-deny INPUT dropped every UDP datagram
    # from 10.77.0.0/24 while happily answering pings — so the line above printed
    # `reachable` for weeks on a rig that could never land a single DHT announce.
    # Assert the transport federation actually uses.
    u="$(fednet_guest_udp_ok "${FED_VM[$inst]}" "$FEDBR_HOST_IP")"
    echo "  ${FED_VM[$inst]} → host $FEDBR_HOST_IP UDP: $u"
    if [ "$u" != ok ]; then
      echo "FATAL: guest→host UDP is BLOCKED on $FEDBR_HOST_IP — the DHT bootstrap is unreachable"
      echo "  hyperdht/udx are UDP-only: joins will log green and NO announce will ever land."
      echo "  Most likely the host firewall has no rule for this rig subnet. Check:"
      echo "    sudo ufw status | grep ${FEDBR_HOST_IP%.*}"
      echo "  and add one (the other rig subnets each have one):"
      echo "    sudo ufw allow from ${FEDBR_HOST_IP%.*}.0/24 comment 'papercusp fed rig subnet'"
      exit 3
    fi
  done
  if [ "$VMS" = 2 ]; then
    b_ip="$(fednet_bridge_ip "${FED_IDX[b]}")"
    r="$(fednet_guest_ping "${FED_VM[a]}" "$b_ip")"
    echo "  ${FED_VM[a]} → ${FED_VM[b]}: $r"
    [ "$r" = reachable ] || { echo "FATAL: VM↔VM bridge reachability failed"; exit 3; }
    # WI-760: the UDX data path is a DIRECT VM↔VM UDP stream, on a different
    # firewall path than guest→host (FORWARD, not INPUT — br_netfilter pushes
    # bridged frames through iptables and ufw's routed policy is deny). With this
    # blocked the rig still announces, still logs `peer_connected`, and carries
    # ZERO bytes — a false green. Assert it.
    u="$(fednet_guest_udp_pair "${FED_VM[a]}" "${FED_VM[b]}" "$b_ip")"
    echo "  ${FED_VM[a]} → ${FED_VM[b]} UDP: $u"
    if [ "$u" != ok ]; then
      echo "FATAL: VM↔VM UDP is BLOCKED — the UDX data path can never carry bytes"
      echo "  Expect `peer_connected` followed by 'data path NEVER came up'. Fix:"
      echo "    sudo ufw route allow in on ${FEDBR_IF:-pcusp-fedbr0} out on ${FEDBR_IF:-pcusp-fedbr0}"
      exit 3
    fi
  fi
fi

# ── 5. install the .deb + driver prereqs in each VM ─────────────────────────
install_vm() {  # <inst>
  local inst="$1"; local name="${FED_VM[$inst]}"
  if [ "$INSTALL" = 1 ]; then
    fed_log "install .deb into $name (fresh-install dep resolution)"
    "$VMCTL" install "$name" "$DEB" || die "install failed on $name"
  fi
  # Driver prereqs (NOT app deps — the app's own dep test is the apt install
  # above): gh for identity resolution (gh-token.ts shells out to `gh auth
  # token`; the GH_TOKEN env var satisfies it without a login), psql for the
  # merge asserts (the .deb bundles initdb/postgres but no client).
  fed_log "driver prereqs in $name (gh + postgresql-client)"
  vm_ssh "$name" 'command -v gh >/dev/null && command -v psql >/dev/null' 2>/dev/null \
    || vm_ssh "$name" 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh postgresql-client >/dev/null' \
    || die "prereq install failed on $name"
}
for inst in a b; do [ "${FED_KIND[$inst]}" = vm ] && install_vm "$inst"; done

# ── 6. DHT bootstrap ────────────────────────────────────────────────────────
BOOTSTRAP=""
case "$DHT" in
  testnet)
    if [ -n "$DHT_BOOTSTRAP_OVERRIDE" ]; then
      # WI-6192: attach to an already-running testnet (typically one left up by
      # a prior --keep-up run) instead of spawning our own.
      BOOTSTRAP="$DHT_BOOTSTRAP_OVERRIDE"
      fed_log "reusing existing testnet DHT bootstrap: $BOOTSTRAP (--dht-bootstrap)"
    elif [ "$NET" = bridge ]; then
      BOOTSTRAP="$(fed_start_testnet_dht "$OPERATOR_DIR" "$WORK" "$FEDBR_HOST_IP" "$KEEP_UP")" || exit 3
    else
      # socket mode: host is not on the fed L2 — bootstrap runs inside fed-a
      # (the .deb's own bundled node + a host-side esbuild bundle of
      # hyperdht/testnet would need native modules; apt node + npm hyperdht
      # is the pragmatic in-VM path).
      fed_log "spin testnet DHT inside ${FED_VM[a]} (rootless socket mode)"
      vm_ssh "${FED_VM[a]}" 'command -v node >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm >/dev/null
        mkdir -p ~/fed-dht && cd ~/fed-dht && [ -d node_modules/hyperdht ] || npm install --no-audit --no-fund hyperdht >/dev/null 2>&1
        nohup node --input-type=module -e "
          import createTestnet from \"hyperdht/testnet.js\";
          const t = await createTestnet(3, { host: \"10.99.0.1\" });
          console.log(\"BOOTSTRAP=\" + t.bootstrap.map(b => b.host + \":\" + b.port).join(\",\"));
          setInterval(() => {}, 1 << 30);
        " > ~/fed-dht/dht.log 2>&1 & sleep 4; grep -oE "BOOTSTRAP=[^ ]+" ~/fed-dht/dht.log | head -1' \
        > "$WORK/vm-dht.out" 2>&1
      BOOTSTRAP="$(grep -oE 'BOOTSTRAP=[^ ]+' "$WORK/vm-dht.out" | head -1 | cut -d= -f2)"
      [ -n "$BOOTSTRAP" ] || { echo "FATAL: in-VM testnet DHT did not start"; cat "$WORK/vm-dht.out"; exit 3; }
    fi
    echo "PAPERCUSP_DHT_BOOTSTRAP=$BOOTSTRAP" ;;
  public)
    fed_log "P-012 stretch: PUBLIC DHT (no bootstrap override) — same-host VMs may fail to hairpin" ;;
esac

# ── 7. launch instances ─────────────────────────────────────────────────────
launch_vm_instance() {  # <inst> [wipe]   wipe=1 (first launch) clears PG state
  local inst="$1" wipe="${2:-1}" name="${FED_VM[$inst]}"
  fed_log "launch packaged app in $name (identity ${FED_USER[$inst]}${wipe:+, wipe=$wipe})"
  # env file over SSH stdin (0600) — keeps the token out of argv/ps
  printf 'GH_TOKEN=%s\nPAPERCUSP_FED_DHT_MODE=%s\n%s\n' "${FED_TOKEN[$inst]}" "$DHT" \
    "${BOOTSTRAP:+PAPERCUSP_DHT_BOOTSTRAP=$BOOTSTRAP}" \
    | vm_ssh "$name" 'umask 077; cat > ~/fed.env'
  # The headless Server owns the sidecar and embedded PG. Use an isolated HOME
  # per VM instance so its workspace registry, operator discovery files, logs,
  # and shared state cannot collide with the host operator or a retry.
  # WIPE=1 (first launch of a run) clears the isolated state for a clean initdb +
  # migration sequence. WIPE=0 preserves it so ensure_booted's retry is a fast
  # restart instead of another fresh initdb.
  # WI-6176: WIPE must be passed as a vm_run ARGUMENT, never as a `WIPE=… vm_run`
  # shell prefix — vm_run is `ssh … 'bash -s'` and forwards no environment, so the
  # prefix form left the guest with WIPE UNSET, took the ${WIPE:-1} wipe branch on
  # EVERY relaunch, and made ensure_booted's preserve-the-data-dir retry (below)
  # inert: each attempt re-ran a fresh ~20-30s initdb and lost the same race.
  vm_run "$name" "WIPE=$wipe VM_HOME=${FED_VM_HOME[$inst]} VM_PORT=${FED_VM_PORT[$inst]} VM_PG_PORT=${FED_VM_PG_PORT[$inst]}" <<'EOF'
pkill -f papercusp-desktop 2>/dev/null
pkill -f papercusp-server 2>/dev/null
pkill -f 'sidecar/serve.mjs' 2>/dev/null
pkill -f embedded-postgres 2>/dev/null; sleep 1
home="${VM_HOME:?}"
state_root="$home/.papercusp-workspaces/.shared"
sidecar_dir="/usr/lib/Papercusp Server/sidecar"
embedded_pg_root="$state_root/embedded-pg-data"
rm -f "$home/papercusp-server.log" "$embedded_pg_root/postmaster.pid" 2>/dev/null
if [ "${WIPE:-1}" = 1 ]; then rm -rf "$home/.papercusp" "$home/.papercusp-workspaces"; fi
mkdir -p "$home" "$state_root" "$embedded_pg_root" "$home/fed"
set -a; . ~/fed.env; set +a
export HOME="$home" USERPROFILE="$home"
export PAPERCUSP_SIDECAR_DIR="$sidecar_dir"
export PAPERCUSP_PORT="${VM_PORT:?}"
export PAPERCUSP_EMBEDDED_PG_ROOT="$embedded_pg_root"
export PAPERCUSP_BIND_HOST=127.0.0.1 PAPERCUSP_BACKGROUND_WORKERS=1
setsid bash -c 'exec /usr/bin/papercusp-server --headless-service' >"$home/papercusp-server.log" 2>&1 </dev/null &
sleep 1; echo "launched Server headless-service (wipe=${WIPE:-1}, port=${PAPERCUSP_PORT}, pg_root=${PAPERCUSP_EMBEDDED_PG_ROOT})"
EOF
}
launch_local_instance() {  # <inst> — the --vms=1 host-side instance
  local inst="$1"
  local home="$WORK/inst-$inst" sidecar
  sidecar="$(fed_sidecar_dir "$PKG")"
  fed_log "launch packaged Server sidecar on the HOST (identity ${FED_USER[$inst]}, hono=${FED_LOCAL_HONO[$inst]}, pg=${FED_LOCAL_PG[$inst]})"
  local envs=(PAPERCUSP_GITHUB_LOGIN="${FED_USER[$inst]}")
  [ -n "$BOOTSTRAP" ] && envs+=(PAPERCUSP_DHT_BOOTSTRAP="$BOOTSTRAP")
  # EI-502: the --vms=1 HOST-side instance must ANNOUNCE a bridge-reachable address.
  # Without this it binds hyperdht to 0.0.0.0 and the DHT learns its address as
  # loopback / the host's default-route (non-bridge) address, which fed-a cannot reach
  # for the holepunch — so both sides log `[swarm] joined topic` and NEITHER ever logs
  # `[swarm] peer_connected`. (fed-a→host is reachable; it is the REVERSE handshake
  # that has nowhere to go.) The VM-side instances never hit this: their only
  # interface IS the bridge, so the address they advertise is reachable by construction.
  #
  # PAPERCUSP_DHT_HOST already exists for exactly this case — its doc names "the
  # fed-a/fed-b VM rig" as the motivating caller, because Hyperswarm does not forward
  # `host` to HyperDHT, so operator-core constructs HyperDHT itself and passes it via
  # Hyperswarm's `dht` option (packages/operator-core/lib/sync/hyperbee/swarm.ts:
  # parseDhtHost -> swarmConstructorOpts -> getSharedSwarm -> new DHT({ host })).
  # The knob was built and then never wired up here, which is why EI-502 read as
  # "no env knob exists" and proposed building one.
  #
  # Bridge mode only: FEDBR_HOST_IP is the host's address ON the rig bridge, and it is
  # already the address the testnet DHT itself is started on (fed_start_testnet_dht
  # ... "$FEDBR_HOST_IP"). Under --net=socket there is no bridge and no such address,
  # so leave it unset and let hyperdht bind 0.0.0.0 as before.
  [ "$NET" = bridge ] && [ -n "${FEDBR_HOST_IP:-}" ] && envs+=(PAPERCUSP_DHT_HOST="$FEDBR_HOST_IP")
  fed_local_launch_sidecar "$home" "${FED_LOG[$inst]}" "$sidecar" \
    "${FED_LOCAL_HONO[$inst]}" "${FED_LOCAL_PG[$inst]}" "${envs[@]}"
}
launch_instance() {  # <inst> [wipe]
  case "${FED_KIND[$1]}" in
    vm)    launch_vm_instance "$1" "${2:-1}" ;;
    local) launch_local_instance "$1" ;;
  esac
}
for inst in a b; do launch_instance "$inst" 1 || exit 4; done

# ── 8. boot + isolation ─────────────────────────────────────────────────────
# Bounded relaunch retry: a clean machine can lose the embedded-PG-vs-sidecar
# boot race (sidecar up first → ECONNREFUSED :5432 → "sidecar did not start
# within 30s" → app exits) when a fresh initdb (~20-30s) overruns the 30s budget
# under concurrent 2-VM load. The RELAUNCH passes wipe=0 so it PRESERVES the
# now-initialised data dir → a fast PG restart (~3s) wins the race. This is the
# clean-machine timing the VM exists to surface; the harness recovers it.
ensure_booted() {  # <inst>
  local inst="$1" attempt
  for attempt in 1 2 3; do
    fed_wait_boot "$inst" 40 && return 0
    [ "$attempt" = 3 ] && break
    echo "[$inst] boot attempt $attempt failed ($FED_BOOT_ERR) — relaunching (preserve data dir)"
    drv_exec "$inst" <<<"tail -6 $(drv_applog "$inst") 2>/dev/null | sed 's/^/    /'" || true
    launch_instance "$inst" 0 || return 1
  done
  return 1
}
fed_log "waiting for embedded-PG + sidecar in both instances"
ensure_booted a || { echo "A boot failed after retries: $FED_BOOT_ERR"; drv_exec a <<<"tail -25 $(drv_applog a)"; exit 4; }
ensure_booted b || { echo "B boot failed after retries: $FED_BOOT_ERR"; drv_exec b <<<"tail -25 $(drv_applog b)"; exit 4; }
[ "${FED_KIND[a]}" = local ] && FED_DB[a]="postgresql://harness_admin:harness_admin_pwd@localhost:${FED_PG[a]}/papercusp"
fed_log "A: PG=${FED_PG[a]} sc=${FED_SC[a]} | B: PG=${FED_PG[b]} sc=${FED_SC[b]}"
if [ "$VMS" = 2 ]; then
  echo "✓ isolated by construction (separate VMs)"
else
  fed_assert_isolated a b || exit 5
fi

# WI-6212 — DEPLOYED-STATE preconditions. Everything above verifies the rig can
# TALK (bridge, UDP, boot); nothing verified WHAT IS RUNNING. Every check below
# exists because its absence produced confident, reproducible, wrong results:
#   - heterogeneous builds: fed-a ran a sidecar WITH the holepunch fix under test
#     and fed-b one WITHOUT it, so the single failing direction was simply the one
#     dialed by the stale VM (WI-6209).
#   - uniform BUT STALE: the uniformity check proves the VMs match EACH OTHER, and
#     is structurally blind to both being equally out of date — a uniformly-wrong
#     rig disagrees with nothing. The app's own /api/health carries the baked build
#     provenance, so ask it (an unprovenanced artifact reports version 0.0.0).
#   - public DHT: a relaunch that omits ~/fed.env silently joins the PUBLIC DHT,
#     pulling outside peers into a rig everyone believes is isolated.
# All are cheap, and all fail CLOSED — an unverifiable precondition is a stop,
# not a warning (EI-18160721229588594: a WARN in a long boot log is reliably missed).
if [ "$VMS" = 2 ] && [ "${FED_KIND[a]}" != local ] && [ "${FED_KIND[b]}" != local ]; then
  fed_log "asserting deployed state (WI-6212: uniform build + provenance + DHT isolation)"
  vm_assert_uniform_sidecar "${FED_VM[a]}" "${FED_VM[b]}"
  vm_assert_build_provenance "${FED_VM[a]}" "${FED_VM[b]}"
fi
if [ -n "${BOOTSTRAP:-}" ]; then
  for inst in a b; do
    [ "$VMS" = 2 ] || [ "$inst" = a ] || continue
    [ "${FED_KIND[$inst]}" = local ] && continue
    vm_assert_dht_isolated "${FED_VM[$inst]}"
  done
fi

# ── 9. create-from-repo on A (auto-publish) → discover → join on B ──────────
# The per-harness /share/finalize step was RETIRED (comb-retire-per-harness-
# sharing-2026-06-11 → the HIVE model). Current federation-setup: A creates a hive
# from a real PUBLIC repo (from-repo clones + blueprints + builds the hive home +
# member and AUTO-PUBLISHES on the directory topic), B discovers A's announce over
# the wire, then JOINS as a hive — the join re-keys B onto the owner's Hive-pubkey
# topic so writes actually federate (EI-681). Mirrors two-instance-hive-from-repo-
# smoke.sh over the vm/local drv_exec vtable.
fed_log "create-from-repo on A → discover → join on B (repo=$REPO_URL)"
fed_wait_api a || echo "⚠ A sidecar API not ready (proceeding)"
fed_wait_api b || echo "⚠ B sidecar API not ready (proceeding)"

a_resp="$(fed_hive_create_from_repo a "$REPO_URL")"
echo "A create → $(printf '%s' "$a_resp" | head -c 400)"
HIVE_SLUG="$(fed_json "$a_resp" "d['created'].get('potSlug') or d['created'].get('hiveSlug') or ''")"  # renamed hiveSlug→potSlug; accept both for skew
MEMBER_SLUG="$(fed_json "$a_resp" "d['created']['memberSlug']")"
A_ANNOUNCED="$(fed_json "$a_resp" "d['publish']['announced']")"
if [ -n "$HIVE_SLUG" ] && [ -n "$MEMBER_SLUG" ]; then
  echo "✓ A created hive='$HIVE_SLUG' member='$MEMBER_SLUG' (publish.announced=$A_ANNOUNCED)"
else
  echo "✗ A from-repo create failed — body above"; drv_exec a <<<"tail -25 $(drv_applog a)"; exit 6
fi

# WI-6191: prefer memberLinks straight off A's OWN create response FIRST —
# the from-repo route already returns them (hive-publish-from-repo.ts's
# PublishCreatedPotOutcome.memberLinks, surfaced on `publish`; from-repo
# already synthesizes a self-link there when publish succeeded but returned
# no memberLinks, WI-3577), specifically so a joiner can join WITHOUT any
# directory round-trip. Proven live (WI-760): POSTing $a_resp's memberLinks
# straight to B's /api/discovery/join-pot joined successfully with ZERO
# directory involvement. The OLD order (poll B's directory for up to ~120s,
# THEN fall back to $a_resp) discarded a value already in hand and made the
# join leg depend on an unrelated gossip/discovery subsystem — an unrelated
# gossip hiccup then red-failed a run that was only testing substrate
# federation. Only fall back to polling B's directory (which, as a side
# effect, also proves A's announce actually crossed the wire — kept as a
# non-fatal observability signal, never a gate) when the create response
# didn't carry any links. A's own /api/discovery/pots is NOT a further
# fallback (WI-6190: that route can never list a locally-owned pot — it only
# returns peer-learned/joined-remote rows — so re-querying it always misses).
MEMBER_LINKS="$(fed_json "$a_resp" "json.dumps(d.get('publish', {}).get('memberLinks') or [])")"
if [ -n "$MEMBER_LINKS" ] && [ "$MEMBER_LINKS" != "[]" ]; then
  links_via="create-response(A)"
  echo "✓ memberLinks resolved via $links_via: $(fed_json "$MEMBER_LINKS" 'len(d)') link(s)"
else
  fed_log "B: no memberLinks on A's create response — poll GET /api/discovery/pots for '$HIVE_SLUG' (~$(( ${DISCOVERY_RETRIES:-40} * 3 ))s)"
  MEMBER_LINKS="[]"; links_via="directory(B)"
  for _ in $(seq 1 "${DISCOVERY_RETRIES:-40}"); do
    brow="$(fed_hive_dir_row b "$HIVE_SLUG")"
    if [ -n "$brow" ]; then
      MEMBER_LINKS="$(fed_json "$brow" "json.dumps(d.get('memberLinks') or [])")"
      [ -n "$MEMBER_LINKS" ] && [ "$MEMBER_LINKS" != "[]" ] && break
    fi
    sleep 3
  done
  if [ -n "$MEMBER_LINKS" ] && [ "$MEMBER_LINKS" != "[]" ]; then
    echo "✓ memberLinks resolved via $links_via: $(fed_json "$MEMBER_LINKS" 'len(d)') link(s)"
  else
    echo "✗ no memberLinks from A's create response OR B's discovery — cannot join"; exit 6
  fi
fi

fed_log "B: JOIN '$HIVE_SLUG' via POST /api/discovery/join-hive"
join_resp="$(fed_hive_join b "$HIVE_SLUG" "$MEMBER_LINKS")"
echo "B join-hive → $(printf '%s' "$join_resp" | head -c 400)"
J_OK="$(fed_json "$join_resp" "d.get('ok')")"
N_MEM_OK="$(fed_json "$join_resp" "sum(1 for m in (d.get('members') or []) if m.get('ok'))")"
if [ "$J_OK" = "True" ] && [ "${N_MEM_OK:-0}" -ge 1 ] 2>/dev/null; then
  echo "✓ B joined hive '$HIVE_SLUG' ($N_MEM_OK member(s) — view materialized, re-keyed onto owner topic)"
else
  echo "✗ B join-hive failed (ok=$J_OK members_ok=$N_MEM_OK) — body above"; drv_exec b <<<"tail -25 $(drv_applog b)"; exit 6
fi

# ── 10. discovery ([swarm] peer_connected across a real network hop) ────────
fed_log "wait for swarm peer discovery + admission (~90s)"
disc="$(fed_wait_discovery a b strict 30 || true)"
case "$disc" in
  1)    echo "✓ data path proven across machines (bytes crossed)" ;;
  skip) echo "⊘ discovery SKIPPED — this build predates the peer_data_path_up emitter (N/A, not a failure; EI-18687938054040755)" ;;
  *)    echo "⚠ no data path proven in ~90s" ;;
esac

# WI-6191: choosing A's create-response links above deliberately removes
# directory gossip from the join's critical path. Keep directory propagation
# observable as a SEPARATE verdict once the existing discovery wait has given
# the announce time to cross, but never turn a missing projection into a join
# failure: the join already succeeded from the canonical links A returned.
if [ "$links_via" = "create-response(A)" ]; then
  fed_log "B: observe A's directory announce after join (non-fatal)"
  announce_row="$(fed_hive_dir_row b "$HIVE_SLUG" || true)"
  announce_links="[]"
  if [ -n "$announce_row" ]; then
    announce_links="$(fed_json "$announce_row" "json.dumps(d.get('memberLinks') or [])" 2>/dev/null || printf '[]')"
  fi
  if [ -n "$announce_links" ] && [ "$announce_links" != "[]" ]; then
    echo "✓ directory announce observed on B: $(fed_json "$announce_links" 'len(d)') link(s)"
  else
    echo "⚠ directory announce not observed on B after discovery wait — join used A's create-response links; continuing"
  fi
fi

# ── 11. the bidirectional MERGE gate (slug-agnostic hive probe) ─────────────
# The hive model may remap harness_slug across peers, so poll the dst for the
# feature_id under ANY slug (fed_hive_merge_probe), seeded on the src's member
# harness ($MEMBER_SLUG). Same bidirectional proof as the pre-hive rig.
fed_log "A→B: write F-A2B on A's member ($MEMBER_SLUG, origin=local) → expect origin=remote in B"
ab="$(fed_hive_merge_probe a b "$MEMBER_SLUG" F-A2B 30 || true)"; ab="${ab%% *}"
[ "$ab" = 1 ] && echo "✓ A→B MERGE: F-A2B federated into B as origin=remote" || echo "✗ A→B: F-A2B not in B after ~90s"
fed_log "B→A: write F-B2A on B → expect origin=remote in A"
ba="$(fed_hive_merge_probe b a "$MEMBER_SLUG" F-B2A 30 || true)"; ba="${ba%% *}"
[ "$ba" = 1 ] && echo "✓ B→A MERGE: F-B2A federated into A as origin=remote" || echo "✗ B→A: F-B2A not in A after ~90s"

# ── 12. report ──────────────────────────────────────────────────────────────
fed_log "RESULT (vms=$VMS dht=$DHT net=$NET reset=$RESET)"
if { [ "$disc" != 1 ] && [ "$disc" != skip ]; } || [ "$ab" != 1 ] || [ "$ba" != 1 ]; then
  echo "── [swarm] diagnostics ──"
  for inst in a b; do
    echo "[$inst] $(drv_exec "$inst" <<<"grep -E '\[swarm\]' $(drv_applog "$inst") 2>/dev/null | tail -5" )"
  done
fi
# EI-18687938054040755: fed_wait_discovery echoes 1|0|skip. `skip` = this build
# predates the peer_data_path_up emitter, so no discovery verdict exists — N/A,
# not a failure, and it must not sink OVERALL. The merge legs are themselves proof
# that bytes crossed, so a run MAY pass with discovery unmeasured — it just has to
# SAY so, never render as an unqualified green.
disc_label() { case "$1" in 1) echo PASS ;; skip) echo SKIP ;; *) echo FAIL ;; esac; }
echo "discovery=$(disc_label "$disc")  A→B-merge=$([ "$ab" = 1 ] && echo PASS || echo FAIL)  B→A-merge=$([ "$ba" = 1 ] && echo PASS || echo FAIL)"
if { [ "$disc" = 1 ] || [ "$disc" = skip ]; } && [ "$ab" = 1 ] && [ "$ba" = 1 ]; then
  if [ "$disc" = skip ]; then
    echo "OVERALL: PASS (⊘ discovery SKIPPED — build predates the peer_data_path_up emitter, EI-18687938054040755; the merges are the wire proof) — packaged cross-machine federation proven (real OS × $((VMS)), real network hop, write-free admission)"
  else
    echo "OVERALL: PASS — packaged cross-machine federation proven (real OS × $((VMS)), real network hop, write-free admission)"
  fi
  exit 0
else
  if [ "$DHT" = public ]; then
    echo "OVERALL: INCONCLUSIVE — public-DHT mode is best-effort on same-host VMs (NAT hairpin; see D-004)"
    exit 7
  fi
  echo "OVERALL: INCOMPLETE — see the [swarm] diagnostics above + the per-instance app logs"
  exit 6
fi
