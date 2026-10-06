/**
 * agent-economy-flywheel P-003 (E1, WI-10004287): the Postgres half of shadow metering.
 *
 * Reads one workspace-month of identity-attributed activity and hands it to the pure pricing
 * module (`shadow-metering.ts`). Nothing here writes or bills.
 *
 * Sources (all read-only):
 * - `agent_usage_samples_identity_attribution` (migrations 1149/1177/1275): inference samples
 *   with the identity span active at sample time. 1275 made a month of it answerable; before
 *   that one hour exceeded 30s (WI-10004451).
 * - `session_identity_activation_events` -> `adv_sessions.launch_spec`: the launch profile and
 *   the specification artifact's blueprint-layer inputs. A layer counts only when its document
 *   fills an identity slot, and is reported slot-qualified (`domain:papercusp-engineer`). Layers
 *   are read only from the artifact of the SAME specification revision the span applied: the
 *   launch record's current artifact, or — once the record has moved on — the matching entry of
 *   its `identityHistory` (WI-10004494). The event's own `specification_layer_refs` stamp
 *   (migration 1295, taken at record time) wins over that lookup, because the record churns its
 *   revision per relaunch and evicts history past 12. With none, the row keeps its profile but no layers,
 *   which prices it as `inferred-profile` (never bill-grade) rather than guessing from a newer
 *   artifact.
 * - `tool_invocations_identity_attribution`: tool calls, reported as counts (priced 0, D-009).
 */
import type { Sql } from 'postgres';
import { PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import {
  buildShadowStatements,
  SHADOW_MARKUP_SHEET,
  usdToMicros,
  type ShadowCostBasisRow,
  type ShadowMarkupSheet,
  type ShadowStatement,
  type ShadowToolAggregate,
  type ShadowUsageAggregate,
} from './shadow-metering';

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** UTC bounds of a `YYYY-MM` month as epoch milliseconds, end exclusive. */
export function shadowMonthBounds(month: string): { startMs: number; endMs: number } {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error(`shadow metering: month must be YYYY-MM, got ${JSON.stringify(month)}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  // Date.UTC treats years 0–99 as 1900–1999. setUTCFullYear preserves
  // the literal year and normalizes the exclusive boundary across December.
  const start = new Date(0);
  const end = new Date(0);
  start.setUTCFullYear(year, monthIndex, 1);
  end.setUTCFullYear(year, monthIndex + 1, 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

interface UsageRow {
  attributed: boolean;
  agent: string | null;
  profile: string | null;
  spec_layers: unknown;
  axis_layers: unknown;
  cost_source: string | null;
  cost_usd: string | null;
  samples: string;
}

/**
 * Inference usage for one workspace-month, one row per (activation event, cost source).
 * Samples are aggregated before the launch record is read, so the large launch spec is parsed
 * once per activation event rather than once per sample.
 */
export async function readShadowUsageAggregates(
  sql: Sql,
  input: { workspaceId: string; month: string },
): Promise<ShadowUsageAggregate[]> {
  const { startMs, endMs } = shadowMonthBounds(input.month);
  const rows = await sql<UsageRow[]>`
    WITH s AS (
      SELECT a.identity_activation_event_id AS event_id,
             a.identity_specification_revision AS revision,
             a.identity_stack_refs AS stack_refs,
             a.cost_source,
             sum(a.cost_usd::numeric) AS cost_usd,
             count(*) AS samples
        FROM harness_shared.agent_usage_samples_identity_attribution a
       WHERE a.workspace_id = ${input.workspaceId}
         AND a.ts >= ${startMs} AND a.ts < ${endMs}
       GROUP BY 1, 2, 3, 4
    )
    SELECT (s.event_id IS NOT NULL) AS attributed,
           av.launch_spec->>'agent' AS agent,
           av.launch_spec->>'profile' AS profile,
           -- Stamp first (migration 1295, taken at record time while the artifact was reachable);
           -- an unstamped event falls back to re-resolving the artifact from the launch record.
           COALESCE(e.specification_layer_refs,
                    harness_shared.identity_specification_layer_refs(art.artifact),
                    '[]'::jsonb) AS spec_layers,
           COALESCE(s.stack_refs, '[]'::jsonb) AS axis_layers,
           s.cost_source,
           s.cost_usd::text AS cost_usd,
           s.samples::text AS samples
      FROM s
      LEFT JOIN harness_shared.session_identity_activation_events e ON e.id = s.event_id
      LEFT JOIN harness_shared.adv_sessions av ON av.id = e.adv_session_id
      -- WI-10004494 gap 3: the artifact for EXACTLY the revision the span applied. A launch record
      -- that has since moved on keeps its earlier revisions in identityHistory (written beside the
      -- revision it describes, identity-management.ts historyWithCurrent); without this lookup
      -- every such span priced as inferred-profile even though its layers are on record.
      -- Skipped for a stamped event, so a stamped month never detoasts the launch record.
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN e.specification_layer_refs IS NOT NULL THEN NULL::jsonb
                 WHEN av.launch_spec->>'specificationRevision' = s.revision
                   THEN av.launch_spec->'specificationArtifact'
                 ELSE (
                   SELECT h->'specificationArtifact'
                     FROM jsonb_array_elements(
                       CASE WHEN jsonb_typeof(av.launch_spec->'identityHistory') = 'array'
                            THEN av.launch_spec->'identityHistory' ELSE '[]'::jsonb END) h
                    WHERE h->>'specificationRevision' = s.revision
                      AND jsonb_typeof(h->'specificationArtifact') = 'object'
                    LIMIT 1)
               END AS artifact
      ) art ON true`;
  return rows.map((row) => ({
    workspaceId: input.workspaceId,
    month: input.month,
    attributed: row.attributed,
    agent: row.agent,
    profile: row.profile,
    specificationLayerRefs: stringArray(row.spec_layers),
    axisLayerRefs: stringArray(row.axis_layers),
    costSource: row.cost_source,
    costMicros: usdToMicros(row.cost_usd == null ? null : Number(row.cost_usd)),
    samples: Number(row.samples),
  }));
}

/** Tool calls for one workspace-month, split by whether an identity span covered them. */
export async function readShadowToolAggregates(
  sql: Sql,
  input: { workspaceId: string; month: string },
): Promise<ShadowToolAggregate[]> {
  const { startMs, endMs } = shadowMonthBounds(input.month);
  const rows = await sql<Array<{ attributed: boolean; calls: string }>>`
    SELECT (t.identity_activation_event_id IS NOT NULL) AS attributed, count(*)::text AS calls
      FROM harness_shared.tool_invocations_identity_attribution t
     WHERE t.workspace_id = ${input.workspaceId}
       AND t.invoked_at >= to_timestamp(${startMs}::double precision / 1000.0)
       AND t.invoked_at < to_timestamp(${endMs}::double precision / 1000.0)
     GROUP BY 1`;
  return rows.map((row) => ({
    workspaceId: input.workspaceId,
    month: input.month,
    attributed: row.attributed,
    calls: Number(row.calls),
  }));
}

/**
 * Plan decision D-018 point 4: what one workspace-month's usage cost was priced against.
 * Counts every usage row in the month, from the base table, because the attribution view
 * exposes neither the price stamp nor the provenance. Measured 2026-10-01 over September
 * (1.19M rows): about 250 ms, a parallel scan, the same population the usage read covers.
 */
export async function readShadowCostBasis(
  sql: Sql,
  input: { workspaceId: string; month: string; priceTableVersion?: string },
): Promise<ShadowCostBasisRow> {
  const { startMs, endMs } = shadowMonthBounds(input.month);
  const version = input.priceTableVersion ?? PRICE_TABLE_VERSION;
  const [row] = await sql<Array<{ samples: string; stale: string; unpriced: string; lower_bound: string }>>`
    SELECT count(*)::text AS samples,
           count(*) FILTER (WHERE u.cost_source IS DISTINCT FROM 'provider'
                              AND u.price_table_version IS DISTINCT FROM ${version})::text AS stale,
           count(*) FILTER (WHERE u.cost_usd IS NULL)::text AS unpriced,
           count(*) FILTER (WHERE u.usage_provenance->>'costBound' = 'lower')::text AS lower_bound
      FROM harness_shared.agent_usage_samples u
     WHERE u.workspace_id = ${input.workspaceId}
       AND u.ts >= ${startMs} AND u.ts < ${endMs}`;
  return {
    workspaceId: input.workspaceId,
    month: input.month,
    priceTableVersion: version,
    samples: Number(row?.samples ?? 0),
    staleSamples: Number(row?.stale ?? 0),
    unpricedSamples: Number(row?.unpriced ?? 0),
    lowerBoundSamples: Number(row?.lower_bound ?? 0),
  };
}

/** The would-have-cost statement for one workspace-month. Read-only; bills nothing. */
export async function readShadowStatement(
  sql: Sql,
  input: { workspaceId: string; month: string; sheet?: ShadowMarkupSheet; priceTableVersion?: string },
): Promise<ShadowStatement> {
  const sheet = input.sheet ?? SHADOW_MARKUP_SHEET;
  const [usage, tools, basis] = await Promise.all([
    readShadowUsageAggregates(sql, input),
    readShadowToolAggregates(sql, input),
    readShadowCostBasis(sql, input),
  ]);
  const statement = buildShadowStatements(usage, tools, sheet, [basis])
    .find((s) => s.workspaceId === input.workspaceId && s.month === input.month);
  if (statement) return statement;
  // No activity at all: still return the itemized empty statement (verdict `no-usage`).
  const empty: ShadowUsageAggregate = {
    workspaceId: input.workspaceId, month: input.month, attributed: false, agent: null, profile: null,
    specificationLayerRefs: [], axisLayerRefs: [], costSource: null, costMicros: 0, samples: 0,
  };
  return buildShadowStatements([empty], [], sheet, [basis])[0]!;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
