/**
 * ideator-feedback-priming.ts — grader feedback → ideator priming (P-005,
 * scout-idea-grading-2026-06-12, contract C-4).
 *
 * The qualitative half of the grading feedback loop: the owner's / Queen's
 * grades (and free-text critiques) on recently routed ideas are formatted into
 * a priming block and concatenated BELOW the gym stepping-stone priming in the
 * cycle's ideate step (cycle-deps), riding the existing `priming` channel of
 * {@link buildIdeatorPrompt}. The quantitative half (fractional win credit in
 * the lens-weight math, C-5) lives in outcome-feedback.
 *
 * Shape pinned by C-4:
 *   - heading exactly {@link GRADER_FEEDBACK_HEADING};
 *   - entries newest-first, `- [★<grade> · <Owner|Queen> · <lens>] <title>: <feedback…>`;
 *   - ≤{@link MAX_FEEDBACK_ENTRIES} entries, ≤{@link MAX_FEEDBACK_BLOCK_CHARS}
 *     chars total, per-entry truncation at {@link MAX_FEEDBACK_ENTRY_CHARS}.
 * Window rationale (last 10, ~1,500 chars — both knobs adjustable): D-003.
 * Grader labels ("Owner" vs "Queen") let ideators weigh sparse-but-sovereign
 * owner grades over the Queen's volume grades (D-004).
 *
 * The pure core ({@link formatGraderFeedbackPriming}) is hermetic; the
 * production gatherer ({@link gatherGraderFeedbackPriming}) reads graded rows
 * through B-02's ledger reader (`readRoutedIdeas`, C-1b mapping) and degrades
 * to an empty block on any read failure — a PG hiccup never kills a Scout
 * cycle, and pre-B-02 rows (no grade fields yet) simply produce no priming.
 */

import { readRoutedIdeas, type ScoutLedgerOpts } from './routed-ledger';
import { rankByIntent, type IntentSimByRef } from './intent-rank-leg';

/** C-4: the block heading, byte-exact. */
export const GRADER_FEEDBACK_HEADING = '## Grader feedback on recent ideas';
/** C-4 / D-003: at most this many graded ideas in the window (newest-first). */
export const MAX_FEEDBACK_ENTRIES = 10;
/** C-4 / D-003: the whole block (heading + entries) stays under this. */
export const MAX_FEEDBACK_BLOCK_CHARS = 1500;
/** Per-entry truncation so a max-window block fits the total cap (10×141 + heading < 1,500). */
export const MAX_FEEDBACK_ENTRY_CHARS = 140;

/**
 * The slice of a routed-ledger row this module reads — structurally a subset of
 * `RoutedIdeaProvenance` once B-04's C-1b extension lands (humanGrade /
 * humanFeedback / gradedBy / gradedAt), so B-02's `readRoutedIdeas` rows flow
 * in directly. Rows without a finite `humanGrade` are ungraded and ignored.
 */
export interface GradedIdeaView {
  /** Which creative lens produced the idea (C-4 entry tag). */
  lens: string;
  ideaId?: string;
  title?: string;
  /** 1–5 owner/auto-grader grade (C-1b); absent/non-finite = ungraded. */
  humanGrade?: number;
  /** Free-text critique (C-1b); optional — a grade-only entry has no `: <feedback>` tail. */
  humanFeedback?: string;
  /** 'owner' | 'auto-grader' (C-1b attribution, D-004). */
  gradedBy?: string;
  /** ISO timestamp of the grade (C-1b) — the newest-first ordering key. */
  gradedAt?: string;
  /** ISO routing timestamp — ordering fallback for a graded row missing gradedAt. */
  routedAt?: string;
  /** The routed artifact ref ('plan:<slug>' | 'wi:<id>' | 'gym:<id>') — the P-019
   *  intent-ranking join key (present on `readRoutedIdeas` rows; unused when no intent). */
  routedRef?: string;
}

export interface GraderFeedbackOptions {
  /** Window size (default {@link MAX_FEEDBACK_ENTRIES}). */
  maxEntries?: number;
  /** Total block cap (default {@link MAX_FEEDBACK_BLOCK_CHARS}). */
  maxBlockChars?: number;
  /** Per-entry cap (default {@link MAX_FEEDBACK_ENTRY_CHARS}). */
  maxEntryChars?: number;
  /**
   * P-019 intent-ranked priming: per-routedRef cosine(intent, artifact) similarities.
   * When present, graded rows are ordered most-relevant-first (by their `routedRef`'s
   * cosine) BEFORE the window — so the window keeps the entries most relevant to the
   * pass's focus, not merely the newest. Rows with no resolved sim keep newest-first,
   * below the ranked ones. The block SHAPE + window/char caps are unchanged (C-4).
   * Absent ⇒ the pre-P-019 newest-first ordering, byte-identical.
   */
  intentSimByRef?: IntentSimByRef;
}

export interface GraderFeedbackPriming {
  /** The formatted entry lines that made the window (newest-first). */
  entries: string[];
  /** The full block, or '' when nothing is graded — the caller skips an empty block. */
  priming: string;
}

/** A recent Scout-origin filing shown back to the next ideation pass. */
export interface RecentScoutFilingView {
  lens: string;
  ideaId?: string;
  title?: string;
  routedAt?: string;
}

/** Bounds for the recent-filing self-dedup priming block. */
export interface RecentScoutFilingPrimingOptions {
  maxEntries?: number;
  maxBlockChars?: number;
  maxEntryChars?: number;
  /** Test/drill seam; production reads the Scout-origin routed-idea ledger. */
  readRows?: () => Promise<RecentScoutFilingView[]>;
  workspaceId?: string;
  harnessSlug?: string;
}

export interface RecentScoutFilingPriming {
  entries: string[];
  priming: string;
}

/** The recent-filing block is deliberately separate from grader feedback. */
export const RECENT_SCOUT_FILINGS_HEADING = '## Your recent Scout filings';
export const MAX_RECENT_SCOUT_FILINGS = 10;
export const MAX_RECENT_SCOUT_FILINGS_BLOCK_CHARS = 1500;
export const MAX_RECENT_SCOUT_FILING_ENTRY_CHARS = 160;

const RECENT_SCOUT_FILINGS_GUIDANCE =
  'These are ideas you already routed recently. Do not re-file one as-is; extend it only with a concrete new mechanism or measurement, and state what is new.';

function filingSortKey(row: RecentScoutFilingView): string {
  return row.routedAt ?? '';
}

function shortFilingDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : undefined;
}

/**
 * Pure formatter for the recent Scout-filing self-dedup block. It is guidance,
 * not a hard rejection: a later filing may be a useful amendment when it says
 * what new evidence or mechanism it adds.
 */
export function formatRecentScoutFilingPriming(
  rows: readonly RecentScoutFilingView[],
  opts: Omit<RecentScoutFilingPrimingOptions, 'readRows' | 'workspaceId' | 'harnessSlug'> = {},
): RecentScoutFilingPriming {
  const maxEntries = Math.max(0, opts.maxEntries ?? MAX_RECENT_SCOUT_FILINGS);
  const maxBlockChars = Math.max(0, opts.maxBlockChars ?? MAX_RECENT_SCOUT_FILINGS_BLOCK_CHARS);
  const maxEntryChars = Math.max(1, opts.maxEntryChars ?? MAX_RECENT_SCOUT_FILING_ENTRY_CHARS);
  const recent = [...rows]
    .filter((row) => Boolean((row.title ?? '').trim() || row.ideaId))
    .sort((a, b) => (filingSortKey(a) < filingSortKey(b) ? 1 : filingSortKey(a) > filingSortKey(b) ? -1 : 0))
    .slice(0, maxEntries);
  if (recent.length === 0) return { entries: [], priming: '' };

  const entries = recent.map((row) => {
    const title = oneLine(row.title ?? '') || row.ideaId || '(untitled idea)';
    const lens = oneLine(row.lens) || 'unknown lens';
    const date = shortFilingDate(row.routedAt);
    const line = `- [${lens}${date ? ` · ${date}` : ''}] ${title}`;
    return truncate(line, maxEntryChars);
  });
  const base = [RECENT_SCOUT_FILINGS_HEADING, RECENT_SCOUT_FILINGS_GUIDANCE];
  while (entries.length > 0 && [...base, ...entries].join('\n').length > maxBlockChars) entries.pop();
  if (entries.length === 0) {
    return { entries: [], priming: maxBlockChars > 0 ? base.join('\n').slice(0, maxBlockChars) : '' };
  }
  return { entries, priming: [...base, ...entries].join('\n') };
}

/** One line, no internal newlines — entries are single ledger lines. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 'owner' → 'Owner', 'auto-grader' → 'Auto-grader'; anything else gets first-letter capitalization. */
function graderLabel(gradedBy: string | undefined): string {
  const g = (gradedBy ?? '').trim();
  if (!g) return 'Owner';
  return g.charAt(0).toUpperCase() + g.slice(1);
}

function clampGrade(grade: number): number {
  const g = Math.round(grade);
  return g < 1 ? 1 : g > 5 ? 5 : g;
}

/** Newest-first ordering key: when graded, else when routed; missing sorts oldest. */
function sortKey(r: GradedIdeaView): string {
  return r.gradedAt ?? r.routedAt ?? '';
}

/**
 * Format graded ledger rows into the C-4 priming block (pure, hermetic).
 * Ungraded rows are filtered out; survivors are ordered newest-first by
 * `gradedAt` (falling back to `routedAt`), windowed to `maxEntries`, each
 * entry truncated to `maxEntryChars`, and — defensively, should the knobs be
 * retuned — oldest entries are dropped until the whole block fits
 * `maxBlockChars`. No graded rows ⇒ `priming: ''` (the caller adds nothing).
 */
export function formatGraderFeedbackPriming(
  rows: readonly GradedIdeaView[],
  opts: GraderFeedbackOptions = {},
): GraderFeedbackPriming {
  const maxEntries = Math.max(0, opts.maxEntries ?? MAX_FEEDBACK_ENTRIES);
  const maxBlockChars = Math.max(0, opts.maxBlockChars ?? MAX_FEEDBACK_BLOCK_CHARS);
  const maxEntryChars = Math.max(1, opts.maxEntryChars ?? MAX_FEEDBACK_ENTRY_CHARS);

  const gradedNewestFirst = rows
    .filter((r) => typeof r.humanGrade === 'number' && Number.isFinite(r.humanGrade))
    .sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  // P-019: when an intent is in play, rank the SAME graded set by cosine(intent, routed
  // artifact) most-relevant-first BEFORE windowing — so the window keeps what's relevant
  // to the pass's focus, not merely the newest. Rows with no resolved sim keep their
  // newest-first order below the ranked ones (rankByIntent is stable). Window + caps
  // below are unchanged, so the C-4 block shape holds either way.
  const ordered = opts.intentSimByRef
    ? rankByIntent(gradedNewestFirst, (r) => r.routedRef, opts.intentSimByRef)
    : gradedNewestFirst;
  const graded = ordered.slice(0, maxEntries);

  const entries = graded.map((r) => {
    const grade = clampGrade(r.humanGrade as number);
    const title = oneLine(r.title ?? '') || r.ideaId || '(untitled idea)';
    const feedback = oneLine(r.humanFeedback ?? '');
    const line = `- [★${grade} · ${graderLabel(r.gradedBy)} · ${r.lens}] ${title}${feedback ? `: ${feedback}` : ''}`;
    return truncate(line, maxEntryChars);
  });

  // Total cap: drop oldest entries until the block fits (a no-op at the default knobs).
  while (entries.length > 0 && [GRADER_FEEDBACK_HEADING, ...entries].join('\n').length > maxBlockChars) {
    entries.pop();
  }

  if (entries.length === 0) return { entries: [], priming: '' };
  return { entries, priming: [GRADER_FEEDBACK_HEADING, ...entries].join('\n') };
}

/**
 * Production gatherer: read the routed-idea ledger (B-02's reader — graded
 * rows carry the C-1b grade fields) and format the C-4 block. Defensive like
 * the cycle's other readers: any read failure yields an empty block, never a
 * crashed cycle. `readRows` overrides the reader (tests / pre-landed seams).
 */
export async function gatherGraderFeedbackPriming(
  opts: ScoutLedgerOpts & GraderFeedbackOptions & { readRows?: () => Promise<GradedIdeaView[]> } = {},
): Promise<GraderFeedbackPriming> {
  try {
    const rows = await (opts.readRows ? opts.readRows() : readRoutedIdeas(opts));
    return formatGraderFeedbackPriming(rows, opts);
  } catch (err) {
     
    console.warn(
      '[scout/ideator-feedback-priming] graded-ledger read failed — no grader priming this cycle:',
      err instanceof Error ? err.message : err,
    );
    return { entries: [], priming: '' };
  }
}

/**
 * Production recent-filing gatherer. Scout-origin rows are scoped to the
 * current harness and bounded before the read; any ledger failure is fail-open
 * so a stale/unavailable history can never stop ideation.
 */
export async function gatherRecentScoutFilingPriming(
  opts: RecentScoutFilingPrimingOptions = {},
): Promise<RecentScoutFilingPriming> {
  try {
    const rows = await (opts.readRows
      ? opts.readRows()
      : readRoutedIdeas({
          workspaceId: opts.workspaceId,
          harnessSlug: opts.harnessSlug,
          origin: 'scout',
          limit: opts.maxEntries ?? MAX_RECENT_SCOUT_FILINGS,
        }));
    return formatRecentScoutFilingPriming(rows, opts);
  } catch (err) {
    console.warn(
      '[scout/ideator-feedback-priming] recent Scout-filing read failed — no self-dedup priming this cycle:',
      err instanceof Error ? err.message : err,
    );
    return { entries: [], priming: '' };
  }
}
