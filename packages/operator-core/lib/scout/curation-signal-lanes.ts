/**
 * curation-signal-lanes — the four deferred Scout corpus signals from
 * blender-self-learning-2026-07-12 P-011 / WI-4456.
 *
 * This is deliberately an EXTENSION of the existing CorpusDigest seam, not a
 * second learner. Each production read reuses a canonical store/reader:
 *   - spend anomaly       ← loadCoordTokenBreakdown
 *   - owner correction   ← routed-idea grades + verified agent facts
 *   - knowledge reuse    ← negative-space demand + recipe hygiene preview
 *   - plan health        ← workspace plan index
 *
 * The pure builders own thresholds/ranking and are unit-tested without PG. The
 * production edge is independently fail-soft per source: one unavailable store
 * drops only its signal, never the Scout cycle or the other lanes.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { AgentFact } from '../agent-facts/store';
import type { CodeRecipeRow } from '../code-recipes-store';
import type { DemandPanelEntry } from '../negative-space/demand-read';
import type { PlanIndexRow } from '../agent-tools/plans/source';
import type { RoutedIdeaProvenance } from './outcome-feedback';
import type { CoordTokenBreakdown } from '../harness-insights/load-token-rollups';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function slug(raw: string, max = 64): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || 'unknown'
  );
}

function trunc(raw: string, max = 180): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export interface SpendAnomalyOptions {
  minSpendUsd?: number;
  unattributedShare?: number;
  concentrationShare?: number;
  limit?: number;
}

/** Raw cost buckets → only distribution/attribution anomalies (not another spend list). */
export function buildSpendAnomalyPatterns(input: CoordTokenBreakdown, opts: SpendAnomalyOptions = {}): MetaPattern[] {
  const minSpend = opts.minSpendUsd ?? 100;
  const unattributedFloor = opts.unattributedShare ?? 0.25;
  const concentrationFloor = opts.concentrationShare ?? 0.85;
  const limit = Math.max(1, opts.limit ?? 4);
  const total = input.byTrigger.reduce((n, r) => n + r.costUsd, 0);
  if (total < minSpend) return [];

  const out: MetaPattern[] = [];
  const unattributed = input.byTrigger.find((r) => r.trigger === 'unattributed')?.costUsd ?? 0;
  const unattributedRatio = total > 0 ? unattributed / total : 0;
  if (!input.triggerAttributionAvailable || unattributedRatio >= unattributedFloor) {
    out.push({
      category: 'spend-anomaly',
      ref: 'spend:attribution-gap',
      summary: `${usd(unattributed || total)} of ${usd(total)} recent spend lacks a usable turn-trigger attribution`,
      detail: `${Math.round(((unattributed || total) / total) * 100)}% of cost cannot be separated into user, coord-wake, cron, or autoloop demand; the raw time-token lane shows where cost landed, but not what caused it.`,
      weight: Math.min(1, 0.5 + unattributedRatio / 2),
    });
  }

  const attributed = input.byTrigger.filter((r) => r.trigger !== 'unattributed' && r.costUsd > 0);
  if (attributed.length >= 2) {
    const top = [...attributed].sort((a, b) => b.costUsd - a.costUsd)[0];
    const attributedTotal = attributed.reduce((n, r) => n + r.costUsd, 0);
    const share = attributedTotal > 0 ? top.costUsd / attributedTotal : 0;
    if (top.costUsd >= minSpend && share >= concentrationFloor) {
      out.push({
        category: 'spend-anomaly',
        ref: `spend:trigger-concentration:${slug(top.trigger)}`,
        summary: `${top.trigger} accounts for ${Math.round(share * 100)}% of attributed recent spend (${usd(top.costUsd)})`,
        detail: `one trigger dominates ${attributed.length} measured trigger classes; compare cost to completed value and add proportional control if this is not intentional.`,
        weight: Math.min(1, share),
      });
    }
  }

  const roles = input.byRoleClass.filter((r) => r.costUsd > 0);
  if (roles.length >= 2) {
    const top = [...roles].sort((a, b) => b.costUsd - a.costUsd)[0];
    const roleTotal = roles.reduce((n, r) => n + r.costUsd, 0);
    const share = roleTotal > 0 ? top.costUsd / roleTotal : 0;
    if (top.costUsd >= minSpend && share >= concentrationFloor) {
      out.push({
        category: 'spend-anomaly',
        ref: `spend:role-concentration:${slug(top.roleClass)}`,
        summary: `${top.roleClass} accounts for ${Math.round(share * 100)}% of recent role-class spend (${usd(top.costUsd)})`,
        detail: `cost is highly concentrated in one of ${roles.length} role classes; this is a prompt to test whether the concentration tracks delivered work, not an assertion that the class is wasteful.`,
        weight: Math.min(0.95, share),
      });
    }
  }

  return out.slice(0, limit);
}

export interface OwnerCorrectionInput {
  ideas: Array<
    Pick<
      RoutedIdeaProvenance,
      'ideaId' | 'title' | 'routedRef' | 'humanGrade' | 'humanFeedback' | 'gradedBy' | 'gradedAt'
    >
  >;
  facts: Array<Pick<AgentFact, 'scope' | 'scopeRef' | 'key' | 'body' | 'sourceRef' | 'sourceProvenance' | 'updatedAt'>>;
}

/** Explicit owner correction rows → citable prompt substrate, newest/strongest first. */
export function buildOwnerCorrectionPatterns(
  input: OwnerCorrectionInput,
  opts: { maxGrade?: number; limit?: number } = {},
): MetaPattern[] {
  const maxGrade = opts.maxGrade ?? 3;
  const limit = Math.max(1, opts.limit ?? 8);
  const ranked: Array<{ ts: number; strength: number; pattern: MetaPattern }> = [];

  for (const idea of input.ideas) {
    if (idea.gradedBy !== 'owner' || idea.humanGrade == null || idea.humanGrade > maxGrade) continue;
    const feedback = idea.humanFeedback
      ? trunc(idea.humanFeedback, 260)
      : 'No written feedback; the low owner grade is the correction signal.';
    ranked.push({
      ts: dateMs(idea.gradedAt) ?? 0,
      strength: 6 - idea.humanGrade,
      pattern: {
        category: 'owner-correction',
        ref: `owner-correction:idea:${slug(idea.ideaId)}`,
        summary: `Owner rated “${trunc(idea.title ?? idea.routedRef, 110)}” ${idea.humanGrade}/5`,
        detail: feedback,
        weight: Math.min(1, 0.4 + (maxGrade + 1 - idea.humanGrade) * 0.2),
      },
    });
  }

  for (const fact of input.facts) {
    const ownerTurn = fact.sourceProvenance?.kind === 'owner-turn' && fact.sourceProvenance.verified;
    if (!ownerTurn && !/^owner-turn(?::|$)/.test(fact.sourceRef ?? '')) continue;
    ranked.push({
      ts: dateMs(fact.updatedAt) ?? 0,
      strength: 2,
      pattern: {
        category: 'owner-correction',
        ref: `owner-correction:fact:${slug(`${fact.scope}-${fact.scopeRef ?? 'workspace'}-${fact.key}`)}`,
        summary: trunc(fact.body),
        detail: `verified owner-turn conclusion · fact ${fact.scope}${fact.scopeRef ? `:${fact.scopeRef}` : ''}:${fact.key}`,
        weight: 0.75,
      },
    });
  }

  return ranked
    .sort((a, b) => b.strength - a.strength || b.ts - a.ts || a.pattern.ref.localeCompare(b.pattern.ref))
    .slice(0, limit)
    .map((r) => r.pattern);
}

export interface KnowledgeReuseInput {
  demand: DemandPanelEntry[];
  staleOneOffRecipes: Array<Pick<CodeRecipeRow, 'id' | 'title' | 'runCount' | 'lastRunAt'>>;
}

/** Repeated zero-hit demand + aged one-off recipes → where knowledge fails to compound. */
export function buildKnowledgeReusePatterns(
  input: KnowledgeReuseInput,
  opts: { minMisses?: number; limit?: number } = {},
): MetaPattern[] {
  const minMisses = opts.minMisses ?? 3;
  const limit = Math.max(1, opts.limit ?? 8);
  const out: MetaPattern[] = [...input.demand]
    .filter((d) => d.missCount >= minMisses)
    .sort((a, b) => b.missCount - a.missCount || b.distinctAgents - a.distinctAgents)
    .map((d) => ({
      category: 'knowledge-reuse-gap' as const,
      ref: `knowledge:search-miss:${slug(d.surface)}:${slug(d.queryNorm)}`,
      summary: `“${trunc(d.exampleQuery || d.queryNorm, 120)}” missed ${d.missCount}× on ${d.surface}`,
      detail: `${d.distinctAgents} distinct agent(s) searched without a hit${d.candidateImprovementId ? `; candidate ${d.candidateImprovementId} is already filed` : '; no candidate is filed yet'}.`,
      weight: Math.min(1, 0.25 + d.missCount / 20 + d.distinctAgents / 20),
    }));

  if (input.staleOneOffRecipes.length > 0) {
    const top = [...input.staleOneOffRecipes]
      .sort((a, b) => (a.lastRunAt ?? '').localeCompare(b.lastRunAt ?? '') || a.id.localeCompare(b.id))
      .slice(0, 6)
      .map((r) => `${r.id} (${r.runCount} run${r.runCount === 1 ? '' : 's'})`)
      .join(', ');
    out.push({
      category: 'knowledge-reuse-gap',
      ref: 'knowledge:recipe-reuse-gap',
      summary: `${input.staleOneOffRecipes.length} reusable recipe(s) aged past the hygiene window after one run`,
      detail: `oldest examples: ${top}. The procedures were captured but did not compound through reuse; improve moment-of-need retrieval or retire misleading one-offs.`,
      weight: Math.min(0.9, 0.45 + input.staleOneOffRecipes.length / 50),
    });
  }

  return out.slice(0, limit);
}

export interface PlanHealthRow {
  workspaceId?: string;
  harnessSlug: string;
  planSlug: string;
  title: string | null;
  status: string | null;
  opStatus: 'started' | 'paused' | 'done' | null;
  updatedAt: string;
  items: Array<{ id: string; status: string; text?: string }>;
}

const TERMINAL_ITEM = new Set(['done', 'dropped']);
const TERMINAL_PLAN = new Set(['shipped', 'superseded']);

/** Plan index → lifecycle coherence and stale planning backlog (not stuck execution). */
export function buildPlanHealthPatterns(
  plans: readonly PlanHealthRow[],
  opts: { nowMs?: number; stalePlanningDays?: number; drainedGraceDays?: number; limit?: number } = {},
): MetaPattern[] {
  const now = opts.nowMs ?? Date.now();
  const stalePlanningDays = opts.stalePlanningDays ?? 14;
  const drainedGraceDays = opts.drainedGraceDays ?? 3;
  const limit = Math.max(1, opts.limit ?? 8);
  const ranked: Array<{ severity: number; age: number; pattern: MetaPattern }> = [];

  for (const plan of plans) {
    const updated = dateMs(plan.updatedAt);
    const ageDays = updated == null ? Number.POSITIVE_INFINITY : Math.max(0, (now - updated) / DAY_MS);
    const open = plan.items.filter((i) => !TERMINAL_ITEM.has(i.status));
    const terminalLifecycle = TERMINAL_PLAN.has(plan.status ?? '');
    const refSuffix = `${slug(plan.harnessSlug)}:${slug(plan.planSlug)}`;
    const label = plan.title ?? plan.planSlug;

    if (terminalLifecycle && open.length > 0) {
      ranked.push({
        severity: 4,
        age: ageDays,
        pattern: {
          category: 'plan-health',
          ref: `plan-health:lifecycle-drift:${refSuffix}`,
          summary: `Terminal plan “${trunc(label, 110)}” still has ${open.length} open item(s)`,
          detail: `lifecycle=${plan.status}; open=${open
            .slice(0, 6)
            .map((i) => `${i.id}:${i.status}`)
            .join(', ')}. The plan index and its terminal claim disagree.`,
          weight: 1,
        },
      });
      continue;
    }

    if (!terminalLifecycle && plan.items.length > 0 && open.length === 0 && ageDays >= drainedGraceDays) {
      ranked.push({
        severity: 3,
        age: ageDays,
        pattern: {
          category: 'plan-health',
          ref: `plan-health:drained-unclosed:${refSuffix}`,
          summary: `Plan “${trunc(label, 110)}” is fully drained but remains ${plan.status ?? 'unclassified'}`,
          detail: `${plan.items.length} terminal item(s), unchanged for ${Math.round(ageDays)}d; close/ship it or record the missing terminal gate so completed work does not remain live backlog.`,
          weight: 0.85,
        },
      });
      continue;
    }

    if ((plan.status === 'draft' || plan.status === 'ready') && open.length > 0 && ageDays >= stalePlanningDays) {
      ranked.push({
        severity: 2,
        age: ageDays,
        pattern: {
          category: 'plan-health',
          ref: `plan-health:stale-backlog:${refSuffix}`,
          summary: `${plan.status} plan “${trunc(label, 110)}” has ${open.length} open item(s) after ${Math.round(ageDays)}d without an update`,
          detail: `the plan has not entered operational execution; supersede, start, or refresh it so stale design does not masquerade as current intent.`,
          weight: Math.min(0.8, 0.45 + ageDays / 100),
        },
      });
    }
  }

  return ranked
    .sort((a, b) => b.severity - a.severity || b.age - a.age || a.pattern.ref.localeCompare(b.pattern.ref))
    .slice(0, limit)
    .map((r) => r.pattern);
}

export interface CurationSignalLanes {
  spendAnomalies: MetaPattern[];
  ownerCorrections: MetaPattern[];
  knowledgeReuseGaps: MetaPattern[];
  planHealth: MetaPattern[];
}

async function failSoft<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/** Production reader edge. Each source fails soft independently. */
export async function buildCurationSignalLanes(opts: {
  workspaceId?: string;
  harnessSlug: string;
}): Promise<CurationSignalLanes> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const runQuery = async <T = unknown>(query: string, params: unknown[]) =>
    (await sql.unsafe(query, params as never)) as unknown as T[];

  const [spend, ideas, facts, demand, recipeSweep, plans] = await Promise.all([
    failSoft(
      async () => {
        const { loadCoordTokenBreakdown } = await import('../harness-insights/load-token-rollups');
        return loadCoordTokenBreakdown({ workspace_id: ws, windowMs: 7 * DAY_MS, runQuery });
      },
      {
        windowMs: 7 * DAY_MS,
        byTrigger: [],
        triggerAttributionAvailable: false,
        attributedCostShare: 0,
        byRoleClass: [],
      } as CoordTokenBreakdown,
    ),
    failSoft(async () => {
      const { readRoutedIdeas } = await import('./routed-ledger');
      return readRoutedIdeas({ workspaceId: ws, harnessSlug: opts.harnessSlug, origin: 'all', limit: 500 });
    }, [] as RoutedIdeaProvenance[]),
    failSoft(async () => {
      const { foldFacts } = await import('../agent-facts/store');
      return foldFacts([{ scope: 'workspace' }, { scope: 'harness', scopeRef: opts.harnessSlug }], {
        workspaceId: ws,
        limitPerSelector: 50,
      });
    }, [] as AgentFact[]),
    failSoft(
      async () => {
        const { readDemandSnapshot } = await import('../negative-space/demand-read');
        return readDemandSnapshot(sql, ws, 100);
      },
      { entries: [], totalEntries: 0, totalMisses: 0, filedCount: 0, minedAt: null },
    ),
    failSoft(
      async () => {
        const { sweepRecipes } = await import('../code-recipes-store');
        return sweepRecipes(sql, { dryRun: true, staleDays: 30, maxRunCount: 1 });
      },
      { swept: [] as CodeRecipeRow[], dryRun: true },
    ),
    failSoft(async () => {
      const { listPlanIndexRowsForWorkspace } = await import('../agent-tools/plans/source');
      return listPlanIndexRowsForWorkspace({
        workspaceId: ws,
        includeArchived: false,
        includeInstances: false,
        limit: 2000,
      });
    }, [] as PlanIndexRow[]),
  ]);

  return {
    spendAnomalies: buildSpendAnomalyPatterns(spend),
    ownerCorrections: buildOwnerCorrectionPatterns({ ideas, facts }),
    knowledgeReuseGaps: buildKnowledgeReusePatterns({
      demand: demand.entries,
      staleOneOffRecipes: recipeSweep.swept,
    }),
    planHealth: buildPlanHealthPatterns(plans),
  };
}
