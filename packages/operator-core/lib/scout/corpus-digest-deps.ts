/**
 * corpus-digest-deps.ts — the production WIRING of the state-of-Hive digest
 * readers to real sources (the change feed, the improvement queue, PG spend +
 * audit + plans).
 *
 * Mirrors curation/change-feed-deps.ts: inject minimal reader contracts so the
 * core `corpus-digest` synthesis stays pure + testable; this file wires the
 * real queries. DERIVED, not logged — every reader queries a completion / audit
 * SOURCE, so the digest regenerates from the live corpus each tick.
 *
 * Reuse over rebuild (CLAUDE.md): completions come from the existing change feed
 * (gatherCompletions), friction from the existing improvement loader
 * (readImprovementItems). Only the spend / reverts / deferrals readers are new
 * PG queries, and even those hit established tables (agent_usage_samples,
 * feature_audit_consolidated, harness_plans).
 *
 * Schema notes (verified live against :5432, 2026-06-08):
 *  - agent_usage_samples: cost_usd double, input/output_tokens bigint(as string),
 *    harness_slug/role nullable, ts bigint epoch-ms (migrations 161/170).
 *  - feature_audit_consolidated: field/old_value/new_value/actor text, ts bigint;
 *    status values are JSON-quoted strings ("passed") in the text columns —
 *    unquoted here before the core ranks them (migration 118).
 *  - harness_plans.items / .decisions: jsonb arrays of parsed plan items /
 *    decisions (migration 128); items carry {id,text,status}, decisions {id,title,body}.
 */

import { getOrgPg } from '@papercusp/db-org';
import { gatherCompletions, type ChangeFeedEntry } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import { readImprovementItems, readObservationItems } from '../harness/improvements/read-items';
import type { SignalOrigin } from '../harness/improvements/provenance';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { getRubric, listRubrics } from '../rubrics';
import { activeWorkspaceId } from '../workspace-registry';
import {
  revertWeight,
  type DeferralRecord,
  type ObservationRating,
  type RevertRecord,
  type RubricSummary,
  type SpendRecord,
  type StateOfHiveReaders,
  type StructuredObservationRecord,
} from './corpus-digest';

const DAY_MS = 24 * 60 * 60 * 1000;
const SPEND_WINDOW_MS = 7 * DAY_MS;

/** ISO timestamp from an epoch-ms bigint column (postgres-js returns bigint as string). */
function epochMsToIso(v: string | number | null): string {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return new Date(Number.isFinite(n) ? n : 0).toISOString();
}

/** Strip the JSON quoting a status carries in feature_audit's text columns
 *  ("passed" → passed). Tolerates already-unquoted values + nulls. */
function unquoteStatus(v: string | null): string {
  if (!v) return '';
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Reverts: status regressions from feature_audit (undone work). Pulls recent
 *  status transitions; the core's revertWeight decides which are regressions. */
async function fetchReverts(): Promise<RevertRecord[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    { feature_id: string; harness_slug: string | null; old_value: string | null; new_value: string | null; actor: string | null; ts: string; deprecation_reason: string | null }[]
  >`
    SELECT a.feature_id, a.harness_slug, a.old_value, a.new_value,
           a.actor, a.ts,
           CASE WHEN a.new_value = '"deprecated"' THEN f.deprecation_reason
                ELSE NULL END AS deprecation_reason
      FROM harness_shared.feature_audit_consolidated a
      LEFT JOIN harness_shared.harness_features_consolidated f
        ON f.workspace_id = a.workspace_id
       AND f.harness_slug = a.harness_slug
       AND f.feature_id = a.feature_id
     WHERE a.field = 'status'
       AND a.old_value IS NOT NULL
       AND a.new_value IS NOT NULL
     ORDER BY a.ts DESC
     LIMIT 2000`;

  return rows
    .map((r) => ({
      workItemId: r.feature_id,
      harness: r.harness_slug ?? undefined,
      from: unquoteStatus(r.old_value),
      to: unquoteStatus(r.new_value),
      actor: r.actor,
      ts: epochMsToIso(r.ts),
      reason: r.deprecation_reason,
    }))
    // Keep only genuine regressions — the core ranks; here we shrink the payload.
    .filter((r) => revertWeight(r.from, r.to) > 0);
}

/** Spend buckets: agent_usage_samples rolled up by (harness, role) — where
 *  time/tokens went. Keep the current-state read tenant-scoped and bounded to
 *  the trailing seven days. */
/**
 * Minimum reports before a canonical counts as RECURRING. Matches
 * RECURRENCE_ESCALATION_THRESHOLD (3) so "recurring" means the same thing on both
 * recurrence paths rather than drifting into two different definitions.
 */
const RECURRING_FLOW_MIN = 3;
/**
 * Bound on the ledger-keyed read, taken count-DESC so the strongest evidence is what
 * survives the bound. Sized against the measured population (618 canonicals at >=3 on
 * the observation lane, 840 on the improvement topic), and comparable to the two
 * `limit ?? 500` reads it rides beside — this widens the mining set by roughly a
 * third, it does not multiply it.
 *
 * ⚠ THIS BOUND IS LOAD-BEARING FOR A BOUND IT DOES NOT OWN. The mining set feeds
 * `findLikelyDuplicates`, whose near-dup leg is O(n²) and — measured in
 * EI-19393516222436864 — SILENTLY SKIPS itself above 4,000 candidates while still
 * reporting full coverage. Raising this cap therefore does not merely cost CPU: past
 * that threshold it would turn the near-dup leg off with no error, degrading the very
 * clustering this read exists to feed. Measured after this change: 1,482 mined
 * (~1,000 window + ~482 ledger), so the headroom is real but finite. If you raise this,
 * check the TOTAL against that 4,000 gate first — do not reason about this number alone.
 */
const RECURRING_FLOW_MAX_IDS = 500;

/**
 * Canonical ids that RECUR according to the occurrence ledger, newest-agnostic.
 *
 * Deliberately id-only: it answers "which rows are worth mining" without loading a
 * single row, so the expensive candidate read stays bounded by the id set rather than
 * scanning the corpus. Never throws into the digest — an unavailable ledger degrades
 * to the recency window alone, which is exactly today's behaviour.
 */
async function fetchRecurringCanonicalIds(workspaceId: string): Promise<string[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: string }[]>`
      SELECT canonical_work_item_id AS id
        FROM harness_shared.work_item_occurrences
       WHERE workspace_id = ${workspaceId}
       GROUP BY 1
      HAVING count(*) >= ${RECURRING_FLOW_MIN}
       ORDER BY count(*) DESC
       LIMIT ${RECURRING_FLOW_MAX_IDS}`;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

async function fetchSpend(opts: { workspaceId?: string; nowMs?: number } = {}): Promise<SpendRecord[]> {
  const { sql } = getOrgPg();
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const nowMs = opts.nowMs ?? Date.now();
  const windowStartMs = nowMs - SPEND_WINDOW_MS;
  const rows = await sql<
    { harness_slug: string | null; role: string | null; cost: string | null; input: string | null; output: string | null; runs: string }[]
  >`
    SELECT harness_slug,
           role,
           COALESCE(SUM(cost_usd), 0)       AS cost,
           COALESCE(SUM(input_tokens), 0)   AS input,
           COALESCE(SUM(output_tokens), 0)  AS output,
           COUNT(*)                          AS runs
      FROM harness_shared.agent_usage_samples
     WHERE workspace_id = ${workspaceId}
       AND ts >= ${windowStartMs}
       AND ts <= ${nowMs}
     GROUP BY harness_slug, role
     ORDER BY cost DESC NULLS LAST
     LIMIT 200`;

  return rows.map((r) => ({
    harness: r.harness_slug,
    role: r.role,
    costUsd: Number(r.cost ?? 0),
    inputTokens: Number(r.input ?? 0),
    outputTokens: Number(r.output ?? 0),
    runs: Number(r.runs ?? 0),
  }));
}

/** Deferrals: explicit plan-item punts (status blocked/needs-human) + decisions
 *  marked deferred. A normal dependency-blocked todo is NOT here (only explicit
 *  status). jsonb arrays guarded with COALESCE so a null column never errors. */
async function fetchDeferrals(): Promise<DeferralRecord[]> {
  const { sql } = getOrgPg();

  const items = await sql<
    { plan_slug: string; ref_id: string | null; status: string | null; text: string | null }[]
  >`
    SELECT p.plan_slug,
           i->>'id'     AS ref_id,
           i->>'status' AS status,
           i->>'text'   AS text
      FROM harness_shared.harness_plans p,
           jsonb_array_elements(COALESCE(p.items, '[]'::jsonb)) AS i
     WHERE i->>'status' IN ('blocked', 'needs-human')
     LIMIT 1000`;

  const decisions = await sql<
    { plan_slug: string; ref_id: string | null; title: string | null }[]
  >`
    SELECT p.plan_slug,
           d->>'id'    AS ref_id,
           d->>'title' AS title
      FROM harness_shared.harness_plans p,
           jsonb_array_elements(COALESCE(p.decisions, '[]'::jsonb)) AS d
     WHERE d->>'body' ~* '\\mdeferr'
     LIMIT 1000`;

  const out: DeferralRecord[] = [];
  for (const r of items) {
    if (!r.ref_id || !r.text) continue;
    out.push({ planSlug: r.plan_slug, refId: r.ref_id, source: 'item', status: r.status ?? 'blocked', text: r.text });
  }
  for (const r of decisions) {
    if (!r.ref_id || !r.title) continue;
    out.push({ planSlug: r.plan_slug, refId: r.ref_id, source: 'decision', status: 'decision', text: r.title });
  }
  return out;
}

/**
 * The structured-observation view P-001 (rubric-driven-observations D-003) surfaces
 * onto `ImprovementCandidate.observation`. Read STRUCTURALLY (not via the typed
 * field) so this module compiles + runs (yielding an empty rubric lane) BEFORE the
 * P-001 type edit lands, and auto-activates the instant it surfaces the field — the
 * "build against the draft contract" seam su-f8ee5 (P-001 owner) agreed. Once
 * `ImprovementCandidate.observation` is in-tree this cast can collapse to `c.observation`.
 */
interface ObservationView {
  sourceHive?: unknown;
  targetHive?: unknown;
  rubricRef?: unknown;
  ratings?: unknown;
}

function observationViewOf(c: ImprovementCandidate): ObservationView | undefined {
  const v = (c as { observation?: unknown }).observation;
  return v && typeof v === 'object' ? (v as ObservationView) : undefined;
}

/** Validate the `Record<criterionKey, { rating, evidence }>` ratings shape (D-003),
 *  dropping malformed entries. Returns undefined when nothing valid remains. */
function normalizeObservationRatings(raw: unknown): Record<string, ObservationRating> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, ObservationRating> = {};
  for (const [criterion, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!criterion || !val || typeof val !== 'object') continue;
    const { rating, evidence, suggestion } = val as {
      rating?: unknown;
      evidence?: unknown;
      suggestion?: unknown;
    };
    if (typeof rating !== 'string' || !rating.trim()) continue;
    out[criterion] = {
      rating,
      evidence: typeof evidence === 'string' ? evidence : '',
      // P-005 (blender-self-learning-2026-07-12): the grader's improvement idea
      // rides through to the rubric-rating pattern detail.
      ...(typeof suggestion === 'string' && suggestion.trim() ? { suggestion } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map an observation candidate → the clean StructuredObservationRecord the digest
 *  groups over. Returns undefined for FREE-TEXT observations (no rubricRef/ratings) —
 *  only RUBRIC-GRADED scorecards become records. The pure digest excludes those
 *  scorecard-shaped observations from friction mining so routine scorecard emitters
 *  do not dominate recurringFriction. */
function toStructuredObservation(c: ImprovementCandidate): StructuredObservationRecord | undefined {
  const view = observationViewOf(c);
  if (!view) return undefined;
  const rubricRef = typeof view.rubricRef === 'string' && view.rubricRef.trim() ? view.rubricRef : undefined;
  const ratings = normalizeObservationRatings(view.ratings);
  if (!rubricRef || !ratings) return undefined; // not a rubric-graded observation
  const sourceHive = typeof view.sourceHive === 'string' && view.sourceHive.trim() ? view.sourceHive : undefined;
  const targetHive = typeof view.targetHive === 'string' && view.targetHive.trim() ? view.targetHive : undefined;
  const tsMs = Date.parse(c.updatedAt ?? c.createdAt ?? '');
  return {
    id: c.id,
    title: c.title,
    rubricRef,
    ratings,
    ...(sourceHive ? { sourceHive } : {}),
    ...(targetHive ? { targetHive } : {}),
    ...(Number.isFinite(tsMs) ? { lastSeenMs: tsMs } : {}),
  };
}

/** Options for {@link buildStateOfHiveReaders}. */
export interface BuildStateOfHiveReadersOptions {
  /** Workspace whose spend rows feed this digest; defaults to the active workspace. */
  workspaceId?: string;
  /** Digest clock used for the spend lookback bounds; defaults to the current time. */
  nowMs?: number;
  /**
   * Signal origins the STRUCTURED-observation (rubricRatings) lane surfaces. Omitted
   * ⇒ readObservationItems's own default (ORGANIC_ONLY) — synthetic rows
   * (drill/replay/shadow) stay OUT of the organic learner, the standing invariant.
   *
   * A DRILL tick (blender-self-learning-2026-07-12 P-013) passes e.g.
   * `['organic','drill']` to surface a vaccination-planted `origin:drill` scorecard
   * so the rubric-seeding → grounded-idea loop can be exercised as a repeatable
   * health check WITHOUT the drill signal contaminating organic learning. Only the
   * dedicated rubricRatings reader is widened; `friction()` (a free-text organic
   * learner) stays organic-only, so drill rows never leak into that lane.
   */
  observationOrigins?: readonly SignalOrigin[];
}

/**
 * Build the production StateOfHiveReaders. The core's synthesizeStateOfHive
 * wraps each reader defensively, so one bad query doesn't kill the whole digest.
 */
export function buildStateOfHiveReaders(opts: BuildStateOfHiveReadersOptions = {}): StateOfHiveReaders {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const nowMs = opts.nowMs ?? Date.now();
  return {
    async completions(): Promise<ChangeFeedEntry[]> {
      return gatherCompletions(buildChangeFeedReaders());
    },
    async reverts() {
      return fetchReverts();
    },
    async friction(): Promise<ImprovementCandidate[]> {
      // Observations (turn-end-reflection-observations-2026-06-14 D-005) are PRE-IDEA
      // friction signals whose SOLE consumer is Scout. Union them into the friction
      // lane so a RECURRING observation gets clustered into a meta-pattern and can be
      // promoted to a real idea — the only path from observation → work. The pure
      // digest filters rubric-graded scorecards out of free-text friction mining;
      // those have the dedicated rubricRatings lane.
      // Both default reads are `limit ?? 500` — the NEWEST 500 of each, which is a
      // RECENCY WINDOW, not a set (the defect class WI-1216687 named for the sibling
      // recurrence path: "a caller that wants a SET and reads the newest N gets a
      // recency window"). Recurrence is precisely what that window cannot show,
      // because a row accrues repeats over TIME and ages out of the newest-N before it
      // becomes interesting. Measured 2026-09-06: inside the window the largest flow is
      // 4, while the corpus holds 618 canonicals at >=3 and one at 364.
      //
      // So union a third read keyed on the OCCURRENCE LEDGER — the rows that actually
      // recur, fetched by id regardless of age. Without this, flow-counting is nearly a
      // no-op in production: it would re-rank 36 low-flow rows and still never see the
      // 79x/63x/61x agent friction this exists to surface (EI-20587312505064997).
      const recurringIds = await fetchRecurringCanonicalIds(workspaceId);
      const byId = recurringIds.length
        ? { issueIds: recurringIds, limit: recurringIds.length }
        : undefined;
      const [improvements, observations, recurringImprovements, recurringObservations] =
        await Promise.all([
          readImprovementItems(),
          readObservationItems(),
          byId ? readImprovementItems(byId) : Promise.resolve([]),
          byId ? readObservationItems(byId) : Promise.resolve([]),
        ]);
      // Dedupe: a recurring row already inside the recency window would otherwise be
      // mined twice and double its own apparent stock count.
      const seen = new Set<string>();
      const out: ImprovementCandidate[] = [];
      for (const c of [...improvements, ...observations, ...recurringImprovements, ...recurringObservations]) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
      return out;
    },
    async spend() {
      return fetchSpend({ workspaceId, nowMs });
    },
    async deferrals() {
      return fetchDeferrals();
    },
    async observations(): Promise<StructuredObservationRecord[]> {
      // Read the observation-lane topic and keep ONLY rubric-graded scorecards
      // (P-006). An independent read from friction()'s free-text union — a single
      // cheap topic query at Scout cadence — so the structured lane stays defensively
      // isolated. Empty until P-001 surfaces candidate.observation + a rubric is in use.
      // A drill tick widens `observationOrigins` to surface origin:drill scorecards
      // (P-013); default (undefined) keeps readObservationItems's ORGANIC_ONLY floor.
      const observations = await readObservationItems(
        opts.observationOrigins ? { origins: opts.observationOrigins } : {},
      );
      // D-004 (observation-lane-scorecard-classification-2026-08-16): drop ONE-SHOT
      // ACCEPTANCE scorecards from the recurring-scorecard corpus. An acceptance
      // scorecard is a plan's definition-of-done verdict, graded once and retired
      // with its plan — folding it into rubric TRENDS pollutes a series meant for
      // recurring health measurements. Kind is resolved per distinct rubricRef via
      // getRubric (an explicit id resolves ANY kind, plan D-010) and cached for the
      // call; a rubricRef that no longer resolves is RETAINED (status quo — not
      // proven acceptance), and a resolver fault fails open for the same reason.
      const rubricKindCache = new Map<string, string | null>();
      const out: StructuredObservationRecord[] = [];
      for (const c of observations) {
        const record = toStructuredObservation(c);
        if (!record) continue;
        const ref = record.rubricRef;
        if (typeof ref === 'string' && ref) {
          let kind = rubricKindCache.get(ref);
          if (kind === undefined) {
            kind = (await getRubric(ref).catch(() => null))?.kind ?? null;
            rubricKindCache.set(ref, kind);
          }
          if (kind === 'acceptance') continue;
        }
        out.push(record);
      }
      return out;
    },
    async rubrics(): Promise<RubricSummary[]> {
      // ACTIVE rubrics only (P-008) — a proposed/retired rubric is not yet a
      // shared standard that "covers" a friction cluster. listRubrics reads the
      // canonical rubric source (P-006 plans∪table union; plans-only after P-007),
      // so this survives the P-007 table drop with no change here. Map the full
      // Rubric → the minimal coverage view the gap-check needs.
      const rubrics = await listRubrics({ status: 'active', limit: 500 });
      return rubrics.map((r) => ({
        rubricId: r.rubricId,
        characteristic: r.characteristic,
        title: r.title,
        criteriaTitles: r.criteria.map((c) => c.title),
      }));
    },
    async occurrences(ids: readonly string[]): Promise<ReadonlyMap<string, number>> {
      // EI-20587312505064997 — how many times each candidate was actually REPORTED.
      //
      // Scoped to the ids being mined, never the corpus: this is one indexed GROUP BY
      // over ~10³ ids, not a scan of the 114k-row ledger. `canonical_work_item_id` is
      // the canonical the report was attributed to, so one row per report is exactly
      // the flow count — the repetition dedup removed from `work_items`.
      if (ids.length === 0) return new Map();
      const { sql } = getOrgPg();
      const rows = await sql<{ id: string; n: string }[]>`
        SELECT canonical_work_item_id AS id, count(*)::text AS n
          FROM harness_shared.work_item_occurrences
         WHERE workspace_id = ${workspaceId}
           AND canonical_work_item_id = ANY(${ids as string[]}::text[])
         GROUP BY 1`;
      // count(*) arrives as text to dodge the bigint→JS coercion; a NaN here would
      // poison Math.max and rank a real recurrence as a singleton, so drop unparseable
      // rows rather than letting one become a silent zero.
      const out = new Map<string, number>();
      for (const row of rows) {
        const n = Number.parseInt(row.n, 10);
        if (Number.isFinite(n) && n > 0) out.set(row.id, n);
      }
      return out;
    },
  };
}
