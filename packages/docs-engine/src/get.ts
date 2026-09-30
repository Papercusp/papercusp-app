/**
 * getDocs — source-agnostic batch page fetch.
 *
 * - 1..10 slugs per call (zod enforces upstream; caller may still
 *   pass an empty array which we tolerate by returning {results: []})
 * - Optional heading slice on single-slug calls
 * - 50KB cap per result with truncation tail
 * - Levenshtein-nearest suggestions on miss
 * - Engine emits identical ctx.metadata across surfaces.
 */

import type {
  DocHeading,
  DocPage,
  DocSource,
  EngineCtx,
  GetArgs,
  GetEntry,
  GetResult,
} from './types';
import {
  MAX_PAYLOAD_BYTES,
  levenshteinNearest,
  sliceByHeading,
  truncationTail,
} from './shared';
import { evaluateOkfTrust, okfTrustBanner, okfTrustIsNotable } from './okf';
import type { OkfTrust } from './okf';

interface Window {
  body: string;
  /** Length of the WHOLE body, so a caller always sees how much this window covers. */
  originalBytes: number;
  /** Where `body` starts in the whole body (0 on an unpaged read). */
  start: number;
  truncated: boolean;
  /** Offset of the NEXT window; undefined is the end-of-document signal. */
  nextOffset: number | undefined;
}

/**
 * Search results from some docs surfaces may carry only the final path
 * segment. Accept that compatibility form when it identifies exactly one
 * listed page, while preserving canonical slugs whenever they were supplied.
 */
function uniqueBareLeafPage(slug: string, pages: readonly DocPage[]): DocPage | null {
  if (slug.includes('/')) return null;
  const matches = pages.filter((page) => page.slug.slice(page.slug.lastIndexOf('/') + 1) === slug);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Clip one window out of a body at `offset`, appending the truncation tail when
 * bytes remain past the cap.
 *
 * Shared by the rendered and the source read so the two cannot drift: the tail is
 * exactly what `docs:author` matches to refuse a clipped body, so a source window
 * that omitted it would be a body that looks whole and is not.
 */
function clipWindow(whole: string, offset: number, toc: readonly DocHeading[]): Window {
  const originalBytes = whole.length;
  const start = Math.min(offset, originalBytes);
  let body = start > 0 ? whole.slice(start) : whole;
  if (body.length <= MAX_PAYLOAD_BYTES) {
    return { body, originalBytes, start, truncated: false, nextOffset: undefined };
  }
  const h2s = toc.filter((h) => h.depth === 2);
  const firstH2 = h2s[0];
  const nextOffset = start + MAX_PAYLOAD_BYTES;
  body =
    body.slice(0, MAX_PAYLOAD_BYTES) +
    truncationTail({
      ...(firstH2 ? { firstH2Id: firstH2.id } : {}),
      h2Count: h2s.length,
      nextOffset,
    });
  return { body, originalBytes, start, truncated: true, nextOffset };
}

/**
 * A `source: true` entry — the canonical bytes, windowed and nothing else.
 *
 * Deliberately does NOT prepend the OKF staleness banner the rendered path adds.
 * That banner is a READ-TIME annotation; prepending it to source text would make a
 * faithful round trip write the warning INTO the document. The `trust` verdict is
 * still reported as a field, so the signal survives without entering the bytes.
 */
function sourceEntry(slug: string, raw: string, page: DocPage, offset: number, trust: OkfTrust): GetEntry {
  const { body, originalBytes, start, truncated, nextOffset } = clipWindow(raw, offset, page.toc);
  return {
    slug,
    found: true,
    content: body,
    bytes: originalBytes,
    source: true,
    ...(truncated ? { truncated: true as const } : {}),
    ...(start > 0 ? { offset: start } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(okfTrustIsNotable(trust) ? { trust } : {}),
  };
}

export async function getDocs(source: DocSource, args: GetArgs, ctx: EngineCtx = {}): Promise<GetResult> {
  const { slugs, heading } = args;
  // WI-1511581. `source: true` asks for the bytes an author edits. Both ways of
  // NOT being able to serve that are answered as errors rather than by quietly
  // handing back the rendered projection, which is the corruption the mode exists
  // to prevent — an agent cannot tell a flattened body from the source it asked for.
  const wantSource = args.source === true;
  const sourceRefusal: 'source_unavailable' | 'heading_unsupported_with_source' | null = !wantSource
    ? null
    : heading
      ? 'heading_unsupported_with_source'
      : typeof source.getSource !== 'function'
        ? 'source_unavailable'
        : null;
  // Only meaningful for a single document — a batch has no one byte stream to be
  // at an offset into. Same single-slug rule `heading` follows.
  const offset =
    slugs.length === 1 && Number.isFinite(args.offset) && (args.offset ?? 0) > 0 ? Math.trunc(args.offset as number) : 0;
  // ONE clock for the whole batch — two docs in the same call must never disagree
  // about whether "today" has crossed a stale_after boundary mid-response.
  const now = ctx.now ?? new Date();
  if (ctx.signal?.aborted) throw new Error('cancelled');
  if (slugs.length === 0) {
    ctx.metadata?.({ requested: 0, found: 0, not_found: 0, truncated: 0, sliced: 0, has_heading: !!heading });
    return { results: [] };
  }

  // Answered before listPages(): this is an ARGUMENT/capability verdict about the
  // whole call, and resolving slugs first would let a typo mask it as `not_found`.
  if (sourceRefusal) {
    const detail =
      sourceRefusal === 'heading_unsupported_with_source'
        ? 'a `heading` slice is not the document — drop `heading` to read the whole source, or drop `source` to read that section rendered.'
        : `this docs source (${source.name}) cannot serve canonical source text. Read the doc's file directly instead; do NOT write back a rendered body.`;
    ctx.metadata?.({
      requested: slugs.length,
      found: 0,
      not_found: slugs.length,
      truncated: 0,
      sliced: 0,
      has_heading: !!heading,
      source_requested: true,
      source_refusal: sourceRefusal,
    });
    return { results: slugs.map((slug) => ({ slug, found: false as const, error: sourceRefusal, detail })) };
  }

  const allPages = await source.listPages();
  if (ctx.signal?.aborted) throw new Error('cancelled');
  const allSlugs = allPages.map((p) => p.slug);

  const results: GetEntry[] = await Promise.all(
    slugs.map(async (slug): Promise<GetEntry> => {
      if (ctx.signal?.aborted) throw new Error('cancelled');
      // Exact source lookup wins. If a search result supplied only a bare leaf,
      // use the listed canonical page only when that leaf is unambiguous; never
      // guess across sections.
      const page = (await source.getPage(slug)) ?? uniqueBareLeafPage(slug, allPages);
      if (!page) {
        return {
          slug,
          found: false,
          error: 'not_found',
          suggestions: levenshteinNearest(slug, allSlugs),
        };
      }

      // In source mode a null answer is a REFUSAL for this page (unreadable file,
      // oversize, no canonical row) — never a silent fall-through to getContent.
      if (wantSource) {
        const raw = await source.getSource!(page);
        if (raw === null) {
          return {
            slug,
            found: false,
            error: 'source_unavailable',
            detail: `${source.name} has no retrievable source for this page (unreadable, oversize, or no canonical row). Its rendered body is NOT a substitute — writing one back drops the frontmatter and rewrites every JSX component (a self-closing one disappears entirely).`,
          };
        }
        return sourceEntry(slug, raw, page, offset, evaluateOkfTrust(page.okf, now));
      }

      let body = await source.getContent(page);
      const onlyHeading = heading && slugs.length === 1 ? heading : undefined;

      if (onlyHeading) {
        // sliceByHeading expects TocEntry shape: { url: '#id', title, depth }
        const tocEntries = page.toc.map((h) => ({ url: `#${h.id}`, title: h.text, depth: h.depth }));
        const sliced = sliceByHeading(body, onlyHeading, tocEntries);
        if (!sliced) {
          return {
            slug,
            found: false,
            error: 'heading_not_found',
            suggestions: page.toc.slice(0, 5).map((h) => h.id),
          };
        }
        body = sliced;
      }

      // OKF read-time trust (P-005). The banner is prepended BEFORE the truncation
      // cap so a stale warning is never the thing that gets cut off the end of a
      // long doc (`bytes` then measures the content actually returned, banner included).
      const trust = evaluateOkfTrust(page.okf, now);
      const banner = okfTrustBanner(trust);
      if (banner) body = banner + body;

      const clip = clipWindow(body, offset, page.toc);
      ({ body } = clip);
      const { originalBytes, start, truncated, nextOffset } = clip;

      return {
        slug,
        found: true,
        content: body,
        bytes: originalBytes,
        ...(truncated ? { truncated: true as const } : {}),
        ...(start > 0 ? { offset: start } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(onlyHeading ? { sliced: true as const } : {}),
        ...(okfTrustIsNotable(trust) ? { trust } : {}),
      };
    }),
  );

  const found = results.filter((r) => r.found).length;
  const notFound = results.length - found;
  const truncatedCount = results.filter((r) => 'truncated' in r && r.truncated).length;
  const slicedCount = results.filter((r) => 'sliced' in r && r.sliced).length;
  // Heuristic: presence of mdxJsxFlowElement-style tokens that survived the
  // JSX-cleanup remark pass. Strip code blocks first so fenced code samples
  // containing JSX (e.g. doc snippets) don't false-positive.
  //
  // NOT measured in source mode: raw MDX is SUPPOSED to contain JSX, so the same
  // signal that means "the render leaked" on a rendered read means "the source
  // read worked" here. Emitting it would report a healthy read as a defect, so the
  // key is omitted rather than sent as a false `true` — and `source_mode` says why
  // it is missing, so its absence is never read as "no JSX was found".
  const ctxMeta: Record<string, unknown> = {
    requested: slugs.length,
    found,
    not_found: notFound,
    truncated: truncatedCount,
    sliced: slicedCount,
    has_heading: !!heading,
  };
  if (wantSource) {
    ctxMeta.source_mode = true;
  } else {
    ctxMeta.jsx_literals_present = results.some((r) => {
      if (!r.found) return false;
      const stripped = r.content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
      return /<[A-Z][A-Za-z0-9]*[\s/>]/.test(stripped);
    });
  }
  ctx.metadata?.(ctxMeta);

  return { results };
}

/** Re-export for adapters / tests that need the constant. */
export { MAX_PAYLOAD_BYTES };
