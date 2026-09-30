/**
 * Cross-epoch campaign measurements for fleet:leader-brief.
 *
 * Every axis names its authoritative writer, units, and cap. Aggregate counts are
 * exact; only recent evidence rows are bounded. A failed/unknown read is unavailable,
 * never a manufactured zero.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { fleetEverMembers } from '../../fleet-membership-store';
import { readIssueOccurrenceCounts } from '../../issue-occurrence-ledger';
import { classifyTerminalOwner, type TerminalOwnerClass } from '../../completion-audit';
import {
  countsTowardBurnDown,
  type CompletionAuthorityFrom,
} from '../../work-item-completion-authority';
import {
  CompletionVerificationEvidenceSchema,
  type CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';

export const FLEET_CAMPAIGN_RECENT_ROW_CAP = 12;

export interface CampaignAxis<T> {
  available: boolean;
  writer: string;
  units: Record<string, string>;
  cap: { aggregates: 'none'; recentRows: number };
  data: T | null;
  reason?: string;
}

export interface RecentEvidence<T> {
  total: number;
  shown: number;
  truncated: boolean;
  rows: T[];
}

export interface FleetCampaign {
  boundary: {
    at: string;
    source: 'explicit-since' | 'fleet-created-at';
  };
  everMembers: {
    available: boolean;
    count: number | null;
    writer: 'harness_shared.fleet_membership_events';
    reason?: string;
  };
  axes: {
    membership: CampaignAxis<unknown>;
    speaking: CampaignAxis<unknown>;
    claims: CampaignAxis<unknown>;
    terminals: CampaignAxis<unknown>;
    issues: CampaignAxis<unknown>;
    gateEvents: CampaignAxis<unknown>;
    jobs: CampaignAxis<unknown>;
    corrections: CampaignAxis<unknown>;
  };
}

type TerminalGroup = {
  terminal_owner: string | null;
  authority: CompletionAuthorityFrom;
  count: string | number;
};

type FleetTerminalRow = {
  feature_id: unknown;
  item_kind: unknown;
  title: unknown;
  status: unknown;
  terminal_owner: unknown;
  terminal_completion_ref: unknown;
  completion_evidence: unknown;
  authority: unknown;
  closed_ts: unknown;
};

export interface FleetTerminalCompletion {
  id: string;
  kind: string | null;
  title: string | null;
  status: string | null;
  terminalOwner: string;
  terminalCompletionRef: string | null;
  completionEvidence: CompletionVerificationEvidence | null;
  verifiedHow: CompletionVerificationEvidence['verifiedHow'] | null;
  addedTests: boolean | null;
  completionAuthority: CompletionAuthorityFrom;
  countsTowardBurnDown: boolean;
  terminalizedAt: string;
}

const cap = () => ({ aggregates: 'none' as const, recentRows: FLEET_CAMPAIGN_RECENT_ROW_CAP });

function unavailable<T>(
  writer: string,
  units: Record<string, string>,
  reason: string,
): CampaignAxis<T> {
  return { available: false, writer, units, cap: cap(), data: null, reason };
}

function available<T>(
  writer: string,
  units: Record<string, string>,
  data: T,
): CampaignAxis<T> {
  return { available: true, writer, units, cap: cap(), data };
}

const number = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const nullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Project the completion writer's canonical columns into the leader-facing
 * audit row. Postgres JSON is untrusted at this boundary: malformed legacy
 * evidence is reported as absent rather than leaking an arbitrary payload or
 * failing the whole fleet brief.
 */
export function projectFleetTerminalCompletion(row: FleetTerminalRow): FleetTerminalCompletion {
  const evidence = CompletionVerificationEvidenceSchema.safeParse(row.completion_evidence);
  const completionEvidence = evidence.success ? evidence.data : null;
  const authority = (row.authority ?? null) as CompletionAuthorityFrom;
  return {
    id: String(row.feature_id),
    kind: nullableString(row.item_kind),
    title: nullableString(row.title),
    status: nullableString(row.status),
    terminalOwner: String(row.terminal_owner),
    terminalCompletionRef: nullableString(row.terminal_completion_ref),
    completionEvidence,
    verifiedHow: completionEvidence?.verifiedHow ?? null,
    addedTests: completionEvidence?.addedTests ?? null,
    completionAuthority: authority,
    countsTowardBurnDown: countsTowardBurnDown(authority, true),
    terminalizedAt: new Date(number(row.closed_ts)).toISOString(),
  };
}

export function recentEvidence<T>(rows: readonly T[], total: number): RecentEvidence<T> {
  const kept = rows.slice(0, FLEET_CAMPAIGN_RECENT_ROW_CAP);
  return {
    total,
    shown: kept.length,
    truncated: total > kept.length,
    rows: [...kept],
  };
}

export function resolveFleetCampaignBoundary(
  since: string | null | undefined,
  fleetCreatedAtMs: number,
): FleetCampaign['boundary'] {
  const explicitMs = since ? Date.parse(since) : Number.NaN;
  if (Number.isFinite(explicitMs)) {
    return { at: new Date(explicitMs).toISOString(), source: 'explicit-since' };
  }
  const created = Number.isFinite(fleetCreatedAtMs) ? fleetCreatedAtMs : 0;
  return { at: new Date(created).toISOString(), source: 'fleet-created-at' };
}

export function partitionTerminalGroups(groups: readonly TerminalGroup[], members: ReadonlySet<string>) {
  const byOwnerClass: Record<TerminalOwnerClass, number> = {
    system: 0,
    agent: 0,
    unattributed: 0,
  };
  const byFleetMembership = { member: 0, nonMember: 0, unattributed: 0 };
  const byAuthority: Record<string, number> = {};
  let total = 0;
  let counted = 0;
  for (const group of groups) {
    const n = number(group.count);
    total += n;
    const ownerClass = classifyTerminalOwner(group.terminal_owner);
    byOwnerClass[ownerClass] += n;
    if (!group.terminal_owner?.trim()) byFleetMembership.unattributed += n;
    else if (members.has(group.terminal_owner)) byFleetMembership.member += n;
    else byFleetMembership.nonMember += n;
    const authority = group.authority ?? 'legacy-null';
    byAuthority[authority] = (byAuthority[authority] ?? 0) + n;
    if (countsTowardBurnDown(group.authority, true)) counted += n;
  }
  return { total, counted, notCounted: total - counted, byOwnerClass, byFleetMembership, byAuthority };
}

const MEMBER_REASON = 'no-ever-members';

export async function readFleetCampaign(
  input: {
    workspaceId: string;
    fleetSlug: string;
    fleetCreatedAtMs: number;
    since?: string | null;
    harnessSlug?: string | null;
  },
  sqlOverride?: Sql,
): Promise<FleetCampaign> {
  const sql = sqlOverride ?? getOrgPg().sql;
  const boundary = resolveFleetCampaignBoundary(input.since, input.fleetCreatedAtMs);
  const boundaryMs = Date.parse(boundary.at);
  const membershipWriter = 'harness_shared.fleet_membership_events';
  const speakingWriter = 'harness_shared.tool_invocations';
  const claimsWriter = 'harness_shared.work_items.worked_by_history + taken_by';
  const terminalWriter = 'harness_shared.work_items.closed_ts + terminal_owner + authority';
  const issueWriter = 'harness_shared.work_items + harness_shared.work_item_occurrences';
  const eventWriter = 'harness_shared.event_key_fires';
  const jobWriter = 'harness_shared.task_ledger';
  const correctionWriter = 'harness_shared.coord_event_log.superseded_*';

  let members: Set<string> | null = null;
  let memberReason: string | null = null;
  try {
    members = await fleetEverMembers(input.fleetSlug, { workspaceId: input.workspaceId }, sql);
    if (members.size === 0) memberReason = MEMBER_REASON;
  } catch {
    memberReason = 'ever-member-oracle-failed';
  }
  const memberIds = [...(members ?? [])];

  let membership: CampaignAxis<unknown>;
  try {
    const totals = await sql<Array<Record<string, string | number>>>`
      SELECT count(*)::bigint AS total,
             count(*) FILTER (WHERE event = 'join')::bigint AS joins,
             count(*) FILTER (WHERE event = 'leave')::bigint AS leaves,
             count(*) FILTER (WHERE event = 'lead')::bigint AS leads,
             count(*) FILTER (WHERE event = 'demote')::bigint AS demotes,
             count(*) FILTER (WHERE event = 'backfill')::bigint AS backfills
        FROM harness_shared.fleet_membership_events
       WHERE (workspace_id = ${input.workspaceId} OR workspace_id = 'default')
         AND fleet_slug = ${input.fleetSlug}
         AND at >= ${boundary.at}::timestamptz
    `;
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, owner_id, owner_label, fleet_role, event, at
        FROM harness_shared.fleet_membership_events
       WHERE (workspace_id = ${input.workspaceId} OR workspace_id = 'default')
         AND fleet_slug = ${input.fleetSlug}
         AND at >= ${boundary.at}::timestamptz
       ORDER BY at DESC, id DESC
       LIMIT ${FLEET_CAMPAIGN_RECENT_ROW_CAP}
    `;
    const t = totals[0] ?? {};
    const total = number(t.total);
    membership = available(membershipWriter, {
      total: 'append-only membership transition rows in boundary',
      recent: 'most-recent transition evidence rows',
    }, {
      total,
      byEvent: {
        join: number(t.joins), leave: number(t.leaves), lead: number(t.leads),
        demote: number(t.demotes), backfill: number(t.backfills),
      },
      recent: recentEvidence(rows.map((row) => ({
        id: number(row.id), ownerId: row.owner_id, ownerLabel: row.owner_label,
        fleetRole: row.fleet_role, event: row.event, at: String(row.at),
      })), total),
    });
  } catch {
    membership = unavailable(membershipWriter, { total: 'membership transition rows' }, 'membership-read-failed');
  }

  let speaking: CampaignAxis<unknown>;
  if (memberReason) {
    speaking = unavailable(speakingWriter, { calls: 'tool invocation rows', owners: 'distinct ever-members' }, memberReason);
  } else {
    try {
      const totals = await sql<Array<Record<string, unknown>>>`
        SELECT count(*)::bigint AS calls, count(DISTINCT coord_owner_id)::bigint AS owners,
               max(invoked_at) AS latest_at
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${input.workspaceId}
           AND coord_owner_id = ANY(${sql.array(memberIds)}::text[])
           AND invoked_at >= ${boundary.at}::timestamptz
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
      `;
      const ownerRows = await sql<Array<Record<string, unknown>>>`
        SELECT coord_owner_id, count(*)::bigint AS calls, max(invoked_at) AS latest_at,
               count(*) FILTER (WHERE status = 'ok')::bigint AS ok_calls
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${input.workspaceId}
           AND coord_owner_id = ANY(${sql.array(memberIds)}::text[])
           AND invoked_at >= ${boundary.at}::timestamptz
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
         GROUP BY coord_owner_id
         ORDER BY max(invoked_at) DESC
         LIMIT ${FLEET_CAMPAIGN_RECENT_ROW_CAP}
      `;
      const t = totals[0] ?? {};
      const distinctOwners = number(t.owners);
      speaking = available(speakingWriter, {
        calls: 'tool invocation rows in boundary', owners: 'distinct fleet ever-member owner ids',
        latestAt: 'latest tool invocation timestamp',
      }, {
        calls: number(t.calls), distinctOwners, latestAt: t.latest_at ? String(t.latest_at) : null,
        recentOwners: recentEvidence(ownerRows.map((row) => ({
          ownerId: row.coord_owner_id, calls: number(row.calls), okCalls: number(row.ok_calls),
          latestAt: row.latest_at ? String(row.latest_at) : null,
        })), distinctOwners),
      });
    } catch {
      speaking = unavailable(speakingWriter, { calls: 'tool invocation rows' }, 'speaking-read-failed');
    }
  }

  let claims: CampaignAxis<unknown>;
  if (memberReason) {
    claims = unavailable(claimsWriter, { stock: 'current held work-item rows', flow: 'holder transition entries' }, memberReason);
  } else {
    try {
      const stockRows = await sql<Array<Record<string, unknown>>>`
        SELECT count(*)::bigint AS held, count(DISTINCT taken_by)::bigint AS holders
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND taken_by = ANY(${sql.array(memberIds)}::text[])
           AND NOT harness_shared.work_item_status_is_terminal(status)
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
      `;
      const flowRows = await sql<Array<Record<string, unknown>>>`
        SELECT count(*)::bigint AS transitions, count(DISTINCT h.value->>'owner')::bigint AS workers
          FROM harness_shared.work_items wi
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(wi.worked_by_history) = 'array' THEN wi.worked_by_history ELSE '[]'::jsonb END
          ) h(value)
         WHERE wi.workspace_id = ${input.workspaceId}
           AND h.value->>'owner' = ANY(${sql.array(memberIds)}::text[])
           AND (h.value->>'at')::timestamptz >= ${boundary.at}::timestamptz
           ${input.harnessSlug ? sql`AND wi.harness_slug = ${input.harnessSlug}` : sql``}
      `;
      const recent = await sql<Array<Record<string, unknown>>>`
        SELECT wi.feature_id, h.value->>'owner' AS owner_id, h.value->>'at' AS at
          FROM harness_shared.work_items wi
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(wi.worked_by_history) = 'array' THEN wi.worked_by_history ELSE '[]'::jsonb END
          ) h(value)
         WHERE wi.workspace_id = ${input.workspaceId}
           AND h.value->>'owner' = ANY(${sql.array(memberIds)}::text[])
           AND (h.value->>'at')::timestamptz >= ${boundary.at}::timestamptz
           ${input.harnessSlug ? sql`AND wi.harness_slug = ${input.harnessSlug}` : sql``}
         ORDER BY (h.value->>'at')::timestamptz DESC
         LIMIT ${FLEET_CAMPAIGN_RECENT_ROW_CAP}
      `;
      const stock = stockRows[0] ?? {};
      const flow = flowRows[0] ?? {};
      const transitions = number(flow.transitions);
      claims = available(claimsWriter, {
        stock: 'current non-terminal work-item rows held by fleet ever-members',
        flow: 'append-only worked_by_history holder-transition entries in boundary',
      }, {
        stock: { held: number(stock.held), distinctHolders: number(stock.holders) },
        flow: {
          transitions, distinctWorkers: number(flow.workers),
          recent: recentEvidence(recent.map((row) => ({
            workItemId: row.feature_id, ownerId: row.owner_id, at: row.at,
          })), transitions),
        },
      });
    } catch {
      claims = unavailable(claimsWriter, { stock: 'held rows', flow: 'holder-transition entries' }, 'claim-read-failed');
    }
  }

  let terminals: CampaignAxis<unknown>;
  if (memberReason || !members) {
    terminals = unavailable(terminalWriter, { closes: 'terminal rows with closed_ts in boundary' }, memberReason ?? 'ever-member-oracle-failed');
  } else {
    try {
      const groups = await sql<TerminalGroup[]>`
        SELECT terminal_owner, authority, count(*)::bigint AS count
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND closed_ts >= ${boundaryMs}
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
         GROUP BY terminal_owner, authority
      `;
      const partition = partitionTerminalGroups(groups, members);
      const recent = await sql<Array<Record<string, unknown>>>`
        SELECT feature_id, status, terminal_owner, authority, closed_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND closed_ts >= ${boundaryMs}
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
         ORDER BY closed_ts DESC
         LIMIT ${FLEET_CAMPAIGN_RECENT_ROW_CAP}
      `;
      // EI-6803: the CONTENT counterpart to the aggregate terminal axis. Keep
      // this on the existing fleet:leader-brief campaign surface instead of
      // adding a parallel fleet:audit-feed tool. `terminal_owner` is the
      // completion writer's durable attribution after `taken_by` is cleared;
      // filtering it in SQL prevents a busy harness's non-fleet completions
      // from crowding fleet-member rows out of the bounded feed.
      const auditRows = await sql<FleetTerminalRow[]>`
        SELECT feature_id, item_kind, title, status, terminal_owner,
               terminal_completion_ref,
               payload -> '_completionEvidence' AS completion_evidence,
               authority, closed_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND closed_ts >= ${boundaryMs}
           AND terminal_owner = ANY(${sql.array(memberIds)}::text[])
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
         ORDER BY closed_ts DESC, feature_id ASC
         LIMIT ${FLEET_CAMPAIGN_RECENT_ROW_CAP}
      `;
      terminals = available(terminalWriter, {
        closes: 'work-item rows whose epoch-ms closed_ts entered terminal state in boundary',
        counted: 'rows accepted by countsTowardBurnDown(authority, terminal=true)',
        auditFeed: 'recent terminal rows attributed to fleet ever-members, with canonical completion evidence',
      }, {
        ...partition,
        recent: recentEvidence(recent.map((row) => {
          const owner = typeof row.terminal_owner === 'string' ? row.terminal_owner : null;
          const authority = (row.authority ?? null) as CompletionAuthorityFrom;
          return {
            workItemId: row.feature_id, status: row.status, terminalOwner: owner,
            ownerClass: classifyTerminalOwner(owner), fleetMember: owner ? members.has(owner) : null,
            authority, countsTowardBurnDown: countsTowardBurnDown(authority, true),
            closedAt: new Date(number(row.closed_ts)).toISOString(),
          };
        }), partition.total),
        auditFeed: recentEvidence(
          auditRows.map(projectFleetTerminalCompletion),
          partition.byFleetMembership.member,
        ),
      });
    } catch {
      terminals = unavailable(terminalWriter, { closes: 'terminal rows' }, 'terminal-read-failed');
    }
  }

  let issues: CampaignAxis<unknown>;
  try {
    const stockRows = await sql<Array<{ stock: string | number }>>`
      SELECT count(*)::bigint AS stock
        FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspaceId}
         AND COALESCE(item_kind, kind) IN ('bug', 'change', 'task')
         AND NOT harness_shared.work_item_status_is_terminal(status)
         ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
    `;
    const flow = await readIssueOccurrenceCounts({
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug ?? null,
      since: boundary.at,
    }, sql);
    issues = available(issueWriter, {
      stock: 'current non-terminal canonical issue-family work-item rows',
      canonicalClusters: flow.units.canonicalClusters,
      rawOccurrences: flow.units.rawOccurrences,
      duplicateOccurrences: flow.units.duplicateOccurrences,
    }, { stock: number(stockRows[0]?.stock), flow });
  } catch {
    issues = unavailable(issueWriter, { stock: 'canonical issue rows', flow: 'occurrence rows' }, 'issue-read-failed');
  }

  let gateEvents: CampaignAxis<unknown>;
  try {
    const keys = ['member-dead', 'context-critical', 'claim-released', 'item-completed', 'drained']
      .map((kind) => `fleet:${kind}:${input.fleetSlug}`);
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT event_key, first_fired_at, last_fired_at, fire_count
        FROM harness_shared.event_key_fires
       WHERE workspace_id = ${input.workspaceId}
         AND event_key = ANY(${sql.array(keys)}::text[])
         AND last_fired_at >= ${boundary.at}::timestamptz
       ORDER BY last_fired_at DESC
    `;
    gateEvents = available(eventWriter, {
      activeKeys: 'distinct fleet transition keys whose latest fire is in boundary',
      lifetimeFires: 'lifetime per-key latch fire_count, not fires within boundary',
    }, {
      activeKeys: rows.length,
      lifetimeFires: rows.reduce((sum, row) => sum + number(row.fire_count), 0),
      recent: recentEvidence(rows.map((row) => ({
        key: row.event_key, lifetimeFires: number(row.fire_count),
        firstFiredAt: String(row.first_fired_at), lastFiredAt: String(row.last_fired_at),
      })), rows.length),
    });
  } catch {
    gateEvents = unavailable(eventWriter, { fires: 'lifetime per-key latch counts' }, 'gate-event-read-failed');
  }

  let jobs: CampaignAxis<unknown>;
  if (memberReason) {
    jobs = unavailable(jobWriter, { jobs: 'task ledger rows launched by fleet ever-members' }, memberReason);
  } else {
    try {
      const groups = await sql<Array<Record<string, unknown>>>`
        SELECT state, class, COALESCE(NULLIF(detail->>'carry', ''), 'unknown') AS carry,
               count(*)::bigint AS count
          FROM harness_shared.task_ledger
         WHERE workspace_id = ${input.workspaceId}
           AND launched_by = ANY(${sql.array(memberIds)}::text[])
           AND started_at >= ${boundary.at}::timestamptz
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
         GROUP BY state, class, COALESCE(NULLIF(detail->>'carry', ''), 'unknown')
      `;
      const recent = await sql<Array<Record<string, unknown>>>`
        SELECT task_id, launched_by, state, class, started_at, ended_at,
               COALESCE(NULLIF(detail->>'carry', ''), 'unknown') AS carry
          FROM harness_shared.task_ledger
         WHERE workspace_id = ${input.workspaceId}
           AND launched_by = ANY(${sql.array(memberIds)}::text[])
           AND started_at >= ${boundary.at}::timestamptz
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``}
         ORDER BY started_at DESC
         LIMIT ${FLEET_CAMPAIGN_RECENT_ROW_CAP}
      `;
      const total = groups.reduce((sum, row) => sum + number(row.count), 0);
      const byState: Record<string, number> = {};
      const byClass: Record<string, number> = {};
      const byCarry: Record<string, number> = {};
      for (const row of groups) {
        const n = number(row.count);
        byState[String(row.state)] = (byState[String(row.state)] ?? 0) + n;
        byClass[String(row.class)] = (byClass[String(row.class)] ?? 0) + n;
        byCarry[String(row.carry)] = (byCarry[String(row.carry)] ?? 0) + n;
      }
      jobs = available(jobWriter, {
        jobs: 'managed task-ledger rows started in boundary by fleet ever-members',
        carry: "detail.carry when the task writer records it; 'unknown' otherwise",
      }, {
        total, byState, byClass, byCarry,
        recent: recentEvidence(recent.map((row) => ({
          taskId: row.task_id, launchedBy: row.launched_by, state: row.state,
          class: row.class, carry: row.carry, startedAt: String(row.started_at),
          endedAt: row.ended_at ? String(row.ended_at) : null,
        })), total),
      });
    } catch {
      jobs = unavailable(jobWriter, { jobs: 'managed task rows' }, 'job-read-failed');
    }
  }

  let corrections: CampaignAxis<unknown>;
  if (memberReason) {
    corrections = unavailable(correctionWriter, { corrections: 'superseded original messages from fleet ever-members' }, memberReason);
  } else {
    try {
      const totals = await sql<Array<{ total: string | number }>>`
        SELECT count(*)::bigint AS total
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${input.workspaceId}
           AND body->>'from' = ANY(${sql.array(memberIds)}::text[])
           AND superseded_by_msg_id IS NOT NULL
           AND superseded_at >= ${boundary.at}::timestamptz
      `;
      const rows = await sql<Array<Record<string, unknown>>>`
        SELECT msg_id, body->>'from' AS from_owner, superseded_by_msg_id, superseded_at
          FROM harness_shared.coord_event_log
         WHERE workspace_id = ${input.workspaceId}
           AND body->>'from' = ANY(${sql.array(memberIds)}::text[])
           AND superseded_by_msg_id IS NOT NULL
           AND superseded_at >= ${boundary.at}::timestamptz
         ORDER BY superseded_at DESC
         LIMIT ${FLEET_CAMPAIGN_RECENT_ROW_CAP}
      `;
      const total = number(totals[0]?.total);
      corrections = available(correctionWriter, {
        corrections: 'original coord messages superseded in boundary',
      }, {
        total,
        recent: recentEvidence(rows.map((row) => ({
          messageId: row.msg_id, from: row.from_owner,
          supersededBy: row.superseded_by_msg_id, supersededAt: String(row.superseded_at),
        })), total),
      });
    } catch {
      corrections = unavailable(correctionWriter, { corrections: 'superseded coord messages' }, 'correction-read-failed');
    }
  }

  return {
    boundary,
    everMembers: {
      available: members !== null,
      count: members?.size ?? null,
      writer: membershipWriter,
      ...(memberReason ? { reason: memberReason } : {}),
    },
    axes: { membership, speaking, claims, terminals, issues, gateEvents, jobs, corrections },
  };
}
