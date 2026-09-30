/**
 * Source-agnostic types for the docs retrieval engine.
 *
 * The engine knows nothing about fumadocs, filesystems, or any specific
 * doc storage. Implementers provide a DocSource; the engine projects it
 * into outline, get, search.
 */

import type { OkfFrontmatter, OkfTrust } from './okf';

export interface DocHeading {
  /** Anchor id (no leading '#'). */
  id: string;
  /** Plain-text heading content (React children flattened). */
  text: string;
  /** 1..6 */
  depth: number;
}

export interface DocPage {
  /** Slash-joined slug, e.g. 'endpoint-system/overview'. Empty string for root index. */
  slug: string;
  /** Slug parts: ['endpoint-system', 'overview']. Empty array for root. */
  slugs: string[];
  /** Public URL the doc site renders this page at. */
  url: string;
  title: string;
  description?: string;
  /** Table of contents — headings extracted from the markdown source. */
  toc: DocHeading[];
  /**
   * EI-10937: `false` ⇒ exclude this page from `searchDocs` (it still renders on
   * the site and is still reachable via `docs:get` / the outline).
   *
   * For GENERATED AGGREGATOR pages — `reference/agent-insights-index` (304KB of
   * every insight's title+description) and `reference/plans-index` (276KB of every
   * plan). Because they concatenate the vocabulary of the WHOLE corpus, they
   * lexically match every possible query and out-score the one focused doc that
   * actually answers it. Measured: the correct doc landed at rank #5 or vanished
   * entirely, so agents concluded "undocumented" and re-derived knowledge that
   * was already written down (this is a large part of why "tribal knowledge"
   * persists — see EI-10904/EI-10941).
   *
   * They are NAVIGATION artifacts, not content. Set via `searchable: false`
   * frontmatter; undefined means searchable.
   */
  searchable?: boolean;
  /**
   * OKF v0.2 trust/staleness frontmatter — plus this repo's local `status:` —
   * when the adapter's source carries any of it
   * (okf-frontmatter-adoption-2026-08-08 P-005). Absent means the source has no
   * OKF metadata — which reads as `unverified` + not-stale, never as verified.
   *
   * ⚠ PRESENT does NOT imply the doc carries OKF trust fields: most of this
   * corpus sets only `status: active`, which populates this object while leaving
   * every trust field unset. Test the specific field you care about
   * (`okf.staleAfter`, `okf.verified`), never `okf !== undefined`.
   */
  okf?: OkfFrontmatter;
}

export interface SectionMeta {
  title?: string;
  description?: string;
}

/**
 * Pluggable source of doc pages. Adapters wrap fumadocs, filesystem walks,
 * HTTP endpoints, etc., and present a uniform interface to the engine.
 */
export interface DocSource {
  /** Identifier for logs, error messages, and cache namespacing. */
  name: string;
  /** List every page in the source. Should be cheap; engines call it freely. */
  listPages(): Promise<DocPage[]>;
  /** Look up by slash-joined slug. Return null if not found. */
  getPage(slug: string): Promise<DocPage | null>;
  /** Render the page's MDX/markdown body to clean markdown (no JSX). */
  getContent(page: DocPage): Promise<string>;
  /**
   * The page's CANONICAL SOURCE — the exact bytes an author edits, frontmatter
   * included: no JSX flattening, no frontmatter strip, no read preamble. This is
   * what a read→edit→write round trip needs; `getContent` is a lossy projection
   * of it (WI-1511581).
   *
   * ⚠ OPTIONAL ON PURPOSE, and a source that cannot produce one must OMIT it
   * rather than alias `getContent`. `getDocs({ source: true })` REFUSES when this
   * method is absent, which is a visible answer; a rendered body served as
   * "source" is the silent corruption the whole mode exists to prevent.
   *
   * What rendering actually costs (`remark-mdx-to-markdown`): EVERY MDX JSX node is
   * rewritten — `<Callout>` to a blockquote, Tabs/Steps/Card unwrapped, any other
   * element with children unwrapped, and a SELF-CLOSING unknown element DROPPED
   * ENTIRELY. Its `import` line survives untouched (nothing handles `mdxjsEsm`),
   * so a rendered body written back leaves an import of a component that no longer
   * appears anywhere. Measured 2026-08-31 over the 956 populated
   * `harness_shared.harness_docs` rows for `papercusp`: 163 carry a Starlight
   * component tag, 222 carry some `<Capital…` token, 195 carry `import … from`.
   *
   * Return `null` when this particular page has no retrievable source (unreadable
   * file, oversize, no canonical row) — again a refusal, never a fallback.
   */
  getSource?(page: DocPage): Promise<string | null>;
  /** Optional per-section metadata (e.g. from meta.json). */
  getSectionMeta?(sectionSlug: string): Promise<SectionMeta>;
}

/**
 * Engine call context. The Phase 2.0 ctx.metadata callback is forwarded
 * so per-call telemetry lands in tool_invocations.metadata_json uniformly
 * across all surfaces.
 */
export interface EngineCtx {
  runId?: string;
  spawnId?: string;
  /** Phase 2.0 telemetry callback — payload lands in tool_invocations.metadata_json. */
  metadata?: (data: Record<string, unknown>) => void;
  /** Forwarded ctx.signal from the dispatcher. Engine functions bail when aborted. */
  signal?: AbortSignal;
  /** Forwarded ctx.progress from the dispatcher. Engine functions emit when defined. */
  progress?: (pct: number, msg: string) => void;
  /**
   * Injectable clock for OKF staleness (`today >= stale_after`). Production never
   * passes it; tests do, so a staleness proof uses a SYNTHETIC past date rather
   * than a fabricated corpus value (plan D-002 forbids the latter).
   */
  now?: Date;
}

/* ─── Outline result ──────────────────────────────────────────────────── */

export interface OutlinePageEntry {
  slug: string;
  title: string;
  description?: string;
  headings: DocHeading[];
}

export interface OutlineSectionEntry {
  slug: string;
  title: string;
  description?: string;
  pages: OutlinePageEntry[];
}

export interface OutlinePayload {
  generatedAt: string;
  sectionCount: number;
  pageCount: number;
  sections: OutlineSectionEntry[];
  /** True if this response was served from per-run cache. */
  cached?: boolean;
}

/* ─── Get result ──────────────────────────────────────────────────────── */

export interface GetArgs {
  /** 1–10 slash-joined slugs. */
  slugs: string[];
  /** Optional heading anchor id or visible heading text. Only honored when slugs.length === 1. */
  heading?: string;
  /**
   * Resume a clipped read at this character offset. Only honored when
   * slugs.length === 1 — it addresses ONE document's byte stream, and a batch has
   * no single stream to be at an offset into.
   *
   * The cap is what made a large doc unreadable through this tool at all
   * (EI-21940075757786953): a caller that needed the WHOLE page had to leave the
   * docs surface for raw SQL. Pair with the `nextOffset` a clipped entry returns.
   */
  offset?: number;
  /**
   * Return each page's CANONICAL SOURCE (see {@link DocSource.getSource}) instead
   * of the rendered read projection — the mode a read→edit→write round trip needs.
   *
   * Mutually exclusive with `heading`: a section slice is by definition not the
   * document, so serving one under this flag would hand a caller a partial body
   * that looks whole. Refused rather than silently narrowed.
   *
   * `offset`/`nextOffset` paging composes normally, and a clipped source window
   * still carries the truncation tail — which is what lets `docs:author` refuse it.
   */
  source?: boolean;
}

export type GetEntry =
  | {
      slug: string;
      found: true;
      content: string;
      bytes: number;
      truncated?: true;
      sliced?: true;
      /**
       * `content` is the CANONICAL SOURCE, not the rendered projection — present
       * exactly when the entry was served under `source: true`. Its ABSENCE on a
       * found entry means the body was rendered, so a caller about to write the
       * body back can tell the two apart without tracking what it asked for.
       */
      source?: true;
      /**
       * Where `content` starts in the page — present only on a paged read
       * (`offset > 0`), so a plain read's shape is unchanged.
       */
      offset?: number;
      /**
       * The offset to pass back to read the NEXT window. Present exactly when
       * bytes remain past this one, so its ABSENCE is the end-of-document signal
       * rather than something the caller has to compute from `bytes`.
       */
      nextOffset?: number;
      /**
       * OKF trust verdict — present ONLY when it carries signal (stale, verified,
       * or an unparseable `stale_after`). Its ABSENCE means `unverified` and not
       * stale, which is the whole live corpus today. A stale doc ALSO gets a
       * one-line banner prepended to `content`, because a field the reader never
       * looks at cannot deliver "this is stale" at read time.
       */
      trust?: OkfTrust;
    }
  | {
      slug: string;
      found: false;
      /**
       * `source_unavailable` — `source: true` was asked for and this source cannot
       * answer it. It is deliberately an ERROR entry and never a quiet fallback to
       * the rendered body: a lossy projection returned under a source read is the
       * corruption this mode prevents.
       *
       * `heading_unsupported_with_source` — `heading` + `source` together. A slice
       * is not the document; narrowing silently would hand back a partial body that
       * reads as complete.
       */
      error: 'not_found' | 'heading_not_found' | 'source_unavailable' | 'heading_unsupported_with_source';
      suggestions?: string[];
      /** Human-readable explanation + the repair, on errors that have one. */
      detail?: string;
    };

export interface GetResult {
  results: GetEntry[];
}

/* ─── Search result ───────────────────────────────────────────────────── */

export interface SearchArgs {
  query: string;
  /** Max hits to return. Default 8. */
  limit?: number;
}

export interface SearchHit {
  slug: string;
  url: string;
  title: string;
  description?: string;
  score: number;
  excerpt: string;
  /** OKF trust verdict — present only when notable (see GetEntry.trust). */
  trust?: OkfTrust;
}

export interface SearchResult {
  query: string;
  tokenCount: number;
  hitCount: number;
  hits: SearchHit[];
}
