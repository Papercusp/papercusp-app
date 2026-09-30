/**
 * Smart-quote (curly-quote-as-code) detector — the pure half of
 * `scripts/check-smart-quotes.mjs` (EI-418, found via EI-412), lifted into an
 * importable module so the CI lint, the git-sync content guard, and the
 * content-fixer's success-check share ONE implementation
 * (git-sync-content-guard-2026-06-13 P-007 / D-003).
 *
 * A curly quote (U+2018 ' / U+2019 ' / U+201C " / U+201D ") used where a
 * straight code delimiter belongs (a copy-paste through a smart-quoting surface)
 * is a HARD esbuild/tsc parse failure. Detection is PRECISE, not a blanket
 * non-ASCII ban: a curly quote is flagged ONLY when the TypeScript parser emits
 * a syntax diagnostic at that exact offset — i.e. it is genuinely in code
 * position. Curly quotes inside string literals, template literals, comments,
 * and JSX text parse cleanly and are LEFT ALONE (zero false positives).
 */
import ts from 'typescript';

/** One curly-quote hit in code position: 1-based line/col + the offending char. */
export interface CurlyQuoteHit {
  line: number;
  col: number;
  ch: string;
}

export const CURLY = /[‘’“”]/;
const CURLY_G = /[‘’“”]/g;

/** Human label for a curly-quote char (used in error messages). */
export function curlyLabel(ch: string): string {
  return (
    { '‘': 'U+2018 ‘', '’': 'U+2019 ’', '“': 'U+201C “', '”': 'U+201D ”' } as Record<string, string>
  )[ch] ?? 'curly quote';
}

/**
 * Pure detector: curly-quote offsets that sit in CODE position (the TS parser
 * emits a syntactic diagnostic at the offset). Returns `[]` for a clean file.
 * Fast path: a file with no curly-quote byte is never parsed.
 */
export function findCodePositionCurlyQuotes(fileName: string, text: string): CurlyQuoteHit[] {
  if (!CURLY.test(text)) return [];
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, scriptKind);
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  // Offsets where a syntactic diagnostic begins (curly-as-code → TS1127 etc.).
  const diagStarts = new Set<number>();
  for (const d of diags) {
    if (typeof d.start === 'number') diagStarts.add(d.start);
  }
  const hits: CurlyQuoteHit[] = [];
  for (const m of text.matchAll(CURLY_G)) {
    const offset = m.index;
    // Flag the curly quote only if a parse error starts at it (code position)
    // or immediately after it (the char it tried to open a token with).
    if (diagStarts.has(offset) || diagStarts.has(offset + 1)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(offset);
      hits.push({ line: line + 1, col: character + 1, ch: m[0] });
    }
  }
  return hits;
}
