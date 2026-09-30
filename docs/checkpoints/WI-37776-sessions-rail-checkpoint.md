# WI-37776 — Sessions rail: checkpoint (parked to disk 2026-08-10T18:55Z)

> Written to a FILE because the operator shed three consecutive
> `work_items:checkpoint` calls with `loop_pressure_critical`. Re-post this to
> the work-item when the operator recovers, then delete this file.
> Author: su-12b70e95-84ce-4ea0-b546-8a692cdc949c

**STATUS: implementation COMPLETE and LIVE-VERIFIED. Remaining work is gate/deploy only.**

## Landed
- `GoalDetailPanel.tsx` — `GoalSessionsRail` mounted as the FIRST right-edge zone,
  immediately before the `pc-zone--work` div (the owner's placement). Added
  `SESSIONS_WIDTH` (= `PEERS_WIDTH` 248, deliberately identical so it reads as the
  same pane rather than an imitation), side/overlay styles (overlay `zIndex 4`,
  BELOW work's 5 — right-edge zones stack outward), the `goalSessions` useMemo
  (3rd reader of the SAME `advRoster.list` row, no new query), nuqs
  `hudgoalsessions` with a room-aware default, the Sessions toggle between Brief
  and Work, and the `borrowedColumns` arithmetic.
- **The give-way ladder RECOMPUTED for a 7th zone** — the real work, not the mount.
  Each column costs `width + 16`, so adding 264px moved the three EXISTING rungs:
  PEERS 2100→2380, ORDERS 1840→2100, DOSSIER 1540→1810, new SESSIONS 1480.
  Leaving them alone would seat 7 columns in the width 6 needed and crush the
  conversation at exactly the widths the ladder claims are safe.
- `chat-controls.css` — `.pc-zone--sessions` (border-left, owns its own seam);
  `.pc-peers__nest` (member indent on the LI WRAPPER, never `.pc-peer` — padding
  the row shrinks the hit target and floats the focus ring off its edge);
  `.pc-peer__intent`.
- `GoalSessionsRail.tsx` — `SessionRow` normalized so `data-testid`/`data-owner`/
  `data-member` sit on the `<li>` in BOTH branches (they were on different
  ELEMENTS, so a `testid`+`data-member` selector would silently match nothing in
  one state). Also REMOVED the `cup` pane-kind badge (see Gate below).

## Verification
- **Tests 76/76 green** (goal-sessions 15, GoalDetailPanel 61). New `P-024`
  describe covers what a model test cannot: ADJACENCY to Work (not "somewhere
  before it" — mere ordering satisfies the one placement the owner ruled out);
  the PENDING roster leg (`payload.active ?? []` is the natural thing to write and
  silently drops launching agents); a SECOND stamped agent's fleet (passing only
  `agentOwnerId` drops that fleet via membership leg 2); no-new-query.
- **Typecheck** `lint:tsc:operator` exit=0 status=clean across all 6 edited files.
- **LIVE**, in an ISOLATED headless Tauri rig (`scripts/verify-tauri-headless.sh`
  — own display :90 / port 33700 / sidecar / frozen SPA; never the owner's :0
  window, which is a human's gnome-terminal dev shell). Snapshot containment
  asserted (`goal-sessions-rail` present in the frozen bundle) so the run provably
  exercised THIS code. exit=0:

      mounted:true · nextSiblingIsWork:true · leftOfWorkOnScreen:true
      siblingOfChat:true · seating:"column" · width:248
      sections: plan/drain/grade/testing/misc · usesPeerClasses:true
      console errors: none

  The single row rendered was THIS session working WI-37776.

## Two traps, each of which produced a convincing false negative first
1. The rig window is 1280x800, and the room-aware default (`param ?? !isNarrow`)
   correctly CLOSES the zone below 1480 — run 1 read that CORRECT behaviour as a
   mount failure. Fix: xdotool resize to 1920 + force `hudgoalsessions=true`.
2. `xdotool search --name 'Papercusp Operator'` matches NOTHING — that string is
   the WEBVIEW's `document.title`, not the X window name; `--class papercusp`
   matches. The failed lookup fell through silently to the 1280 path.

## Gate
Removed the `cup` badge after su-965e1 routed EI-20091394509538630 to me (the
mug/kettle surface guard is the sole failing leg of a 3-cycle red; `main` frozen
~97 behind). Removal rather than a gate or a baseline entry: the cup tier is
RETIRED, so a file written today should not surface it.

⚠ **HONEST GAP — I never reproduced the guard failing.** Bare
`node scripts/check-ungated-mug-kettle.mjs` exits 0 before AND after my change; it
has NO `--files` parser (a `--files=` run is silently a FULL run); and the baseline
moved 195→193 known under me mid-session because su-b91d2 is re-seeding it live.
My removal is justified on its own merits but is NOT confirmed to be the cause.

⚠ **DO NOT FIRE `release:checkpoint-run` BLIND** — a MANUAL green-checkpoint has
been in flight since 18:39:20Z (`/tmp/papercup-green-checkpoint-manual-1fxzuva.log`),
started by another agent BEFORE my badge removal, so it judges a pre-fix candidate
and a FURTHER run is needed once git-sync commits mine (`git-sync:run` fired 18:50,
reported degraded/still-running).

## Box
Load ~100–117, three `papercusp-testvm-*` qemu VMs (~1500% CPU combined). The
operator SHED three MCP calls with `loop_pressure_critical` while `/api/health`
answered in 22ms on the same process — an agent can lose durable checkpoint
writes to that guard exactly when the box is busiest.
