/**
 * P-017 MICRO REPO (plan `gitnexus-deterministic-integration-2026-10-05`, D-011,
 * D-012): a tiny TypeScript project whose answer keys are COMPLETE and DERIVED
 * from markers in its own source, so every arm adapter is checked against known
 * truth before its real-corpus numbers are believed.
 *
 * Why it exists: on the real corpus a wrong answer can come from the engine OR
 * from our adapter (a bad output parser, a 0- vs 1-based line, a mis-mapped
 * intent). Those must not be scored as engine weakness. Every intent has at
 * least one PLAIN case here (no hardness tag): an arm that declares an intent
 * and cannot answer its plain case exactly has an adapter defect, which is fixed
 * before the arm runs on the real corpus (`runConformance` in
 * fair-comparison-arms.ts).
 *
 * MARKERS — a trailing `// @fair <token> …` on a source line. Tokens:
 *   k:<case>[#unit]  a canonical answer site; one per unit (D-012 answer units)
 *   a:<case>#unit    an alias of that unit's canonical site (another granularity
 *                    for the same answer: a declaration line vs a call line)
 *   n:<case>         neutral — neither credited nor penalised
 *   r:<case>         rejected — a verified WRONG answer (a deliberate trap)
 * Markers are stripped when the repo is materialized. Stripping removes only the
 * trailing comment, so line numbers are unchanged and no engine sees a case id.
 *
 * Nothing here is a hand-maintained line number: keys come from the marked
 * source, and `deriveMicroKeys` refuses a marker set that is inconsistent.
 */
import type { AnswerKey, FairCase, FairIntent, SiteKey } from './fair-comparison';
import { FAIR_INTENTS, siteKey } from './fair-comparison';

/** The marked source. Each file is an array of lines, so line numbers are the index + 1. */
export const MICRO_REPO_MARKED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'package.json': [
    '{',
    '  "name": "fair-micro-repo",',
    '  "version": "0.0.0",',
    '  "private": true,',
    '  "type": "module"',
    '}',
  ],
  'tsconfig.json': [
    '{',
    '  "compilerOptions": {',
    '    "target": "ES2022",',
    '    "module": "ESNext",',
    '    "moduleResolution": "Bundler",',
    '    "strict": true,',
    '    "noEmit": true',
    '  },',
    '  "include": ["src"]',
    '}',
  ],
  'src/util/math.ts': [
    '/** Arithmetic helpers for the fair-comparison micro repo. */',
    'export function add(a: number, b: number): number { // @fair k:micro-callees-scale#add k:micro-symbol-search-add n:micro-callers-add r:micro-definition-add-local',
    '  return a + b;',
    '}',
    '',
    'export function scale(x: number, factor: number): number { // @fair a:micro-callers-add#scale k:micro-definition-scale n:micro-references-scale n:micro-impact-scale',
    '  const scaled = add(x * factor, 0); // @fair k:micro-callers-add#scale a:micro-callees-scale#add',
    '  return Math.round(scaled); // @fair n:micro-callees-scale',
    '}',
    '',
    'export function unusedHelper(): string { // @fair n:micro-callers-unused-helper n:micro-references-unused-helper',
    "  return 'unused';",
    '}',
    '',
    'export function neverCalled(): number { // @fair n:micro-callers-never-called',
    '  return 0;',
    '}',
  ],
  'src/util/index.ts': [
    "export { add, scale, neverCalled } from './math'; // @fair k:micro-references-scale r:micro-callers-add r:micro-callers-never-called r:micro-impact-scale",
  ],
  'src/app/report.ts': [
    "import { add, scale } from '../util'; // @fair k:micro-references-scale a:micro-callers-add#top r:micro-impact-scale",
    '',
    "export const GRAND_TOTAL_LABEL = 'grand total'; // @fair k:micro-text-search-grand-total",
    'export const BASE = add(1, 2); // @fair k:micro-callers-add#top',
    '',
    'export function total(values: number[]): number { // @fair a:micro-callers-add#total n:micro-callers-total k:micro-callees-report#total',
    '  let sum = add(0, BASE); // @fair k:micro-callers-add#total',
    '  for (const v of values) sum = add(sum, v); // @fair a:micro-callers-add#total',
    '  return sum;',
    '}',
    '',
    'export function doubled(values: number[]): number[] { // @fair k:micro-impact-scale#doubled k:micro-definition-doubled a:micro-references-scale#doubled n:micro-impact-doubled k:micro-callees-report#doubled',
    '  const out: number[] = [];',
    '  for (const v of values) out.push(scale(v, 2)); // @fair k:micro-references-scale#doubled a:micro-impact-scale#doubled',
    '  return out;',
    '}',
    '',
    '// prints the grand total line // @fair k:micro-text-search-grand-total',
    'export function report(values: number[]): string { // @fair k:micro-impact-scale#report a:micro-callers-total#report k:micro-impact-doubled#report n:micro-callees-report',
    '  const parts = doubled(values).map(String); // @fair a:micro-impact-scale#report a:micro-impact-doubled#report a:micro-callees-report#doubled',
    "  return `${total(values)} [${parts.join(',')}]`; // @fair k:micro-callers-total#report a:micro-callees-report#total",
    '}',
  ],
  'src/app/format.ts': [
    '/** A file-local helper that shares its name with util/math add but is a different symbol. */',
    'function add(parts: string[], part: string): string[] { // @fair k:micro-definition-add-local k:micro-symbol-search-add',
    '  return [...parts, part];',
    '}',
    '',
    'export function formatList(items: string[]): string { // @fair k:micro-symbol-search-format-list',
    '  let parts: string[] = [];',
    '  for (const item of items) parts = add(parts, item); // @fair r:micro-callers-add',
    "  return parts.join(', ');",
    '}',
  ],
  'src/app/rows.ts': [
    'export interface Row {',
    '  label: string;',
    '}',
    '',
    'export function byLabel(a: Row, b: Row): number { // @fair n:micro-callers-by-label-dynamic',
    '  return a.label.localeCompare(b.label);',
    '}',
    '',
    'export function sortRows(rows: Row[]): Row[] { // @fair a:micro-callers-by-label-dynamic#sortRows n:micro-references-sort-rows',
    '  return [...rows].sort(byLabel); // @fair k:micro-callers-by-label-dynamic#sortRows',
    '}',
  ],
  'src/main.ts': [
    "import { report } from './app/report'; // @fair r:micro-impact-scale a:micro-references-sort-rows#top",
    "import { sortRows } from './app/rows'; // @fair k:micro-references-sort-rows#top",
    "import { formatList } from './app/format';",
    '',
    "const rows = sortRows([{ label: 'b' }, { label: 'a' }]); // @fair k:micro-references-sort-rows",
    'console.log(formatList(rows.map((r) => r.label)));',
    'console.log(report(rows.map((r) => r.label.length))); // @fair r:micro-impact-scale',
  ],
});

const micro = (
  id: string,
  intent: FairIntent,
  subject: string,
  tags: FairCase['tags'],
  extra: { anchorFile?: string; depth?: number } = {},
): FairCase => ({ id, intent, subject, tags, source: 'micro-repo', ...extra });

/**
 * The micro cases. An UNTAGGED case is PLAIN: any engine that supports the
 * intent should answer it exactly, so a miss there is read as an adapter defect.
 */
export const MICRO_CASES: readonly FairCase[] = Object.freeze([
  micro('micro-callers-total', 'callers', 'total', [], { anchorFile: 'src/app/report.ts' }),
  micro('micro-callers-add', 'callers', 'add', ['barrel-reexport', 'same-name'], { anchorFile: 'src/util/math.ts' }),
  micro('micro-callers-unused-helper', 'callers', 'unusedHelper', ['absence'], { anchorFile: 'src/util/math.ts' }),
  micro('micro-callers-never-called', 'callers', 'neverCalled', ['absence', 'barrel-reexport'], { anchorFile: 'src/util/math.ts' }),
  micro('micro-callers-by-label-dynamic', 'callers', 'byLabel', ['dynamic-dispatch'], { anchorFile: 'src/app/rows.ts' }),
  micro('micro-callees-report', 'callees', 'report', [], { anchorFile: 'src/app/report.ts' }),
  micro('micro-callees-scale', 'callees', 'scale', ['same-name'], { anchorFile: 'src/util/math.ts' }),
  micro('micro-callees-add-leaf', 'callees', 'add', ['absence'], { anchorFile: 'src/util/math.ts' }),
  micro('micro-impact-doubled', 'impact', 'doubled', [], { anchorFile: 'src/app/report.ts', depth: 1 }),
  micro('micro-impact-scale', 'impact', 'scale', ['barrel-reexport'], { anchorFile: 'src/util/math.ts', depth: 2 }),
  micro('micro-definition-doubled', 'definition', 'doubled', [], { anchorFile: 'src/app/report.ts' }),
  micro('micro-definition-scale', 'definition', 'scale', ['barrel-reexport'], { anchorFile: 'src/app/report.ts' }),
  micro('micro-definition-add-local', 'definition', 'add', ['same-name'], { anchorFile: 'src/app/format.ts' }),
  micro('micro-references-sort-rows', 'references', 'sortRows', [], { anchorFile: 'src/app/rows.ts' }),
  micro('micro-references-scale', 'references', 'scale', ['barrel-reexport'], { anchorFile: 'src/util/math.ts' }),
  micro('micro-references-unused-helper', 'references', 'unusedHelper', ['absence'], { anchorFile: 'src/util/math.ts' }),
  micro('micro-symbol-search-format-list', 'symbol-search', 'formatList', []),
  micro('micro-symbol-search-add', 'symbol-search', 'add', ['same-name']),
  micro('micro-symbol-search-absent', 'symbol-search', 'subtract', ['absence']),
  micro('micro-text-search-grand-total', 'text-search', 'grand total', []),
  micro('micro-text-search-absent', 'text-search', 'no such phrase zq', ['absence']),
]);

const MARKER_RE = /\s*\/\/ @fair ((?:[knar]:[a-z0-9-]+(?:#[A-Za-z0-9_-]+)?\s*)+)$/;
const TOKEN_RE = /^([knar]):([a-z0-9-]+)(?:#([A-Za-z0-9_-]+))?$/;

export interface MicroMarker {
  readonly path: string;
  readonly line1: number;
  readonly kind: 'k' | 'a' | 'n' | 'r';
  readonly caseId: string;
  readonly unit: string | null;
}

/** Every marker in a marked file set, in file/line order. */
export function parseMicroMarkers(marked: Readonly<Record<string, readonly string[]>>): MicroMarker[] {
  const out: MicroMarker[] = [];
  for (const path of Object.keys(marked).sort()) {
    marked[path]!.forEach((line, i) => {
      const m = MARKER_RE.exec(line);
      if (!m) return;
      for (const tok of m[1]!.trim().split(/\s+/)) {
        const t = TOKEN_RE.exec(tok);
        if (!t) continue;
        out.push({ path, line1: i + 1, kind: t[1] as MicroMarker['kind'], caseId: t[2]!, unit: t[3] ?? null });
      }
    });
  }
  return out;
}

/** The source an engine sees: every marker removed, every line kept. */
export function stripMicroMarkers(marked: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, lines] of Object.entries(marked)) {
    out[path] = `${lines.map((l) => l.replace(MARKER_RE, '')).join('\n')}\n`;
  }
  return out;
}

const wordOn = (line: string, word: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$])${word.replace(/[$]/g, '\\$')}([^A-Za-z0-9_$]|$)`).test(line);

/** Intents whose canonical line must name the subject itself (callees/impact name a different symbol). */
const NAMES_SUBJECT: ReadonlySet<FairIntent> = new Set<FairIntent>(['callers', 'definition', 'references', 'symbol-search']);

/**
 * Derive one complete AnswerKey per case from the markers, and every reason the
 * marker set is inconsistent. A non-empty `problems` list means the keys must
 * not be used.
 */
export function deriveMicroKeys(
  marked: Readonly<Record<string, readonly string[]>>,
  cases: readonly FairCase[],
): { keys: AnswerKey[]; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  const markers = parseMicroMarkers(marked);
  const stripped = stripMicroMarkers(marked);
  const lineAt = (path: string, line1: number): string => stripped[path]!.split('\n')[line1 - 1] ?? '';

  for (const m of markers) if (!byId.has(m.caseId)) problems.push(`marker ${m.kind}:${m.caseId} at ${m.path}:${m.line1} names no case`);
  for (const path of Object.keys(marked)) {
    marked[path]!.forEach((line, i) => {
      if (line.includes('@fair') && !MARKER_RE.test(line)) problems.push(`${path}:${i + 1} has a malformed @fair marker`);
    });
  }

  const keys: AnswerKey[] = [];
  for (const kase of cases) {
    const mine = markers.filter((m) => m.caseId === kase.id);
    const canonical = new Map<string, SiteKey>();
    const sites: SiteKey[] = [];
    for (const m of mine.filter((x) => x.kind === 'k')) {
      const site = siteKey(m);
      const unit = m.unit ?? `@${site}`;
      if (canonical.has(unit)) problems.push(`${kase.id}: unit ${unit} has two canonical sites`);
      canonical.set(unit, site);
      sites.push(site);
      const text = lineAt(m.path, m.line1);
      if (NAMES_SUBJECT.has(kase.intent) && !wordOn(text, kase.subject)) {
        problems.push(`${kase.id}: canonical ${site} does not name ${kase.subject}`);
      }
      if (kase.intent === 'text-search' && !text.includes(kase.subject)) {
        problems.push(`${kase.id}: canonical ${site} does not contain the literal`);
      }
    }
    const aliases: Record<SiteKey, SiteKey> = {};
    for (const m of mine.filter((x) => x.kind === 'a')) {
      const target = m.unit === null ? undefined : canonical.get(m.unit);
      if (!target) problems.push(`${kase.id}: alias ${siteKey(m)} names unit ${m.unit ?? '(none)'} with no canonical site`);
      else aliases[siteKey(m)] = target;
    }
    const neutral = mine.filter((x) => x.kind === 'n').map(siteKey);
    const rejected = mine.filter((x) => x.kind === 'r').map(siteKey);
    const ruled = [...sites, ...Object.keys(aliases), ...neutral, ...rejected];
    if (new Set(ruled).size !== ruled.length) problems.push(`${kase.id}: a site carries two rulings`);

    const absence = kase.tags.includes('absence');
    if (absence && sites.length > 0) problems.push(`${kase.id}: tagged absence but has ${sites.length} answer site(s)`);
    if (!absence && sites.length === 0) problems.push(`${kase.id}: no answer site and not tagged absence`);

    if (kase.intent === 'text-search') {
      for (const [path, body] of Object.entries(stripped)) {
        if (!path.endsWith('.ts')) continue;
        body.split('\n').forEach((line, i) => {
          const site = siteKey({ path, line1: i + 1 });
          if (line.includes(kase.subject) && !sites.includes(site)) problems.push(`${kase.id}: ${site} contains the literal but is not in the key`);
        });
      }
    }
    keys.push({ caseId: kase.id, sites: [...sites].sort(), aliases, rejected: rejected.sort(), neutral: neutral.sort() });
  }

  for (const intent of FAIR_INTENTS) {
    if (!cases.some((c) => c.intent === intent && c.tags.length === 0)) problems.push(`intent ${intent} has no plain (untagged) case`);
  }
  for (const [path, body] of Object.entries(stripped)) {
    const leaked = cases.find((c) => body.includes(c.id));
    if (body.includes('@fair') || leaked) problems.push(`${path}: a case marker survived stripping (${leaked?.id ?? '@fair'})`);
  }
  return { keys, problems };
}

/** The materialized micro repo (markers stripped): repo-relative path -> file content. */
export const MICRO_REPO_FILES: Readonly<Record<string, string>> = Object.freeze(stripMicroMarkers(MICRO_REPO_MARKED));

/** The complete keys for MICRO_CASES. Throws if the markers are inconsistent, so a bad key is never scored against. */
export function microRepoKeys(): AnswerKey[] {
  const { keys, problems } = deriveMicroKeys(MICRO_REPO_MARKED, MICRO_CASES);
  if (problems.length > 0) throw new Error(`micro repo markers are inconsistent:\n${problems.join('\n')}`);
  return keys;
}
