/**
 * dev:stall_waker_status — runtime observability for the stall-waker poll loop
 * (EI-2432, gateway-rate-limit-stall-autowake). The loop's only prior signal
 * was a `console.log('[stall-waker] started')` + per-tick console output
 * buried in the operator's stdout — not queryable, so even a full-access su
 * session could not confirm the loop was running, its cadence, or its recent
 * activity without grepping host logs.
 *
 * EI-22054545312178322: this tool used to read ONLY the calling process's
 * in-process singleton, on the false premise that the loop "runs IN the
 * operator process (same process as this tool handler)". Under the
 * dedicated-bg-host topology `ensureStallWakerLoop` boot-starts ONLY on the
 * host with `PAPERCUSP_BACKGROUND_WORKERS=1` (bg-host today) — :3070/:3170
 * are request-only and never boot-start it — so a call served by :3070/:3170
 * always read `running:false` locally while bg-host's copy was genuinely
 * ticking (WI-2054656). Fixed by federating: try the local reading first
 * (the fast path — correct and network-free whenever THIS process is the one
 * running the loop, e.g. a call served directly by bg-host), and only when
 * it reads `running:false` fan out to sibling processes
 * (`schedule-federation.ts`, the same mechanism `schedule:inventory` uses for
 * cross-process managed timers) looking for one that reports it running.
 * `source` on the response says which process the answer actually came from.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getStallWakerStatus, type StallWakerStatus } from '../../inference-gateway/stall-waker-loop';
import { collectSiblingManagedTimers } from '../../schedule-federation';

export default defineTool({
  name: 'dev:stall_waker_status',
  description:
    "Runtime status of the stall-waker poll loop that auto-wakes bees stalled on a rate-limited account. Returns { running, workspaceId, startedAt, pollMs, idleSilenceMs, tickCount, lastTickAt, lastTickOk, lastTickError, pendingCount, breadcrumbCount, wokenTotal, droppedTotal, unwedgedTotal, source }. `running:false` means the loop never started (gateway off / no spawn yet) or was stopped anywhere reachable. Reads the calling process's own in-process singleton first (source:'local'); if that reads not-running, federates to sibling processes on the box (source:'<sibling label>', e.g. 'bg-host:3271') so a call served by a request-only host (:3070/:3170) still finds the loop's real home in bg-host instead of falsely reporting it stopped.",
  guidance: {
    when: "Confirming the stall-waker is actually running (vs grepping operator stdout for '[stall-waker]'), checking its poll cadence / last-tick health, or how many bees it's currently tracking/has woken.",
    notWhen: 'Per-owner outcomes (429/shed/stall) — gateway:owner_report. Live admission/pool state — gateway:status / dev:rate_governor_status.',
    seeAlso: ['gateway:owner_report (per-agent stall/wake outcomes)', 'dev:rate_governor_status (live rate-limit pacing)'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'documenter', 'curator'],
  args: z.object({}),
  async handler() {
    const local = getStallWakerStatus();
    if (local.running) {
      return { data: { ok: true, source: 'local', ...local } };
    }
    // Local copy is not running — this may just mean THIS process never
    // boot-starts it (request-only :3070/:3170). Fan out to siblings on the
    // box and see whether one of them (bg-host) reports the real loop alive.
    // Fail-soft: collectSiblingManagedTimers never rejects and degrades to []
    // on a discovery-file read error, so a federation failure here falls
    // through to the honest local (not-running) reading below, never throws.
    const siblings = await collectSiblingManagedTimers().catch(() => []);
    const remote = siblings.find(
      (s): s is typeof s & { stallWaker: StallWakerStatus } => s.ok && s.stallWaker?.running === true,
    );
    if (remote) {
      return { data: { ok: true, source: remote.label, ...remote.stallWaker } };
    }
    return { data: { ok: true, source: 'local', ...local } };
  },
});
