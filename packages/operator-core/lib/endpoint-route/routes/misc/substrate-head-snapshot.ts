/**
 * POST /api/internal/substrate/head-snapshot — append ONE fresh head `__snapshot__`
 * to the own log of a harness THIS process has booted.
 *
 * P-019 (plan memory-corpus-hygiene-and-release-distribution-2026-08-03, D-012).
 *
 * The caller is a release cut running on this box. `--sparse` ships only
 * `[coreSparseFrom, len)`, and `computeSparseFrom` resolves that bound by scanning
 * back only `SNAPSHOT_SCAN_LOOKBACK` (4,000) ops from the tail — so a head snapshot
 * AT the tail is a PRECONDITION of a sparse cut, not an optimisation. The quiesced
 * cut appends it itself. The WI-4487 no-outage cut cannot: the operator holds the
 * corestore write lock, so the cutter opens READ-ONLY. This route is how it asks the
 * lock holder to append on its behalf, and it is the whole of what restores a
 * sparse cut with no outage.
 *
 * Three properties are load-bearing:
 *
 * 1. **`booted: false` is a 200, not an error.** The caller does not know WHICH
 *    process on the box holds the hive — it fans out across every operator-shaped
 *    sibling (`listSiblingOperators`) and takes the one that answers `booted: true`.
 *    A non-holder answering 404/5xx would make "I don't have it" indistinguishable
 *    from "I am broken", and the fan-out could not tell a miss from an outage.
 *
 * 2. **Never 5xx**, mirroring `managed-timers` and the canary routes: a failure is
 *    reported in the 200 body as `ok: false` + `error`. A broken probe apparatus must
 *    not read to a naive caller as "this process is unhealthy".
 *
 * 3. **`probeOnly` exists so the fan-out is cheap.** The real call is O(own-log) —
 *    461,475 blocks on this box as of 2026-08-03 — and stalls the holder's merge loop
 *    for its duration. Fanning THAT out across every sibling under one long budget
 *    would put every operator on the box at risk to find one. So discovery is a
 *    separate, instant, side-effect-free pass (`probeOnly: true` ⇒ answer whether the
 *    harness is booted here and append nothing), and only the identified holder is
 *    then asked to do the expensive thing.
 *
 * `auth: 'loopback'` — the only caller is a cut running on the same box.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getBootedHarness } from '../../../sync/hyperbee/boot-all';
import { describeProcessRole, ownHonoPort } from '../../../schedule-federation';

export interface HeadSnapshotRequestBody {
  readonly workspaceId?: string;
  readonly hive?: string;
  /** Discovery pass: answer `booted` and append NOTHING. */
  readonly probeOnly?: boolean;
}

export default defineTool({
  method: 'POST',
  path: '/internal/substrate/head-snapshot',
  auth: 'loopback',
  /**
   * P-014 — NO route watchdog. This route is not a request/response lookup: producing a
   * head snapshot reads the ENTIRE own log (461,475 blocks on this box) and legitimately
   * takes minutes. The route-stack default is 30s (`route-stack.ts` — `timeoutSec ?? 30`),
   * which this route silently inherited, so it could NEVER deliver a snapshot for a real
   * corpus: MEASURED 2026-08-09, the call returned `408 {"code":"timeout","message":"route
   * exceeded 30s"}` while the holder itself was healthy and still working.
   *
   * That 408 is worse than a slow success, because the two remedies it suggests are both
   * wrong: it looks like the holder is wedged (it is not) and it looks transient (it is
   * not — it recurs identically at any corpus size above ~30s of read).
   *
   * The client owns the real budget: `live-head-snapshot-client.ts` applies
   * DEFAULT_HEAD_SNAPSHOT_TIMEOUT_MS (15 min) and aborts. Two bounds on one operation is
   * what produced this bug, so the server defers to the caller's rather than racing it
   * with a much shorter one. `probeOnly` requests return immediately and are unaffected.
   */
  timeoutSec: null,
  async handler(req) {
    const identity = {
      process: describeProcessRole(),
      pid: process.pid,
      port: ownHonoPort(),
    };
    let body: HeadSnapshotRequestBody;
    try {
      body = (await req.json()) as HeadSnapshotRequestBody;
    } catch {
      return Response.json({ ok: false, ...identity, error: 'invalid json' }, { status: 400 });
    }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
    const hive = typeof body.hive === 'string' ? body.hive.trim() : '';
    if (!workspaceId || !hive) {
      return Response.json(
        { ok: false, ...identity, error: 'workspaceId + hive required' },
        { status: 400 },
      );
    }

    // NOTE: getBootedHarness marks the harness HOT (LRU) and can trigger a
    // reboot-on-access for an evicted engine, returning null THIS call. That is the
    // correct behaviour for a probe too — a hive this process is meant to hold comes
    // back resident, and the caller simply sees `booted: false` on the pass that
    // triggered the reboot rather than a fabricated success.
    const handle = getBootedHarness(workspaceId, hive);
    if (!handle) {
      return Response.json({ ok: true, ...identity, booted: false });
    }
    if (body.probeOnly) {
      // `ownLog.length` is an O(1) in-memory getter. Return the producer's actual
      // cost driver so the cutter can size its request deadline without reading or
      // folding the corpus a second time; rowCount is only known after the expensive
      // snapshot operation and is therefore the wrong preflight signal.
      return Response.json({
        ok: true,
        ...identity,
        booted: true,
        probeOnly: true,
        logLength: handle.ownLog.length,
      });
    }

    const startedAt = Date.now();
    try {
      const snap = await handle.produceHeadSnapshotNow();
      return Response.json({
        ok: true,
        ...identity,
        booted: true,
        appended: snap.appended,
        coversUpTo: snap.coversUpTo,
        chunkCount: snap.chunkCount,
        rowCount: snap.rowCount,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (e) {
      return Response.json({
        ok: false,
        ...identity,
        booted: true,
        elapsedMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
