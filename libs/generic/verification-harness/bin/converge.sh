# converge.sh: the shell twin of src/converge.ts (waitForConvergence). Source it; do not
# execute it. vh.sh sources it, and a harness that does not use vh.sh can source it alone.
#
#   vh_converge --budget <sec> --poll <sec> --what <text> --out <file> \
#               [--err <file>] [--between <fn>] -- <cmd...>
#
# Reads remote state after an async action until it converges, instead of reading once.
# The observation command's exit code is the protocol:
#   0          converged: return 0
#   3          observed, NOT converged yet: read again after --poll seconds, until --budget
#   any other  the read itself broke: return that code at once (a broken read is not lag)
# Each read OVERWRITES --out (stdout) and --err (stderr, default "<out minus extension>.err"),
# so the LAST observation survives as evidence whether or not it converged.
#
# LEVEL-triggered: the first read runs immediately. --budget 0 is an explicit single read.
# --between <fn> runs between reads while budget remains (e.g. nudge a sync), with the read
# count as $1. Its output goes to "<out minus extension>-between-<n>.log" and its exit code
# is ignored. Never before the first read, never past the deadline.
#
# On timeout: prints "CONVERGENCE_TIMEOUT: <what> ..." with the last stderr line to stderr
# and returns 3. Usage errors return 2. VH_CONVERGE_READS holds the read count afterwards.
# Test seams: VH_CONVERGE_SLEEP names the sleep command (default: sleep); VH_CONVERGE_NOW
# names a function that sets VH_CONVERGE_T to the current second (default: $SECONDS).

VH_CONVERGE_READS=0
VH_CONVERGE_T=0
_vh_converge_now() { VH_CONVERGE_T=$SECONDS; }

vh_converge() {
  local budget="" poll="" what="" out="" err="" between=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --budget) budget="${2:-}"; shift 2 ;;
      --poll) poll="${2:-}"; shift 2 ;;
      --what) what="${2:-}"; shift 2 ;;
      --out) out="${2:-}"; shift 2 ;;
      --err) err="${2:-}"; shift 2 ;;
      --between) between="${2:-}"; shift 2 ;;
      --) shift; break ;;
      *) echo "vh_converge: unknown argument '$1'" >&2; return 2 ;;
    esac
  done
  if ! [[ "$budget" =~ ^[0-9]+$ ]] || ! [[ "$poll" =~ ^[0-9]+$ ]] || [ "$poll" -eq 0 ] \
    || [ -z "$what" ] || [ -z "$out" ] || [ "$#" -eq 0 ]; then
    echo 'usage: vh_converge --budget <sec> --poll <sec,>0> --what <text> --out <file> [--err <file>] [--between <fn>] -- <cmd...>' >&2
    return 2
  fi
  local stem="${out%.*}"
  [ -n "$err" ] || err="$stem.err"
  local sleep_cmd="${VH_CONVERGE_SLEEP:-sleep}" now_fn="${VH_CONVERGE_NOW:-_vh_converge_now}"
  local deadline reads=0 rc remaining
  "$now_fn"; deadline=$((VH_CONVERGE_T + budget))
  VH_CONVERGE_READS=0
  while :; do
    reads=$((reads + 1))
    VH_CONVERGE_READS=$reads
    rc=0
    "$@" >"$out" 2>"$err" || rc=$?
    [ "$rc" -ne 0 ] || return 0
    if [ "$rc" -ne 3 ]; then
      echo "vh_converge: $what observation failed (exit $rc); see $err" >&2
      return "$rc"
    fi
    "$now_fn"; remaining=$((deadline - VH_CONVERGE_T))
    if [ "$remaining" -le 0 ]; then
      echo "CONVERGENCE_TIMEOUT: $what did not converge within ${budget}s ($reads read(s)); last: $(tail -n 1 "$err" 2>/dev/null)" >&2
      return 3
    fi
    "$sleep_cmd" "$((poll < remaining ? poll : remaining))"
    "$now_fn"
    if [ -n "$between" ] && [ "$((deadline - VH_CONVERGE_T))" -gt 0 ]; then
      "$between" "$reads" >"$stem-between-$reads.log" 2>&1 || true
    fi
  done
}
