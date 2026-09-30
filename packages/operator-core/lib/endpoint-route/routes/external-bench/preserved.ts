/**
 * /api/external-bench/runs — the Evaluation "Preserved runs" surface backend
 * (impartial-benchmark-suite).
 *
 *   GET /api/external-bench/runs        → list available preserved run dirs
 *   GET /api/external-bench/runs/:id    → one run's arm json + the grader's
 *        per-instance `resolved` merged onto each perTask row + the summary
 *        (resolvedCount/taskCount, totals, coordEvent count, coord rates)
 *
 * Reads from `~/.papercusp/bench-results/<id>/` — the preserved fleet-arm run
 * snapshots the runners write for reproducibility (the merge + summary live in
 * `external-bench/preserved-runs.ts`, unit-tested). Public + loopback-only,
 * consistent with the sibling /gym + /harness read routes; the base dir is
 * resolved SERVER-SIDE only (the run id is path-validated, never a host param)
 * so a caller can't make the operator read an arbitrary path.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  listPreservedRuns,
  readPreservedRun,
  isSafeRunId,
} from '../../../external-bench/preserved-runs';

const runs = defineTool({
  method: 'GET',
  path: '/external-bench/runs',
  auth: 'public',
  async handler() {
    return Response.json({ runs: listPreservedRuns() });
  },
});

const run = defineTool({
  method: 'GET',
  path: '/external-bench/runs/:id',
  auth: 'public',
  async handler(_req, ctx) {
    const id = ctx.params.id as string;
    if (!isSafeRunId(id)) {
      return Response.json({ error: 'invalid_run_id' }, { status: 400 });
    }
    const detail = readPreservedRun(id);
    if (!detail) {
      return Response.json({ error: 'run_not_found', id }, { status: 404 });
    }
    return Response.json(detail);
  },
});

export default [runs, run];
