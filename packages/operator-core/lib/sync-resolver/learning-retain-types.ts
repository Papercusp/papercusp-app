/**
 * learning-retain-types.ts — the PURE shared vocabulary of the Retain view's
 * unified "Retained" ledger (Variant D, WI-39493 / WI-39491, owner pick
 * 2026-08-16).
 *
 * Deliberately import-free (no node:fs / postgres / pg-layer): the operator-vite
 * client VALUE-imports the tab/filter enums for its nuqs parsers, so this module
 * must stay safe for the browser bundle. The read implementation lives in
 * learning-retain-read.ts (server-only).
 */

/** One row-kind per retained store. Tie-order at equal ts is the PLAIN STRING
 *  order of these tokens (kind ASC) — the cursor predicate on both the SQL and
 *  JS legs relies on that, so never reorder semantically. 'memory' = the hive's
 *  shared-memory pool, folded in as its own kind (WI-39535). */
export type RetainFeedKind = 'memory' | 'plan' | 'wi' | 'rubric' | 'runbook' | 'recipe';

export const RETAIN_FEED_TABS = ['all', 'memories', 'plans', 'wi', 'rubrics', 'runbooks', 'recipes'] as const;
export type RetainFeedTab = (typeof RETAIN_FEED_TABS)[number];

/** Column-filter state the Retain client compiles from its `rtf` URL param.
 * Text/numeric presentation columns without a server predicate stay out of
 * this shape; these are exactly the persisted axes the six feed legs support. */
export interface RetainFeedColumnFilters {
  /** Case-insensitive substring match over the rendered row title. */
  title?: string;
  /** OR within status, AND with every other active dimension. */
  statuses?: readonly string[];
  /** Origin-idea lens. Rows without an origin idea fail an active lens filter. */
  lenses?: readonly string[];
}

/** Wire arguments shared by `learning.retainFeed` and its companion summary.
 * `hive` is resolved to concrete store scopes by the registry layer. */
export interface RetainFeedQueryArgs {
  tab?: RetainFeedTab;
  cursor?: string | null;
  limit?: number;
  hive?: string;
  /** Quick search over id + title + server-stamped status. */
  q?: string;
  filters?: RetainFeedColumnFilters;
}

export const RETAIN_KIND_FOR_TAB: Record<Exclude<RetainFeedTab, 'all'>, RetainFeedKind> = {
  memories: 'memory',
  plans: 'plan',
  wi: 'wi',
  rubrics: 'rubric',
  runbooks: 'runbook',
  recipes: 'recipe',
};

export interface RetainFeedRowMeta {
  /** Origin idea (plan/wi rows): the Blender lens + idea that produced it. */
  lens?: string;
  ideaId?: string;
  ideaTitle?: string | null;
  /** Plan rows: plan-born work-item rollup (engineer_issues.source_plan_slug). */
  childTotal?: number;
  childDone?: number;
  /** Recipe rows. */
  runCount?: number;
  /** Runbook rows: the doc's `discovered:` frontmatter date. */
  discovered?: string | null;
  /** Memory rows (WI-39535): the memory's own kind tag + provenance — what the
   *  standalone pool's provenance badges rendered from. `memKind` (not `kind`)
   *  so it can never shadow the ROW kind. */
  memKind?: string;
  createdBy?: string;
  packId?: string;
}

export interface RetainFeedRow {
  kind: RetainFeedKind;
  /** plan slug · issue id · rubric slug · doc slug · recipe id. */
  id: string;
  title: string;
  /** Recent-activity instant (ISO, ms precision) — the interleave key. Per
   *  kind: plans = GREATEST(plan updated, idea routed) · wi = updated_at ·
   *  rubrics = updatedAt · runbooks = file mtime · recipes =
   *  GREATEST(last_run_at, updated_at, created_at). */
  ts: string;
  /** Server-classified status chip; null for kinds without one (runbook, recipe). */
  status: string | null;
  /** Did it LAND — classified server-side against the shared status sets
   *  (client re-typing state lists is the drift bug EI-18792873324746237). */
  shipped: boolean;
  meta: RetainFeedRowMeta;
}

/** Corpus size per kind — the tab badges. For the two statusful kinds
 *  (`plans`, `wi`) this counts the SHIPPED population, matching the rows the
 *  tab actually yields; the other four are whole-corpus counts because those
 *  kinds are retained unconditionally. A badge that could not promise the rows
 *  behind it is the failure this alignment exists to prevent (D-001).
 *  null = that count's read degraded, render as unknown, never as 0. */
export interface RetainFeedCounts {
  memories: number | null;
  plans: number | null;
  wi: number | null;
  rubrics: number | null;
  runbooks: number | null;
  recipes: number | null;
}

export interface RetainFeedPage {
  rows: RetainFeedRow[];
  /** Opaque keyset cursor for the next page; null = feed exhausted. */
  nextCursor: string | null;
  /** Present on the FIRST page only (cursor omitted); pages keep it out so
   *  scroll fetches stay slim. */
  counts: RetainFeedCounts | null;
  /** Legs that errored while building this page (best-effort feed — a leg
   *  failure degrades to absence, never a 500). */
  degraded: string[];
  generatedAt: string;
}

/** A plan-born work item under an expanded plan row. */
export interface RetainPlanChild {
  id: string;
  title: string;
  status: string;
  shipped: boolean;
  ts: string;
}

/** Composite keyset cursor over (ts DESC, kind ASC, id ASC). */
export interface RetainFeedCursor {
  ts: string;
  kind: RetainFeedKind;
  id: string;
}

const RETAIN_FEED_KINDS: readonly string[] = ['memory', 'plan', 'wi', 'rubric', 'runbook', 'recipe'];

export function encodeRetainCursor(c: RetainFeedCursor): string {
  return JSON.stringify(c);
}

/** Parse an opaque cursor string; malformed input reads as "no cursor" (first
 *  page) rather than an error — a stale client cursor must never 500 the feed. */
export function decodeRetainCursor(s: string | null | undefined): RetainFeedCursor | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as Partial<RetainFeedCursor>;
    if (
      v &&
      typeof v.ts === 'string' &&
      typeof v.id === 'string' &&
      typeof v.kind === 'string' &&
      RETAIN_FEED_KINDS.includes(v.kind)
    ) {
      return { ts: v.ts, kind: v.kind as RetainFeedKind, id: v.id };
    }
  } catch {
    /* malformed cursor → first page */
  }
  return null;
}

/** Total order of the feed: ts DESC, then kind ASC, then id ASC — the ONE
 *  comparator both the merge and the cursor predicates derive from. */
export function compareRetainRows(
  a: Pick<RetainFeedRow, 'ts' | 'kind' | 'id'>,
  b: Pick<RetainFeedRow, 'ts' | 'kind' | 'id'>,
): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * The per-leg keyset window a cursor induces on a leg of fixed `kind`:
 * everything strictly AFTER the cursor position in (ts DESC, kind ASC, id ASC)
 * order. null = no cursor (first page).
 */
export interface RetainLegWindow {
  beforeTs: string;
  /** true when this leg's kind sorts AFTER the cursor's kind — rows AT the
   *  cursor ts are still unemitted for it (ts <= beforeTs). */
  includeTies: boolean;
  /** Set when this leg IS the cursor's kind: at ts = beforeTs only ids after
   *  the cursor id remain. */
  tieIdAfter: string | null;
}

export function retainLegWindowFor(kind: RetainFeedKind, cursor: RetainFeedCursor | null): RetainLegWindow | null {
  if (!cursor) return null;
  if (kind > cursor.kind) return { beforeTs: cursor.ts, includeTies: true, tieIdAfter: null };
  if (kind === cursor.kind) return { beforeTs: cursor.ts, includeTies: false, tieIdAfter: cursor.id };
  return { beforeTs: cursor.ts, includeTies: false, tieIdAfter: null };
}

/** The JS-side evaluation of a leg window (SQL legs express the same predicate
 *  in their WHERE clause — keep the two in lockstep). */
export function inRetainLegWindow(ts: string, id: string, w: RetainLegWindow | null): boolean {
  if (!w) return true;
  if (ts < w.beforeTs) return true;
  if (ts > w.beforeTs) return false;
  if (w.includeTies) return true;
  if (w.tieIdAfter != null) return id > w.tieIdAfter;
  return false;
}

// ─── Row detail (WI-39534) ───────────────────────────────────────────────────

/** Server-side clamp on a detail body/code excerpt. The full artifact stays one
 *  click away on its own board; the detail aside is a preview, not a mirror. */
export const RETAIN_DETAIL_BODY_MAX = 4000;

/**
 * One ledger row's expanded detail (learning.retainDetail, WI-39534) — ONE
 * neutral shape for every kind so the client renders a single aside: prose in
 * `body`, code in `code`, bullet lists (rubric criteria) in `listItems`, and
 * provenance as label/value `fields` rows. `editable` marks the memory kind,
 * whose body keeps the standalone pool's inline edit (WI-39535).
 */
export interface RetainDetail {
  kind: RetainFeedKind;
  id: string;
  title: string;
  status: string | null;
  /** Last-activity instant (ISO) when the store carries one. */
  ts: string | null;
  /** Main prose (plan content, wi body, rubric/recipe description, runbook
   *  excerpt, memory text). Clamped to RETAIN_DETAIL_BODY_MAX. */
  body: string | null;
  bodyTruncated: boolean;
  /** Recipe rows: the script, clamped like `body`. */
  code?: string;
  /** Rubric rows: criterion labels. */
  listItems?: string[];
  /** Provenance / metadata rows, render-ready. */
  fields: Array<{ label: string; value: string }>;
  /** Memory rows: the body is editable in place (PATCH /api/user/memory). */
  editable?: boolean;
}
