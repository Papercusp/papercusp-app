/**
 * PRE-FLIGHT THE INTERPRETABILITY RATCHET AT THE MOMENT OF THE CLOSE
 * (EI-18850142725126359 fix #4).
 *
 * ── THE FAILURE THIS EXISTS TO MOVE ──────────────────────────────────────────
 *
 * `lint:plane-ratchet` is a green-checkpoint leg that reads LIVE Postgres — the
 * measurement series AND `work_items.status`. {@link judgeKnownGap} withdraws a
 * metric's exemption the moment its METRIC_KNOWN_GAPS item closes. So a close is
 * a fleet-gate mutation: at 2026-07-28T01:26Z closing WI-6465 red the very next
 * checkpoint (01:28:57Z) and held `main` 63 commits behind.
 *
 * The damage is not the red — the red is CORRECT, and weakening it is the one
 * "fix" that must never happen. The damage is WHO receives it and WHEN. The
 * failure is candidate-INDEPENDENT: every candidate reds identically, no commit
 * caused it and no commit can green it, and the release-fixer who gets dispatched
 * is handed a SHA that is causally irrelevant. Three minutes and one dispatch
 * separate the agent who caused the failure from the agent who has to diagnose it,
 * and the obvious-looking fixes available to the second one (quarantine the leg,
 * edit METRIC_KNOWN_GAPS, relabel the metric) are all destructive.
 *
 * So: tell the agent who is ABOUT to cause it, at the moment they cause it, while
 * the two legitimate exits are still cheap.
 *
 * ── ⚠ WHY THIS WARNS RATHER THAN REFUSES ────────────────────────────────────
 *
 * The tempting version blocks the close. It must not, and the reason is
 * PROVENANCE, not politeness: this runs inside a live operator process, so the
 * METRIC_KNOWN_GAPS it consults is the copy THAT PROCESS was started with — the
 * DEPLOYED map. The gate will judge the CANDIDATE's map. Those differ for exactly
 * as long as a map change is in flight, which is precisely the window in which an
 * agent legitimately retires or repoints an exemption and then closes its item.
 *
 * That happened, deliberately and correctly, on WI-6545: the retirement removed
 * the metric from the map, `lint:plane-ratchet` was verified green against the
 * change, and the close landed only once `dev:pipeline_position` confirmed the
 * judged candidate carried it. A refusal keyed on the deployed map would have
 * blocked that correct close with no override until a deploy — blocking a right
 * action on data known to be stale, which is worse than not checking at all.
 *
 * The asymmetry is what makes warn-only sound: a stale map can only make this
 * check FIRE when the gate would in fact pass (a false alarm the caller can
 * dismiss in one read). It cannot go quiet on a close that will red the gate,
 * because the deployed map is never AHEAD of the candidate's. So the warning is
 * conservative in the safe direction, and it discloses which map it used.
 *
 * ── ⚠ ITS OWN VACUOUS PASS ──────────────────────────────────────────────────
 *
 * (agent-state-plane-verification-2026-07-27: every probe declares the condition
 * under which it passes while checking nothing.)
 *
 * An EMPTY series makes every metric judge `no-data`, `judgeKnownGap` returns
 * `not-applicable`, no verdict is `fails`, and a naive delta reports SAFE for a
 * close that is about to red the gate the moment the sweep writes its next row.
 * Same for a non-empty series in which THIS metric has no windows. Both are
 * reported as {@link PlaneClosePreflight.unjudgeable} — "we could not look",
 * never "we looked and it is fine".
 *
 * ── ⚠ AND WHY IT IS A DELTA, NOT AN ABSOLUTE ────────────────────────────────
 *
 * It reports only the failures THIS close ADDS. A gate already red for an
 * unrelated regression must not be attributed to the next agent who closes
 * anything — misattributing a candidate-independent failure is the entire defect
 * this item filed, and re-committing it inside the fix would be building the trap
 * twice knowing what it is.
 */
import {
  METRIC_KNOWN_GAPS,
  ratchetPlaneSeries,
  type MetricWindow,
  type RatchetRow,
} from './agent-plane-ratchet';
import { METRIC_SPECS, type PlaneMetricId } from './agent-plane-measurement';
import { activeWorkspaceId } from './workspace-registry';

/** One window of the series, as the ratchet consumes it. */
export type PlaneSeriesPoint = {
  measuredAt: string;
  metrics: ReadonlyArray<{ id: string } & MetricWindow>;
};

/**
 * metric → the work-item that excuses its blindness. Defaults to the shipped
 * {@link METRIC_KNOWN_GAPS}; INJECTABLE for the same reason `ratchetPlaneSeries`
 * takes `specs` — the live map legitimately empties as its gaps get built, and a
 * suite whose cases are keyed off it would then pass while asserting nothing. The
 * behaviour must stay testable against a literal map after the real one is empty.
 */
export type PlaneGapMap = Readonly<Partial<Record<PlaneMetricId, string>>>;

export interface PlaneCloseImpact {
  metric: PlaneMetricId;
  /** The gap item whose exemption the close withdraws. */
  knownGap: string;
  /** The metric's ratchet verdict as the series currently reads it. */
  verdict: RatchetRow['verdict'];
}

export interface PlaneClosePreflight {
  /**
   * `not-a-gap-item` — no id being closed appears in METRIC_KNOWN_GAPS. The
   *   overwhelmingly common case, and the one that must cost nothing.
   * `reds-the-gate` — at least one metric loses its exemption and then FAILS.
   * `unjudgeable`   — a gap item is closing but the series cannot answer (see
   *   the vacuous-pass note in the header). NOT a pass.
   * `safe`          — a gap item is closing and every metric it excused is
   *   holding, so the exemption is genuinely spent.
   */
  outcome: 'not-a-gap-item' | 'reds-the-gate' | 'unjudgeable' | 'safe';
  /** Of the ids asked about, those that carry a ratchet exemption. */
  gapItems: string[];
  /** Failures this close ADDS to the gate (see the delta note in the header). */
  causes: PlaneCloseImpact[];
  /** Gap metrics the series cannot judge — reported, never counted as safe. */
  unjudgeable: PlaneCloseImpact[];
  /** Already failing before this close. Reported so it is never blamed on the caller. */
  preExisting: PlaneMetricId[];
}

/**
 * Does closing this id touch the ratchet at all?
 *
 * THE CHEAPNESS GUARD, and the reason this can sit on the hot completion path: a
 * frozen-object value scan over a map that holds ONE entry today. Every close of
 * every other work-item in the fleet pays exactly this and no I/O. The database
 * is read only once an id has already matched.
 */
export function isPlaneGapItem(id: string, gaps: PlaneGapMap = METRIC_KNOWN_GAPS): boolean {
  const needle = id.trim();
  if (!needle) return false;
  for (const ref of Object.values(gaps)) {
    if (ref === needle) return true;
  }
  return false;
}

/** Every work-item id that currently grants a ratchet exemption. */
export function planeGapItemIds(gaps: PlaneGapMap = METRIC_KNOWN_GAPS): string[] {
  return [...new Set(Object.values(gaps))].filter((r): r is string => Boolean(r));
}

/**
 * Of these ids, the distinct ones that carry an exemption.
 *
 * ⚠ EXISTS TO MAKE ONE SPECIFIC BUG UNWRITABLE. `isPlaneGapItem` takes an optional
 * SECOND parameter, so passing it straight to `Array.prototype.filter` hands the
 * element INDEX in as the gap map — `Object.values(0)` is `[]`, every id then
 * matches nothing, and the whole pre-flight silently degrades to a no-op that
 * reports `not-a-gap-item` for the one item it exists to catch. It is a green,
 * fully-passing, completely inert guard; only `tsc` noticed. Route every
 * many-ids selection through here so there is one call site to get right.
 */
export function selectPlaneGapItems(
  ids: readonly string[],
  gaps: PlaneGapMap = METRIC_KNOWN_GAPS,
): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => isPlaneGapItem(id, gaps)))];
}

/**
 * Judge what closing `closingIds` does to the ratchet.
 *
 * PURE ({ series, closedGaps, closingIds } -> verdict), like every other
 * judgement in this plane — so the states that matter (a gap metric still blind,
 * a gap metric that started holding, an empty series) are testable against
 * literal arrays rather than only against whatever a live box happens to be in.
 */
export function preflightPlaneClose(args: {
  closingIds: readonly string[];
  series: readonly PlaneSeriesPoint[];
  /** Gap items ALREADY closed, so the baseline reflects the real current gate. */
  closedGaps?: ReadonlySet<string>;
  specs?: Readonly<Partial<Record<PlaneMetricId, { interpretableOnlyWith?: readonly PlaneMetricId[] }>>>;
  gaps?: PlaneGapMap;
}): PlaneClosePreflight {
  const { series, closedGaps = new Set<string>(), specs = METRIC_SPECS, gaps = METRIC_KNOWN_GAPS } = args;
  const gapItems = selectPlaneGapItems(args.closingIds, gaps);

  if (gapItems.length === 0) {
    return { outcome: 'not-a-gap-item', gapItems: [], causes: [], unjudgeable: [], preExisting: [] };
  }

  // ⚠ A gap item ALREADY marked closed contributes nothing to the delta (the
  // baseline already carries its failure), which would report a re-close of a
  // still-blind metric as `safe`. Judge the baseline as if these ids were open,
  // so the verdict answers "does this item being closed red the gate" rather
  // than "does closing it again change anything".
  const baselineClosed = new Set([...closedGaps].filter((ref) => !gapItems.includes(ref)));
  const afterClosed = new Set([...baselineClosed, ...gapItems]);

  const before = ratchetPlaneSeries({ series: series as PlaneSeriesPoint[], closedGaps: baselineClosed, specs, gaps });
  const after = ratchetPlaneSeries({ series: series as PlaneSeriesPoint[], closedGaps: afterClosed, specs, gaps });

  const failingBefore = new Set(before.failures.map((f) => f.metric));
  const causes: PlaneCloseImpact[] = after.failures
    .filter((f) => !failingBefore.has(f.metric) && f.knownGap && gapItems.includes(f.knownGap))
    .map((f) => ({ metric: f.metric, knownGap: f.knownGap!, verdict: f.verdict }));

  // The vacuous pass, made explicit: a gap metric the series cannot speak to.
  // `no-data` is the shape an empty series takes AND the shape a metric with no
  // windows of its own takes, and neither is evidence that the exemption is spent.
  const unjudgeable: PlaneCloseImpact[] = after.rows
    .filter((r) => r.verdict === 'no-data' && r.knownGap && gapItems.includes(r.knownGap))
    .map((r) => ({ metric: r.metric, knownGap: r.knownGap!, verdict: r.verdict }));

  return {
    outcome: causes.length > 0 ? 'reds-the-gate' : unjudgeable.length > 0 ? 'unjudgeable' : 'safe',
    gapItems,
    causes,
    unjudgeable,
    preExisting: [...failingBefore],
  };
}

/**
 * The caller-facing warning. Separated from the judgement so the wording is
 * unit-testable and so both close paths (`work_items:complete`,
 * `work_items:set_state`) say exactly the same thing — a guard that phrases
 * itself differently per call site is how one of them quietly drifts into
 * uselessness.
 *
 * Returns undefined when there is nothing to say.
 */
export function renderPlaneClosePreflightWarning(v: PlaneClosePreflight): string | undefined {
  if (v.outcome === 'not-a-gap-item' || v.outcome === 'safe') return undefined;

  const rows = v.outcome === 'reds-the-gate' ? v.causes : v.unjudgeable;
  // Attribute the metric to its gap item only when there is more than one item in
  // play — on the single close (every real call today) "Closing WI-6548 … exempted
  // by WI-6548" is noise in the first sentence, which is the sentence that has to land.
  const list = rows
    .map((r) => (v.gapItems.length > 1 ? `${r.metric} (exempted by ${r.knownGap})` : r.metric))
    .join(', ');

  const head =
    v.outcome === 'reds-the-gate'
      ? `⚠ THIS CLOSE WILL RED THE FLEET RELEASE GATE. Closing ${v.gapItems.join(', ')} withdraws the ` +
        `interpretability exemption for ${list}, and ${rows.length === 1 ? 'that metric is' : 'those metrics are'} ` +
        `still blind — so the next green-checkpoint leg (lint:plane-ratchet) fails.`
      : `⚠ THIS CLOSE MAY RED THE FLEET RELEASE GATE, and the check could not rule it out. Closing ` +
        `${v.gapItems.join(', ')} withdraws the interpretability exemption for ${list}, and the measurement ` +
        `series has no window to judge ${rows.length === 1 ? 'it' : 'them'} by — that is "we could not look", ` +
        `NOT "it is fine".`;

  return (
    `${head}\n` +
    // The half that cost a peer real diagnosis time. State it before the remedies.
    `That failure is INDEPENDENT of any commit: every release candidate reds identically, no code change ` +
    `can green it, and the release-fixer who gets dispatched is handed a SHA that is causally irrelevant ` +
    `(EI-18850142725126359). It also blocks main for the whole fleet, not just you.\n` +
    `TWO legitimate exits, and editing METRIC_KNOWN_GAPS to green a live gate is NOT one of them:\n` +
    `  (1) make the producer emit, so the metric reads interpretable before you close; or\n` +
    `  (2) land the change that RETIRES or REPOINTS the exemption FIRST, and close only once the JUDGED ` +
    `CANDIDATE carries it — verify with dev:pipeline_position { path: ` +
    `'packages/operator-core/lib/agent-plane-ratchet.ts', marker: '<a literal string from your edit>' }, ` +
    `not against your working tree. A fix green on staging does not protect the close.\n` +
    `If you close anyway, say so on the item and reopen it the moment the gate reds — reopening a gap item ` +
    `is the SANCTIONED exit, not gate-weakening.\n` +
    `⚠ PROVENANCE: this check used the METRIC_KNOWN_GAPS compiled into the running operator (the DEPLOYED ` +
    `map), while the gate judges the candidate's. If your in-flight change already removed this exemption, ` +
    `this warning is a false alarm — confirm with \`npm run --silent lint:plane-ratchet\` plus the ` +
    `pipeline_position marker above, and proceed.` +
    (v.preExisting.length > 0
      ? `\nFYI the ratchet is ALREADY failing on ${v.preExisting.join(', ')}, which is not attributable to this close.`
      : '')
  );
}

/**
 * Statuses that mean a gap item is CLOSED and its exemption withdrawn.
 *
 * ⚠ Must stay identical to `scripts/check-plane-ratchet.ts`'s copy: the whole
 * value of this pre-flight is that it predicts what THAT script will decide, so
 * a divergence here does not make the check wrong in an obvious way — it makes it
 * confidently wrong. The unified enum folds the legacy tokens onto done/dropped,
 * but rows written before the fold still carry the originals.
 */
export const PLANE_GAP_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'dropped',
  'resolved',
  'closed',
  'passed',
  'deprecated',
]);

/**
 * The live half: read the same series and the same work-item statuses the gate
 * reads, then judge. Returns `null` when nothing was worth reading (no id being
 * closed carries an exemption) — the caller does no work in the common case.
 *
 * ⚠ Scoped by `workspace_id` ONLY, with no harness filter, because that is
 * exactly what check-plane-ratchet.ts does. Adding a harness filter here would
 * read a NARROWER series than the gate judges and could report `safe` for a close
 * the gate then fails on. Match the oracle, do not improve on it.
 */
export async function preflightPlaneCloseLive(args: {
  closingIds: readonly string[];
  /** Defaults to the active workspace — a caller's `ctx.workspaceId` is optional. */
  workspaceId?: string;
}): Promise<PlaneClosePreflight | null> {
  if (selectPlaneGapItems(args.closingIds).length === 0) return null;

  const workspaceId = args.workspaceId ?? activeWorkspaceId();
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;

  const rows = await sql<Array<{ measured_at: string; metrics: unknown }>>`
    SELECT measured_at::text AS measured_at, metrics
      FROM harness_shared.agent_plane_measurements
     WHERE workspace_id = ${workspaceId}
     ORDER BY agent_plane_measurements.measured_at ASC
  `;
  const series: PlaneSeriesPoint[] = rows.map((r) => ({
    measuredAt: r.measured_at,
    metrics: (Array.isArray(r.metrics) ? r.metrics : []) as PlaneSeriesPoint['metrics'],
  }));

  // The baseline: which exemptions are ALREADY spent, so a gate that is red for
  // someone else's reason is never charged to this caller.
  const refs = planeGapItemIds();
  const items = refs.length
    ? await sql<Array<{ feature_id: string; status: string }>>`
        SELECT feature_id, status
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${refs})
      `
    : [];
  const closedGaps = new Set(
    items.filter((i) => PLANE_GAP_TERMINAL_STATUSES.has(i.status)).map((i) => i.feature_id),
  );

  return preflightPlaneClose({ closingIds: args.closingIds, series, closedGaps });
}
