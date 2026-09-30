/**
 * POST /api/internal/substrate/own-compaction — run ONE own-log compaction now on a
 * harness THIS process has booted, whether or not the proportional cadence says it is due.
 *
 * p2p-join-catchup-speed-2026-09-23, D-023. The cadence spaces snapshot sets by the prior
 * set's row count, which on the tower's papercusp pot is ~1.9M ops. So a fold-time policy
 * change — P-530's drop of dead resource-governor receipts, ~56% of set@7711093's rows —
 * reaches no joiner until the log has grown that far again. This route is the lever that
 * publishes the next set now. It runs the periodic compaction itself (worker-thread fold,
 * P-530 census, off the merge gate), so nothing here is a second producer.
 *
 * Same contract as `/internal/substrate/head-snapshot` (see that route's doc-comment):
 *
 * 1. **`booted: false` is a 200, not an error** — the caller fans out across the box's
 *    operator-shaped processes and takes the one that holds the hive.
 * 2. **Never 5xx** — a refusal or a failed compaction is `ok: false` + `error` in a 200.
 * 3. **`probeOnly`** answers `booted` and the own-log length and starts nothing.
 *
 * `auth: 'loopback'` — an operator on this box is the only caller.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getBootedHarness } from '../../../sync/hyperbee/boot-all';
import { describeProcessRole, ownHonoPort } from '../../../schedule-federation';

export interface OwnCompactionRequestBody {
  readonly workspaceId?: string;
  readonly hive?: string;
  /** Discovery pass: answer `booted` and start NOTHING. */
  readonly probeOnly?: boolean;
}

export default defineTool({
  method: 'POST',
  path: '/internal/substrate/own-compaction',
  auth: 'loopback',
  /**
   * No route watchdog, for the reason `/internal/substrate/head-snapshot` gives: the call
   * folds the newest set plus the tail since it (1.4M rows on the tower) and legitimately
   * takes minutes. The caller owns the deadline; `probeOnly` returns immediately.
   */
  timeoutSec: null,
  async handler(req) {
    const identity = {
      process: describeProcessRole(),
      pid: process.pid,
      port: ownHonoPort(),
    };
    let body: OwnCompactionRequestBody;
    try {
      body = (await req.json()) as OwnCompactionRequestBody;
    } catch {
      return Response.json({ ok: false, ...identity, error: 'invalid json' }, { status: 400 });
    }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
    const hive = typeof body.hive === 'string' ? body.hive.trim() : '';
    if (!workspaceId || !hive) {
      return Response.json({ ok: false, ...identity, error: 'workspaceId + hive required' }, { status: 400 });
    }

    const handle = getBootedHarness(workspaceId, hive);
    if (!handle) {
      return Response.json({ ok: true, ...identity, booted: false });
    }
    if (body.probeOnly) {
      return Response.json({
        ok: true,
        ...identity,
        booted: true,
        probeOnly: true,
        logLength: handle.ownLog.length,
      });
    }

    try {
      const outcome = await handle.compactOwnLogNow();
      return Response.json({ ...outcome, ...identity, booted: true });
    } catch (e) {
      return Response.json({
        ok: false,
        ...identity,
        booted: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
