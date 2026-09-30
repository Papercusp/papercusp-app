// Types for letter-spacing-pattern.mjs — hand-written, mirroring the repo's existing
// `.mjs` + `.d.mts` hook convention (posttooluse-no-proc-path-fixture-nudge.d.mts et al).
// The implementation is .mjs because a PostToolUse hook runs under plain `node`, which
// cannot load TypeScript; the declaration is what lets the TS lint import the same one
// definition instead of forking the regex.

export interface LetterSpacingMatch {
  /** 1-based line number, truthful because comment stripping preserves newlines. */
  line: number;
  /** The matched declaration, trimmed. */
  snippet: string;
}

/** A FRESH `/gm` regex each call — never share one (`lastIndex` is stateful). */
export function nonzeroLetterSpacingRe(): RegExp;

/** Blank out CSS block comments, preserving newlines. */
export function stripCssComments(src: string): string;

/** Every banned declaration in RAW file text, comment-stripped internally. */
export function findNonzeroLetterSpacing(rawText: string): LetterSpacingMatch[];
