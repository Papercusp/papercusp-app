import { defineTool } from '@papercusp/agent-mcp';
import { isTaskManagerEnabled } from '../../../task-manager/enabled';
import { getTaskInventory, disabledInventory } from '../../../task-manager/inventory';
import { killTask } from '../../../task-manager/control';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';

/**
 * Admin task inventory — the NON-UI read surface for the Task Manager
 * (task-manager-no-escape-2026-07-27, P-017).
 *
 * Mirrors `/admin/schedules/inventory` exactly: it shares the SAME store the
 * `processes:list` MCP tool reads.
 *
 * ⚠ This file used to state that a dashboard fetch "must not be able to kill anything",
 * and the panes were read-only on that basis. The owner reversed it on 2026-08-08
 * ("there should be a way to kill processes in both the dropdown and the full page
 * view") — a supervision pane that can SEE a runaway but not stop it sends the reader
 * to a shell, which is exactly where `pkill -f` lives. The kill route below is the
 * safe expression of that: it takes a `taskId` and nothing else, so it can only ever
 * reach a row the ledger already owns, and it delegates to `killTask` whose two paths
 * (cgroup scope, or a pid re-verified against its recorded kernel identity) are the
 * same rails the `processes:kill` MCP tool rides. There is still no name/pattern form.
 *
 * ⚠ The PANE no longer reads through here (WI-6475). A bare `fetch` from the desktop
 * webview does not ride the sys:http IPC bridge that injects the loopback-superuser
 * bearer, so it resolves `unverified-loopback` and this VT gate 403-blanks the pane —
 * the failure mode documented in `endpoint-route/__tests__/auth-posture.test.ts`
 * (EI-338). The UI now reads the `taskManager.inventory` sync query instead, whose
 * transport is `auth:'loopback'`. This route stays for curl/external probes and shares
 * `getTaskInventory` with that resolver so the two can never report different numbers.
 *
 * `live=1` runs a dry-run reconcile so the caller can see kernel truth (unaccounted
 * groups, degraded scans) alongside the ledger. Still writes nothing.
 */
const inventory = defineTool({
  method: 'GET',
  path: '/admin/tasks/inventory',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    // WI-6499: fail CLOSED via the shared authority — this used to `.catch(() => true)`,
    // which served a live inventory whenever the flag backend was unreachable.
    if (!(await isTaskManagerEnabled('admin:task-manager'))) return Response.json(disabledInventory());

    const url = new URL(req.url);
    return Response.json(
      await getTaskInventory({
        state: url.searchParams.get('state'),
        cls: url.searchParams.get('class'),
        includeEnded: url.searchParams.get('includeEnded') === '1',
        live: url.searchParams.get('live') === '1',
        // P-019 — `schedules=1` folds in the RECURRING kind. Opt-in here for the same
        // reason as the pane: it reads DBOS + routines and probes sibling processes.
        includeSchedules: url.searchParams.get('schedules') === '1',
      }),
    );
  },
});

/**
 * POST /api/admin/tasks/kill  { taskId, escalateAfterMs? }
 *
 * The write half of the pane (P-023/P-024/P-025). BOTH surfaces — the AdvShell
 * dropdown and the full page — call exactly this, through one shared component, so
 * there is a single set of refusal semantics rather than two that drift.
 *
 * AUTH is VTL + a CSRF backstop, NOT the VT gate its sibling GET uses, and not the
 * bare `auth: 'loopback'` either. Same shape as every other desktop-callable admin
 * write here (`/admin/coord/:verb`, `/admin/mode/:verb`, `/admin/coord-inbox-reply`),
 * for the same two reasons: a bare `fetch` from the packaged desktop webview carries no
 * cookie or bearer and resolves `unverified-loopback`, so under VT the button would 403
 * on the one surface the owner asked for it (EI-338 — the trap that moved the READ off
 * this route in WI-6475); and `requireAllowedOriginOr403` then refuses a cross-origin
 * browser POST, which plain `auth: 'loopback'` would have admitted from any page on
 * this box.
 *
 * The reply is `killTask`'s ControlOutcome VERBATIM, including `error` + `detail`, and
 * always with HTTP 200 for a well-formed request. A refusal is a RESULT here, not a
 * transport failure: `identity_mismatch` means the rail worked (the pid was recycled and
 * we declined to signal a stranger), and mapping that onto a 4xx would present the
 * safety property as a fault. The UI renders the reason verbatim — a destructive control
 * that silently no-ops teaches people to click it twice.
 */
const kill = defineTool({
  method: 'POST',
  path: '/admin/tasks/kill',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  timeoutSec: 30,
  async handler(req): Promise<Response> {
    // Same CSRF backstop as admin/mode.ts: a browser cross-origin POST is refused; the
    // desktop webview's allowed origins pass. This is what buys back the safety that
    // widening past VT gives up — and it runs BEFORE the flag read, so a cross-origin
    // caller cannot even probe whether the subsystem is on.
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;

    if (!(await isTaskManagerEnabled('admin:task-manager:kill'))) {
      return Response.json({ ok: false, error: 'disabled', detail: 'task manager is switched off' }, { status: 409 });
    }

    let body: { taskId?: unknown; escalateAfterMs?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'bad_request', detail: 'body must be JSON' }, { status: 400 });
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    if (!taskId) {
      return Response.json({ ok: false, error: 'bad_request', detail: 'taskId is required' }, { status: 400 });
    }
    // Bounded: this is awaited inside the request, and the escalation is a SLEEP.
    const escalateAfterMs =
      typeof body.escalateAfterMs === 'number' && Number.isFinite(body.escalateAfterMs)
        ? Math.max(0, Math.min(10_000, Math.floor(body.escalateAfterMs)))
        : 5_000;

    const outcome = await killTask(taskId, { escalateAfterMs });
    // Both panes read `taskManager.inventory`; a killed row must not linger as running
    // until the next 5s poll, or the reader clicks again.
    void notifySyncInvalidate('taskManager.inventory', {}).catch(() => {});
    return Response.json(outcome);
  },
});

export default [inventory, kill];
