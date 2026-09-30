/**
 * Strip JS/TS comments for source-level guard tests.
 *
 * WHY THIS EXISTS AS A SHARED MODULE (cdn-egress-fixes-2026-08-02 P-001). The
 * CDN guards (vditor-cdn.test.ts, monaco-cdn.test.ts) assert over SOURCE TEXT,
 * so they must not count a call site that only appears in prose. Both grew their
 * own two-regex stripper:
 *
 *     src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
 *
 * That is subtly wrong, and it bit for real. It strips BLOCK comments first, so
 * a `/*` appearing inside a LINE comment opens a phantom block comment that runs
 * until the next `*​/` anywhere in the file. Measured on
 * HarnessPluginsSection.tsx, whose line 8 reads:
 *
 *     // hand-editing its dotfiles (AGENTS.md / config.json / .mcp.json / .claude/​* /
 *
 * The `.claude/​*` swallowed lines 8-52 — including the file's
 * `import MonacoEditor from '@monaco-editor/react'` — so the guard saw 3 call
 * sites where 4 exist.
 *
 * THE DANGEROUS DIRECTION is not the one observed. Here the count fell below the
 * floor and the test failed loudly. But the same swallow that hides a call site
 * can hide it while the count still clears the floor — and then the guard PASSES
 * while a surface silently fetches from a CDN. A guard whose blind spot is
 * invisible is worse than no guard, so this is fixed at the helper rather than
 * worked around at either call site.
 *
 * A single left-to-right scan fixes it by construction: whichever of `//` or
 * `/*` is reached FIRST wins, which is exactly what a real tokenizer does.
 * String literals are copied through verbatim so a `/​*` or `//` inside a string
 * (a URL, a glob) is never mistaken for a comment.
 *
 * Deliberately NOT a full parser: regex literals are not tracked, since these
 * guards match import/constructor text and a regex containing an unbalanced
 * quote is vanishingly rare in the files under guard. If that ever bites, the
 * fix is a real tokenizer, not another special case here.
 */

/** Remove line and block comments, preserving string-literal contents. */
export function stripJsComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // String / template literal: copy verbatim, honouring escapes. This is what
    // keeps a URL ('https://…') or a glob ('.claude/*') from reading as a comment.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        const done = src[i] === quote;
        i++;
        if (done) break;
      }
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}
