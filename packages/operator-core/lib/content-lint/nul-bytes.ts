/**
 * The raw-NUL-byte detector (EI-19393386475030577).
 *
 * A single literal NUL (0x00) in a tracked text source file makes `file(1)`
 * classify a perfectly valid UTF-8 .ts as binary and makes `grep` refuse to
 * search it — while tsc/esbuild compile it fine and the tests pass. So it is
 * invisible locally and only surfaces ~55min later as a RED SHARED GATE
 * (`apps/operator/app/_lints/no-nul-bytes.test.ts`), where the cost lands on the
 * whole fleet instead of the one author.
 *
 * Measured 2026-08-03: a raw NUL committed into
 * `agent-tools/facts/contested-fold.ts:62` at 00:31:38Z held the green gate until
 * 01:28Z — roughly an hour, blocking every agent, for a defect detectable in
 * ~0.2s. The class header already documents SIX prior instances, because by the
 * time the gate reds the author's session is usually gone and nobody learns it.
 *
 * The detector was never the gap — its only FIRING POINT was. Moving it onto the
 * git-sync content guard puts it on the one path every edit takes to reach the
 * gate, ~3min after the write, attributable to the author.
 *
 * ── Why this one carries an `autoFix` when ts-parse/shell-syntax do not ──────
 * Those quarantine because a parse break needs a human to decide the intended
 * code. Here the intent is never ambiguous: `\x00` (the escape) and a raw NUL
 * produce the BYTE-IDENTICAL runtime string, so the repair is a pure
 * re-spelling with no semantic choice to make. That is what makes it safe to
 * apply unattended — and it must be, because a raw NUL is the one defect class
 * the agent Edit tool CANNOT repair: Read renders the NUL as a space, so
 * `old_string` never matches. Four instances once sat unfixed for exactly this
 * reason.
 *
 * PURE + dependency-free so the git-sync guard and the CI lint share one
 * definition (registry D-003) and cannot drift.
 */

/**
 * The NUL as a CHARACTER, built numerically so THIS file never contains one —
 * otherwise the module implementing the check would trip the check (the script
 * this mirrors documents the same trap, having been written with a raw NUL on
 * its first draft).
 */
const NUL_CHAR = String.fromCharCode(0);

/** The 4-ASCII-char escape a raw NUL is rewritten to: backslash, x, 0, 0. */
const NUL_ESCAPE = '\\x00';

/**
 * Text sources only, mirroring `scripts/check-no-nul-in-source.mjs` EXACTLY.
 * A NUL is legitimate in a real binary fixture, and some tests deliberately
 * assert on NUL handling using a fixture file — so fixture/snapshot dirs are
 * skipped rather than repaired.
 */
export const NUL_SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|sql|sh|yml|yaml|toml)$/;
export const NUL_SKIP_RE = /(^|\/)(fixtures?|__fixtures__|snapshots?|__snapshots__)\//;

/** Whether the NUL check applies to a repo-relative path. */
export function nulByteScopeMatches(file: string): boolean {
  return NUL_SOURCE_RE.test(file) && !NUL_SKIP_RE.test(file);
}

export interface NulByteHit {
  /** Total number of raw NUL bytes in the file. */
  count: number;
  /** 1-indexed lines containing at least one NUL, in order of first appearance. */
  lines: number[];
}

/**
 * Find every raw NUL in `text`, reporting the 1-indexed line of each so the fix
 * is one jump away. Returns null when the file is clean.
 *
 * Counts lines the same way the CI script does (advance on \n, record on NUL),
 * so the guard's message and the lint's message name the same positions.
 */
export function findNulBytes(text: string): NulByteHit | null {
  if (!text.includes(NUL_CHAR)) return null;
  const lines: number[] = [];
  let line = 1;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') line++;
    else if (ch === NUL_CHAR) {
      count++;
      if (!lines.includes(line)) lines.push(line);
    }
  }
  return count > 0 ? { count, lines } : null;
}

/**
 * Rewrite every raw NUL to the `\x00` escape — the same transformation
 * `check-no-nul-in-source.mjs --fix` applies, and runtime-identical to it.
 *
 * PURE + idempotent as the registry requires: the output contains no NUL, so a
 * second application is a no-op and reports `changed: false`. Operating on a
 * decoded string is lossless here because NUL is itself a valid UTF-8 codepoint,
 * so no other byte can be disturbed (the script does a latin1 round-trip only
 * because it works at the Buffer level).
 */
export function autoFixNulBytes(text: string): { fixed: string; changed: boolean } {
  if (!text.includes(NUL_CHAR)) return { fixed: text, changed: false };
  return { fixed: text.split(NUL_CHAR).join(NUL_ESCAPE), changed: true };
}
