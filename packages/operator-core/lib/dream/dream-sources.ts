/**
 * Production source adapter for REM dreaming (P-005).
 *
 * The dream engine consumes the four distilled strata ratified in the plan:
 * observation-lane sensor readings, terminal work with completion evidence,
 * pot-scoped memories, and textualized existing Analyze-cycle statistics.  It
 * extends those established reads and resolves the existing prose embedder
 * once per cycle; there is no raw-turn store or parallel analytics pipeline.
 */
import type { Sql } from 'postgres';
import { getMemoryBackend, type MemoryEntry } from '../memory/backend';
import { hiveScopeKey } from '../memory/hive-scope';
import { loadHarnessRegistry, hiveMemberHarnessScopes, type ProjectEntry } from '../harness-registry';
import { readObservationItems, type ReadImprovementOpts } from '../harness/improvements/read-items';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { listWorkItems, TERMINAL_WORK_ITEM_STATES, type ListWorkItemsFilter, type WorkItem } from '../work-items';
import { readAnalyzeSnapshot, type AnalyzeSnapshot } from '../sync-resolver/learning-analyze-read';
import { resolveBackfillEmbedder } from '../search/embed-backfill';
import { resolveDreamSamplerConfig, type DreamSamplerConfig } from './dream-config';
import { indexDreamFragments, type DreamFragment } from './fragment-sampler';
import { runWithWorkspace } from '../workspace-als';
import { resolveIssuesScopeWorkspace } from '../issues-engineer';
import { capabilityHash } from './capability-contracts';
import { scopeDreamProblems, type DreamProblemContext, type DreamProblemEvidence } from './capability-pass';

const SOURCE_READ_LIMIT = 2_000;
const DEFAULT_EMBED_CONCURRENCY = 4;

type ResolvedDreamEmbedder =
  | { mode: string; dims: number; embed: (text: string) => Promise<number[]> }
  | { mode: 'disabled'; reason?: string }
  | null;

export interface DreamSourceDeps {
  loadRegistry: (workspaceId: string) => Promise<{ projects: ProjectEntry[] }>;
  readObservations: (opts: ReadImprovementOpts) => Promise<ImprovementCandidate[]>;
  readWorkItems: (filter: ListWorkItemsFilter) => Promise<WorkItem[]>;
  listMemories: (scope: string) => Promise<MemoryEntry[]>;
  readAnalyze: (sql: Sql, workspaceId: string) => Promise<AnalyzeSnapshot>;
  resolveEmbedder: () => Promise<ResolvedDreamEmbedder>;
}

const defaultDeps: DreamSourceDeps = {
  loadRegistry: loadHarnessRegistry,
  readObservations: (opts) => readObservationItems(opts),
  readWorkItems: (filter) => listWorkItems(filter),
  listMemories: async (scope) => getMemoryBackend().list({ scope }),
  readAnalyze: (sql, workspaceId) => readAnalyzeSnapshot(sql, workspaceId),
  resolveEmbedder: () => resolveBackfillEmbedder(),
};

/** Bounded problem context reuses the observation and work-item readers. No new
 * corpus/index or automatic work creation. A report is attributable, not proven. */
export async function readDreamProblemContext(
  input: { workspaceId: string; potSlug: string },
  deps: Pick<DreamSourceDeps, 'readObservations' | 'readWorkItems'> = defaultDeps,
): Promise<DreamProblemContext> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const potSlug = required(input.potSlug, 'potSlug');
  return runWithWorkspace(workspaceId, async () => {
    // Legacy shared issue storage cannot establish this workspace's provenance.
    if (deps === defaultDeps && resolveIssuesScopeWorkspace(workspaceId) !== workspaceId)
      return { mode: 'open-exploration', evidence: [], note: 'Problem evidence unavailable: issue storage cannot establish workspace scope.' };
    const [observations, requirements] = await Promise.all([
      deps.readObservations({ harnessScopes: ['harness:' + potSlug], state: 'open', limit: 12 }),
      deps.readWorkItems({ harness: potSlug, kind: 'feature', notTerminal: true, limit: 12 }),
    ]);
    const evidence: DreamProblemEvidence[] = [];
    const add = (ref: string, kind: DreamProblemEvidence['kind'], attributedTo: string | null | undefined, capturedAt: string | undefined, content: string) => {
      if (!attributedTo?.trim() || !capturedAt || !Number.isFinite(Date.parse(capturedAt)) || !content.trim()) return;
      const excerpt = content.trim().slice(0, 4_000);
      evidence.push({ ref, kind, workspaceId, potSlug, attributedTo, capturedAt: new Date(capturedAt).toISOString(), text: excerpt, contentHash: capabilityHash(excerpt) });
    };
    for (const row of observations) {
      if (row.scope !== 'harness:' + potSlug || (row.state && row.state !== 'open')) continue;
      add('observation:' + row.id, 'observation', row.createdBy, row.updatedAt ?? row.createdAt, text(row.title, row.body));
    }
    for (const row of requirements) {
      if (row.harness !== potSlug || row.kind !== 'feature' || TERMINAL_WORK_ITEM_STATES.includes(row.state as never)) continue;
      add('wi:' + row.id, 'requirement', row.createdBy, row.updatedAt, text(row.title, row.summary));
    }
    return scopeDreamProblems(evidence, { workspaceId, potSlug });
  });
}

export interface ReadDreamSourcesInput {
  sql: Sql;
  workspaceId: string;
  potSlug: string;
  sampler?: Partial<DreamSamplerConfig>;
  now?: number;
  embedConcurrency?: number;
}

export interface DreamSourceCensus {
  observations: number;
  workItems: number;
  memories: number;
  stats: number;
  indexed: number;
  embedded: number;
}

export interface DreamSourceSnapshot {
  fragments: DreamFragment[];
  census: DreamSourceCensus;
  harnessScopes: string[];
  embeddingMode: string;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${name} must be a non-empty string`);
  return normalized;
}

function text(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

function severitySalience(severity: string | undefined | null): number {
  return severity === 'critical' ? 4 : severity === 'major' ? 3 : severity === 'minor' ? 2 : 1;
}

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function completionEvidence(item: WorkItem): string | null {
  const direct = item.terminalCompletionRef?.trim();
  if (direct) return direct;
  const structured = payloadObject(item.payload)._completionEvidence;
  if (!structured) return null;
  try {
    const encoded = JSON.stringify(structured);
    return encoded && encoded !== '{}' ? encoded : null;
  } catch {
    return null;
  }
}

function metadataTimestamp(entry: MemoryEntry): string {
  const metadata = entry.metadata ?? {};
  for (const key of ['createdAt', 'created_at', 'timestamp', 'updatedAt', 'updated_at']) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const millis = value < 1_000_000_000_000 ? value * 1_000 : value;
      const date = new Date(millis);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
      return new Date(value).toISOString();
    }
  }
  return '';
}

function observationsToFragments(rows: readonly ImprovementCandidate[], potSlug: string): DreamFragment[] {
  return rows.map((row) => ({
    id: `observation:${row.id}`,
    kind: 'observation',
    ref: `observation:${row.id}`,
    text: text(row.title, row.body),
    createdAt: row.createdAt ?? row.updatedAt ?? '',
    harness: potSlug,
    salience: severitySalience(row.severity),
  }));
}

function workItemsToFragments(rows: readonly WorkItem[], potSlug: string): DreamFragment[] {
  const out: DreamFragment[] = [];
  for (const item of rows) {
    const evidence = completionEvidence(item);
    // Migration 864 made payload.needsHuman historical metadata only. A terminal row
    // with completion evidence remains a valid Dream signal even if that legacy key
    // survived in its history; only missing completion evidence excludes it here.
    if (!evidence) continue;
    out.push({
      id: `work-item:${item.id}`,
      kind: 'work_item',
      ref: `wi:${item.id}`,
      text: text(item.title, item.summary, `Completion evidence: ${evidence}`),
      createdAt: item.closedAt ?? item.updatedAt,
      harness: potSlug,
      salience: item.terminalCompletionEvidence ? 3 : item.completionAuthority ? 2 : 1,
    });
  }
  return out;
}

function memoriesToFragments(rows: readonly MemoryEntry[], potSlug: string): DreamFragment[] {
  return rows.map((entry) => ({
    id: `memory:${entry.id}`,
    kind: 'memory',
    ref: `memory:${entry.id}`,
    text: entry.text,
    createdAt: metadataTimestamp(entry),
    harness: potSlug,
    salience:
      typeof entry.metadata?.salience === 'number' && Number.isFinite(entry.metadata.salience)
        ? Math.max(0, entry.metadata.salience)
        : 1,
  }));
}

function statsToFragments(snapshot: AnalyzeSnapshot, potSlug: string): DreamFragment[] {
  return snapshot.cycles
    .filter((cycle) => cycle.at && Number.isFinite(Date.parse(cycle.at)))
    .map((cycle) => {
      const tick = cycle.tick;
      const economics = tick
        ? `status=${tick.status ?? 'unknown'} stop=${tick.stop ?? 'unknown'} generated=${tick.generated} routed=${tick.routed} deduped=${tick.deduped} spendUsd=${tick.spendUsd ?? 'unknown'}`
        : 'tick economics unavailable';
      return {
        id: `stat:analyze:${cycle.cycleId}`,
        kind: 'stat' as const,
        ref: `analyze-cycle:${cycle.cycleId}`,
        text: `Analyze cycle ${cycle.cycleId}: ideas=${cycle.ideasCount} proposals=${cycle.proposalsCount} routed=${cycle.routedCount}; verdicts=${cycle.verdicts.join(',') || 'none'}; ${economics}`,
        createdAt: cycle.at!,
        harness: potSlug,
        salience: Math.max(1, cycle.routedCount + (tick?.deduped ?? 0)),
      };
    });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      out[index] = await fn(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Read, age/quota bound, then embed the four production strata exactly once. */
export async function readDreamSources(
  input: ReadDreamSourcesInput,
  deps: DreamSourceDeps = defaultDeps,
): Promise<DreamSourceSnapshot> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const potSlug = required(input.potSlug, 'potSlug');
  const sampler = resolveDreamSamplerConfig(input.sampler);
  const now = input.now ?? Date.now();
  const embedConcurrency = Math.floor(input.embedConcurrency ?? DEFAULT_EMBED_CONCURRENCY);
  if (!Number.isInteger(embedConcurrency) || embedConcurrency <= 0 || embedConcurrency > 16) {
    throw new RangeError('embedConcurrency must be an integer between 1 and 16');
  }

  const registry = await deps.loadRegistry(workspaceId);
  const harnessScopes = hiveMemberHarnessScopes(registry.projects, potSlug);
  const harnesses = harnessScopes.map((scope) => scope.slice('harness:'.length));
  const [observations, workItems, memories, analyze] = await Promise.all([
    deps.readObservations({ harnessScopes, limit: SOURCE_READ_LIMIT }),
    deps.readWorkItems({
      harnesses,
      states: TERMINAL_WORK_ITEM_STATES,
      includeChildren: true,
      limit: SOURCE_READ_LIMIT,
    }),
    deps.listMemories(hiveScopeKey(potSlug)),
    deps.readAnalyze(input.sql, workspaceId),
  ]);

  const observationFragments = observationsToFragments(observations, potSlug);
  const workItemFragments = workItemsToFragments(workItems, potSlug);
  const memoryFragments = memoriesToFragments(memories, potSlug);
  const statFragments = statsToFragments(analyze, potSlug);
  const raw = [...observationFragments, ...workItemFragments, ...memoryFragments, ...statFragments];
  const indexed = indexDreamFragments(raw, { harness: potSlug, now, config: sampler });
  const candidates = [...Object.values(indexed.recent).flat(), ...Object.values(indexed.remote).flat()];

  const resolved = await deps.resolveEmbedder();
  if (!resolved || resolved.mode === 'disabled' || !('embed' in resolved)) {
    const disabledReason = resolved && 'reason' in resolved ? resolved.reason : undefined;
    throw new Error(
      `dream sources require the existing prose embedder for banded pairing${disabledReason ? `: ${disabledReason}` : ''}`,
    );
  }
  const fragments = await mapConcurrent(candidates, embedConcurrency, async (fragment) => {
    const embedding = await resolved.embed(fragment.text);
    if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
      throw new Error(`dream source ${fragment.ref} produced an invalid embedding`);
    }
    return { ...fragment, embedding };
  });

  return {
    fragments,
    harnessScopes,
    embeddingMode: resolved.mode,
    census: {
      observations: observationFragments.length,
      workItems: workItemFragments.length,
      memories: memoryFragments.length,
      stats: statFragments.length,
      indexed: candidates.length,
      embedded: fragments.length,
    },
  };
}

/** Existing-prior adapter for dream-review's shared novelty matcher. */
export function dreamCorpusFromFragments(
  fragments: readonly DreamFragment[],
): Array<{ ref: string; kind: 'improvement' | 'memory' | 'digest-pattern'; text: string }> {
  return fragments.map((fragment) => ({
    ref: fragment.ref,
    kind: fragment.kind === 'memory' ? 'memory' : fragment.kind === 'stat' ? 'digest-pattern' : 'improvement',
    text: fragment.text,
  }));
}
