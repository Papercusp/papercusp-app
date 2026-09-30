/**
 * Pure MDX → clean markdown rendering pipeline.
 *
 * Source-agnostic: takes raw MDX text + an absolute path and returns
 * rendered markdown with JSX nodes converted (Callout/Aside →
 * blockquote, Tabs/Steps unwrapped, etc.) per the rules in
 * remark-mdx-to-markdown.ts. Used by adapters (starlight, harness-fs).
 */

import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkMdxToMarkdown from './remark-mdx-to-markdown.js';

const processor = remark()
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkMdxToMarkdown);

/**
 * Fallback body for a doc whose MDX fails to parse (EI-5860). A single malformed
 * doc — a raw `<owner>` placeholder parsed as an unclosed JSX tag, or a `{expr}`
 * acorn can't parse — must NOT throw and blind the whole corpus for search/outline.
 * Strip a leading frontmatter block + ESM import/export wiring (never prose) with
 * pure regex (no parse), leaving the prose so the doc stays keyword-searchable.
 */
function fallbackStripMdx(rawMdx: string): string {
  return rawMdx
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^[ \t]*(import|export)\s.*$/gm, '')
    .trim();
}

export async function renderMdxToMarkdown(rawMdx: string, absolutePath: string): Promise<string> {
  try {
    const processed = await processor.process({ path: absolutePath, value: rawMdx });
    return String(processed);
  } catch (err) {
    // EI-5860: remark-mdx throws on a single malformed doc (unclosed `<tag>`,
    // unparseable `{expr}`). Because adapters render every page (Promise.all),
    // one throw unwinds the entire search/outline for the corpus. Degrade
    // gracefully: keep the doc keyword-searchable via a raw-text fallback and
    // warn so the offending doc gets fixed (backtick the raw placeholder).
    // eslint-disable-next-line no-console
    console.warn(
      `[docs-engine] MDX parse failed for ${absolutePath}; using raw-text fallback so search/outline still work. ` +
        `Fix the doc (backtick raw <placeholders> / {expressions}). Cause: ${(err as Error)?.message ?? String(err)}`,
    );
    return fallbackStripMdx(rawMdx);
  }
}

/** Format a page body with the standard agent-readable preamble. */
export function withPreamble(
  body: string,
  meta: { title: string; url: string; description?: string },
): string {
  const desc = meta.description ?? '';
  return `# ${meta.title}\nURL: ${meta.url}\n\n${desc}\n\n${body}`;
}
