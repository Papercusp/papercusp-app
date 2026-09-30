/**
 * MDX compile detector — the pure half of `scripts/check-mdx.mjs` (EI-438),
 * lifted into an importable module so the CI lint, the git-sync content guard,
 * and the content-fixer's success-check all call the SAME implementation
 * (git-sync-content-guard-2026-06-13 P-007 / D-003). "Is this .mdx valid" then
 * has one source of truth — the three can never disagree.
 *
 * A bare angle-bracket token in prose — `<date>`, `<id>`, `<slug>`, `<n>` —
 * written OUTSIDE a code span is parsed by MDX as a JSX element open tag. With
 * no matching close it is a HARD `astro build` failure that blocks the ENTIRE
 * apps/operator-docs build (every agent's doc regeneration). Detection is the
 * REAL MDX compiler, not a regex: each .mdx is compiled with `@mdx-js/mdx` (the
 * same MDX core astro runs) + remark-gfm (matching starlight's pipeline), so
 * undefined Starlight components compile cleanly and only genuine SYNTAX errors
 * fail — zero false positives on the docs that currently build.
 *
 * `@mdx-js/mdx` + `remark-gfm` are LAZILY imported (the operator process loads
 * this module via the content-detector registry at boot; the heavy MDX core
 * should load only when a dirty `.mdx` actually needs compiling).
 */

/** A single MDX syntax error: source position (1-based) + the compiler's reason. */
export interface MdxCompileError {
  line: number | null;
  col: number | null;
  reason: string;
}

/**
 * Blank a leading YAML frontmatter block (--- … ---) to empty lines, preserving
 * line count. `@mdx-js/mdx` alone can't parse frontmatter (no remark-frontmatter
 * here), and astro strips it before the MDX core sees it — so stripping here
 * matches astro, and keeping line numbers means a compile error still points at
 * the offending source line.
 */
export function blankFrontmatter(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return text; // unterminated fence — leave it for the compiler
  for (let i = 0; i <= end; i++) lines[i] = '';
  return lines.join('\n');
}

/**
 * Validate a leading YAML frontmatter block (--- … ---). astro parses the
 * frontmatter as YAML *before* it compiles the MDX body, so a frontmatter YAML
 * error — classically an UNQUOTED value containing `": "` (a quoted phrase) or
 * any `key: value`-looking substring, which YAML reads as a nested mapping and
 * rejects with "bad indentation of a mapping entry" — fails `astro build` HARD
 * and wedges the WHOLE apps/operator-docs build fleet-wide. Yet
 * `findMdxCompileError` blanks the frontmatter and never sees it: EI-438 closed
 * only the body-JSX half; this closes the frontmatter half (EI-1449).
 *
 * Returns the YAML error mapped to the real 1-based source line, or null when the
 * frontmatter parses cleanly (or there is none). `js-yaml` is astro's frontmatter
 * loader (the "bad indentation…" wording is its own), lazily imported like the
 * MDX core. Fails OPEN if the loader shape ever changes (don't wedge the guard).
 */
export async function findFrontmatterYamlError(text: string): Promise<MdxCompileError | null> {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return null; // no frontmatter block
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return null; // unterminated fence — the MDX compile path reports it
  const body = lines.slice(1, end).join('\n');
  const mod = (await import('js-yaml')) as {
    load?: (s: string) => unknown;
    default?: { load?: (s: string) => unknown };
  };
  const load = mod.load ?? mod.default?.load;
  if (typeof load !== 'function') return null; // loader shape changed — fail open
  try {
    load(body);
    return null;
  } catch (err) {
    const e = err as { mark?: { line?: number; column?: number }; reason?: string; message?: string };
    // js-yaml `mark.line` is 0-based WITHIN `body` (which starts after the opening
    // `---` on source line 1) → +2 maps to the 1-based source line.
    const line = typeof e?.mark?.line === 'number' ? e.mark.line + 2 : null;
    const col = typeof e?.mark?.column === 'number' ? e.mark.column + 1 : null;
    const reason = `frontmatter YAML: ${(e?.reason ?? e?.message ?? String(err)).split('\n')[0]}`;
    return { line, col, reason };
  }
}

/**
 * The HTML/SVG intrinsic tag names a docs author legitimately writes as elements
 * (`<br>`, `<kbd>`, `<div>`, `<details>`, `<svg>`/`<path>`, …). `autoFixMdxAngles`
 * NEVER escapes these bare `<name>` tokens — they are real markup, not the
 * placeholder-token offender — so an ambiguous name is always left to the LLM
 * content-fixer (conservative-by-default). Comprehensive on purpose: a name IN
 * this set is skipped even if it looks like a placeholder (`<path>`, `<summary>`,
 * `<time>`), because escaping a real tag would be the worse outcome.
 */
const KNOWN_HTML_TAGS = new Set<string>([
  // HTML5 flow/inline/section elements
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi',
  'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code',
  'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog',
  'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li',
  'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre',
  'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section',
  'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
  // SVG (Starlight docs occasionally inline icons)
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs',
  'use', 'symbol', 'marker', 'text', 'tspan', 'ellipse',
]);

/**
 * Deterministically repair the two most common MDX offenders (WI-276) — a bare
 * angle-bracket token in prose that MDX parses as an unclosed JSX tag and that
 * hard-fails `astro build`, blocking the WHOLE apps/operator-docs build (every
 * agent's doc regen; the 2026-06-20 5-tick quarantine). Escapes the leading `<`
 * to `\<` (which MDX renders as a literal `<`, so `<date>` reads as `<date>`):
 *
 *   1. `<`+DIGIT   — `<1s`, `<5min`, `responds in <100ms`. A JSX tag name can
 *      never start with a digit, so this branch is unconditionally safe.
 *   2. `<word>`    — a bare lowercase placeholder token: `<date>`, `<id>`,
 *      `<slug>`, `<n>`, `<my-flag>`. Escaped ONLY when the name (a) starts
 *      lowercase (real components are Capitalized → skipped: `<Card>`), (b) is
 *      NOT a real HTML/SVG tag (KNOWN_HTML_TAGS → skipped: `<div>`, `<br>`), and
 *      (c) has NO matching `</name>` close tag anywhere in the prose (a properly
 *      PAIRED `<foo>…</foo>` compiles even for an undefined name → skipped). A
 *      token with attributes (`<name x=…>`) or a slash (`<name/>`) never matches
 *      the bare-token regex, so those real-markup shapes are left alone too.
 *
 * SAFE BY CONSTRUCTION: skips frontmatter, fenced code blocks, and inline-code
 * spans (where `<1`/`<date>` are literal and must stay); idempotent (the `(?<!\\)`
 * lookbehind never double-escapes `\<`). Anything ambiguous (a Capitalized
 * component, a known tag, a paired element) is deliberately left to the LLM
 * content-fixer. And note the ONE call-site invariant that makes even branch (2)
 * safe: both callers apply this ONLY to a file that ALREADY fails to compile — a
 * valid, compiling doc is never touched — so the worst case for a mis-targeted
 * `<word>` is a literal render in an already-broken file, strictly better than a
 * fleet-wide build block.
 *
 * Shared so `check-mdx.mjs --fix` (agent-facing) and the git-sync content guard
 * (the deterministic pre-pass before the LLM role) apply the IDENTICAL repair.
 */
export function autoFixMdxAngles(text: string): { fixed: string; changed: boolean } {
  const lines = text.split('\n');
  // Skip a leading YAML frontmatter block — `<1s`/`<date>` there is a YAML string, not MDX.
  let fmEnd = -1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { fmEnd = i; break; }
    }
  }
  const isFence = (line: string): boolean => /^\s*(```|~~~)/.test(line);
  const proseSegments = (line: string): string[] => line.split(/(`[^`]*`)/g); // odd idx = inline code

  // PASS 1: collect close-tag names present in prose (outside frontmatter/fences/inline-code)
  // so a properly PAIRED element (`<foo>…</foo>`, which compiles even for an undefined name)
  // is never escaped — only genuinely UNCLOSED placeholder tokens are.
  const closedNames = new Set<string>();
  {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (i <= fmEnd) continue;
      const line = lines[i];
      if (isFence(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const parts = proseSegments(line);
      for (let idx = 0; idx < parts.length; idx++) {
        if (idx % 2 === 1) continue; // inline code
        for (const m of parts[idx].matchAll(/<\/([a-zA-Z][\w-]*)>/g)) closedNames.add(m[1]);
      }
    }
  }

  // PASS 2: escape the offenders line-by-line, only outside inline-code spans.
  let inFence = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (i <= fmEnd) continue;
    const line = lines[i];
    if (isFence(line)) { inFence = !inFence; continue; } // fence open/close — leave code literal
    if (inFence) continue;
    const parts = proseSegments(line);
    const next = parts
      .map((p, idx) => {
        if (idx % 2 === 1) return p; // inline code — literal, untouched
        // (1) `<`+digit — a JSX tag name can never start with a digit.
        let out = p.replace(/(?<!\\)<(?=\d)/g, '\\<');
        // (2) bare lowercase placeholder `<name>` that is not a real tag and is unclosed.
        out = out.replace(/(?<!\\)<([a-z][a-z0-9_-]*)>/g, (full, name: string) =>
          KNOWN_HTML_TAGS.has(name) || closedNames.has(name) ? full : `\\<${name}>`,
        );
        return out;
      })
      .join('');
    if (next !== line) { lines[i] = next; changed = true; }
  }
  return { fixed: changed ? lines.join('\n') : text, changed };
}

// Memoised lazy loaders for the MDX core + remark-gfm (heavy; only when needed).
type MdxCompile = (value: string, opts?: Record<string, unknown>) => Promise<unknown>;
let _compile: MdxCompile | null = null;
let _remarkGfm: unknown = null;
async function loadMdx(): Promise<{ compile: MdxCompile; remarkGfm: unknown }> {
  if (!_compile) {
    const mdx = (await import('@mdx-js/mdx')) as { compile: MdxCompile };
    _compile = mdx.compile;
  }
  if (!_remarkGfm) {
    const gfm = (await import('remark-gfm')) as { default: unknown };
    _remarkGfm = gfm.default;
  }
  return { compile: _compile, remarkGfm: _remarkGfm };
}

/** Normalise whatever the MDX core threw into our flat `{ line, col, reason }`. */
function normaliseCompileError(err: unknown): MdxCompileError {
  const e = err as { place?: { start?: { line?: number; column?: number } } | { line?: number; column?: number }; line?: number; column?: number; reason?: string; message?: string };
  const start = (e?.place && 'start' in e.place ? e.place.start : e?.place) ?? {};
  const line = e?.line ?? (start as { line?: number }).line ?? null;
  const col = e?.column ?? (start as { column?: number }).column ?? null;
  const reason = (e?.reason ?? e?.message ?? String(err)).split('\n')[0];
  return { line, col, reason };
}

/** Compile once under an explicit remark plugin set. `null` ⇒ it compiled. */
async function compileUnder(
  compile: MdxCompile,
  body: string,
  remarkPlugins: unknown[],
): Promise<MdxCompileError | null> {
  try {
    await compile(body, { format: 'mdx', remarkPlugins });
    return null;
  } catch (err) {
    return normaliseCompileError(err);
  }
}

/**
 * Pure detector: compile one .mdx with the MDX core. Returns `null` when it
 * compiles, or `{ line, col, reason }` on a syntax error. Never throws on a
 * compile error (it is caught + returned); a failure to LOAD the MDX core
 * propagates so the caller can decide (the git-sync guard treats a loader throw
 * as "can't check — don't block").
 *
 * ── Why TWO compiles, with and without remark-gfm (EI-22415725782521670) ──────
 * This detector exists so a doc that `astro build` refuses can never be WRITTEN
 * (docs:author refuses), committed (git-sync guard), or merged (lint:mdx). It
 * only does that job if it is at least as strict as the real build. It was not.
 *
 * `@astrojs/mdx` adds remark-gfm under `if (mdxOptions.gfm)` — a TRUTHINESS
 * check, not the `!== false` it uses for smartypants — so an unset/undefined
 * `gfm` silently drops the GFM table extension. GFM tables change how a row's
 * inline code spans are parsed, so a doc can be valid WITH the extension and a
 * hard parse error WITHOUT it. Measured 2026-09-05: system/lifecycle.mdx built
 * for weeks, then failed fleet-wide with
 *   [@mdx-js/rollup] Expected a closing tag for `<ArchitectChat>` (168:118-168:133)
 * — a signature this detector reproduces EXACTLY with no gfm and not at all with
 * it. `npm run docs:rebuild` was broken for every agent, and this detector — the
 * documented single source of truth for "is this .mdx valid" — reported it clean.
 *
 * So compile under BOTH plugin sets and reject content that fails EITHER: a
 * conservative superset that does not depend on guessing which configuration the
 * build resolved today. Content that parses only under one of them is a latent
 * fleet-wide build break, so rejecting it is the point, not a false positive.
 * Cost is one extra compile; the whole 965-doc corpus re-scans in ~8s. Measured
 * over that corpus at the time of the change: ZERO docs fail only-without-gfm,
 * so this added no false positives to anything that exists.
 */
export async function findMdxCompileError(fileName: string, text: string): Promise<MdxCompileError | null> {
  // astro parses the YAML frontmatter BEFORE it compiles the MDX body, so a
  // frontmatter YAML error wedges the build just as hard (EI-1449). Check it
  // first — the body compile below blanks the frontmatter and can't see it.
  const fmErr = await findFrontmatterYamlError(text);
  if (fmErr) return fmErr;

  const { compile, remarkGfm } = await loadMdx();
  const body = blankFrontmatter(text);

  // With gfm: the pipeline astro resolves when `markdown.gfm` is truthy.
  const withGfm = await compileUnder(compile, body, [remarkGfm]);
  if (withGfm) return withGfm;

  // Without gfm: the pipeline astro ACTUALLY resolved for the EI-22415725782521670
  // build red. A failure only here means the doc is one config change away from
  // wedging the fleet-wide docs build, so say that rather than emit a bare parse
  // error the reader will (correctly) note astro currently builds fine.
  const withoutGfm = await compileUnder(compile, body, []);
  if (withoutGfm) {
    return {
      ...withoutGfm,
      reason:
        `${withoutGfm.reason} — parses ONLY with the GFM table extension active, ` +
        'which the astro MDX pipeline does not guarantee (it adds remark-gfm on a ' +
        'truthiness check). Rewrite the construct so it parses either way; the ' +
        'usual cause is backslash-escaped backticks inside an inline code span in ' +
        'a table cell, which leak into the next line (EI-22415725782521670).',
    };
  }
  return null;
}
