/**
 * EI-20261012762389206: a coord message's TIME-RELATIVE urgency decays into a
 * false claim, because neither reader surface says how old the line is.
 *
 * The measured incident (2026-08-12): a genuinely excellent warning said
 * "sweepExposure.exposed=true with nextSweepInMs ~74s" — i.e. git-sync would
 * commit half-finished edits within ~74 SECONDS. It was read 5.6 HOURS later,
 * the countdown was treated as live, and the reader ACKed and started editing
 * two files that had in fact been fixed and committed 90 seconds BEFORE the
 * warning was even sent. Sender and reader were each caught by the same gap,
 * independently — which is what makes it a surface bug rather than a
 * discipline failure.
 *
 * Why the two existing markers do not cover it. `staleBasis` diffs the
 * sender's `basedOn` refs at SEND ("had the basis already gone stale when I
 * wrote this"), and `annotateResolvedConditions` needs an explicit resolution
 * envelope naming the condition. A free-prose countdown inside the body has
 * neither: nothing to diff, nothing to resolve. The only thing that falsifies
 * it is ELAPSED TIME, which no surface was reporting —
 * {@link renderInjection}'s line carries no timestamp at all, and
 * `coord:inbox` renders an absolute `ts` that a reader must difference against
 * a "now" it routinely mis-estimates (the incident is exactly that mistake).
 *
 * So the marker is deliberately AGE, not a detector for urgency phrasing:
 * age is derivable for every line and cannot be fooled by wording, whereas
 * pattern-matching prose for "in ~74s" would miss "sweeping now" / "before the
 * next tick" and would fire on quoted or historical text.
 *
 * Pure — no clock read, no IO; the caller passes `nowMs`, so both the renderer
 * and its tests stay deterministic.
 */

/**
 * Below this, a line is effectively LIVE and gets no marker.
 *
 * The suffix costs tokens on every rendered line, so it must buy something: a
 * message seconds old needs no age (the reader's assumption that it is current
 * is correct), while at ten minutes any "in ~74s" / "right now" claim in the
 * body is already false. Ten minutes is therefore the point where silence
 * starts to mislead — under it the marker is noise, over it the marker is the
 * whole finding.
 */
export const MESSAGE_AGE_MARKER_MIN_MS = 10 * 60_000;

/**
 * Coarse human age: "5m ago" / "3h ago" / "9d ago".
 *
 * The single formatter for elapsed coord/session time. It deliberately rounds
 * hard — the reader needs an ORDER OF MAGNITUDE ("this is hours old, discount
 * the countdown"), not precision, and a precise age invites arithmetic that
 * the marker exists to make unnecessary. Never returns "0m ago": a sub-minute
 * age floors to "1m ago" so the string always reads as elapsed time.
 */
export function formatAgo(ms: number, now: number): string {
  const min = Math.round(Math.max(0, now - ms) / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Parse a coord envelope `ts` to epoch ms; null when unusable. Pure. */
export function messageAgeMs(ts: unknown, nowMs: number): number | null {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const sentMs = Date.parse(ts);
  if (!Number.isFinite(sentMs)) return null;
  const age = nowMs - sentMs;
  // A future-dated envelope (clock skew across federated nodes) is NOT aged —
  // reporting a negative age as "1m ago" would assert freshness we cannot
  // establish, so say nothing instead.
  return age < 0 ? null : age;
}

/**
 * The injection-line suffix — '' for anything younger than
 * {@link MESSAGE_AGE_MARKER_MIN_MS}, so an ordinary live delta is unchanged.
 * Pure.
 */
export function renderMessageAgeSuffix(ts: unknown, nowMs: number): string {
  const age = messageAgeMs(ts, nowMs);
  if (age === null || age < MESSAGE_AGE_MARKER_MIN_MS) return '';
  return ` ⏳ sent ${formatAgo(nowMs - age, nowMs)}`;
}

/**
 * Stamp `age` (and raw `age_ms`) onto inbox rows old enough to mislead.
 *
 * MARKS, never suppresses or reorders — same contract as the sibling
 * annotators in `tools/inbox.ts`, and non-mutating for the same load-bearing
 * reason: `readInbox`'s slow path hands back objects owned by the in-memory
 * coord log, so annotating in place would write the marker into the log's own
 * rows. Only the rows that earn a marker are copied. Pure.
 */
export function annotateMessageAge<T extends Record<string, unknown>>(
  entries: readonly T[],
  nowMs: number,
): Array<Record<string, unknown>> {
  let marked = false;
  const out = entries.map((e) => {
    const age = messageAgeMs(e['ts'], nowMs);
    if (age === null || age < MESSAGE_AGE_MARKER_MIN_MS) return e;
    marked = true;
    return { ...e, age: formatAgo(nowMs - age, nowMs), age_ms: age };
  });
  return (marked ? out : entries) as Array<Record<string, unknown>>;
}
