/**
 * The ended-session model + the pure helpers behind the "View inactive sessions"
 * expander — the roster's SECOND population.
 *
 * Extracted from apps/operator-vite/src/components/adv/AgentsPillSessions.tsx
 * (WI-2047194, the parity follow-up to P-001 of
 * portal-universal-bar-and-agent-roster-2026-08-31). P-001 lifted the LIVE
 * roster into this package; the inactive-sessions section stayed behind, so the
 * portal — which imports this package to render the same dropdown — had no
 * route to historical sessions at all. Same rule as P-001 / D-005: an
 * EXTRACTION, never a copy.
 *
 * Host-free by construction: no fetch, no router, no lexicon. The host supplies
 * the rows (see `InactiveSessionsSection`'s `loadPage` seam) and, optionally, a
 * label normalizer.
 */
import { shortOwner } from './logic';

/**
 * The subset of a host's ended-session record this section reads.
 *
 * The operator serves its full `AdvSessionRow` here; the portal serves an
 * allowlist projection that drops the transcript handles a browser cannot open
 * (`sessionId` / `ompThreadId`), which is why every handle field is optional —
 * a host that omits them still renders the row, and `isOpenable` (the host's
 * own predicate) decides whether it is clickable.
 */
export interface EndedSessionRow {
  id: number;
  workspaceId?: string;
  planSlug: string | null;
  agent: string | null;
  role: string | null;
  feature: string | null;
  label: string | null;
  /** The coord identity the session ran under — the join key to a live roster
   *  row (elision of a running agent's older terminals) and, for a host with a
   *  conversation surface keyed by owner, the thing a click opens. */
  coordOwnerId: string | null;
  /** Native (claude/codex) session id — a transcript handle. Desktop-only. */
  sessionId?: string | null;
  /** omp thread id — a transcript handle. Desktop-only. */
  ompThreadId?: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

/** One page of the ended-sessions feed, as the host's loader returns it. The
 *  keyset cursor is opaque to this package: `nextBefore` is handed back to
 *  `loadPage` verbatim on the next call; null ⇒ no more pages. */
export interface EndedSessionsPage {
  sessions: EndedSessionRow[];
  hasMore: boolean;
  nextBefore: string | null;
}

/**
 * Display name for an ended session row: label → short owner id → agent+row.
 *
 * `agentLabel` is the host's optional label normalizer (the operator binds its
 * lexicon through it, exactly as `displayName` does for the live roster). Pure
 * — exported for tests.
 */
export function endedDisplayName(
  r: Pick<EndedSessionRow, 'id' | 'agent' | 'label' | 'coordOwnerId'>,
  agentLabel?: (raw: string) => string,
): string {
  const label = r.label?.trim();
  if (label) return agentLabel ? agentLabel(label) : label;
  if (r.coordOwnerId) return shortOwner(r.coordOwnerId);
  return `${r.agent ?? 'session'} #${r.id}`;
}

/** Append a page of ended rows, dropping ids already present (a session that
 *  ended between two page fetches shifts the keyset). Pure — exported for tests. */
export function appendEndedPage(
  prev: readonly EndedSessionRow[],
  page: readonly EndedSessionRow[],
): EndedSessionRow[] {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...page.filter((r) => !seen.has(r.id))];
}

/**
 * The rows the section SHOWS from what it has loaded:
 *  · a focus deep-link ("show me this agent's history") shows ONLY that owner's
 *    ended sessions — including ones the active-elision below would hide,
 *    because a running agent's older terminals ARE its history;
 *  · otherwise a running agent's ended rows are elided (they are older
 *    terminals of an agent already on the live roster above — mirrors the
 *    operator roster's dedupeEndedAgainstActive).
 * Pure — exported for tests.
 */
export function visibleEndedRows(
  rows: readonly EndedSessionRow[],
  activeOwnerIds: ReadonlySet<string>,
  focusOwnerId: string | null | undefined,
): EndedSessionRow[] {
  if (focusOwnerId) return rows.filter((r) => r.coordOwnerId === focusOwnerId);
  return rows.filter((r) => !r.coordOwnerId || !activeOwnerIds.has(r.coordOwnerId));
}
