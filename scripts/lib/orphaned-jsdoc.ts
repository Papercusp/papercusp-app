/**
 * EI-19448039697242208 — detect a JSDoc block that documents a SIGNATURE but is followed
 * immediately by another JSDoc block, so it documents nothing.
 *
 * ## The defect
 *
 * JSDoc binds to the IMMEDIATELY FOLLOWING declaration. Insert a function (or another doc
 * block) between a block and its function and the block silently detaches: TypeScript falls
 * back to inference, and `gen-declarations` happily emits the DEGRADED signature. Measured
 * live in this repo: `projectPrefixFromTscCommand(tscCommand: any)` where the orphaned block
 * said `@param {string}`, and `coalesceWatermarkFor({root: any, files: any, updateFlag: any})`
 * where it said `{root: string, files: Set<string> | null, updateFlag: boolean}`.
 *
 * Nothing else catches it. `gen:declarations:check` compares COMMITTED bytes against a fresh
 * emit — that is STALENESS, not DEGRADATION — so once a degraded declaration is committed the
 * check reports "up to date" forever. It did, while both exports above were degraded.
 *
 * ## Why the rule is narrower than "two JSDoc blocks in a row"
 *
 * Bare adjacency was measured at a **92.5% false-positive rate** (40 flagged / 3 real across 90
 * files): a `@typedef`/`@property` block documents a TYPE, so it legitimately precedes another
 * doc block. Two refinements take it to zero false positives across all enrolled modules:
 *
 *  1. require a SIGNATURE tag (`@param`/`@returns`) — only those document a declaration;
 *  2. match tags at LINE START. A first cut matched `@param` anywhere and false-fired on a
 *     `@typedef` block whose PROSE reads "NOT as an inline `@param`".
 */

/** One orphaned block: the file it is in, its 1-based opening line, and the tags it strands. */
export type OrphanedJsdoc = { file: string; line: number; tags: string[] };

/** A tag that documents the FOLLOWING declaration — the only kind that can be orphaned. */
const SIGNATURE_TAG = /^\s*\*\s*@(?:param|returns|return)\b/;
/** A tag that documents something OTHER than the next declaration — legitimately adjacent. */
const STANDALONE_TAG = /^\s*\*\s*@(?:typedef|callback|module|enum|namespace|property|template)\b/;

type Block = { start: number; end: number; lines: string[] };

function jsdocBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\/\*\*/.test(lines[i] as string)) continue;
    let j = i;
    while (j < lines.length && !/\*\//.test(lines[j] as string)) j++;
    if (j >= lines.length) break; // unterminated: not our business
    blocks.push({ start: i, end: j, lines: lines.slice(i, j + 1) });
    i = j;
  }
  return blocks;
}

/**
 * Find signature-documenting JSDoc blocks whose next non-blank line opens ANOTHER JSDoc block.
 *
 * Pure and syntactic: no type information, no compiler, no filesystem beyond the text handed in.
 *
 * @param sources file text keyed by display path
 * @returns one entry per orphaned block, in file then line order
 */
export function orphanedJsdocProblems(sources: Map<string, string>): OrphanedJsdoc[] {
  const problems: OrphanedJsdoc[] = [];
  for (const [file, text] of sources) {
    const lines = text.split('\n');
    const blocks = jsdocBlocks(lines);
    for (let b = 0; b < blocks.length - 1; b++) {
      const block = blocks[b] as Block;
      const next = blocks[b + 1] as Block;
      let k = block.end + 1;
      while (k < lines.length && (lines[k] as string).trim() === '') k++;
      if (k !== next.start) continue; // real code between: correctly attached
      if (block.lines.some((l) => STANDALONE_TAG.test(l))) continue;
      const tags = block.lines.filter((l) => SIGNATURE_TAG.test(l)).map((l) => l.trim());
      if (tags.length === 0) continue;
      problems.push({ file, line: block.start + 1, tags });
    }
  }
  return problems;
}

/** Render problems for a gate error message, one line each. */
export function formatOrphanedJsdoc(problems: OrphanedJsdoc[]): string[] {
  return problems.map((p) => `${p.file}:${p.line} — strands ${p.tags.join(' ')}`);
}
