/**
 * Parity cases for the embedding-space move (shared-vector-search-libraries-
 * 2026-09-29 P-001, specs AUTO-BAR-R-1-P-001 and AUTO-BAR-R-3-P-001).
 *
 * Builds, from papercusp's PRE-MOVE functions in prose-vector-dims.ts, the
 * expected output of every embedding-space filter and storage check for a
 * pinned set of inputs. The result is committed as
 * libs/generic/search/src/__fixtures__/embedding-space-parity-cases.json and:
 *   - the library replays it through createEmbeddingSpace(hostConfig)
 *     (libs/generic/search/src/embedding-space.test.ts);
 *   - embedding-space-parity.test.ts rebuilds it here and requires it to equal
 *     the committed copy, so a pin cannot drift from the code it pins, a new
 *     filter call site cannot appear without a pinned case, and papercusp's
 *     live config cannot drift from the hostConfig the library replays.
 *
 * Column inputs come from the tree, not from a hand list: an AST census of
 * every call to the three pre-move filters, plus the columns the chunk-aware
 * vector leg hands to a `spaceFilter` callback for every registered chunk
 * surface (the only way a call site receives non-literal columns — the census
 * lists each such site so a new kind cannot hide).
 *
 * Regenerate: npx tsx packages/operator-core/lib/search/embedding-space-parity-gen-cli.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { chunkAwareVectorLegSpaceColumns, type PgHandle } from '@papercusp/search';
import { CHUNK_SURFACES } from './chunks/registry';
import {
  PROSE_ELIGIBLE_MODES,
  PROSE_VECTOR_STORAGE_PROFILE,
  computeProseColumnWidthSkew,
  effectiveStoredProseProfileIdSql,
  fitsProseColumns,
  proseProfilePredicateSql,
  resolveAcceptedProseProfileSelection,
  resolveCurrentProseProfileSelection,
  resolveProseProfileIdSelection,
  resolveProseProfileSelection,
  storedProseIdentityMatches,
  validateProseStorageCompatibility,
  type ProseProfileSelection,
} from './prose-vector-dims';

// ── recording SQL tag ────────────────────────────────────────────────────────

const REC = Symbol('recorded-sql');
type Recorded = { [REC]: true; strings?: readonly string[]; values?: unknown[]; unsafe?: string };

/** A stand-in for a postgres.js handle that records instead of executing. */
export function recordingSql(): PgHandle {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Recorded => ({ [REC]: true, strings: [...strings], values });
  (tag as unknown as { unsafe: (t: string) => Recorded }).unsafe = (text: string) => ({ [REC]: true, unsafe: text });
  return tag as unknown as PgHandle;
}

/** Flatten a recorded fragment to SQL text with `$n` placeholders and its
 * bind values. Whitespace runs collapse to one space: layout is not semantic,
 * and the move re-flows multi-line templates. */
export function renderRecordedSql(fragment: unknown): { text: string; binds: unknown[] } {
  const binds: unknown[] = [];
  const walk = (node: unknown): string => {
    const r = node as Recorded;
    if (r && typeof r === 'object' && r[REC]) {
      if (r.unsafe !== undefined) return r.unsafe;
      return r.strings!.map((s, i) => s + (i < r.values!.length ? walk(r.values![i]) : '')).join('');
    }
    binds.push(node);
    return `$${binds.length}`;
  };
  return { text: walk(fragment).replace(/\s+/g, ' ').trim(), binds };
}

// ── census ───────────────────────────────────────────────────────────────────

export const FILTER_FUNCTIONS = ['proseProfileSql', 'proseProfilePredicateSql', 'effectiveStoredProseProfileIdSql'] as const;
type FilterFunction = (typeof FILTER_FUNCTIONS)[number];

export interface CensusSite {
  fn: FilterFunction;
  file: string;
  /** Column argument source text, e.g. `'embedding_profile' | 'embedding_mode'`. */
  args: string;
  literal: { profileColumn: string; modeColumn: string } | null;
}

/** Every non-test call to a pre-move filter under packages/, apps/ and libs/,
 * sorted and line-free (a moved line is not a new site).
 *
 * `--untracked` makes the answer independent of git-sync timing: without it a
 * call site in a file nobody has committed yet is invisible, and the census
 * changes the moment the sweep commits it. This module is excluded because it
 * is the instrument: its own reproductions of the filters are not call sites
 * (it self-matched once git-sync committed it, 2026-09-30). */
export function censusFilterCallSites(repoRoot: string): CensusSite[] {
  const self = relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join('/');
  const files = execFileSync(
    'git',
    ['grep', '--untracked', '-lE', FILTER_FUNCTIONS.join('|'), '--', 'packages', 'apps', 'libs', ':!*.test.ts', ':!*.test.tsx', `:!${self}`],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  const sites: CensusSite[] = [];
  for (const file of files) {
    const src = ts.createSourceFile(file, readFileSync(join(repoRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (FILTER_FUNCTIONS as readonly string[]).includes(n.expression.text)) {
        const fn = n.expression.text as FilterFunction;
        const cols = fn === 'proseProfilePredicateSql' ? n.arguments.slice(2, 4) : n.arguments.slice(1, 3);
        const text = (a: ts.Expression) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? a.text : null);
        const [p, m] = cols.map(text);
        sites.push({
          fn,
          file,
          args: cols.map((a) => a.getText(src)).join(' | '),
          literal: p != null && m != null ? { profileColumn: p, modeColumn: m } : null,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return sites.sort((a, b) => `${a.file}\t${a.fn}\t${a.args}`.localeCompare(`${b.file}\t${b.fn}\t${b.args}`));
}

/** The (profile, mode) columns the chunk-aware vector leg passes to a
 * `spaceFilter`, for every registered chunk surface, both legs. */
export function chunkSurfaceSpaceColumns(): Array<{ surface: string; profileColumn: string; modeColumn: string }> {
  const sql = recordingSql();
  const seen: Array<{ surface: string; profileColumn: string; modeColumn: string }> = [];
  for (const surface of CHUNK_SURFACES) {
    for (const cols of chunkAwareVectorLegSpaceColumns(sql, { surface, mode: 'retrieve' })) {
      if (cols.profileColumn && cols.modeColumn) {
        seen.push({ surface: surface.surface, profileColumn: cols.profileColumn, modeColumn: cols.modeColumn });
      }
    }
  }
  return seen;
}

// ── cases ────────────────────────────────────────────────────────────────────

export interface EmbeddingSpaceParityFixture {
  provenance: string;
  hostConfig: {
    storageLabel: string;
    storage: { acceptedProfileIds: string[]; dimensions: number; distanceMetric: string; indexOperatorClass: string };
    legacyModes: Record<string, { profileId: string; dimensions: number; distanceMetric: string }>;
  };
  census: CensusSite[];
  columnPairs: Array<{ profileColumn: string; modeColumn: string; from: string[] }>;
  predicate: Array<{ selection: ProseProfileSelection | null; profileColumn: string; modeColumn: string; expected: { text: string; binds: unknown[] } }>;
  sourceFilter: Array<{ embeddingProfile: { profileId: string; legacyMode: string | null } | null; profileColumn: string; modeColumn: string; expected: { text: string; binds: unknown[] } }>;
  effectiveStored: Array<{ profileColumn: string; modeColumn: string; expected: { text: string; binds: unknown[] } }>;
  compatibility: Array<{ profile: { profileId: string; dimensions: number; distanceMetric: string }; expected: string[] }>;
  resolveSelection: Array<{ mode: string; profile: { profileId: string; dimensions: number; distanceMetric: string }; expected: ProseProfileSelection | null }>;
  resolveCurrent: Array<{ mode: string; expected: ProseProfileSelection | null }>;
  resolveProfileId: Array<{ profileId: string; legacyMode: string | null; expected: ProseProfileSelection | null }>;
  resolveAccepted: Array<{ profileId: string; expected: ProseProfileSelection | null }>;
  identity: Array<{ stored: { profileId?: string | null; mode?: string | null }; selection: ProseProfileSelection; expected: boolean }>;
  fits: Array<{ dims: number; expected: boolean }>;
  widthSkew: { measured: Array<{ table: string; column: string; dims: number }>; expected: ReturnType<typeof computeProseColumnWidthSkew> };
}

type Spec = { profileId: string; dimensions: number; distanceMetric: string };
const specOf = (p: { profileId: string; targetDims: number; distanceMetric: string }): Spec => ({
  profileId: p.profileId,
  dimensions: p.targetDims,
  distanceMetric: p.distanceMetric,
});
const asMemory = (s: Spec) => ({ profileId: s.profileId, targetDims: s.dimensions, distanceMetric: s.distanceMetric }) as Parameters<typeof validateProseStorageCompatibility>[0];

export function buildEmbeddingSpaceParityFixture(repoRoot: string): EmbeddingSpaceParityFixture {
  const sql = recordingSql();
  const render = (f: unknown) => renderRecordedSql(f);
  const census = censusFilterCallSites(repoRoot);

  const pairs = new Map<string, { profileColumn: string; modeColumn: string; from: Set<string> }>();
  const addPair = (profileColumn: string, modeColumn: string, from: string) => {
    const key = `${profileColumn}\t${modeColumn}`;
    const entry = pairs.get(key) ?? { profileColumn, modeColumn, from: new Set<string>() };
    entry.from.add(from);
    pairs.set(key, entry);
  };
  for (const site of census) if (site.literal) addPair(site.literal.profileColumn, site.literal.modeColumn, `${site.fn}@${site.file}`);
  for (const c of chunkSurfaceSpaceColumns()) addPair(c.profileColumn, c.modeColumn, `spaceFilter@chunk-surface:${c.surface}`);
  const columnPairs = [...pairs.values()]
    .map((p) => ({ profileColumn: p.profileColumn, modeColumn: p.modeColumn, from: [...p.from].sort() }))
    .sort((a, b) => `${a.profileColumn}\t${a.modeColumn}`.localeCompare(`${b.profileColumn}\t${b.modeColumn}`));

  const allModes = Object.keys(EMBEDDER_DIM_SPECS) as Array<keyof typeof EMBEDDER_DIM_SPECS>;
  const modeInputs = [...allModes, 'constructor', ''];
  const specs: Spec[] = allModes.map((m) => specOf(EMBEDDER_DIM_SPECS[m]));
  const gemma = EMBEDDER_DIM_SPECS.gemma.profileId;
  const openai = EMBEDDER_DIM_SPECS.openai.profileId;
  const profiles: Spec[] = [
    ...specs,
    { profileId: gemma, dimensions: 1024, distanceMetric: 'cosine' },
    { profileId: gemma, dimensions: 768, distanceMetric: 'l2' },
    { profileId: 'unknown-model@v1', dimensions: 768, distanceMetric: 'cosine' },
  ];
  const ids = [...new Set([...PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds, ...specs.map((s) => s.profileId), 'unknown-model@v1'])];

  const selections: Array<ProseProfileSelection | null> = [
    null,
    resolveCurrentProseProfileSelection('gemma'),
    resolveCurrentProseProfileSelection('openai'),
    resolveProseProfileIdSelection(gemma, null),
    resolveProseProfileIdSelection(openai, null),
  ];
  const queryProfiles: Array<{ profileId: string; legacyMode: string | null } | null> = [
    null,
    { profileId: gemma, legacyMode: 'gemma' },
    { profileId: openai, legacyMode: 'openai' },
    { profileId: gemma, legacyMode: 'openai' },
    { profileId: gemma, legacyMode: null },
    { profileId: 'unknown-model@v1', legacyMode: 'gemma' },
    { profileId: EMBEDDER_DIM_SPECS.local.profileId, legacyMode: 'local' },
  ];
  // proseProfileSql (agent-tools/search/sources.ts) is module-private; this is
  // its body, verbatim in behaviour: resolve the query's provenance, then the predicate.
  const proseProfileSql = (embeddingProfile: { profileId: string; legacyMode: string | null } | null, p: string, m: string) =>
    proseProfilePredicateSql(sql, embeddingProfile ? resolveProseProfileIdSelection(embeddingProfile.profileId, embeddingProfile.legacyMode) : null, p, m);

  const storedRows = [
    { profileId: gemma },
    { profileId: openai },
    { profileId: null, mode: 'gemma' },
    { profileId: null, mode: 'openai' },
    { profileId: null, mode: 'local' },
    { mode: 'gemma' },
    {},
  ];
  const measured = [
    { table: 'harness_shared.a', column: 'embedding', dims: 768 },
    { table: 'harness_shared.b', column: 'embedding', dims: 1024 },
    { table: 'harness_shared.c', column: 'embedding', dims: 384 },
    { table: 'harness_shared.d', column: 'embedding', dims: 0 },
    { table: 'harness_shared.e', column: 'embedding', dims: -1 },
  ];

  return {
    provenance:
      'Expected outputs were produced by papercusp\'s PRE-MOVE functions in packages/operator-core/lib/search/prose-vector-dims.ts ' +
      '(and the module-private proseProfileSql in agent-tools/search/sources.ts, reproduced in embedding-space-parity-cases.ts) ' +
      'before P-001 moved them into @papercusp/search. SQL is rendered with a recording tag: $n placeholders, whitespace collapsed. ' +
      'Regenerate with packages/operator-core/lib/search/embedding-space-parity-gen-cli.ts.',
    hostConfig: {
      storageLabel: 'shared prose storage',
      storage: {
        acceptedProfileIds: [...PROSE_VECTOR_STORAGE_PROFILE.acceptedProfileIds],
        dimensions: PROSE_VECTOR_STORAGE_PROFILE.dimensions,
        distanceMetric: PROSE_VECTOR_STORAGE_PROFILE.distanceMetric,
        indexOperatorClass: PROSE_VECTOR_STORAGE_PROFILE.indexOperatorClass,
      },
      legacyModes: Object.fromEntries(PROSE_ELIGIBLE_MODES.map((m) => [m, specOf(EMBEDDER_DIM_SPECS[m])])),
    },
    census,
    columnPairs: columnPairs,
    predicate: columnPairs.flatMap(({ profileColumn, modeColumn }) =>
      selections.map((selection) => ({ selection, profileColumn, modeColumn, expected: render(proseProfilePredicateSql(sql, selection, profileColumn, modeColumn)) })),
    ),
    sourceFilter: columnPairs.flatMap(({ profileColumn, modeColumn }) =>
      queryProfiles.map((embeddingProfile) => ({ embeddingProfile, profileColumn, modeColumn, expected: render(proseProfileSql(embeddingProfile, profileColumn, modeColumn)) })),
    ),
    effectiveStored: columnPairs.map(({ profileColumn, modeColumn }) => ({
      profileColumn,
      modeColumn,
      expected: render(effectiveStoredProseProfileIdSql(sql, profileColumn, modeColumn)),
    })),
    compatibility: profiles.map((profile) => ({ profile, expected: validateProseStorageCompatibility(asMemory(profile)) })),
    resolveSelection: modeInputs.flatMap((mode) => profiles.map((profile) => ({ mode, profile, expected: resolveProseProfileSelection(mode, asMemory(profile)) }))),
    resolveCurrent: modeInputs.map((mode) => ({ mode, expected: resolveCurrentProseProfileSelection(mode) })),
    resolveProfileId: ids.flatMap((profileId) =>
      [...modeInputs, null].map((legacyMode) => ({ profileId, legacyMode, expected: resolveProseProfileIdSelection(profileId, legacyMode) })),
    ),
    resolveAccepted: ids.map((profileId) => ({ profileId, expected: resolveAcceptedProseProfileSelection(profileId) })),
    identity: storedRows.flatMap((stored) =>
      selections.filter((s): s is ProseProfileSelection => s !== null).map((selection) => ({ stored, selection, expected: storedProseIdentityMatches(stored, selection) })),
    ),
    fits: [384, 768, 1024, 0].map((dims) => ({ dims, expected: fitsProseColumns(dims) })),
    widthSkew: { measured, expected: computeProseColumnWidthSkew(measured) },
  };
}
