/**
 * TasksRunningPill — the Task Manager's always-visible header control
 * (WI-6844, owner ask 2026-08-02: "move the location of it from the middle pane
 * to a button on our top bar to the right of the 'agents running' button").
 *
 * Third pill in `pc-advshell__header-status`, after PotsRunningPill and
 * AgentsRunningPill. Modelled on PotsRunningPill rather than AgentsRunningPill:
 * both are Popover-over-a-pill, but the hives one is the 65-line version that has
 * not accreted a roster, a search box and a bulk-action bar, and this pill's job
 * is only to open the panel.
 *
 * ── The pill and the panel report the SAME number ──
 * Both read the live SCAN: every process actually running, enrolled or not
 * (WI-6475 added the scan precisely because the pane showed an empty table beside
 * "400 process(es) scanned", which reads as broken). The pill and the panel it
 * opens can therefore never disagree — the trap AdvOverviewTab warns about with
 * the Agents tile, avoided the same way: one query, one number.
 *
 * This is NOT how it originally shipped, and the difference is the whole point of
 * WI-6844's second half. The pill used to render `summary.total` — the LEDGER —
 * because a kernel scan was thought too expensive for something mounted on every
 * tab. That read "3 tasks" on a box running 131 agents. The counts-only live arm
 * (`{ live: true, countsOnly: true }`) plus the resolver's 5s shared scan memo is
 * what retired that trade-off: one walk per TTL for the whole app, so the honest
 * number became affordable and the cheap-but-wrong one is gone. See
 * `countProcesses` below for the ledger fallback that survives, and why.
 *
 * The panel is lazy: it is the thing that carries the scan, and it must not run
 * for a popover nobody has opened.
 */
import { Suspense } from 'react';
// lazyWithRetry, NOT React's bare `lazy` (WI-2902, and re-learned the hard way here).
// A dynamic import that 404s escalates to the FATAL error boundary, and on this box
// the dist bundle is rebuilt every few minutes under a live window — every rebuild
// rotates the chunk hashes and deletes the old ones, so an open view that lazily
// imports a chunk mid-rebuild gets "Importing a module script failed."
//
// That hazard is much worse HERE than it was in the component's old home. As a
// left-rail tab this panel only mounted when someone opened that tab; as a header
// pill it mounts on EVERY AdvShell tab, so a single missed chunk fetch takes down
// the whole shell rather than one pane. Retrying is what turns that into a blip.
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { Activity } from 'lucide-react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Popover } from '@/app/harness/Popover';
import './adv-header-pills.css';

const TasksRosterPanel = lazy(() => import('./TasksRosterPanel'));

/** The slice of `taskManager.inventory` this pill needs — the counts-only arm. */
type PillPayload = {
  enabled: boolean;
  summary: { total: number; byState: Record<string, number>; byClass: Record<string, number> };
  live?: { scan?: { processes?: number } } | null;
};

/**
 * What the pill counts: PROCESSES ACTUALLY RUNNING, from the live scan.
 *
 * OWNER-REPORTED 2026-08-02, and it was a real defect, not a labelling quibble:
 * this used to count running rows in the LEDGER, which read "3 tasks" on a box with
 * 131 live agents. Three things stack up to make the ledger a hopeless proxy for
 * "what is running":
 *   - enrolment binds at SPAWN, so every agent started while the flag was dark is
 *     invisible to it permanently — no reconcile can adopt them later;
 *   - only three seams enrol at all until P-009 lands; and
 *   - the enrolling seams are short-lived, so even a healthy ledger holds few
 *     in-flight rows at any instant (the WI-6475 finding).
 * A number that is wrong by two orders of magnitude is worse than no pill, because
 * it is quietly authoritative. `scan.processes` is what the panel itself reports,
 * so the pill and the panel it opens can no longer disagree.
 *
 * Falls back to the ledger's active count only when the scan is unavailable
 * (degraded / errored), which is a genuine undercount but an honest one — and the
 * panel says so in its own header when you open it.
 */
export function countProcesses(payload: PillPayload | undefined): number {
  if (!payload) return 0;
  const scanned = payload.live?.scan?.processes;
  if (typeof scanned === 'number' && scanned > 0) return scanned;
  return countActive(payload.summary?.byState);
}

/** Ledger-active fallback: running + starting. Pure — exported for the test. */
export function countActive(byState: Record<string, number> | undefined): number {
  if (!byState) return 0;
  return (byState.running ?? 0) + (byState.starting ?? 0);
}

export default function TasksRunningPill() {
  const [open, setOpen] = useQueryState('tasks', parseAsBoolean.withDefault(false));
  // `live` + `countsOnly`: the scan's TOTALS without its 4000 process rows. The
  // scan is memoised server-side for 5s and shared with the panel and /admin/tasks,
  // so mounting this on every tab costs one walk per TTL for the whole app, not one
  // per reader — which is what makes an honest number affordable here at all.
  const { data } = useSyncQuery<PillPayload>({
    queryName: 'taskManager.inventory',
    args: { live: true, countsOnly: true },
    staleTime: 10_000,
  });

  const payload = (data as PillPayload[] | undefined)?.[0];

  // Self-hide like its two neighbours, so the strip grows no empty chrome. Two
  // reasons to say nothing: the kill-switch is pulled (the flag survives
  // graduation precisely so it can be), or nothing at all is running.
  if (!payload?.enabled) return null;
  const running = countProcesses(payload);
  if (running === 0) return null;

  return (
    <div className="pc-advshell__tasks-pill-wrap">
      <Popover
        open={open}
        onOpenChange={(next) => void setOpen(next)}
        trigger={(
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--tasks"
            data-testid="tasks-running-pill"
            aria-expanded={open}
            aria-controls="pc-advshell-tasks-pop"
          >
            <Activity size={11} aria-hidden />
            {running} {running === 1 ? 'process' : 'processes'}
          </button>
        )}
        tooltipLabel="Every Papercusp process running right now — who launched it, for which work-item, and what it is consuming"
        side="bottom"
        align="end"
        ariaLabel="Task manager"
        contentClassName="pc-advshell__tasks-pop"
      >
        <div id="pc-advshell-tasks-pop" data-testid="tasks-running-pop">
          <Suspense fallback={<div className="pc-tasks-roster__loading">Scanning…</div>}>
            {/* `open` gates the scan a second time: Popover keeps content mounted
                across a close on some paths, and a kernel scan must not outlive
                the popover that asked for it. */}
            <TasksRosterPanel active={open} />
          </Suspense>
        </div>
      </Popover>
    </div>
  );
}
