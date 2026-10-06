#!/usr/bin/env bash
# Host sampler (runs ON a capacity VM; moved from .papercusp/scratch/p011/host-sampler.sh by WI-10006497).
# One line every SAMPLE_SEC (default 30) s: MemTotal/MemAvailable/SwapTotal/SwapFree (kB) and the load
# average. sidecar-idle-probe.sh prints the latest line at the head of each census.
SAMPLE_SEC=${SAMPLE_SEC:-30}
while :; do
  mem=$(awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/{printf "%s=%s ", $1, $2}' /proc/meminfo)
  load=$(cut -d' ' -f1-3 /proc/loadavg)
  echo "$(date -u +%FT%TZ) ${mem}load=${load// /,}"
  sleep "$SAMPLE_SEC"
done
