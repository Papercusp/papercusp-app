/**
 * Per-fire telemetry for dev:pg_query advisories.
 *
 * Plan `dry-run-for-claims-preview-a-predicate-partition-null-traps-2026-09-20`,
 * P-003 — the instrumentation that lets the plan's bet be SETTLED rather than
 * believed. Shape deliberately copied from `../bash-substitution/fires.ts`
 * (migration 720), which solved the same problem — an advisory fires at a tool
 * call site, and nothing records whether it ever did.
 *
 * Two rules here are load-bearing and easy to "simplify" away:
 *
 *  1. A fire is counted at DELIVERY, not at computation. pg_query composes every
 *     sql-shape advisory up front as a pure function of the SQL text, but the
 *     unbounded-json-search path returns early carrying only its own. Counting
 *     the computed set there would inflate exactly the number the plan's
 *     "<5 queries/week" falsifier reads, turning a too-narrow trigger into a
 *     healthy-looking one.
 *
 *  2. An absent count is NOT a zero. `countAdvisoryFires` reports a discriminated
 *     status, because "the migration has not applied yet" and "this advisory
 *     genuinely never fired" are opposite findings that a bare 0 renders
 *     identical — and the second one is a real, reportable result while the
 *     first is a broken instrument. Migration 720's own header names this trap:
 *     a counter nobody writes reads exactly like a clean bill of health.
 *
 * This module knows nothing about coord traffic or population-claim corrections,
 * and must not learn: the plan's acceptance bar requires the two signals be
 * counted INDEPENDENTLY, so that the instrument remains able to report "the
 * advisory fired constantly and nothing changed" — i.e. to condemn the advisory.
 * Joining them here would make that verdict unreachable by construction.
 */
import { getOrgPg } from '@papercusp/db-org';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/** Postgres `undefined_table` — the schema has not caught up with the code yet. */
const PG_UNDEFINED_TABLE = '42P01';

export type AdvisoryOutcome = 'success' | 'error' | 'refused';

/**
 * One labelled advisory slot: its stable kebab identity and the text it produced.
 * `null` means the builder declined to fire for this query.
 */
export type LabelledAdvisory = readonly [label: string, text: string | null];

export interface AdvisoryFireRow {
  advisoryLabel: string;
  outcome: AdvisoryOutcome;
  /** How many advisories rode in the same payload, this one included. */
  deliveredWith: number;
}

/**
 * The pure, DB-free core: which advisories actually fired in a delivered payload.
 *
 * Kept pure so the delivery-vs-computation rule above is testable without a
 * database — the rule is the whole point of the module, and a rule that can only
 * be checked through an integration fixture is a rule that stops being checked.
 */
export function firesForDelivery(
  slots: readonly LabelledAdvisory[],
  outcome: AdvisoryOutcome,
): AdvisoryFireRow[] {
  const fired = slots.filter(
    ([, text]) => typeof text === 'string' && text.trim().length > 0,
  );
  const deliveredWith = fired.length;
  return fired.map(([advisoryLabel]) => ({ advisoryLabel, outcome, deliveredWith }));
}

/**
 * Labels for dev:pg_query's delivered advisory list, IN COMPOSITION ORDER: the
 * 17 `sqlShapeAdvisories` entries first, then the four result-derived advisories
 * appended at the success composition site.
 *
 * ⚠ ORDER IS THE CONTRACT, and this is knowingly a SECOND COPY of a list the
 * code owns — which the derived-truth ladder says to avoid. It could not be
 * DERIVED: the advisories are builder functions assembled into an anonymous
 * array literal, with no registry to read, and restructuring that array would
 * mean rewriting a file another lane is actively editing. So the duplication is
 * PINNED instead (ladder rung 2): `labelDeliveredAdvisories` refuses to guess
 * when the lengths disagree, and a sibling test pins the expected count so that
 * adding an advisory fails loudly rather than silently shifting every label by
 * one position — which would misattribute every fire after the insertion point
 * while still producing a perfectly plausible report.
 */
export const SQL_SHAPE_ADVISORY_LABELS = [
  'json-text-search',
  'epoch-unit',
  'claimability',
  'backlog-flow',
  'agent-facts-supersession',
  'event-fire-window',
  'silent-null-path',
  'jsonb-typeof-negation',
  'unused-cte',
  'population-narrowing',
  // The success path substitutes the EXECUTED partition into this same slot,
  // so this label covers both forms — which is correct: they are one advisory
  // with two renderings, and splitting them would fragment the count the
  // plan's "<5 queries/week" falsifier reads.
  'non-summing-partition',
  'split-completion-evidence',
  'native-tool-attribution',
  'agent-activity-ledger',
  'adv-sessions-liveness',
  'session-turn-parts-json',
  'corpus-namespace',
] as const;

/**
 * The result-derived advisories the SUCCESS path appends after the sql-shape
 * list. They need a round trip or a row count, so a failed query never produces
 * them — which is why the error path has a different tail and its own list.
 */
export const SUCCESS_TAIL_ADVISORY_LABELS = [
  'tenant-scope',
  'positive-control-tenant',
  'positive-control',
  'tool-routing',
] as const;

/** Success-path composition order. */
export const DELIVERED_ADVISORY_LABELS: readonly string[] = [
  ...SQL_SHAPE_ADVISORY_LABELS,
  ...SUCCESS_TAIL_ADVISORY_LABELS,
];

/**
 * Error-path composition order: the same sql-shape list, then ONLY the routing
 * advisory. DERIVED from the list above rather than written out again — a third
 * hand-maintained copy is how the error path would silently start labelling
 * `toolRoutingAdvisory` as `tenant-scope`, which is exactly the misattribution
 * `labelDeliveredAdvisories` refuses to make elsewhere.
 */
export const ERROR_PATH_ADVISORY_LABELS: readonly string[] = [
  ...SQL_SHAPE_ADVISORY_LABELS,
  'tool-routing',
];

/**
 * Zip delivered advisory VALUES with their labels.
 *
 * Deliberately neither throws nor truncates on a length disagreement: that means
 * someone added an advisory without adding a label, and the honest response is
 * to record the fire as `unlabelled:<index>` rather than attribute it to
 * whichever label happens to occupy that position. A MISLABELLED fire is worse
 * than an unlabelled one — it is a wrong number that looks right, and it would
 * be read as evidence about an advisory that never fired.
 */
export function labelDeliveredAdvisories(
  values: readonly (string | null)[],
  labels: readonly string[] = DELIVERED_ADVISORY_LABELS,
): LabelledAdvisory[] {
  return values.map(
    (text, i) => [labels[i] ?? `unlabelled:${i}`, text] as LabelledAdvisory,
  );
}

/**
 * Write the fires for one delivered payload. Never throws: this sits behind a
 * caller that is already holding an agent's query result.
 *
 * Returns the number of rows written; 0 covers both "nothing fired" and "the
 * write failed", which is acceptable HERE because no decision is made on this
 * return value — unlike `countAdvisoryFires`, where the same conflation would be
 * a fabricated measurement.
 */
export async function recordAdvisoryFires(opts: {
  /**
   * Optional because the tool context's workspaceId is `string | undefined`.
   * An absent workspace means the fire cannot be ATTRIBUTED, and the column is
   * NOT NULL, so the honest response is to record nothing rather than coerce a
   * placeholder — a row under `''` would silently pool unattributable fires into
   * a phantom tenant that every per-workspace window then reports on.
   */
  workspaceId: string | undefined;
  harnessSlug?: string | null;
  sessionId?: string | null;
  fires: readonly AdvisoryFireRow[];
  client?: OrgSql;
}): Promise<number> {
  const { workspaceId, fires } = opts;
  if (!workspaceId || fires.length === 0) return 0;

  try {
    const sql = opts.client ?? getOrgPg().sql;
    const labels = fires.map((f) => f.advisoryLabel);
    // One statement via unnest rather than a row-per-insert loop: this runs on
    // the path of every advisory-bearing query in the fleet, and up to ~17
    // advisories can ride one payload.
    await sql`
      INSERT INTO harness_shared.pg_query_advisory_fires
        (workspace_id, harness_slug, advisory_label, session_id, outcome, delivered_with)
      SELECT ${workspaceId}, ${opts.harnessSlug ?? null}, label, ${opts.sessionId ?? null},
             ${fires[0].outcome}, ${fires[0].deliveredWith}
        FROM unnest(${labels}::text[]) AS label
    `;
    return fires.length;
  } catch {
    return 0;
  }
}

/**
 * Fire-and-forget wrapper for the hot path.
 *
 * Deliberately not awaited: the advisory is already computed and the agent is
 * waiting on its query result, so making them wait on a write that only we will
 * read is the wrong trade. The rejection handler is required rather than
 * decorative — an unhandled rejection in the operator process is a real crash,
 * and taking the operator down with the telemetry meant to measure an advisory
 * would be a spectacular way to fail at measuring it.
 */
export function recordAdvisoryFiresDetached(opts: {
  /** See `recordAdvisoryFires` — absent workspace records nothing, by design. */
  workspaceId: string | undefined;
  harnessSlug?: string | null;
  sessionId?: string | null;
  fires: readonly AdvisoryFireRow[];
}): void {
  void recordAdvisoryFires(opts).catch(() => undefined);
}

/**
 * The read side. `status` is in-band and must be branched on, never coerced:
 *
 *   measured          — the window was scanned; byLabel/total are real, and a
 *                       label at 0 (or absent) genuinely never fired.
 *   not-instrumented  — migration 1183 has not applied in this database. There
 *                       is no number here, and reporting one would be invention.
 *   unavailable       — the query failed for some other reason.
 */
export type AdvisoryFireCount =
  | { status: 'measured'; byLabel: Record<string, number>; total: number }
  | { status: 'not-instrumented'; reason: string }
  | { status: 'unavailable'; reason: string };

export async function countAdvisoryFires(opts: {
  workspaceId: string;
  since: Date;
  until: Date;
  client?: OrgSql;
}): Promise<AdvisoryFireCount> {
  try {
    const sql = opts.client ?? getOrgPg().sql;
    const rows = (await sql`
      SELECT advisory_label, count(*)::bigint AS n
        FROM harness_shared.pg_query_advisory_fires
       WHERE workspace_id = ${opts.workspaceId}
         AND fired_at >= ${opts.since}
         AND fired_at <  ${opts.until}
       GROUP BY advisory_label
       ORDER BY n DESC
    `) as Array<{ advisory_label: string; n: string | number }>;

    const byLabel: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n);
      byLabel[r.advisory_label] = n;
      total += n;
    }
    return { status: 'measured', byLabel, total };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === PG_UNDEFINED_TABLE) {
      return {
        status: 'not-instrumented',
        reason:
          'harness_shared.pg_query_advisory_fires does not exist — migration 1183 has not applied in this database. This is NOT a measured zero.',
      };
    }
    return { status: 'unavailable', reason: String((err as Error)?.message ?? err) };
  }
}
