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

/**
 * WI-10004766 — every render goes through ONE FIFO queue, with a macrotask hop
 * before each page.
 *
 * A unified parse+stringify runs entirely inside microtasks. Corpus-wide callers
 * (docs:search, the docs/section resource, docs-qa, doc-embed-sync) fan out over
 * ~1,000 pages with Promise.all, so on a cold cache every render resolved in one
 * uninterrupted microtask chain: the event loop got no turn until the whole corpus
 * was done. Measured on :3170 (2026-10-02 00:07Z): one docs:search ran 16.2s and its
 * stall profile was 95.8% getContent → renderMdxToMarkdown; 22 of 40 R-state
 * sentinel stalls that day overlapped a slow docs call, against 1.2% base-rate
 * coverage. WI-2146645 had already fixed this for doc-embed-sync's own loop, but the
 * defect lived here, in the renderer every caller shares.
 *
 * A per-call yield is NOT enough under Promise.all: N setImmediate callbacks queued
 * together all drain in one check phase, with no I/O poll between them. Serializing
 * the queue means each hop is scheduled only after the previous page finished, so it
 * lands in the NEXT loop iteration. The loop then blocks for at most one page's render,
 * and timers, I/O and pool releases run between pages. Throughput is unchanged
 * because renders are CPU-bound on one thread anyway.
 */
let renderQueueTail: Promise<unknown> = Promise.resolve();

function macrotaskHop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function renderMdxToMarkdown(rawMdx: string, absolutePath: string): Promise<string> {
  const run = renderQueueTail.then(macrotaskHop).then(() => renderMdxToMarkdownUnqueued(rawMdx, absolutePath));
  renderQueueTail = run.catch(() => undefined);
  return run;
}

/**
 * The render itself, with no queue and no yield. Exported ONLY so the test suite can
 * keep it as the deliberately-starving control that proves the measurement detects
 * starvation. Production callers must use {@link renderMdxToMarkdown}.
 * @internal
 */
export async function renderMdxToMarkdownUnqueued(rawMdx: string, absolutePath: string): Promise<string> {
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
