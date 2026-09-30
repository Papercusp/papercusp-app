/**
 * DECLARED, MACHINE-CHECKABLE COMPLETION CLAIMS — the falsity half of completion
 * integrity (EI-22175397357614106).
 *
 * ── The gap this closes ──
 *
 * Every existing completion-integrity check is a PRESENCE test: is the authority
 * `proposed` or `committed`, are the `filesChanged` paths in the staging commit, do the
 * three evidence surfaces carry anything at all. A close whose evidence is present,
 * well-formed and WRONG passes all of them.
 *
 * The measured instance: WI-37365 closed `done` / authority `committed`, its evidence
 * asserting that `coord:dispatch` had reached the live seeded tool surface. It had not —
 * the verb sat only in `QUEEN_MCP_TOOL_NAMES` (the retired `role==='mug'` tier) and was
 * absent from `CORE_MCP_TOOL_NAMES`. Nothing could see it: the false close then became
 * the premise for a P-013 falsifier armed to fire 2026-09-08, which would have measured
 * adoption of a verb no live session could call, observed ~zero, and reported
 * non-adoption — a confident wrong verdict three items downstream of the original close.
 * (That specific defect was remediated 2026-09-02T19:37Z, ~69 min after the item was
 * filed, by seeding the verb into CORE — see the comment at `invoke.ts` CORE_MCP_TOOL_NAMES.
 * The general blindness it exposed is what this module addresses.)
 *
 * ── Why a CALLER-DECLARED claim is not the testimonial that `filesChanged` is ──
 *
 * `CompletionTreeStampSchema` states the rule this module has to answer to: a
 * caller-supplied sha is a testimonial, an observed one is evidence — which is why the
 * tree stamp is server-stamped and never asked of the caller. `filesChanged` is the
 * cautionary case in the other direction (EI-20093150500083378: 8 of 12 declared paths
 * did not exist).
 *
 * A declared claim here is categorically different, and the difference is the whole
 * design: it is not asked to be BELIEVED. It is a falsifiable assertion in a form the
 * server can independently RE-EVALUATE against the source, so the caller supplies only
 * the CLAIM and the machine supplies the VERDICT. A closer who declares something false
 * is not adding unchecked testimony — they are handing the auditor the rope.
 *
 * ── Why DECLARED and not EXTRACTED from the completion prose ──
 *
 * The obvious alternative is to mine `summary`/`testResult` for membership assertions.
 * `doc-claims/executable-claims.ts` already measured what that costs on this repo's
 * prose and documents it at length: a negation-cue heuristic was wrong in BOTH
 * directions on the real CLAUDE.md, and the failure is SILENT — a detector that
 * understands nothing reports "clean", not "unsupported". Its conclusion (whitelist the
 * sites where the voice is unambiguous; treat everything else as unknown → skipped) is
 * the same conclusion reached here one layer further: do not parse the claim out of
 * English at all, take it in a structured form or not at all.
 *
 * ── Fail-open, in every uncertain direction ──
 *
 * A verdict is `holds`, `falsified`, or `unevaluatable` — never a boolean. `holds` is
 * returned ONLY on positive evidence from the parsed source. Anything that makes the
 * source unreadable, unparseable, or the container's membership genuinely undecidable
 * (an unresolved spread, a computed element) yields `unevaluatable` WITH a reason.
 *
 * This is the lesson the source item cites about itself: an incomplete enumeration reads
 * exactly like a passing guard. A missed falsity costs what we have today; a fabricated
 * one costs a red gate on honest work and trains readers to ignore the check.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import ts from 'typescript';
import { z } from 'zod';

/**
 * A string literal's membership in a named array literal — the shape of the measured
 * failure ("`coord:dispatch` is in `CORE_MCP_TOOL_NAMES`").
 */
export const StringInArrayClaimSchema = z.object({
  kind: z.literal('string-in-array'),
  /** Repo-relative path to the source file holding the array. */
  path: z.string().min(1),
  /** The declared name the array literal is bound to, e.g. `CORE_MCP_TOOL_NAMES`. */
  container: z.string().min(1),
  /** The string literal asserted to be present/absent, e.g. `coord:dispatch`. */
  value: z.string().min(1),
  expect: z.enum(['present', 'absent']),
});

/** A named declaration's existence in a file — "X is defined/exported in Y". */
export const SymbolDefinedClaimSchema = z.object({
  kind: z.literal('symbol-defined'),
  path: z.string().min(1),
  /** The declared name, e.g. `derivedTerminalCompletionAuthority`. */
  symbol: z.string().min(1),
  expect: z.enum(['present', 'absent']),
  /** When true, the declaration must also carry an `export` modifier. */
  exported: z.boolean().optional(),
});

export const CompletionClaimSchema = z.discriminatedUnion('kind', [
  StringInArrayClaimSchema,
  SymbolDefinedClaimSchema,
]);

export type StringInArrayClaim = z.infer<typeof StringInArrayClaimSchema>;
export type SymbolDefinedClaim = z.infer<typeof SymbolDefinedClaimSchema>;
export type CompletionClaim = z.infer<typeof CompletionClaimSchema>;

/**
 * Deliberately small. Every kind here is decidable from a single file's AST with no
 * type resolution, no module graph and no build — which is what keeps evaluation cheap
 * enough to run on the close path. Widening this set is a real design step, not a
 * convenience: a kind that cannot be decided syntactically belongs somewhere else.
 */
export const COMPLETION_CLAIM_KINDS = ['string-in-array', 'symbol-defined'] as const;
export type CompletionClaimKind = (typeof COMPLETION_CLAIM_KINDS)[number];

export const COMPLETION_CLAIMS_CONTRACT =
  'Optional machine-checkable assertions about the source ("X is in array Y", "X is defined ' +
  'in Z"). The server RE-EVALUATES each against the tree: a false one downgrades this close ' +
  'to proposed and is named back to you. Undecidable ones are ignored, never treated as passing.';

export type CompletionClaimVerdict = 'holds' | 'falsified' | 'unevaluatable';

export interface CompletionClaimResult {
  claim: CompletionClaim;
  verdict: CompletionClaimVerdict;
  /**
   * Why the evaluator reached this verdict. REQUIRED for `falsified` and
   * `unevaluatable` — a verdict a reader cannot act on is barely better than no verdict.
   */
  reason: string;
}

/** Injected so tests can evaluate against fixtures without touching the repo. */
export interface ClaimSourceReader {
  /** Return the file's text, or null when it does not exist / cannot be read. */
  readSource(path: string): string | null;
}

/** Reads repo-relative paths under `repoRoot`. Absolute paths are rejected, not resolved. */
export function repoSourceReader(repoRoot: string): ClaimSourceReader {
  return {
    readSource(path: string): string | null {
      if (isAbsolute(path)) return null;
      // Reject traversal rather than normalising it away: a claim is supposed to name a
      // path inside the repo, and one that climbs out is malformed, not merely unusual.
      if (path.split(/[\\/]/).includes('..')) return null;
      try {
        return readFileSync(resolve(repoRoot, path), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/** Unwrap `as const` / `satisfies` / parenthesised wrappers around an initializer. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

function findDeclaration(sf: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

function hasExportModifier(node: ts.Node): boolean {
  // The declaration itself carries no modifiers — `export const X = …` puts them on the
  // enclosing VariableStatement, so walk up to it.
  const stmt = ts.isVariableDeclaration(node) ? node.parent?.parent : node;
  const mods = ts.canHaveModifiers(stmt as ts.Node) ? ts.getModifiers(stmt as ts.HasModifiers) : undefined;
  return (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function evaluateStringInArray(claim: StringInArrayClaim, reader: ClaimSourceReader): CompletionClaimResult {
  const settle = (verdict: CompletionClaimVerdict, reason: string): CompletionClaimResult => ({
    claim,
    verdict,
    reason,
  });

  const text = reader.readSource(claim.path);
  if (text === null) {
    return settle('unevaluatable', `source not readable: ${claim.path}`);
  }

  const sf = parse(claim.path, text);
  const decl = findDeclaration(sf, claim.container);
  if (!decl) {
    // An absent container cannot witness a present value, and cannot establish absence
    // either — the array may simply have been renamed or moved.
    return settle('unevaluatable', `no declaration named '${claim.container}' in ${claim.path}`);
  }
  if (!decl.initializer) {
    return settle('unevaluatable', `'${claim.container}' has no initializer in ${claim.path}`);
  }

  const init = unwrap(decl.initializer);
  if (!ts.isArrayLiteralExpression(init)) {
    return settle(
      'unevaluatable',
      `'${claim.container}' is not an array literal in ${claim.path} (found ${ts.SyntaxKind[init.kind]})`,
    );
  }

  let sawUnresolvable = false;
  let present = false;
  for (const el of init.elements) {
    const e = unwrap(el);
    if (ts.isStringLiteralLike(e)) {
      if (e.text === claim.value) present = true;
      continue;
    }
    // A spread or computed element means the enumeration this check can see is
    // INCOMPLETE. That is decisive for absence and irrelevant to a positive hit.
    sawUnresolvable = true;
  }

  if (claim.expect === 'present') {
    if (present) {
      return settle('holds', `'${claim.value}' is a literal element of '${claim.container}' in ${claim.path}`);
    }
    if (sawUnresolvable) {
      return settle(
        'unevaluatable',
        `'${claim.value}' is not a literal element of '${claim.container}', but that array ` +
          `contains spread/computed elements — membership cannot be decided syntactically`,
      );
    }
    return settle(
      'falsified',
      `'${claim.value}' is NOT an element of '${claim.container}' in ${claim.path} ` +
        `(${init.elements.length} fully-enumerated element(s))`,
    );
  }

  // expect: 'absent'
  if (present) {
    return settle('falsified', `'${claim.value}' IS an element of '${claim.container}' in ${claim.path}`);
  }
  if (sawUnresolvable) {
    return settle(
      'unevaluatable',
      `'${claim.container}' contains spread/computed elements — absence cannot be established syntactically`,
    );
  }
  return settle('holds', `'${claim.value}' is absent from the fully-enumerated '${claim.container}'`);
}

function evaluateSymbolDefined(claim: SymbolDefinedClaim, reader: ClaimSourceReader): CompletionClaimResult {
  const settle = (verdict: CompletionClaimVerdict, reason: string): CompletionClaimResult => ({
    claim,
    verdict,
    reason,
  });

  const text = reader.readSource(claim.path);
  if (text === null) {
    return settle('unevaluatable', `source not readable: ${claim.path}`);
  }

  const sf = parse(claim.path, text);
  let declared = false;
  let exported = false;

  const named = (node: ts.Node): boolean => {
    const decl = node as { name?: ts.Node };
    return !!decl.name && ts.isIdentifier(decl.name as ts.Node) && (decl.name as ts.Identifier).text === claim.symbol;
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      named(node)
    ) {
      declared = true;
      if (hasExportModifier(node)) exported = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  const satisfied = claim.exported === true ? declared && exported : declared;

  if (claim.expect === 'present') {
    if (satisfied) {
      return settle(
        'holds',
        claim.exported === true
          ? `'${claim.symbol}' is declared and exported in ${claim.path}`
          : `'${claim.symbol}' is declared in ${claim.path}`,
      );
    }
    if (declared && claim.exported === true) {
      return settle('falsified', `'${claim.symbol}' is declared in ${claim.path} but NOT exported`);
    }
    return settle('falsified', `'${claim.symbol}' is not declared in ${claim.path}`);
  }

  if (satisfied) {
    return settle('falsified', `'${claim.symbol}' IS declared in ${claim.path}`);
  }
  return settle('holds', `'${claim.symbol}' is not declared in ${claim.path}`);
}

/** Evaluate ONE claim. Never throws — an evaluator that throws would fail CLOSED. */
export function evaluateCompletionClaim(
  claim: CompletionClaim,
  reader: ClaimSourceReader,
): CompletionClaimResult {
  try {
    switch (claim.kind) {
      case 'string-in-array':
        return evaluateStringInArray(claim, reader);
      case 'symbol-defined':
        return evaluateSymbolDefined(claim, reader);
      default: {
        // Exhaustiveness guard: a kind added to the schema without an evaluator arm must
        // degrade to `unevaluatable`, never be silently reported as holding.
        const unknown = claim as { kind?: unknown };
        return {
          claim,
          verdict: 'unevaluatable',
          reason: `no evaluator for claim kind '${String(unknown.kind)}'`,
        };
      }
    }
  } catch (err) {
    return {
      claim,
      verdict: 'unevaluatable',
      reason: `evaluator error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface CompletionClaimsReport {
  results: CompletionClaimResult[];
  held: number;
  falsified: number;
  unevaluatable: number;
  /** True when at least one declared claim was FALSIFIED against the source. */
  anyFalsified: boolean;
}

/** Evaluate every declared claim on a close. */
export function evaluateCompletionClaims(
  claims: readonly CompletionClaim[] | null | undefined,
  reader: ClaimSourceReader,
): CompletionClaimsReport {
  const results = (claims ?? []).map((c) => evaluateCompletionClaim(c, reader));
  const held = results.filter((r) => r.verdict === 'holds').length;
  const falsified = results.filter((r) => r.verdict === 'falsified').length;
  const unevaluatable = results.filter((r) => r.verdict === 'unevaluatable').length;
  return { results, held, falsified, unevaluatable, anyFalsified: falsified > 0 };
}

/** One-line-per-claim rendering for a completion result or an audit row. */
export function renderCompletionClaimsReport(report: CompletionClaimsReport): string {
  if (report.results.length === 0) return 'no declared claims';
  const glyph: Record<CompletionClaimVerdict, string> = {
    holds: '✓',
    falsified: '✗',
    unevaluatable: '?',
  };
  return report.results.map((r) => `${glyph[r.verdict]} ${r.verdict.toUpperCase()}: ${r.reason}`).join('\n');
}
