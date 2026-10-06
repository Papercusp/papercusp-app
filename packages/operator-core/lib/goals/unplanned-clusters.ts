/**
 * Unplanned goal-work CLUSTERS (plan goal-holder-plans-ideation-truthful-reports-2026-10-03 P-002).
 *
 * The GOAL contract makes a started plan the default unit of placement: when 3+ open
 * goal-stamped work-items share one cluster (a root cause, a subsystem or a topic), the
 * holder writes a plan (plans:new + items + plans:start) and staffs a fleet on it; the
 * standing drain fleet is for singletons. Measured before this existed: the Work-on-
 * everything goal carried 29 open goal-stamped items and ZERO goal-authored plans, so the
 * holder's whole portfolio was loose singletons the drain fleet picked in arbitrary order.
 *
 * This module is the platform half of that contract. It finds clusters DETERMINISTICALLY —
 * no model call — from five signals the ledger already records:
 *
 *   1. an explicit link edge between two of the goal's open unplanned items
 *      (caused-by / duplicates / relates / blocks / fixes / investigates / about / revises);
 *   2. a shared topic tag, EXCLUDING the built-in improvement-provenance topic that
 *      `improvements:capture` stamps on every capture (it records where an item came
 *      from, not what it is about, so treating it as a cluster key would merge everything);
 *   3. a shared cited repository path (`packages/…/x.ts`) in the title or summary — two
 *      items naming the same file are the same subsystem;
 *   4. a shared bracketed title prefix (`[Truthful reports] …`), the fleet's own grouping
 *      convention;
 *   5. a shared tool-failure CLASS: the failure family + error code from the canonical
 *      `payload.toolFailureSignature.signatureKey` that automatic tool-failure capture
 *      stamps. `coord:glance … (authorization_denied)` and `flags:get … (authorization_denied)`
 *      are one kernel refusal seen through two verbs; they cite no path and carry no
 *      prefix, so signals 1-4 missed a 4-item cluster of exactly this shape
 *      (WI-10005920). Catch-all codes that name no root cause are not a key.
 *
 * Signals are unioned (union-find), so A–B by a link and B–C by a shared path make one
 * cluster A–B–C. A cluster is REPORTABLE once it has `minSize` members and it FORMED (its
 * `minSize`-th member arrived) more than `cycles` reporting cycles ago — the contract's
 * "older than 2 reporting cycles", so a holder gets two full cycles to plan it unprompted.
 *
 * Items already in a plan — `source_plan_slug` set, or a link edge to a plan item / plan —
 * are not unplanned and never join a cluster. The nudge items this module itself files
 * carry `payload.unplannedCluster` and are excluded too, so a nudge can never seed or
 * grow the cluster it reports.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';

import { IMPROVEMENT_TOPIC } from '../agent-tools/coordination/topics-core';
import { parseToolFailureSignatureKey } from '../harness/improvements/tool-error-classifier';
import { createWorkItem, TERMINAL_WORK_ITEM_STATES } from '../work-items';
import { stampPromotedGoal } from './provenance-stamp';

/** The contract's threshold: "3+ open goal-stamped work-items share one cluster". */
export const UNPLANNED_CLUSTER_MIN_SIZE = 3;
/** The contract's age: "older than 2 reporting cycles". */
export const UNPLANNED_CLUSTER_AGE_CYCLES = 2;
/** Bound on the per-goal read; a goal with more open unplanned items than this is
 *  reported on its oldest `limit` items, and the read says so (`truncatedByLimit`). */
export const UNPLANNED_CLUSTER_READ_LIMIT = 500;

/** Link relations that put two items in one cluster. `tagged` is the topic plane and is
 *  handled as signal 2; everything else between two work-items is a relationship. */
export const CLUSTER_LINK_RELS: readonly string[] = [
  'caused-by',
  'duplicates',
  'relates',
  'blocks',
  'fixes',
  'investigates',
  'about',
  'revises',
];

/** Topics that record PROVENANCE rather than subject; never a cluster key. Derived from
 *  the constant `improvements:capture` actually stamps, not a hand-copied string. */
export const PROVENANCE_TOPICS: readonly string[] = [IMPROVEMENT_TOPIC];

/** Error codes that name no root cause, so two failures sharing one are not one subject:
 *  the classifier's own unknown fallback, and `handler_error`, the wrapper around ANY
 *  exception a handler threw. Curated, not derived: whether a code is diagnostic is a
 *  judgment no registry records. */
export const NON_DIAGNOSTIC_ERROR_CODES: readonly string[] = ['error-code-unknown', 'handler_error'];

/** The tool-failure class attribute (`failure:<family>:<errorCode>`) for one signature
 *  key, or null when the key is absent, unparseable, or carries a catch-all code. */
export function failureClassAttr(signatureKey: string | null | undefined): string | null {
  const parsed = parseToolFailureSignatureKey(signatureKey);
  if (!parsed || NON_DIAGNOSTIC_ERROR_CODES.includes(parsed.errorCode)) return null;
  return `failure:${parsed.failureFamily}:${parsed.errorCode}`;
}

export interface ClusterCandidateItem {
  id: string;
  title: string;
  summary?: string | null;
  createdAtMs: number;
  harness?: string | null;
  /** Topic tags (coord_links rel='tagged', dst_kind='topic'). */
  topics?: readonly string[];
  /** `payload.toolFailureSignature.signatureKey`, when automatic tool-failure capture filed it. */
  failureSignatureKey?: string | null;
}

export interface ClusterEdge {
  a: string;
  b: string;
  rel: string;
}

export interface UnplannedCluster {
  /** Stable identity: the goal plus the cluster's EARLIEST member. Members come and go as
   *  items close; the anchor only changes when the anchor itself leaves, so one nudge per
   *  cluster rather than one per membership change. */
  key: string;
  anchorId: string;
  memberIds: string[];
  /** When the cluster reached `minSize` members (the minSize-th earliest createdAt). */
  formedAtMs: number;
  /** Why these items are one cluster, e.g. `link:caused-by`, `topic:gate`,
   *  `path:packages/x.ts`, `prefix:[truthful reports]`. Sorted, deduped. */
  reasons: string[];
  harness: string | null;
}

const PATH_RE =
  /\b((?:packages|apps|libs|scripts|papercusp-desktop|bin)\/[A-Za-z0-9_.@/-]+\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|sql|md|mdx|rs|sh))\b/g;
const PREFIX_RE = /^\s*\[([^\]]{2,60})\]/;

/** Repository paths cited in an item's title/summary. */
export function citedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) out.add(m[1]);
  return [...out];
}

/** The `[Group]` title prefix, normalized, or null. */
export function titlePrefix(title: string): string | null {
  const m = PREFIX_RE.exec(title);
  if (!m) return null;
  const p = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
  return p.length >= 2 ? p : null;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/**
 * Cluster one goal's open UNPLANNED items. Pure: no clock, no I/O.
 * Returns every cluster with at least `minSize` members, oldest-formed first.
 */
export function findUnplannedClusters(
  goalKey: string,
  items: readonly ClusterCandidateItem[],
  edges: readonly ClusterEdge[],
  opts: { minSize?: number; provenanceTopics?: readonly string[] } = {},
): UnplannedCluster[] {
  const minSize = opts.minSize ?? UNPLANNED_CLUSTER_MIN_SIZE;
  const provenance = new Set(opts.provenanceTopics ?? PROVENANCE_TOPICS);
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const uf = new UnionFind();
  /** attribute → member ids carrying it (a reason applies to a cluster when ≥2 of its
   *  members carry it). */
  const attrMembers = new Map<string, Set<string>>();
  const addAttr = (attr: string, id: string) => {
    let s = attrMembers.get(attr);
    if (!s) attrMembers.set(attr, (s = new Set()));
    s.add(id);
  };

  for (const e of edges) {
    if (e.a === e.b || !byId.has(e.a) || !byId.has(e.b)) continue;
    if (!CLUSTER_LINK_RELS.includes(e.rel)) continue;
    uf.union(e.a, e.b);
    // A link reason is per-edge, so key it by the pair to keep it out of the shared-attr fold.
    addAttr(`link:${e.rel}\u0000${e.a}`, e.a);
    addAttr(`link:${e.rel}\u0000${e.a}`, e.b);
  }
  for (const it of items) {
    for (const t of it.topics ?? []) {
      if (!provenance.has(t)) addAttr(`topic:${t}`, it.id);
    }
    for (const p of citedPaths(`${it.title}\n${it.summary ?? ''}`)) addAttr(`path:${p}`, it.id);
    const prefix = titlePrefix(it.title);
    if (prefix) addAttr(`prefix:[${prefix}]`, it.id);
    const failure = failureClassAttr(it.failureSignatureKey);
    if (failure) addAttr(failure, it.id);
  }
  for (const ids of attrMembers.values()) {
    const arr = [...ids];
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }

  const groups = new Map<string, string[]>();
  for (const it of items) {
    const r = uf.find(it.id);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(it.id);
  }

  const clusters: UnplannedCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < minSize) continue;
    const sorted = members
      .map((id) => byId.get(id)!)
      .sort((x, y) => x.createdAtMs - y.createdAtMs || x.id.localeCompare(y.id));
    const memberSet = new Set(members);
    const reasons = new Set<string>();
    for (const [attr, ids] of attrMembers) {
      let n = 0;
      for (const id of ids) if (memberSet.has(id)) n += 1;
      if (n >= 2) reasons.add(attr.split('\u0000')[0]);
    }
    const anchor = sorted[0];
    clusters.push({
      key: `${goalKey}:${anchor.id}`,
      anchorId: anchor.id,
      memberIds: sorted.map((i) => i.id),
      formedAtMs: sorted[minSize - 1].createdAtMs,
      reasons: [...reasons].sort(),
      harness: anchor.harness ?? null,
    });
  }
  return clusters.sort((a, b) => a.formedAtMs - b.formedAtMs || a.anchorId.localeCompare(b.anchorId));
}

/** Clusters that have existed (at `minSize`) for MORE than `cycles` reporting cycles. */
export function overdueUnplannedClusters(
  clusters: readonly UnplannedCluster[],
  nowMs: number,
  reportCycleMs: number,
  cycles: number = UNPLANNED_CLUSTER_AGE_CYCLES,
): UnplannedCluster[] {
  return clusters.filter((c) => nowMs - c.formedAtMs > cycles * reportCycleMs);
}

export interface UnplannedClusterRead {
  clusters: UnplannedCluster[];
  /** Open unplanned items read for the goal. */
  itemCount: number;
  /** True when the read hit {@link UNPLANNED_CLUSTER_READ_LIMIT}: the clusters are over
   *  the oldest `limit` items only, never the whole population. */
  truncatedByLimit: boolean;
}

/**
 * Read one goal's open, unplanned, non-observation work-items plus their link edges and
 * topic tags, and cluster them. Items already in a plan (source_plan_slug, or a link to a
 * plan item / plan) and this module's own nudge items are excluded at the source.
 */
export async function readUnplannedGoalClusters(
  sql: Sql,
  args: {
    workspaceId: string;
    goalId: string;
    limit?: number;
    /**
     * Read the items that were open at this instant (created_ts <= asOfMs and not closed
     * by then) instead of the items open now. Used to grade a past window
     * (goal-holder-behavior-metrics). Plan membership (source_plan_slug, plan links) is
     * still read as of now, so an item planned after `asOfMs` is excluded: an as-of read
     * can under-count a cluster the holder planned later, never over-count one.
     */
    asOfMs?: number;
  },
): Promise<UnplannedClusterRead> {
  const limit = args.limit ?? UNPLANNED_CLUSTER_READ_LIMIT;
  const openAt =
    args.asOfMs == null
      ? sql`w.status <> ALL(${[...TERMINAL_WORK_ITEM_STATES]}::text[])`
      : sql`w.created_ts <= ${args.asOfMs} AND (w.closed_ts IS NULL OR w.closed_ts > ${args.asOfMs})`;
  const rows = await sql<
    Array<{
      feature_id: string;
      harness_slug: string | null;
      title: string | null;
      summary: string | null;
      created_ts: string | number;
      failure_signature_key: string | null;
    }>
  >`
    SELECT w.feature_id, w.harness_slug, w.title, w.summary, w.created_ts,
           w.payload->'toolFailureSignature'->>'signatureKey' AS failure_signature_key
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${args.workspaceId}
       AND w.goal_id = ${args.goalId}
       AND w.source_plan_slug IS NULL
       AND ${openAt}
       AND w.lane IS DISTINCT FROM 'observation'
       AND NOT (COALESCE(w.payload, '{}'::jsonb) ? 'unplannedCluster')
       AND NOT EXISTS (
             SELECT 1 FROM harness_shared.coord_links pl
              WHERE pl.workspace_id = w.workspace_id
                AND pl.src_ref = w.feature_id
                AND pl.dst_kind IN ('plan_item', 'plan'))
     ORDER BY w.created_ts ASC, w.feature_id ASC
     LIMIT ${limit + 1}`;
  const truncatedByLimit = rows.length > limit;
  const kept = rows.slice(0, limit);
  if (kept.length === 0) return { clusters: [], itemCount: 0, truncatedByLimit: false };
  const ids = kept.map((r) => r.feature_id);
  const links = await sql<Array<{ src_ref: string; dst_ref: string; dst_kind: string; rel: string }>>`
    SELECT src_ref, dst_ref, dst_kind, rel
      FROM harness_shared.coord_links
     WHERE workspace_id = ${args.workspaceId}
       AND src_ref = ANY(${ids}::text[])
       AND ((dst_kind = 'topic' AND rel = 'tagged') OR dst_ref = ANY(${ids}::text[]))`;
  const topics = new Map<string, string[]>();
  const edges: ClusterEdge[] = [];
  for (const l of links) {
    if (l.dst_kind === 'topic' && l.rel === 'tagged') {
      const t = topics.get(l.src_ref) ?? [];
      t.push(l.dst_ref);
      topics.set(l.src_ref, t);
    } else {
      edges.push({ a: l.src_ref, b: l.dst_ref, rel: l.rel });
    }
  }
  const items: ClusterCandidateItem[] = kept.map((r) => ({
    id: r.feature_id,
    title: r.title ?? '',
    summary: r.summary,
    createdAtMs: Number(r.created_ts),
    harness: r.harness_slug,
    topics: topics.get(r.feature_id) ?? [],
    failureSignatureKey: r.failure_signature_key,
  }));
  return {
    clusters: findUnplannedClusters(`${args.workspaceId}:${args.goalId}`, items, edges),
    itemCount: items.length,
    truncatedByLimit,
  };
}

export interface UnplannedClusterAlert {
  workspaceId: string;
  goalId: string;
  goalTitle: string;
  holderOwnerId: string;
  cluster: UnplannedCluster;
  reportCycleMs: number;
}

/**
 * File ONE goal-stamped nudge work-item for an overdue cluster, assigned to the holder
 * (so the goal's drain fleet cannot claim the holder's planning decision). Idempotent per
 * cluster anchor: a nudge already filed for this anchor — in ANY state, including a
 * holder's reasoned `dropped` — suppresses a second one.
 *
 * Returns the new item id, or null when a nudge for this anchor already exists.
 */
export async function fileUnplannedClusterNudge(alert: UnplannedClusterAlert): Promise<string | null> {
  const { sql } = getOrgPg();
  const { workspaceId, goalId, cluster } = alert;
  const existing = await sql<Array<{ feature_id: string }>>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND goal_id = ${goalId}
       AND payload -> 'unplannedCluster' ->> 'anchorId' = ${cluster.anchorId}
     LIMIT 1`;
  if (existing.length > 0) return null;
  const harness = cluster.harness ?? undefined;
  const hours = Math.round((alert.reportCycleMs * UNPLANNED_CLUSTER_AGE_CYCLES) / 3600_000);
  const item = await createWorkItem({
    kind: 'task',
    title: `Plan the ${cluster.memberIds.length}-item unplanned cluster anchored at ${cluster.anchorId} (goal "${alert.goalTitle}")`,
    summary:
      `${cluster.memberIds.length} open goal-stamped work-items share one cluster and are not in any plan: ` +
      `${cluster.memberIds.join(', ')}. Shared signals: ${cluster.reasons.join('; ') || 'linked'}. ` +
      `The cluster formed ${new Date(cluster.formedAtMs).toISOString()}, more than ${UNPLANNED_CLUSTER_AGE_CYCLES} ` +
      `reporting cycles (${hours}h) ago. The GOAL contract places clustered work as a plan: plans:new + ` +
      `plans:add-item for each member, plans:start, then fleet:launch-on-plan with a claim spec filtered to the plan. ` +
      `If these items are NOT one cluster, close this item as dropped with the reason; that suppresses a re-file for this anchor. ` +
      `Filed by the goal liveness watchdog (plan goal-holder-plans-ideation-truthful-reports-2026-10-03 P-002).`,
    harness,
    workspaceId,
    createdBy: 'system:goal-liveness-watchdog',
    assignee: alert.holderOwnerId,
    // This is a threshold-triggered, anchor-deduped planning obligation routed to the
    // goal holder. Born-pending admission intentionally strips assignee so the promoter
    // can decide; that would put the holder's planning decision back in the drain pool.
    admission: 'auto',
    admittedBy: 'bypass:goal-liveness-watchdog',
    payload: {
      unplannedCluster: {
        goalId,
        anchorId: cluster.anchorId,
        memberIds: cluster.memberIds,
        reasons: cluster.reasons,
        formedAt: new Date(cluster.formedAtMs).toISOString(),
      },
    },
  });
  await stampPromotedGoal({ id: item.id, harness }, workspaceId, goalId);
  return item.id;
}
