/**
 * The work-predicate lint (enterprise-data-sources-2026-10-01 P-009, acceptance R-3, D-022).
 *
 * Claimability is decided by ONE predicate (`agent-work-predicate.ts`), and family routing is
 * spelled in ONE list (`ISSUE_FAMILY_ROUTE_KINDS`). This lint fails a claim or placement path
 * that carries its own hardcoded kind list, which is how the pre-P-009 hand-maintained kind
 * lists (the get-next issue IN list, the claimable tool's ISSUE_KINDS copy) drifted apart.
 *
 * WHICH CODE IS A CLAIM PATH. Derived, not hand-listed: every `selection` row of the P-007
 * census (WORK_SELECTION_CENSUS) names a file and a literal anchor at its kind decider, plus
 * the handler `sites` that reach it. The scope of a path is the top-level declaration that
 * encloses each anchor, widened transitively to the same-file top-level declarations it
 * references. A list hoisted to a module-level const, or into a same-file helper the claim
 * function calls, is therefore still in scope. Listing and rollup code in the same file that
 * no claim path reaches is not.
 *
 * WHAT IS FLAGGED (AST-walked, so comments never count):
 *   - SQL text keyed on a kind column with a literal list: `item_kind IN ('bug', …)`,
 *     `kind NOT IN ('…'`, `item_kind = ANY (ARRAY['…'`, `item_kind <> ALL (ARRAY['…'`.
 *   - A TS array literal of two or more string literals that names a built-in work-item kind
 *     (`['bug', 'change', 'task']`, `new Set(['feature', 'chunk'])`).
 *
 * The fix for a finding is the shared surface, never an exemption: `ISSUE_FAMILY_ROUTE_KINDS`
 * / `issueFamilyRouteSql` for routing, `agentWorkWhereSql` and siblings for claimability.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WORK_SELECTION_CENSUS, type WorkSelectionCensusRow } from '../work-selection-census';
import { ISSUE_FAMILY_ROUTE_KINDS } from './agent-work-predicate';

/**
 * Built-in work-item kinds a hardcoded TS kind array would name. Derived from the shared
 * route list plus the feature family (work-items.ts FeatureFamilyKind). The lint module is
 * not a claim path, so this list does not scan itself.
 */
export const BUILT_IN_KIND_LITERALS: ReadonlySet<string> = new Set<string>([
  ...ISSUE_FAMILY_ROUTE_KINDS,
  'feature',
  'chunk',
  'research-task',
]);

export type KindListFinding = 'sql-in-list' | 'sql-any-array' | 'kind-array';

export interface KindListViolation {
  file: string;
  line: number;
  /** Name of the top-level declaration the list sits in. */
  scope: string;
  finding: KindListFinding;
  /** The offending text, trimmed to one line. */
  text: string;
}

export interface ClaimPathSource {
  /** Repo-relative path, used only for reporting. */
  file: string;
  source: string;
  /** Literal substrings of `source` that sit inside a claim or placement path. */
  anchors: readonly string[];
}

export interface WorkPredicateLintResult {
  violations: KindListViolation[];
  /** Anchors that were not found in their file: the lint scanned nothing for them. */
  unresolvedAnchors: { file: string; anchor: string }[];
  /** Top-level declarations scanned, per file (positive control: never empty for a resolved anchor). */
  scopes: { file: string; names: string[] }[];
}

const SQL_IN_LIST = /\b(?:\w+\.)?(?:item_kind|kind)\s+(?:NOT\s+)?IN\s*\(\s*'/i;
const SQL_ANY_ARRAY = /\b(?:\w+\.)?(?:item_kind|kind)\s*(?:=|<>|!=)\s*(?:ANY|ALL)\s*\(\s*(?:ARRAY\s*)?\[\s*'/i;

function declarationNames(stmt: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) return stmt.name ? [stmt.name.text] : [];
  if (ts.isVariableStatement(stmt)) {
    const names: string[] = [];
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) names.push(d.name.text);
    }
    return names;
  }
  if (ts.isEnumDeclaration(stmt)) return [stmt.name.text];
  return [];
}

function scopeLabel(sf: ts.SourceFile, stmt: ts.Statement): string {
  const names = declarationNames(stmt);
  if (names.length > 0) return names.join(',');
  return `<statement@${sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1}>`;
}

function referencedIdentifiers(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function templateText(node: ts.TemplateExpression): string {
  // Interpolations become a NUL placeholder: `IN (${list})` is not a literal list.
  return node.head.text + node.templateSpans.map((s) => `\u0000${s.literal.text}`).join('');
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

function scanStatement(sf: ts.SourceFile, file: string, stmt: ts.Statement, out: KindListViolation[]): void {
  const scope = scopeLabel(sf, stmt);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const checkSql = (n: ts.Node, text: string): void => {
    if (SQL_IN_LIST.test(text)) out.push({ file, line: lineOf(n), scope, finding: 'sql-in-list', text: oneLine(text) });
    else if (SQL_ANY_ARRAY.test(text))
      out.push({ file, line: lineOf(n), scope, finding: 'sql-any-array', text: oneLine(text) });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      checkSql(n, n.text);
    } else if (ts.isTemplateExpression(n)) {
      checkSql(n, templateText(n));
    } else if (ts.isArrayLiteralExpression(n)) {
      const els = n.elements;
      const literals = els.every((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e));
      if (
        els.length >= 2 &&
        literals &&
        els.some((e) => BUILT_IN_KIND_LITERALS.has((e as ts.StringLiteral).text))
      ) {
        out.push({ file, line: lineOf(n), scope, finding: 'kind-array', text: oneLine(n.getText(sf)) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(stmt);
}

/** Lint in-memory sources. The tree entry point and the fixture tests both go through here. */
export function lintClaimPathSources(inputs: readonly ClaimPathSource[]): WorkPredicateLintResult {
  const violations: KindListViolation[] = [];
  const unresolvedAnchors: { file: string; anchor: string }[] = [];
  const scopes: { file: string; names: string[] }[] = [];

  for (const input of inputs) {
    const sf = ts.createSourceFile(input.file, input.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const topLevel = [...sf.statements];
    const byName = new Map<string, ts.Statement>();
    for (const stmt of topLevel) for (const name of declarationNames(stmt)) byName.set(name, stmt);

    const inScope = new Set<ts.Statement>();
    for (const anchor of input.anchors) {
      let found = false;
      for (let at = input.source.indexOf(anchor); at !== -1; at = input.source.indexOf(anchor, at + 1)) {
        const stmt = topLevel.find((s) => s.getStart(sf) <= at && at < s.getEnd());
        if (stmt) {
          inScope.add(stmt);
          found = true;
        }
      }
      if (!found) unresolvedAnchors.push({ file: input.file, anchor });
    }

    // Widen transitively to same-file top-level declarations the claim path references.
    const queue = [...inScope];
    while (queue.length > 0) {
      const stmt = queue.pop()!;
      for (const name of referencedIdentifiers(stmt)) {
        const target = byName.get(name);
        if (target && !inScope.has(target)) {
          inScope.add(target);
          queue.push(target);
        }
      }
    }

    const ordered = topLevel.filter((s) => inScope.has(s));
    for (const stmt of ordered) scanStatement(sf, input.file, stmt, violations);
    scopes.push({ file: input.file, names: ordered.map((s) => scopeLabel(sf, s)) });
  }

  return { violations, unresolvedAnchors, scopes };
}

/** Group the census `selection` rows (and their sites) into one input per file. */
export function claimPathAnchors(
  census: readonly WorkSelectionCensusRow[] = WORK_SELECTION_CENSUS,
): { file: string; anchors: string[] }[] {
  const byFile = new Map<string, Set<string>>();
  const add = (file: string, anchor: string) => {
    let set = byFile.get(file);
    if (!set) byFile.set(file, (set = new Set()));
    set.add(anchor);
  };
  for (const row of census) {
    if (row.role !== 'selection') continue;
    add(row.file, row.anchor);
    for (const site of row.sites ?? []) add(site.file, site.anchor);
  }
  return [...byFile].map(([file, anchors]) => ({ file, anchors: [...anchors] }));
}

/** Lint the real tree: every claim and placement path named by the census. */
export function lintWorkPredicateTree(
  repoRoot: string,
  census: readonly WorkSelectionCensusRow[] = WORK_SELECTION_CENSUS,
): WorkPredicateLintResult {
  const inputs = claimPathAnchors(census).map(({ file, anchors }) => ({
    file,
    anchors,
    source: readFileSync(path.join(repoRoot, file), 'utf8'),
  }));
  return lintClaimPathSources(inputs);
}
