/**
 * Lazy retrieval + rendering for EI-6139's repeated-failure intervention.
 *
 * The dispatcher hot path only records a bounded, value-free signal in
 * failure-loop-circuit-breaker.ts. The heavier corpus reads happen here, after
 * the next mid-turn delivery boundary drains that signal. This reuses the
 * existing agent-insights index and recipe hybrid search rather than creating a
 * third knowledge store or search engine.
 */

import type { SimilarRecipe } from './code-recipes-search';
import type { FailureLoopHint } from './failure-loop-circuit-breaker';
import type { InsightEntry } from './memory/insights-index';

const MAX_INSIGHTS = 3;
const MAX_RECIPES = 2;
const MAX_LABEL_CHARS = 180;
const MAX_HINT_CHARS = 1_200;

const LOW_SIGNAL_TOKENS = new Set([
  'dispatch',
  'error',
  'failed',
  'failure',
  'get',
  'list',
  'read',
  'refused',
  'set',
  'tool',
  'write',
]);

export interface FailureLoopHintDeps {
  readInsights?: () => Promise<InsightEntry[]>;
  searchRecipes?: (hint: FailureLoopHint) => Promise<SimilarRecipe[]>;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !LOW_SIGNAL_TOKENS.has(token)),
  );
}

function overlapScore(query: Set<string>, value: string, weight: number): number {
  const haystack = tokens(value);
  let score = 0;
  for (const token of query) if (haystack.has(token)) score += weight;
  return score;
}

/** Pure lexical rank over the already-curated, non-retired insight index. */
export function rankFailureLoopInsights(
  entries: readonly InsightEntry[],
  hint: Pick<FailureLoopHint, 'toolName' | 'errorClass'>,
): InsightEntry[] {
  const query = tokens(`${hint.toolName} ${hint.errorClass}`);
  if (query.size === 0) return [];

  return entries
    .map((entry) => ({
      entry,
      score:
        overlapScore(query, entry.title, 4) +
        overlapScore(query, entry.slug, 3) +
        overlapScore(query, entry.tags.join(' '), 2) +
        overlapScore(query, entry.description, 1),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.slug.localeCompare(b.entry.slug))
    .slice(0, MAX_INSIGHTS)
    .map(({ entry }) => entry);
}

async function readInsights(): Promise<InsightEntry[]> {
  // Kept dynamic so ordinary settled tool calls never load the docs reader or
  // touch the filesystem. Only a drained third-failure signal reaches here.
  const [{ readInsightsDir }, { INSIGHTS_DIR }] = await Promise.all([
    import('./memory/insights-index'),
    import('./memory/knowledge-read'),
  ]);
  return readInsightsDir(INSIGHTS_DIR);
}

async function findRecipes(hint: FailureLoopHint): Promise<SimilarRecipe[]> {
  // The recipe index is already the canonical hybrid search surface. Pass no
  // embedder here: this interruption is latency-sensitive, and lexical plus the
  // exact tool-set overlap is enough to produce a bounded hint.
  const [{ getOrgPg }, { searchSimilarRecipes }] = await Promise.all([
    import('@papercusp/db-org'),
    import('./code-recipes-search'),
  ]);
  return searchSimilarRecipes(getOrgPg().sql, {
    title: `${hint.toolName} ${hint.errorClass}`,
    description: 'recover from a repeated failing tool call',
    toolsUsed: [hint.toolName],
    embedding: null,
    limit: MAX_RECIPES,
  });
}

function compact(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_LABEL_CHARS ? oneLine : `${oneLine.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`;
}

function clampHint(text: string): string {
  if (text.length <= MAX_HINT_CHARS) return text;
  const cut = text.slice(0, MAX_HINT_CHARS);
  const lineEnd = cut.lastIndexOf('\n');
  return `${(lineEnd > MAX_HINT_CHARS * 0.6 ? cut.slice(0, lineEnd) : cut).trimEnd()}\n…`;
}

/**
 * Build one bounded, actionable advisory. Each retrieval leg fails soft and the
 * base intervention survives even when both knowledge sources are unavailable.
 */
export async function buildFailureLoopHintText(hint: FailureLoopHint, deps: FailureLoopHintDeps = {}): Promise<string> {
  if (hint.kind === 'repetition') {
    return `⟦repeated-work⟧ ${hint.count} equivalent \`${hint.toolName}\` calls returned unchanged information. ` +
      (hint.category === 'test' ? 'The declared source/test fingerprints also match. Reuse the saved evidence, or provide recheckReason when another run is necessary.'
        : hint.category === 'schema' ? 'Reuse the schema already returned; read a different contract when the next action requires it.'
        : 'Use the saved status or await the relevant change; another check is useful when new evidence or an expected transition justifies it.') +
      ' This is an advisory; it does not block execution.';
  }
  const [insights, recipes] = await Promise.all([
    (deps.readInsights ?? readInsights)().catch(() => []),
    (deps.searchRecipes ?? findRecipes)(hint).catch(() => []),
  ]);
  const rankedInsights = rankFailureLoopInsights(insights, hint);

  const lines = [
    '⟦failure-loop⟧ Repeated tool failure detected.',
    `You called \`${hint.toolName}\` with the same argument shape and \`${hint.errorClass}\` ${hint.count} times.`,
  ];

  if (rankedInsights.length > 0) {
    lines.push('Matching agent insights:');
    for (const insight of rankedInsights) {
      lines.push(
        `- \`${insight.slug}\` — ${compact(insight.title)} (` + `\`docs:get { slugs: ['${insight.slug}'] }\`)`,
      );
    }
  }
  if (recipes.length > 0) {
    lines.push('Matching reusable recipes:');
    for (const recipe of recipes.slice(0, MAX_RECIPES)) {
      lines.push(`- \`${recipe.id}\` — ${compact(recipe.title)} (refresh via \`recipes:search\` before running)`);
    }
  }

  if (rankedInsights.length === 0 && recipes.length === 0) {
    lines.push('No matching indexed runbook or recipe was found.');
  }
  lines.push('Inspect a reference or change the call shape before retrying the same failure.');
  return clampHint(lines.join('\n'));
}
