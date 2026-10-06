/**
 * SU-S37 / WORKER-W01 — code-search discipline: the agent-side baseline for
 * GitNexus adoption (gitnexus-deterministic-integration-2026-10-05 P-015,
 * SPEC-P-015 and AUTO-BAR-R-3-P-015).
 *
 * Three questions an engineer asks every day, each in a hermetic world:
 *
 *   (a) "Is resolveLegacyRoute still used anywhere?" — the answer is YES: two
 *       production callers in OTHER workspaces. A `grep -rn … | head -N` (N ≤ 60)
 *       shows only the definition, 58 test lines and a doc line, because grep walks
 *       those paths first. An agent that reads that truncated window and says
 *       "no callers / safe to delete" has concluded absence from a search that never
 *       reached the answer — the exact failure the project guide warns about. The
 *       complete instruments (`graph:query callers`, `lsp:query references`,
 *       `grep -rl`, an unbounded grep, `| wc -l`) all surface the callers.
 *   (b) "What breaks if I change buildSyncEnvelope's signature?" — three consumers
 *       in three OTHER workspaces (apps/operator, libs/sync, papercusp-desktop) plus
 *       one in the defining workspace. The answer must name the cross-workspace ones.
 *   (c) "Where is parseHarnessManifest defined?" — a definition lookup is compiler
 *       (LSP) or text-search (rg/grep) work, NOT graph work (P-002's routing).
 *
 * Run for two targets via `makeS37Scenarios`: `su-code` (the su playbook) and
 * `worker` (the coding-role prompt). Same world, same asserts — the only variables
 * are the prompt and the offered catalog.
 *
 * Baselines are recorded on the plan (P-015), re-run after P-002 / P-010 / P-014;
 * P-012 reports the change.
 */

import { BRIEF_ADMIN, PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type {
  DeterministicAssert,
  RunSummary,
  Scenario,
  ToolCallEvent,
  ToolDispatchOverride,
  Violation,
} from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { effectiveToolCall } from './_asserts';

type CustomAssert = Extract<DeterministicAssert, { kind: 'custom' }>;

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

interface Site {
  file: string;
  line1: number;
  text: string;
}

export const S37_ABSENCE_SYMBOL = 'resolveLegacyRoute';
export const S37_IMPACT_SYMBOL = 'buildSyncEnvelope';
export const S37_DEFINITION_SYMBOL = 'parseHarnessManifest';

/** The graph index the world reports; an answer that used the graph must state its age. */
export const S37_INDEX = { commit: '9819960751', ageHours: 3.4, indexedAt: '2026-10-05T23:58:00Z' } as const;

const ABSENCE_DEF: Site = {
  file: 'packages/operator-core/lib/routing/legacy-route.ts',
  line1: 42,
  text: 'export function resolveLegacyRoute(path: string, table: LegacyRouteTable): RouteTarget | null {',
};
const ABSENCE_TEST_FILE = 'packages/operator-core/lib/routing/__tests__/legacy-route.test.ts';
/** The two production callers — both in workspaces OTHER than the defining one. */
export const S37_ABSENCE_CALLERS: readonly Site[] = [
  {
    file: 'apps/operator/lib/endpoint-route/dispatch.ts',
    line1: 118,
    text: 'const route = resolveLegacyRoute(req.path, legacyTable);',
  },
  {
    file: 'packages/agent-mcp/src/tools/route-proxy.ts',
    line1: 57,
    text: 'return resolveLegacyRoute(target, opts.table) ?? fallback;',
  },
];
/** grep's walk order: definition, 58 test lines, one doc line, THEN the callers (lines 61–62). */
const ABSENCE_GREP: readonly Site[] = [
  ABSENCE_DEF,
  ...Array.from({ length: 58 }, (_, i): Site => ({
    file: ABSENCE_TEST_FILE,
    line1: 12 + i * 4,
    text: `    expect(resolveLegacyRoute('/legacy/case-${i + 1}', table)).toEqual(expected[${i}]);`,
  })),
  { file: 'docs/routing/legacy-routes.md', line1: 9, text: '`resolveLegacyRoute` maps a pre-v2 path to its v2 route.' },
  ...S37_ABSENCE_CALLERS,
];

const IMPACT_DEF: Site = {
  file: 'packages/operator-core/lib/sync/envelope.ts',
  line1: 21,
  text: 'export function buildSyncEnvelope(query: SyncQueryName, rows: unknown[]): SyncEnvelope {',
};
const IMPACT_SAME_WORKSPACE: Site = {
  file: 'packages/operator-core/lib/sync-sse.ts',
  line1: 60,
  text: 'res.write(encode(buildSyncEnvelope(name, rows)));',
};
/** The consumers in OTHER workspaces — the ones a signature change breaks silently. */
export const S37_IMPACT_CONSUMERS: readonly Site[] = [
  {
    file: 'apps/operator/providers/HarnessSyncProvider.tsx',
    line1: 88,
    text: 'const envelope = buildSyncEnvelope(queryName, cached);',
  },
  { file: 'libs/sync/src/client.ts', line1: 140, text: 'return buildSyncEnvelope(this.query, payload.rows);' },
  { file: 'papercusp-desktop/src/bridge/sync.ts', line1: 33, text: 'emit(buildSyncEnvelope(q, rows));' },
];
const IMPACT_GREP: readonly Site[] = [
  IMPACT_DEF,
  ...Array.from({ length: 30 }, (_, i): Site => ({
    file: 'packages/operator-core/lib/sync/__tests__/envelope.test.ts',
    line1: 8 + i * 5,
    text: `    const env = buildSyncEnvelope('query-${i + 1}', rows);`,
  })),
  IMPACT_SAME_WORKSPACE,
  ...S37_IMPACT_CONSUMERS,
];

export const S37_DEFINITION_SITE: Site = {
  file: 'packages/operator-core/lib/harness/manifest.ts',
  line1: 17,
  text: 'export function parseHarnessManifest(raw: string): HarnessManifest {',
};
const DEFINITION_GREP: readonly Site[] = [
  { file: 'packages/operator-core/lib/harness/loader.ts', line1: 31, text: 'const manifest = parseHarnessManifest(text);' },
  S37_DEFINITION_SITE,
  { file: 'packages/operator-core/lib/harness/manifest.test.ts', line1: 9, text: "expect(parseHarnessManifest('{}')).toBeDefined();" },
  { file: 'apps/operator/lib/harness/install.ts', line1: 74, text: 'parseHarnessManifest(await readFile(p, "utf8"))' },
];

const GREP_BY_SYMBOL: Record<string, readonly Site[]> = {
  [S37_ABSENCE_SYMBOL]: ABSENCE_GREP,
  [S37_IMPACT_SYMBOL]: IMPACT_GREP,
  [S37_DEFINITION_SYMBOL]: DEFINITION_GREP,
};
const SYMBOLS = Object.keys(GREP_BY_SYMBOL);

const FRESHNESS = {
  indexedCommit: S37_INDEX.commit,
  indexedAt: S37_INDEX.indexedAt,
  ageHours: S37_INDEX.ageHours,
  stale: false,
  note: 'Built from the last committed tree; uncommitted edits are not in the graph.',
};
const COVERAGE = {
  exhaustive: false,
  note: 'Static call edges only; dynamic dispatch and string-keyed lookups are not in the graph.',
};

function symbolIn(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return SYMBOLS.find((s) => text.includes(s));
}

function grepLine(s: Site): string {
  return `${s.file}:${s.line1}:${s.text}`;
}

function patternTest(pattern: string, line: string): boolean {
  try {
    return new RegExp(pattern.replace(/\\\|/g, '|')).test(line);
  } catch {
    return line.includes(pattern);
  }
}

function argOf(segment: string, flag: RegExp): string | undefined {
  const m = segment.match(flag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** `head -n 20` / `head -20` / bare `head` (10). */
function lineCount(segment: string): number {
  const m = segment.match(/\s-n\s*(\d+)|\s-(\d+)/);
  return m ? Number(m[1] ?? m[2]) : 10;
}

/**
 * A faithful-enough shell for the three symbols: the search segment (grep / rg /
 * git grep) yields lines in the world's walk order, honouring -l / -c and
 * --exclude / --exclude-dir; later pipe segments apply grep / grep -v / head /
 * tail / wc -l in order. Anything else answers as a command with no output.
 */
export function s37Shell(cmd: string): string {
  const symbol = symbolIn(cmd);
  if (!symbol) return '';
  const segments = cmd.split('|').map((s) => s.trim());
  const searchIdx = segments.findIndex((s) => /\b(grep|rg)\b/.test(s) && s.includes(symbol));
  if (searchIdx < 0) return '';
  const search = segments[searchIdx];
  let sites = [...GREP_BY_SYMBOL[symbol]];
  for (const m of search.matchAll(/--exclude-dir[= ](?:'([^']+)'|"([^"]+)"|(\S+))/g)) {
    const dirs = (m[1] ?? m[2] ?? m[3]).replace(/[{}]/g, '').split(',');
    sites = sites.filter((s) => !dirs.some((d) => s.file.split('/').includes(d)));
  }
  for (const m of search.matchAll(/--exclude[= ](?:'([^']+)'|"([^"]+)"|(\S+))/g)) {
    const suffix = (m[1] ?? m[2] ?? m[3]).replace(/^\*/, '');
    sites = sites.filter((s) => !s.file.endsWith(suffix));
  }
  for (const m of search.matchAll(/(?:-g|--glob)[= ](?:'!([^']+)'|"!([^"]+)"|!(\S+))/g)) {
    const suffix = (m[1] ?? m[2] ?? m[3]).replace(/^\*+\/?/, '').replace(/^\*/, '');
    sites = sites.filter((s) => !s.file.includes(suffix));
  }
  const shortFlags = (search.match(/\s-[a-zA-Z]+/g) ?? []).join('');
  let out: string[];
  if (/l/.test(shortFlags) || /--files-with-matches/.test(search)) {
    out = [...new Set(sites.map((s) => s.file))];
  } else if (/c/.test(shortFlags) || /--count\b/.test(search)) {
    const counts = new Map<string, number>();
    for (const s of sites) counts.set(s.file, (counts.get(s.file) ?? 0) + 1);
    out = [...counts].map(([f, n]) => `${f}:${n}`);
  } else {
    out = sites.map(grepLine);
  }
  for (const seg of segments.slice(searchIdx + 1)) {
    if (/^grep\s/.test(seg)) {
      const invert = /\s-[a-zA-Z]*v/.test(seg);
      const pattern = argOf(seg, /\s(?:-[a-zA-Z]+\s+)*(?:'([^']+)'|"([^"]+)"|([^\s-]\S*))\s*$/);
      if (pattern) out = out.filter((line) => patternTest(pattern, line) !== invert);
    } else if (/^head\b/.test(seg)) {
      out = out.slice(0, lineCount(seg));
    } else if (/^tail\b/.test(seg)) {
      out = out.slice(-lineCount(seg));
    } else if (/^wc\s+-l\b/.test(seg)) {
      out = [String(out.length)];
    }
  }
  return out.join('\n');
}

function sitesFor(symbol: string | undefined, op: string): Site[] {
  if (symbol === S37_ABSENCE_SYMBOL) {
    if (op === 'symbol' || op === 'symbol-search') return [ABSENCE_DEF];
    if (op === 'callees') return [];
    return [...S37_ABSENCE_CALLERS];
  }
  if (symbol === S37_IMPACT_SYMBOL) {
    if (op === 'symbol' || op === 'symbol-search') return [IMPACT_DEF];
    if (op === 'callees') return [];
    return [IMPACT_SAME_WORKSPACE, ...S37_IMPACT_CONSUMERS];
  }
  if (symbol === S37_DEFINITION_SYMBOL) return [S37_DEFINITION_SITE];
  return [];
}

function json(value: unknown): { content: Array<{ text: string }> } {
  return { content: [{ text: JSON.stringify(value) }] };
}

function readWindow(file: string): string | undefined {
  const all = [...ABSENCE_GREP, ...IMPACT_GREP, ...DEFINITION_GREP];
  const hits = all.filter((s) => s.file === file);
  if (!hits.length) return undefined;
  return hits.slice(0, 6).map((s) => `${String(s.line1).padStart(5)}\t${s.text}`).join('\n');
}

export const S37_WORLD: ToolDispatchOverride = {
  override(name, args) {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === 'capability:bash') {
      const cmd = String(a.cmd ?? a.command ?? '');
      const output = s37Shell(cmd);
      return json({ ok: true, exit_code: output ? 0 : 1, output });
    }
    if (name === 'graph:query') {
      const op = String(a.op ?? '');
      if (op === 'health') return json({ ok: true, freshness: FRESHNESS, coverage: COVERAGE });
      const symbol = symbolIn(a.name);
      const sites = sitesFor(symbol, op);
      return json({
        sites: sites.map((s) => ({ file: s.file, line1: s.line1, snippet: s.text })),
        truncation: { truncated: false },
        freshness: FRESHNESS,
        coverage: COVERAGE,
        latencyMs: 41,
        error: symbol ? null : { code: 'symbol_not_found', message: `No symbol named ${String(a.name)} in the index.` },
      });
    }
    if (name === 'gitnexus.context') {
      const symbol = symbolIn(a.name);
      if (!symbol) return json({ error: `symbol not found: ${String(a.name)}` });
      const [def] = sitesFor(symbol, 'symbol');
      return json({
        symbol,
        definedAt: def ? { file: def.file, line1: def.line1 } : null,
        callers: sitesFor(symbol, 'callers').map((s) => ({ file: s.file, line1: s.line1 })),
        callees: [],
        freshness: FRESHNESS,
      });
    }
    if (name === 'gitnexus.query') {
      return json({
        processes: [
          { name: 'RouteTableWarmup', steps: 4, relevance: null },
          { name: 'HarnessInstallFlow', steps: 7, relevance: null },
          { name: 'SyncFanout', steps: 5, relevance: null },
        ],
        note: 'Results are not ranked.',
      });
    }
    if (name === 'lsp:query') {
      const op = String(a.op ?? '');
      if (op === 'health') return json({ ok: true, servers: [{ language: 'typescript', ready: true }] });
      const file = typeof a.file === 'string' ? a.file : '';
      const symbol =
        symbolIn(a.query) ??
        SYMBOLS.find((s) => GREP_BY_SYMBOL[s].some((site) => file.endsWith(site.file))) ??
        undefined;
      let sites: Site[] = [];
      if (symbol && (op === 'symbol' || op === 'workspace_symbols' || op === 'implementations')) {
        sites = sitesFor(symbol, 'symbol');
      } else if (symbol && op === 'references') {
        sites = GREP_BY_SYMBOL[symbol].filter((s) => s !== sitesFor(symbol, 'symbol')[0]);
      }
      return json({
        sites: sites.map((s) => ({ file: s.file, line1: s.line1, snippet: s.text })),
        truncation: { truncated: false },
        freshness: { source: 'working-tree' },
        coverage: { exhaustive: true },
        latencyMs: 120,
        error: symbol ? null : { code: 'no_symbol', message: 'No identifier at that position; pass file + line1 + character.' },
      });
    }
    if (name === 'capability:read') {
      const path = String(a.file_path ?? '');
      const rel = SYMBOLS.flatMap((s) => GREP_BY_SYMBOL[s]).find((s) => path.endsWith(s.file))?.file;
      const body = rel ? readWindow(rel) : undefined;
      if (body) return { content: [{ text: body }] };
    }
    return PASS_THROUGH;
  },
};

// ---------------------------------------------------------------------------
// Asserts
// ---------------------------------------------------------------------------

interface Meta {
  name: string;
  claim: string;
  suggestion: string;
}

function violation(meta: Meta, evidenceTurnIdx?: number): Violation {
  return {
    assertKind: `custom:${meta.name}`,
    severity: 'error',
    ...(evidenceTurnIdx !== undefined ? { evidenceTurnIdx } : {}),
    claim: meta.claim,
    suggestion: meta.suggestion,
  };
}

function calls(run: RunSummary): Array<{ name: string; input: Record<string, unknown> }> {
  return run.turns.flatMap((t) => t.toolCalls).map((tc: ToolCallEvent) => effectiveToolCall(tc));
}

function allText(run: RunSummary): string {
  return run.turns.map((t) => t.assistantText ?? '').join('\n');
}

/** The answer under test: the last turn that said anything. */
function finalAnswer(run: RunSummary): { text: string; idx: number } {
  for (let i = run.turns.length - 1; i >= 0; i--) {
    const text = run.turns[i].assistantText ?? '';
    if (text.trim()) return { text, idx: i };
  }
  return { text: '', idx: -1 };
}

const NEGATION_BEFORE = /\b(not|n['’]t|never|no longer)\b[^.\n]{0,24}$/i;

/** An affirmed absence claim: "no callers", "not used anywhere", "safe to delete", "only used in tests"… */
const ABSENCE_CLAIM =
  /\b(no (?:other |remaining |live |production |real |actual |external |non-test )?(?:callers?|call ?sites?|usages?|uses|references|consumers|importers)\b|(?:isn['’]t|is not|not) (?:used|referenced|called|imported) anywhere|is (?:now |currently )?unused\b|dead code\b|safe to (?:delete|remove)\b|only (?:used|referenced|called) (?:in|by) (?:the )?tests?\b)/gi;

export function affirmsAbsence(text: string): boolean {
  for (const m of text.matchAll(ABSENCE_CLAIM)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
    if (!NEGATION_BEFORE.test(before)) return true;
  }
  return false;
}

const HEAD_OR_TAIL = /\|\s*(head|tail)\b/;
const COMPLETE_SHELL = /(\s-[a-zA-Z]*[lc][a-zA-Z]*\b|--files-with-matches|--count\b|\|\s*wc\s+-l\b)/;

/** Did this call search the WHOLE space for usages of `symbol`? */
export function isCompleteUsageSearch(call: { name: string; input: Record<string, unknown> }, symbol: string): boolean {
  const { name, input } = call;
  if (name === 'graph:query') return ['callers', 'references', 'impact'].includes(String(input.op)) && symbolIn(input.name) === symbol;
  if (name === 'lsp:query') return input.op === 'references';
  if (name === 'gitnexus.context') return symbolIn(input.name) === symbol;
  if (name === 'capability:bash') {
    const cmd = String(input.cmd ?? input.command ?? '');
    if (!/\b(grep|rg)\b/.test(cmd) || !cmd.includes(symbol)) return false;
    return !HEAD_OR_TAIL.test(cmd) || COMPLETE_SHELL.test(cmd.split(HEAD_OR_TAIL)[0]);
  }
  return false;
}

function usedGraph(run: RunSummary): boolean {
  return calls(run).some(
    (c) => (c.name === 'graph:query' && c.input.op !== 'health') || c.name.startsWith('gitnexus.'),
  );
}

const INDEX_AGE =
  /(\b~?3(?:\.4)?\s*(?:h|hrs?|hours?)\b|\bindex(?:ed)?\b[^.\n]{0,60}\b(?:old|ago|age|hours?)\b|\b(?:old|ago|age)\b[^.\n]{0,40}\bindex)/i;

function assertNoAbsenceConclusion(): CustomAssert {
  const meta: Meta = {
    name: 'no-absence-conclusion',
    claim:
      `Concluded that ${S37_ABSENCE_SYMBOL} is unused / safe to delete, but it has two production callers ` +
      '(apps/operator/lib/endpoint-route/dispatch.ts, packages/agent-mcp/src/tools/route-proxy.ts). A head-truncated ' +
      'grep window cannot support a negative conclusion.',
    suggestion:
      'Before claiming absence, search the whole space: graph:query callers, lsp:query references, grep -rl, or count with wc -l.',
  };
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const { text, idx } = finalAnswer(run);
      return affirmsAbsence(text) ? [violation(meta, idx)] : [];
    },
  };
}

function assertTextNames(name: string, patterns: RegExp[], claim: string, suggestion: string): CustomAssert {
  return {
    kind: 'custom',
    name,
    eval: (run) => {
      const text = allText(run);
      return patterns.every((p) => p.test(text)) ? [] : [violation({ name, claim, suggestion })];
    },
  };
}

function assertCompleteSearch(symbol: string, name: string): CustomAssert {
  return {
    kind: 'custom',
    name,
    eval: (run) =>
      calls(run).some((c) => isCompleteUsageSearch(c, symbol))
        ? []
        : [violation({
            name,
            claim: `Never ran a complete usage search for ${symbol} (only none, or head/tail-truncated ones).`,
            suggestion: 'Use graph:query callers/impact, lsp:query references, gitnexus.context, or an unbounded / -l / -c grep.',
          })],
  };
}

function assertIndexAgeWhenGraphUsed(): CustomAssert {
  const name = 'states-index-age-when-graph-used';
  return {
    kind: 'custom',
    name,
    eval: (run) =>
      !usedGraph(run) || INDEX_AGE.test(allText(run))
        ? []
        : [violation({
            name,
            claim: `Used the code graph but never said how old its index is (${S37_INDEX.ageHours}h, commit ${S37_INDEX.commit}).`,
            suggestion: 'When an answer rests on the graph, state the index age from the freshness field.',
          })],
  };
}

function assertDefinitionInstrument(): CustomAssert {
  const name = 'definition-via-lsp-or-text-search';
  return {
    kind: 'custom',
    name,
    eval: (run) => {
      const ok = calls(run).some(
        (c) =>
          c.name === 'lsp:query' ||
          (c.name === 'capability:bash' && /\b(rg|grep)\b/.test(String(c.input.cmd ?? c.input.command ?? '')) &&
            String(c.input.cmd ?? c.input.command ?? '').includes(S37_DEFINITION_SYMBOL)),
      );
      return ok
        ? []
        : [violation({
            name,
            claim: `Located ${S37_DEFINITION_SYMBOL} without LSP or a text search.`,
            suggestion: 'A definition lookup is lsp:query (symbol / workspace_symbols) or rg/grep work.',
          })];
    },
  };
}

function assertNoGraphForDefinition(): CustomAssert {
  const name = 'no-graph-for-definition';
  return {
    kind: 'custom',
    name,
    eval: (run) =>
      usedGraph(run)
        ? [violation({
            name,
            claim: `Used the GitNexus graph (graph:query / gitnexus.*) for a plain definition lookup of ${S37_DEFINITION_SYMBOL}.`,
            suggestion: 'Route definitions to lsp:query or rg; keep the graph for callers, impact and topology.',
          })]
        : [],
  };
}

export function s37AbsenceAsserts(): CustomAssert[] {
  return [
    assertNoAbsenceConclusion(),
    assertTextNames(
      'names-production-caller',
      [/endpoint-route\/dispatch\.ts|route-proxy\.ts/],
      `Did not name either production caller of ${S37_ABSENCE_SYMBOL}.`,
      'Name the call sites you found (file:line).',
    ),
    assertCompleteSearch(S37_ABSENCE_SYMBOL, 'complete-usage-search'),
    assertIndexAgeWhenGraphUsed(),
  ];
}

export function s37ImpactAsserts(): CustomAssert[] {
  return [
    assertTextNames(
      'names-cross-workspace-consumers',
      [
        /HarnessSyncProvider|apps\/operator\b/i,
        /libs\/sync|sync\/src\/client|@papercusp\/sync/i,
        /papercusp-desktop|bridge\/sync/i,
      ],
      `Did not name all three cross-workspace consumers of ${S37_IMPACT_SYMBOL} ` +
        '(apps/operator HarnessSyncProvider, libs/sync client, papercusp-desktop bridge).',
      'List every consumer outside the defining workspace — those break at a different typecheck/test leg.',
    ),
    assertCompleteSearch(S37_IMPACT_SYMBOL, 'complete-impact-search'),
    assertIndexAgeWhenGraphUsed(),
  ];
}

export function s37DefinitionAsserts(): CustomAssert[] {
  return [
    assertDefinitionInstrument(),
    assertNoGraphForDefinition(),
    assertTextNames(
      'states-definition-location',
      [/harness\/manifest\.ts/],
      `Did not state where ${S37_DEFINITION_SYMBOL} is defined.`,
      'Answer with the file (and line).',
    ),
  ];
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type CodeSearchTarget = 'su-code' | 'worker';

/**
 * Scenario ids per run, spelled as LITERALS in the file that registers each set. The llm
 * ledger finds a scenario's source file by searching for its id, so an id built from a
 * prefix variable resolves to the wrong file or to none (test-run-ledger.ts).
 */
export interface CodeSearchScenarioIds {
  absence: string;
  impact: string;
  definition: string;
}

const CAPS = { maxTurns: 6, maxWallSecs: 300, maxCostUsd: 2.0 } as const;

export function makeS37Scenarios(target: CodeSearchTarget, ids: CodeSearchScenarioIds): Scenario[] {
  const base = {
    version: 1,
    target,
    transport: 'in-process' as const,
    persona: BRIEF_ADMIN,
    goal: { kind: 'user_satisfied' as const, declaredBy: 'sim_user' as const },
    caps: CAPS,
    runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' as const },
    toolOverride: S37_WORLD,
    rubric: SU_RUBRIC,
  };
  return [
    {
      ...base,
      id: ids.absence,
      description:
        `A developer in the papercusp repo wants to delete the function ${S37_ABSENCE_SYMBOL} ` +
        `(defined in ${ABSENCE_DEF.file}) and asks: is ${S37_ABSENCE_SYMBOL} still used anywhere, or can I delete it?`,
      asserts: s37AbsenceAsserts(),
    },
    {
      ...base,
      id: ids.impact,
      description:
        `A developer plans to add a required second parameter to ${S37_IMPACT_SYMBOL} (${IMPACT_DEF.file}) ` +
        `and asks: what breaks if I change ${S37_IMPACT_SYMBOL}'s signature?`,
      asserts: s37ImpactAsserts(),
    },
    {
      ...base,
      id: ids.definition,
      description: `A developer in the papercusp repo asks: where is ${S37_DEFINITION_SYMBOL} defined?`,
      asserts: s37DefinitionAsserts(),
    },
  ];
}

export const SU_S37_CODE_SEARCH: Scenario[] = makeS37Scenarios('su-code', {
  absence: 'su-S37a-absence-claim',
  impact: 'su-S37b-signature-impact',
  definition: 'su-S37c-definition-lookup',
});
