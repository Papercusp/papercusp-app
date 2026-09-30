/**
 * Finds chunk-boundary-unsafe text accumulation inside stream `data` handlers.
 *
 * Shared by the guard test (child-output-guard.test.ts). Lives in its own module
 * so the scanner itself is unit-testable against fixtures — a guard whose
 * DETECTOR is untested can go quietly blind and its green then means nothing,
 * which is the exact failure the guard exists to prevent.
 *
 * See child-output.ts for the bug being detected (WI-6728).
 */

/** One chunk-unsafe accumulation site. */
export interface ChunkUnsafeSite {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed line of the accumulation itself, not of the handler. */
  line: number;
  /** The offending source line, trimmed. */
  text: string;
  /** Enclosing top-level symbol (`const foo = …`, `function foo`, …), if resolvable. */
  symbol: string | null;
}

/**
 * Accumulation of a per-chunk decode:
 *   acc += String(d)
 *   acc += d.toString()      /  d.toString('utf8')  /  d?.toString()
 *   acc += `${d}`
 * Deliberately NOT matched: `chunks.push(d)` (byte-exact, correct) and
 * `acc += 'a literal'` (not a chunk).
 */
const ACCUMULATE = /\+=\s*(?:String\(|`\$\{|[A-Za-z_$][\w$]*\??\.toString\()/;

/** Opens a `data` subscription: `.on('data',` / `.addListener("data",` */
const DATA_HANDLER = /\.(?:on|addListener|once)\(\s*['"]data['"]\s*,/;

/**
 * Resolve a line to its enclosing TOP-LEVEL symbol.
 *
 * Indentation-zero declarations only. A naive nearest-declaration walk finds
 * the local `const child = spawn(...)` on the matching line itself, so every
 * site resolves to a symbol named `child` and any symbol-keyed allowlist
 * silently matches nothing — a guard that passes while checking nothing.
 */
export function enclosingTopLevelSymbol(lines: string[], lineIdx: number): string | null {
  const decl =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
  for (let i = lineIdx; i >= 0; i--) {
    const m = decl.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Scan one file's source for chunk-unsafe accumulation sites.
 *
 * Walks the `data` handler's real extent by paren depth rather than by a fixed
 * line window, so an accumulation in a SIBLING handler (`child.on('error', e =>
 * { stderr += String(e) })` — an Error, not a chunk, and correct) is not
 * mistaken for one inside the data handler.
 */
export function scanSource(file: string, src: string): ChunkUnsafeSite[] {
  const lines = src.split('\n');
  const hits: ChunkUnsafeSite[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const open = DATA_HANDLER.exec(lines[i]);
    if (open === null) continue;

    // Walk from `.on(` to its matching close paren, tracking paren depth.
    //
    // ⚠ The accumulation must be tested against the depth AT THE START of the
    // line, not after the whole line is accounted for. The dominant form is a
    // ONE-LINE arrow — `.on('data', (d) => (s += String(d)))` — which opens and
    // closes the handler on the same line, so an end-of-line depth check reads
    // 0 and skips it. That mistake made this scanner miss ~84% of real sites.
    let depth = 0;
    let started = false;
    for (let j = i; j < Math.min(i + 40, lines.length); j++) {
      const line = lines[j];
      const insideAtLineStart = started && depth > 0;

      if ((j === i || insideAtLineStart) && ACCUMULATE.test(line) && !seen.has(j)) {
        seen.add(j);
        hits.push({
          file,
          line: j + 1,
          text: line.trim(),
          symbol: enclosingTopLevelSymbol(lines, j),
        });
      }

      for (let k = j === i ? open.index : 0; k < line.length; k++) {
        if (line[k] === '(') {
          depth++;
          started = true;
        } else if (line[k] === ')') {
          depth--;
        }
      }
      if (started && depth <= 0) break;
    }
  }
  return hits;
}
