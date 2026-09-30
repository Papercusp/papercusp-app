/**
 * draft-suspension.ts — "your turn was suspended; measurements in this draft may have aged."
 *
 * EI-19395608899173941. A sender measured `git status` truthfully at 00:55Z, a wake-pump
 * interleaved the turn, and the message actually sent at 01:40Z — by which time the file
 * had been committed. Five agents were told a peer's landed work was unlanded, one of them
 * woken `required` to act on it. The claim was correctly measured, just not at the moment
 * it was sent.
 *
 * ── WHY NOT THE TWO OBVIOUS FIXES ──────────────────────────────────────────
 *
 * The filed item proposed extending `cellHint` to recognise measurement-shaped prose
 * (`M <path>`, "uncommitted", "+N/-M"). Deliberately NOT done: `cell-transcription-detector.ts`
 * requires a value shape backed by a REGISTERED CELL precisely so it cannot misfire, and
 * cites EI-10949 — a nudge keyed on bare prose fired on ordinary text and taught agents to
 * skim the channel. Working-tree status is not cell-backed, so a prose matcher for it is
 * that same hazard with a new name.
 *
 * It also proposed age-stamping the draft from the sender's read trace. That cannot see this
 * failure: `basedOn` has a 30-minute window (BASED_ON_WINDOW_MS), and the stale measurement
 * was 45 minutes old — it had already fallen out of the array being age-checked.
 *
 * ── WHAT THIS DOES INSTEAD ─────────────────────────────────────────────────
 *
 * It reports a MEASURED FACT about the session, never an inference about the message:
 * "there was a gap of N minutes in your tool-call sequence before this send."
 *
 * That distinction is the whole design. A content heuristic can be wrong about a message and
 * so must be tuned against false positives; a gap either happened or it did not. There is no
 * prose to misread, so the EI-10949 failure mode is structurally unavailable to it. The agent
 * is told the thing it provably could not see — that time passed — and decides for itself
 * which claims to re-verify.
 *
 * Advisory, never a gate: it appends a field, refuses nothing, and fails soft.
 */

/** Envelope field carrying the stamp. */
export const DRAFT_SUSPENSION_FIELD = 'draftSuspension';

/** Provenance marker — a machine observation about the session, never sender intent. */
export const DRAFT_SUSPENSION_DERIVED_PROVENANCE = 'session-derived';

/**
 * A gap must clear this to be reported.
 *
 * Sized against what it is distinguishing, not picked round: git-sync commits this shared
 * tree every 3-5 minutes, so ten minutes is ~2-3 sweeps — long enough that a working-tree
 * or commit-status observation taken before it is genuinely suspect. It is also comfortably
 * above uninterrupted model thinking time, so an agent working continuously is never
 * described as suspended.
 */
export const DRAFT_SUSPENSION_THRESHOLD_MS = 10 * 60_000;

export interface DraftSuspensionStamp {
  /** Length of the largest gap, milliseconds. */
  gapMs: number;
  /** Last observed activity before the gap. */
  gapStartedAt: string;
  /** First observed activity after it — or the send itself, when the gap runs to now. */
  gapEndedAt: string;
  /** True when the gap runs from the last recorded call up to this send. */
  openAtSend: boolean;
}

/**
 * Largest gap in an activity series, or null when nothing clears the threshold.
 *
 * Pure, so the decision is testable without a database. `nowMs` is appended to the series:
 * a sender that has been idle since its last call is in a gap that is still open, which is
 * the freshly-woken case and is exactly as stale as one that closed a second ago.
 *
 * Unsorted, duplicate and non-finite inputs are tolerated — the caller reads a DB whose
 * ordering it should not have to guarantee, and a decorative stamp must not be the thing
 * that throws.
 */
export function suspensionGap(
  invokedAtMs: readonly number[],
  opts: { nowMs: number; thresholdMs?: number },
): DraftSuspensionStamp | null {
  const threshold = opts.thresholdMs ?? DRAFT_SUSPENSION_THRESHOLD_MS;
  if (!Number.isFinite(opts.nowMs)) return null;
  const series = invokedAtMs
    .filter((ms): ms is number => Number.isFinite(ms) && ms <= opts.nowMs)
    .slice()
    .sort((a, b) => a - b);
  if (!series.length) return null;
  series.push(opts.nowMs);

  let best: DraftSuspensionStamp | null = null;
  for (let i = 1; i < series.length; i += 1) {
    const from = series[i - 1]!;
    const to = series[i]!;
    const gapMs = to - from;
    if (gapMs < threshold) continue;
    if (best && gapMs <= best.gapMs) continue;
    best = {
      gapMs,
      gapStartedAt: new Date(from).toISOString(),
      gapEndedAt: new Date(to).toISOString(),
      openAtSend: i === series.length - 1,
    };
  }
  return best;
}

/** Narrow an untrusted envelope value back to a stamp. */
export function readDraftSuspension(value: unknown): DraftSuspensionStamp | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.gapMs !== 'number' || !Number.isFinite(row.gapMs)) return null;
  if (typeof row.gapStartedAt !== 'string' || typeof row.gapEndedAt !== 'string') return null;
  if (typeof row.openAtSend !== 'boolean') return null;
  return {
    gapMs: row.gapMs,
    gapStartedAt: row.gapStartedAt,
    gapEndedAt: row.gapEndedAt,
    openAtSend: row.openAtSend,
  };
}

/**
 * Inbox suffix. States the gap and what it implies, without claiming to know which
 * sentence is stale — naming a specific claim would be the inference this avoids.
 */
export function renderDraftSuspensionSuffix(value: unknown): string {
  const stamp = readDraftSuspension(value);
  if (!stamp) return '';
  const minutes = Math.round(stamp.gapMs / 60_000);
  const when = stamp.openAtSend ? 'idle since' : 'suspended at';
  return ` ⚠ sender ${when} ${stamp.gapStartedAt} (${minutes}m gap before this send) — measured claims may predate it`;
}
