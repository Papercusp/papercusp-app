/**
 * POST /api/admin/testing/desktop-perf-runs — ingest one desktop-perf run from
 * an OUT-OF-PROCESS producer (the packaged-binary wdio runner).
 *
 * WHY THIS EXISTS (perf-testing-sweep-2026-07-27, WI-6538):
 * `harness_shared.desktop_perf_runs` was EMPTY from the day the suite landed
 * (2026-07-20) until this route, and that made the desktop-perf release gate
 * structurally incapable of firing: `desktop-perf-gate.ts` reads the latest run,
 * finds none, and takes its fail-soft `pass` branch — so every deploy cleared a
 * perf gate that had never measured anything.
 *
 * The cause was a missing PRODUCER, not a bug in the gate. The only writer was
 * `persistDesktopPerfRun` in admin-test-runs-store.ts, which fires only when the
 * in-app admin suite finishes — and that suite is started only by a human
 * clicking Run in the admin testing UI. Nothing scheduled it, so nothing ever
 * wrote a row.
 *
 * The fresh-binary wdio runner (`npm run perf:desktop`) is the one path that can
 * run UNATTENDED — it boots its own packaged binary headlessly over WebDriver —
 * but it lives outside the npm workspace and threw its measures away. This route
 * is the seam that lets it persist them. Note `DesktopPerfSource` has always been
 * `'admin-suite' | 'wdio'`: the wdio half was designed for and never wired, so
 * this completes the original design rather than adding a new concept.
 *
 * Deliberately a thin wrapper over the SAME `recordDesktopPerfRun` the in-app
 * suite uses — one writer, one schema, one trend, so the two producers cannot
 * diverge.
 */
import { defineTool } from '@papercusp/agent-mcp';
import {
  isDesktopPerfContextStamp,
  type DesktopPerfMeasure,
  type DesktopPerfMetricUnit,
  type DesktopPerfRunStatus,
} from '../../../admin-test-suites-shared';
import { recordDesktopPerfRun } from '../../../system-health/desktop-perf-runs';

const UNITS: readonly DesktopPerfMetricUnit[] = ['ms', 'kb', 'count'];
const STATUSES: readonly DesktopPerfRunStatus[] = ['pass', 'warn', 'fail'];

/** Context stamps (`host:` box, `build:` artifact) are measurement context, not
 *  evidence that a suite ran. */
export function hasDesktopPerfOutcomeMeasure(measures: readonly DesktopPerfMeasure[]): boolean {
  return measures.some((measure) => !isDesktopPerfContextStamp(measure.key));
}

/** Parse one wire measure, or null when it does not satisfy DesktopPerfMeasure.
 *  Exported for unit test only — pure, no IO. */
export function parseMeasure(raw: unknown): DesktopPerfMeasure | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const key = typeof m.key === 'string' ? m.key.trim() : '';
  if (key.length === 0 || key.length > 200) return null;
  if (typeof m.value !== 'number' || !Number.isFinite(m.value)) return null;
  const unit = m.unit as DesktopPerfMetricUnit;
  if (!UNITS.includes(unit)) return null;
  // budget is nullable BY DESIGN — an unbudgeted metric is recorded, never a
  // failure (see evaluateInteractionBudget). Absent and null mean the same here.
  const budget =
    m.budget === null || m.budget === undefined
      ? null
      : typeof m.budget === 'number' && Number.isFinite(m.budget)
        ? m.budget
        : NaN;
  if (typeof budget === 'number' && Number.isNaN(budget)) return null;
  if (typeof m.ok !== 'boolean') return null;
  // no-http-anywhere-2026-07-28 P-003c: carry the invariant flag through.
  // This parser REBUILDS the measure rather than spreading `m`, so a field that is
  // not named here is silently dropped — which for this flag would be the worst
  // possible failure mode: the run still records, still looks healthy, and the
  // breach it was meant to block on arrives at the gate as an ordinary measure.
  // Only a literal `true` counts; anything else stays undefined so a malformed
  // producer can never accidentally arm a blocking invariant.
  const invariant = m.invariant === true ? true : undefined;
  return { key, value: m.value, unit, budget, ok: m.ok, ...(invariant ? { invariant } : {}) };
}

const BUILD_SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Parse the wire `buildSha` — the identity of the BINARY that was measured
 * (desktop-perf-measure-candidate-build-2026-09-29 P-001 / D-001). Distinct from
 * `gitSha`, which names the tree the RUNNER came from: the gate attributes a run
 * to a candidate by this field, so a run whose binary identity is unknown must be
 * stored as null (unattributable), never guessed.
 *
 * Returns `null` when the producer did not send one (a legacy producer), the
 * lower-cased sha when it is a 7–64 char hex string, and `undefined` when it sent
 * something malformed — the route rejects that post rather than recording a
 * garbage identity the gate would then trust. Exported for unit test only.
 */
export function parseBuildSha(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const sha = raw.trim().toLowerCase();
  return BUILD_SHA_RE.test(sha) ? sha : undefined;
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/desktop-perf-runs',
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return new Response('body must be JSON', { status: 400 });

    const rawMeasures = Array.isArray(body.measures) ? body.measures : null;
    if (!rawMeasures) return new Response('measures must be an array', { status: 400 });
    if (rawMeasures.length > 500) {
      return new Response('measures exceeds the 500-per-run cap', { status: 400 });
    }

    const measures: DesktopPerfMeasure[] = [];
    for (const raw of rawMeasures) {
      const parsed = parseMeasure(raw);
      if (!parsed) {
        return new Response(
          'each measure must be { key:string, value:number, unit:"ms"|"kb"|"count", budget:number|null, ok:boolean }',
          { status: 400 },
        );
      }
      measures.push(parsed);
    }

    // A run that measured NOTHING is rejected rather than stored: an empty row
    // would satisfy the gate's "is there a fresh run?" check while carrying no
    // evidence — reintroducing the vacuous pass this route exists to kill.
    // (persistDesktopPerfRun applies the same rule by skipping the write.)
    if (measures.length === 0) {
      return new Response('refusing to record a run with no measures', { status: 400 });
    }
    if (!hasDesktopPerfOutcomeMeasure(measures)) {
      return new Response(
        'refusing to record a run with host context but no performance outcome',
        { status: 400 },
      );
    }

    const status: DesktopPerfRunStatus = STATUSES.includes(body.status as DesktopPerfRunStatus)
      ? (body.status as DesktopPerfRunStatus)
      : measures.every((m) => m.ok)
        ? 'pass'
        : 'fail';

    const url = new URL(req.url);
    const ws = url.searchParams.get('ws');
    const workspaceId =
      ws && ws.length > 0
        ? ws
        : typeof body.workspaceId === 'string' && body.workspaceId.length > 0
          ? body.workspaceId
          : (process.env.PAPERCUSP_WORKSPACE_ID ?? 'default');

    const gitSha =
      typeof body.gitSha === 'string' && body.gitSha.length > 0
        ? body.gitSha
        : (process.env.PAPERCUSP_GIT_SHA ?? process.env.PAPERCUSP_RELEASE_SHA ?? null);
    const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId : null;
    const buildSha = parseBuildSha(body.buildSha);
    if (buildSha === undefined) {
      return new Response('buildSha must be a 7-64 character hex string, null, or absent', { status: 400 });
    }

    const id = await recordDesktopPerfRun({
      workspaceId,
      source: 'wdio',
      status,
      measures,
      gitSha,
      buildSha,
      runId,
    });

    // The committed row is the acknowledgement boundary. Waiting on this
    // optional nudge can turn a successful insert into a route timeout and
    // encourage a duplicate publication. The trend panel also polls.
    void import('../../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('desktopPerfTrend', { workspaceId }))
      .catch(() => { /* the trend panel polls; this nudge is best-effort */ });

    return Response.json({ id, recorded: measures.length, status });
  },
});
