import type { Sql } from 'postgres';
import {
  getPlanRow,
  listPlanRowsMatchingAnyToken,
  type PlanRow,
  type PlanSourceOpts,
} from '../agent-tools/plans/source';
import { corpusNovelty, type CorpusKind } from '../scout/critique-core';
import { dedupSignature } from '../harness/improvements/digest';
import { readRoutedIdeas, type ScoutLedgerOpts } from '../scout/routed-ledger';
import type { RoutedIdeaProvenance } from '../scout/outcome-feedback';
import { capabilityHash, type CapabilityManifest, type CapabilityPacket } from './capability-contracts';
import { CapabilityProposalSchema } from './capability-pass';
import { verifyCapabilityPacket, type BuildCapabilityPacketInput } from './capability-packets';
import { capabilityContentVersion } from './capability-sampler';
import { getDreamRun, listDreamRuns, type DreamRun } from './dream-run-store';
import {
  CAPABILITY_PRIOR_KINDS,
  CAPABILITY_REVIEW_VERSION,
  capabilityProposalHash,
  type CapabilityReviewPrior,
  type CapabilityReviewSearch,
  type CapabilityReviewSearchResult,
  type CapabilityReviewSources,
} from './capability-review';

type Scope = CapabilityPacket['scope'];
const IDEA_LIMIT = 1_000;
const RUN_LIMIT = 500;
const PLAN_LIMIT = 24;
const sameScope = (a: Scope, b: Scope) =>
  a.workspaceId === b.workspaceId && a.potSlug === b.potSlug && a.repositoryId === b.repositoryId;
export interface CapabilityReviewSourceDeps {
  plans: (
    tokens: string[],
    opts: PlanSourceOpts & { includeArchived: boolean; limit: number },
  ) => Promise<{ rows: PlanRow[]; truncated: boolean }>;
  plan: typeof getPlanRow;
  ideas: (opts: ScoutLedgerOpts) => Promise<RoutedIdeaProvenance[]>;
  runs: typeof listDreamRuns;
  run: typeof getDreamRun;
  verifyPacket: (packet: unknown, input: BuildCapabilityPacketInput) => ReturnType<typeof verifyCapabilityPacket>;
}
const defaultDeps: CapabilityReviewSourceDeps = {
  plans: listPlanRowsMatchingAnyToken,
  plan: getPlanRow,
  ideas: readRoutedIdeas,
  runs: listDreamRuns,
  run: getDreamRun,
  verifyPacket: verifyCapabilityPacket,
};
export interface BuildCapabilityReviewSourcesInput {
  sql: Sql;
  scope: Scope;
  rootPath: string;
  manifest: CapabilityManifest;
  /** The admitted capability catalogue, including potential integration priors, not just the selected primaries. */
  packets: readonly CapabilityPacket[];
}

function prior(
  scope: Scope,
  ref: string,
  kind: CapabilityReviewPrior['kind'],
  fullText: string,
  sourceHash?: string,
): CapabilityReviewPrior {
  const text = fullText.slice(0, 12_000);
  return {
    scope,
    ref,
    kind,
    text,
    contentHash: capabilityHash(text),
    sourceHash: sourceHash ?? capabilityHash(fullText),
    candidateHash: null,
    evidenceHash: null,
  };
}
function planPrior(scope: Scope, row: PlanRow): CapabilityReviewPrior {
  if (row.workspaceId !== scope.workspaceId || row.harnessSlug !== scope.potSlug)
    throw new Error('Plan crosses review scope.');
  return prior(scope, 'plan:' + row.planSlug, 'plan', row.content);
}
function ideaPrior(scope: Scope, idea: RoutedIdeaProvenance): CapabilityReviewPrior {
  // Exact JSON, including feedback and revision lineage, is the source version.
  return prior(scope, 'idea:' + idea.ideaId + ':' + idea.routedRef, 'idea', JSON.stringify(idea));
}
function runPrior(scope: Scope, run: DreamRun): CapabilityReviewPrior {
  if (run.workspaceId !== scope.workspaceId || run.potSlug !== scope.potSlug)
    throw new Error('Dream run crosses review scope.');
  const value = { status: run.status, outcome: run.outcome, review: run.review, routedRef: run.routedRef };
  const result = prior(
    scope,
    'dream:' + run.runId,
    run.status === 'rejected' || run.status === 'duplicate' ? 'rejected-attempt' : 'idea',
    JSON.stringify(value),
  );
  const insight = run.outcome?.insight as Record<string, unknown> | undefined;
  const parsed = CapabilityProposalSchema.safeParse(insight?.capability ?? run.outcome?.capability);
  if (parsed.success) result.candidateHash = capabilityProposalHash(parsed.data);
  if (
    run.review?.schemaVersion === CAPABILITY_REVIEW_VERSION &&
    typeof run.review.evidenceHash === 'string' &&
    /^[a-f0-9]{64}$/.test(run.review.evidenceHash)
  )
    result.evidenceHash = run.review.evidenceHash;
  return result;
}
function packetPriors(packet: CapabilityPacket): CapabilityReviewPrior[] {
  return (['implementation', 'test'] as const).map((kind) => {
    const fullText = JSON.stringify({
      unit: packet.unit,
      sources: packet.sources
        .filter((s) => s.kind === kind)
        .map((s) => ({ path: s.path, startLine: s.startLine, text: s.excerpt })),
    });
    return prior(
      packet.scope,
      'code:' + packet.unit.id + ':' + kind,
      kind,
      fullText,
      capabilityHash(packet.unitHash + ':' + capabilityContentVersion(packet)),
    );
  });
}
const corpusKind = (kind: CapabilityReviewPrior['kind']): CorpusKind =>
  kind === 'plan' ? 'plan' : kind === 'idea' || kind === 'rejected-attempt' ? 'idea' : 'implementation';

/** A bounded lexical candidate stage over the established readers; the review's
 * shared cross-encoder reranks its union. Scores here never decide originality. */
function shortlist(query: string, values: CapabilityReviewPrior[], limit: number): CapabilityReviewPrior[] {
  const unique = new Map(values.map((p) => [p.ref, p]));
  const matches = corpusNovelty(
    query,
    [...unique.values()].map((p) => ({ ref: p.ref, kind: corpusKind(p.kind), text: p.text })),
    { matchFloor: 0, maxMatches: unique.size },
  ).matches;
  // corpusNovelty deliberately omits zero-overlap rows, even at floor zero.
  // Preserve them as recall candidates: renamed mechanisms still need a chance
  // at cross-encoder/behavioral review, especially in the rejected-attempt lane.
  const rankedRefs = new Set(matches.map((m) => m.ref));
  const ranked = [...matches, ...[...unique.values()].filter((p) => !rankedRefs.has(p.ref))];
  // Reserve a slot for every source kind before filling by relevance. A large code
  // catalogue must not evict the rejected-attempt or plan search from adjudication.
  const selected = new Map<string, CapabilityReviewPrior>();
  for (const kind of CAPABILITY_PRIOR_KINDS) {
    const hit = ranked.find((m) => unique.get(m.ref)!.kind === kind);
    if (hit && selected.size < limit) selected.set(hit.ref, unique.get(hit.ref)!);
  }
  for (const match of ranked) {
    if (selected.size >= limit) break;
    selected.set(match.ref, unique.get(match.ref)!);
  }
  return [...selected.values()];
}

/** Reuses capability packet evidence, canonical plan reads, Scout's routed ledger,
 * and the Dream attempt ledger. No new index, table, or background scanner. */
export function buildCapabilityReviewSources(
  input: BuildCapabilityReviewSourcesInput,
  deps: CapabilityReviewSourceDeps = defaultDeps,
): CapabilityReviewSources {
  const { scope } = input;
  if (Object.values(scope).some((s) => !s.trim()) || input.packets.length > 200)
    throw new RangeError('A bounded, explicitly scoped capability catalogue is required.');
  const planOpts = { workspaceId: scope.workspaceId, harnessSlug: scope.potSlug };
  const ideaOpts: ScoutLedgerOpts = {
    workspaceId: scope.workspaceId,
    harnessSlug: scope.potSlug,
    origin: 'all',
    limit: IDEA_LIMIT,
  };
  const packets = new Map<string, CapabilityPacket>();
  for (const packet of input.packets) {
    if (!sameScope(packet.scope, scope) || packets.has(packet.unit.id))
      throw new Error('Invalid catalogue scope or duplicate unit.');
    packets.set(packet.unit.id, packet);
  }
  const locators = new Map<string, { kind: 'plan' | 'idea' | 'dream' | 'code'; id: string; subref?: string }>();
  const remember = (p: CapabilityReviewPrior, locator: NonNullable<CapabilityReviewPrior['locator']>) => {
    locators.set(p.ref, locator);
    return { ...p, locator };
  };
  async function fresh(packet: CapabilityPacket) {
    const unit = input.manifest.units.find((u) => u.id === packet.unit.id);
    if (!unit) throw new Error('Catalogue unit is absent from the current manifest.');
    const result = await deps.verifyPacket(packet, {
      rootPath: input.rootPath,
      scope,
      unit,
      manifestRevision: input.manifest.revision,
    });
    if (!result.fresh) throw new Error(result.reason);
  }
  // Request-local snapshot only. Independent readCurrent calls never use it.
  let history: Promise<{ priors: CapabilityReviewPrior[]; truncated: boolean }> | undefined;
  function readHistory() {
    return (history ??= (async () => {
      const [ideas, runs] = await Promise.all([
        deps.ideas(ideaOpts),
        deps.runs(input.sql, { workspaceId: scope.workspaceId, potSlug: scope.potSlug, limit: RUN_LIMIT }),
      ]);
      await Promise.all(input.packets.map(fresh));
      return {
        priors: [
          ...input.packets.flatMap((p) =>
            packetPriors(p).map((value) => remember(value, { kind: 'code', id: p.unit.id })),
          ),
          ...ideas.map((idea) =>
            remember(ideaPrior(scope, idea), { kind: 'idea', id: idea.ideaId, subref: idea.routedRef }),
          ),
          ...runs
            .filter((r) => r.status !== 'running' && r.outcome !== null)
            .map((run) => remember(runPrior(scope, run), { kind: 'dream', id: run.runId })),
        ],
        truncated: ideas.length >= IDEA_LIMIT || runs.length >= RUN_LIMIT,
      };
    })());
  }
  return {
    search: async (request: CapabilityReviewSearch, signal): Promise<CapabilityReviewSearchResult> => {
      signal?.throwIfAborted();
      if (!sameScope(request.scope, scope)) throw new Error('Search request crosses configured scope.');
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 8)
        throw new RangeError('Invalid review search limit.');
      const tokens = dedupSignature(request.query)
        .split(' ')
        .filter((t) => t.length > 2)
        .slice(0, 16);
      if (!tokens.length)
        return {
          scope,
          kinds: CAPABILITY_PRIOR_KINDS,
          status: 'unknown',
          matches: [],
          truncated: false,
          note: 'No searchable facet vocabulary.',
        };
      const [snapshot, plans] = await Promise.all([
        readHistory(),
        deps.plans(tokens, { ...planOpts, includeArchived: true, limit: PLAN_LIMIT }),
      ]);
      signal?.throwIfAborted();
      const values = [
        ...snapshot.priors,
        ...plans.rows.map((p) => remember(planPrior(scope, p), { kind: 'plan', id: p.planSlug })),
      ];
      return {
        scope,
        kinds: CAPABILITY_PRIOR_KINDS,
        status: 'current',
        matches: shortlist(request.query, values, request.limit),
        truncated:
          snapshot.truncated ||
          plans.truncated ||
          values.length > request.limit ||
          values.some((p) => p.text.length === 12_000),
        note:
          'Current bounded lexical search: admitted capability code/tests; matching plans including archives; ' +
          'latest ' +
          IDEA_LIMIT +
          ' ordinary routed Blender ideas; latest ' +
          RUN_LIMIT +
          ' Dream attempts including rejects. ' +
          'Unmapped code, older evicted attempts and unrouted Scout critique artifacts are outside this search; global novelty is not established.',
      };
    },
    readCurrent: async (p, signal) => {
      signal?.throwIfAborted();
      if (!sameScope(p.scope, scope)) return null;
      const locator = locators.get(p.ref) ?? p.locator;
      if (!locator) return null;
      const located = (value: CapabilityReviewPrior | null) =>
        value?.ref === p.ref ? { ...value, ...(p.locator ? { locator: p.locator } : {}) } : null;
      if (locator.kind === 'code') {
        const packet = packets.get(locator.id)!;
        await fresh(packet);
        return located(packetPriors(packet).find((current) => current.ref === p.ref) ?? null);
      }
      if (locator.kind === 'plan') {
        const row = await deps.plan(locator.id, planOpts);
        return located(row ? planPrior(scope, row) : null);
      }
      if (locator.kind === 'idea') {
        const ideas = await deps.ideas({ ...ideaOpts, ideaIds: [locator.id] });
        const idea = ideas.find((i) => i.routedRef === locator.subref);
        return located(idea ? ideaPrior(scope, idea) : null);
      }
      const run = await deps.run(input.sql, { workspaceId: scope.workspaceId, runId: locator.id });
      return located(run ? runPrior(scope, run) : null);
    },
  };
}
