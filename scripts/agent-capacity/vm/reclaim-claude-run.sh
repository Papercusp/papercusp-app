#!/usr/bin/env bash
# Spot reclaim drill (plan agent-capacity-and-cost-gcp-2026-09-30 P-007, D-026), VM side: the drill's
# one real claude session.
#   reclaim-claude-run.sh task            turn 1: the long tool-loop task (interrupted by the reclaim)
#   reclaim-claude-run.sh resume <sid>    turn 2 after the restart: claude --resume <sid>
# Fresh CLAUDE_CONFIG_DIR, sonnet, the tower gateway through the reverse tunnel (no credentials on
# the VM). Each stream-json event is written as "<epoch.ms>\t<event>" to ~/reclaim-drill/claude-<mode>.tsv,
# so time-to-first-event and the turn's tool steps can be read without a client-side probe.
# The task is resumable by construction: one line per file appended to notes.md, so a resumed turn
# that duplicates or skips a step shows up as a duplicate or missing line.
set -uo pipefail
MODE=${1:?usage: reclaim-claude-run.sh task|resume <sid>}
W=${RECLAIM_HOME:-$HOME/reclaim-drill}
cd "$W/work" || exit 1
export CLAUDE_CONFIG_DIR=$W/claude-config
export ANTHROPIC_BASE_URL=${RECLAIM_GATEWAY:-http://127.0.0.1:8788}
export ANTHROPIC_AUTH_TOKEN=papercusp-gateway
export ANTHROPIC_CUSTOM_HEADERS='x-papercusp-owner: agent-capacity-reclaim-drill'
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
case "$MODE" in
  task)
    PROMPT='For each file in this directory except notes.md, in alphabetical order and strictly one file at a time: (1) Read the file with your Read tool, (2) run wc -l on it with Bash, (3) with a separate Bash call append exactly one line "<filename> (<N> lines): <one-sentence summary>" to notes.md (echo ... >> notes.md). Finish all three steps for a file before you start the next one; never batch. When every file has a line, append the line DONE to notes.md and stop.'
    EXTRA=() ;;
  resume)
    SID=${2:?resume needs the session id}
    PROMPT='Your previous turn was interrupted by a machine restart. Continue the same task from where it stopped: check notes.md, then handle every remaining file the same way (Read, wc -l, append), and finish with DONE.'
    EXTRA=(--resume "$SID") ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
printf '%s\tSTART\n' "$(date +%s.%3N)" > "$W/claude-$MODE.tsv"
claude -p "$PROMPT" "${EXTRA[@]}" --output-format stream-json --verbose --dangerously-skip-permissions --model sonnet \
  2> "$W/claude-$MODE.err" |
  while IFS= read -r line; do printf '%s\t%s\n' "$(date +%s.%3N)" "$line"; done >> "$W/claude-$MODE.tsv"
rc=${PIPESTATUS[0]}
printf '%s\tEXIT rc=%s\n' "$(date +%s.%3N)" "$rc" >> "$W/claude-$MODE.tsv"
exit "$rc"
