/**
 * Parser + symbol matcher for `PARITY.md` — the machine-checkable Papercup-chat
 * feature matrix (plan `papercup-chat-one-component-one-contract-2026-09-06`,
 * P-002; trust columns per D-005).
 *
 * This module is PURE (no filesystem): `parity-matrix.test.ts` reads the files
 * and is the guard; later phases (P-011's render matrix, P-013's audit) can
 * import `parseParityMatrix` to derive their fixture lists from the same table
 * instead of restating it.
 *
 * Grammar of the table (one GFM pipe table, columns in this order):
 *
 *   | id | side | capability | source | disposition | trust | target | reason |
 *
 *   id          unique slug, e.g. `op-transcript`, `md-links`
 *   side        operator | portal | shared
 *   capability  free text — what the row is
 *   source      `repo/path#Symbol` or `repo/path#"literal text"` in backticks,
 *               where repo is `papercusp` or `portal`; `—` when the row has no
 *               code yet (e.g. a contract-only row)
 *   disposition keep | port | ported | retire | retired | open:P-NNN
 *               keep    — stays where it is (host chrome / already shared);
 *                         the guard asserts the source symbol still exists
 *               port    — WILL move into the shared component; source must
 *                         exist today, `target` names where it lands (proposed)
 *               ported  — the move landed; the guard asserts the TARGET symbol
 *                         exists (the source may be gone or a re-export). Flip
 *                         port → ported in the same change that lands it.
 *               retire  — WILL be deleted (P-012); source must STILL exist
 *               retired — deleted; the guard asserts the symbol is GONE so a
 *                         retired duplicate cannot quietly return
 *               open:P-NNN — undecided; the named plan item decides. The guard
 *                         still requires the source to exist.
 *               Final state (P-013 checks it): no `port`, `retire` or `open:`
 *               rows remain — only keep / ported / retired.
 *   trust       `public=<v> owner=<v>` for markdown-feature rows (D-005), else `—`
 *               v ∈ render | inert | off | opt-in | allowlist
 *   target      `repo/path#Symbol` where a port/ported row lands, else `—`
 *   reason      one line — why this disposition
 */

export const SIDES = ['operator', 'portal', 'shared'] as const;
export type Side = (typeof SIDES)[number];

export const FIXED_DISPOSITIONS = ['keep', 'port', 'ported', 'retire', 'retired'] as const;
export type FixedDisposition = (typeof FIXED_DISPOSITIONS)[number];
export type Disposition = FixedDisposition | `open:P-${string}`;

export const TRUST_VALUES = ['render', 'inert', 'off', 'opt-in', 'allowlist'] as const;
export type TrustValue = (typeof TRUST_VALUES)[number];
export interface TrustDisposition {
  public: TrustValue;
  owner: TrustValue;
}

export const REPOS = ['papercusp', 'portal'] as const;
export type Repo = (typeof REPOS)[number];

export type SymbolRef =
  | { kind: 'identifier'; name: string }
  | { kind: 'literal'; text: string };

export interface SourceRef {
  repo: Repo;
  /** path relative to the repo root (no repo prefix) */
  path: string;
  symbol: SymbolRef;
  raw: string;
}

export interface ParityRow {
  id: string;
  side: Side;
  capability: string;
  source: SourceRef | null;
  disposition: Disposition;
  trust: TrustDisposition | null;
  target: SourceRef | null;
  reason: string;
  /** 1-based line in the markdown file, for error messages */
  line: number;
}

export interface ParsedMatrix {
  rows: ParityRow[];
  /** one entry per malformed row/cell; a non-empty list is a failed guard */
  errors: string[];
}

export const COLUMNS = ['id', 'side', 'capability', 'source', 'disposition', 'trust', 'target', 'reason'] as const;

const EMPTY_CELL = /^(?:—|-|–|)$/;

function stripBackticks(cell: string): string {
  const m = /^`([^`]*)`$/.exec(cell.trim());
  return m ? m[1] : cell.trim();
}

/** Split one `| a | b | c |` line into trimmed cells (no escaped-pipe support; the matrix does not need it). */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

export function parseSourceRef(cell: string, where: string, errors: string[]): SourceRef | null {
  const raw = stripBackticks(cell);
  if (EMPTY_CELL.test(raw)) return null;
  const hash = raw.indexOf('#');
  if (hash <= 0 || hash === raw.length - 1) {
    errors.push(`${where}: source/target must be \`repo/path#Symbol\`, got \`${raw}\``);
    return null;
  }
  const fullPath = raw.slice(0, hash);
  const symbolText = raw.slice(hash + 1);
  const slash = fullPath.indexOf('/');
  const repo = slash > 0 ? fullPath.slice(0, slash) : fullPath;
  if (!(REPOS as readonly string[]).includes(repo) || slash < 0) {
    errors.push(`${where}: path must start with one of ${REPOS.join('|')}/, got \`${fullPath}\``);
    return null;
  }
  const path = fullPath.slice(slash + 1);
  if (!path || path.includes('..')) {
    errors.push(`${where}: bad path \`${fullPath}\``);
    return null;
  }
  let symbol: SymbolRef;
  const lit = /^"(.+)"$/.exec(symbolText);
  if (lit) {
    symbol = { kind: 'literal', text: lit[1] };
  } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbolText)) {
    symbol = { kind: 'identifier', name: symbolText };
  } else {
    errors.push(`${where}: symbol must be an identifier or a "quoted literal", got \`${symbolText}\``);
    return null;
  }
  return { repo: repo as Repo, path, symbol, raw };
}

export function parseDisposition(cell: string, where: string, errors: string[]): Disposition | null {
  const v = stripBackticks(cell);
  if ((FIXED_DISPOSITIONS as readonly string[]).includes(v)) return v as FixedDisposition;
  const open = /^open:(P-\d{3,})$/.exec(v);
  if (open) return `open:${open[1]}` as Disposition;
  errors.push(
    `${where}: disposition must be one of ${FIXED_DISPOSITIONS.join('|')} or open:P-NNN, got \`${v || '(empty)'}\``,
  );
  return null;
}

export function parseTrust(cell: string, where: string, errors: string[]): TrustDisposition | null {
  const v = stripBackticks(cell);
  if (EMPTY_CELL.test(v)) return null;
  const m = /^public=([a-z-]+)\s+owner=([a-z-]+)$/.exec(v);
  if (!m) {
    errors.push(`${where}: trust must be \`public=<v> owner=<v>\` or —, got \`${v}\``);
    return null;
  }
  const [, pub, own] = m;
  for (const val of [pub, own]) {
    if (!(TRUST_VALUES as readonly string[]).includes(val)) {
      errors.push(`${where}: trust value must be one of ${TRUST_VALUES.join('|')}, got \`${val}\``);
      return null;
    }
  }
  return { public: pub as TrustValue, owner: own as TrustValue };
}

/**
 * Parse the FIRST pipe table in `markdown` whose header matches COLUMNS.
 * Rows that fail to parse are reported in `errors` and omitted from `rows`.
 */
export function parseParityMatrix(markdown: string): ParsedMatrix {
  const lines = markdown.split(/\r?\n/);
  const errors: string[] = [];
  const rows: ParityRow[] = [];
  let headerAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    if (cells.length === COLUMNS.length && cells.every((c, j) => c.toLowerCase() === COLUMNS[j])) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0) {
    errors.push(`no table with header | ${COLUMNS.join(' | ')} | found`);
    return { rows, errors };
  }
  const seen = new Set<string>();
  for (let i = headerAt + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break; // table ended
    const cells = splitTableRow(line);
    const where = `PARITY.md:${i + 1}`;
    if (cells.length !== COLUMNS.length) {
      errors.push(`${where}: expected ${COLUMNS.length} cells, got ${cells.length}`);
      continue;
    }
    const [idCell, sideCell, capability, sourceCell, dispCell, trustCell, targetCell, reason] = cells;
    const id = stripBackticks(idCell);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) errors.push(`${where}: id must be a kebab-case slug, got \`${id}\``);
    if (seen.has(id)) errors.push(`${where}: duplicate id \`${id}\``);
    seen.add(id);
    const side = stripBackticks(sideCell);
    if (!(SIDES as readonly string[]).includes(side)) errors.push(`${where}: side must be ${SIDES.join('|')}, got \`${side}\``);
    if (!capability) errors.push(`${where}: capability is empty`);
    const source = parseSourceRef(sourceCell, where, errors);
    const disposition = parseDisposition(dispCell, where, errors);
    const trust = parseTrust(trustCell, where, errors);
    const target = parseSourceRef(targetCell, where, errors);
    if (!reason) errors.push(`${where}: reason is empty — every disposition needs its one-line why`);
    if ((disposition === 'port' || disposition === 'ported') && !target) {
      errors.push(`${where}: a ${disposition} row must name its target`);
    }
    if (disposition === 'retired' && !source) errors.push(`${where}: a retired row must name the source it asserts is gone`);
    if (!disposition) continue;
    rows.push({ id, side: side as Side, capability, source, disposition, trust, target, reason, line: i + 1 });
  }
  return { rows, errors };
}

/** Remove `//` line comments and `/* *\/` block comments (string-unaware; adequate for presence checks). */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is `symbol` present in `fileText` as CODE — a declaration, an import/export
 * binding, a JSX tag, or a call/generic use? Mentions inside comments do not
 * count (so a deleted symbol that survives only in a comment reads as absent).
 * Literals are matched verbatim anywhere, comments included — they are used for
 * URL/string markers that live inside string literals by design.
 */
export function symbolPresent(fileText: string, symbol: SymbolRef): boolean {
  if (symbol.kind === 'literal') return fileText.includes(symbol.text);
  const code = stripComments(fileText);
  const n = escapeRe(symbol.name);
  const patterns = [
    `(?:function|const|let|var|class|type|interface|enum)\\s+${n}(?![\\w$])`,
    `import\\b[^;]*?(?<![\\w$])${n}(?![\\w$])[^;]*?\\bfrom\\b`,
    `export\\s*\\{[^}]*?(?<![\\w$])${n}(?![\\w$])[^}]*?\\}`,
    `<${n}(?=[\\s/>])`,
    `(?<![\\w$.])${n}\\s*[(<]`,
  ];
  return patterns.some((p) => new RegExp(p, 'm').test(code));
}
