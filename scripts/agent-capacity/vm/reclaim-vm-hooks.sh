#!/usr/bin/env bash
# Spot reclaim drill, VM side (plan agent-capacity-and-cost-gcp-2026-09-30 P-007, D-026).
# Run as root on the drill VM (reclaim-drill.sh prep copies and runs it). Installs three root
# services that write fsync'd timestamps under /var/lib/reclaim-drill, so the reclaim timeline
# survives the stop and can be read after the restart:
#   reclaim-preempt-watch  long-polls the GCE metadata 'preempted' flag; logs PREEMPTED_FLAG=<v> on change
#   reclaim-heartbeat      logs HB every second to hb.log (its last line = when the guest stopped writing)
#   reclaim-mark           logs BOOT at start and SHUTDOWN_STOP when systemd stops it during shutdown
# Ordered After=local-fs.target, so reclaim-mark is stopped (and logs) before the filesystems unmount.
# D-026 measured: the preempted flag is the guest's only warning (~30 s), and SHUTDOWN_STOP never
# appears (no clean shutdown), so a reclaim-aware agent host must act on the flag.
# HOOK_ROOT prefixes every install path (tests); the units still reference the runtime paths.
set -euo pipefail
R=${HOOK_ROOT:-}
D=/var/lib/reclaim-drill
install -d -m 0755 "$R$D" "$R/usr/local/bin" "$R/etc/systemd/system"

cat > "$R/usr/local/bin/reclaim-log" <<'EOF'
#!/bin/sh
# reclaim-log <tag> [file]: append "<tag> <utc ms>" and fsync it.
f=${2:-/var/lib/reclaim-drill/events.log}
printf '%s %s\n' "$1" "$(date -u +%FT%T.%3NZ)" >> "$f"
sync "$f"
EOF
chmod 0755 "$R/usr/local/bin/reclaim-log"

cat > "$R/usr/local/bin/reclaim-preempt-watch" <<'EOF'
#!/bin/sh
# Logs only value CHANGES; an immediate unchanged return is throttled to one poll per second.
/usr/local/bin/reclaim-log WATCH_START
last=""
while true; do
  t0=$(date +%s)
  v=$(curl -sf -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/preempted?wait_for_change=true&timeout_sec=300') || v=ERR
  if [ "$v" != "$last" ]; then /usr/local/bin/reclaim-log "PREEMPTED_FLAG=$v"; last=$v; fi
  [ $(( $(date +%s) - t0 )) -ge 1 ] || sleep 1
done
EOF
chmod 0755 "$R/usr/local/bin/reclaim-preempt-watch"

cat > "$R/etc/systemd/system/reclaim-preempt-watch.service" <<'EOF'
[Unit]
Description=Reclaim drill: GCE preempted-flag watcher
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/reclaim-preempt-watch
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > "$R/etc/systemd/system/reclaim-heartbeat.service" <<'EOF'
[Unit]
Description=Reclaim drill: 1 s fsync'd heartbeat
After=local-fs.target
[Service]
ExecStart=/bin/sh -c 'while true; do /usr/local/bin/reclaim-log HB /var/lib/reclaim-drill/hb.log; sleep 1; done'
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > "$R/etc/systemd/system/reclaim-mark.service" <<'EOF'
[Unit]
Description=Reclaim drill: boot and shutdown markers
After=local-fs.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/reclaim-log BOOT
ExecStop=/usr/local/bin/reclaim-log SHUTDOWN_STOP
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now reclaim-preempt-watch.service reclaim-heartbeat.service reclaim-mark.service
sleep "${HOOK_SETTLE_SEC:-2}"
systemctl is-active reclaim-preempt-watch reclaim-heartbeat reclaim-mark
# A volatile journal loses the previous boot, so the drill could not read the shutdown sequence.
ls -d /var/log/journal >/dev/null 2>&1 && echo JOURNAL_PERSISTENT || echo JOURNAL_VOLATILE
cat "$R$D/events.log" 2>/dev/null || true
echo HOOKS_OK
