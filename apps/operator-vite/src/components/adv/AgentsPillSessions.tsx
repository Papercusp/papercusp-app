/**
 * AgentsPillSessions — the agents-running popover's session-history surfaces
 * (agents-pill-inactive-search-2026-07-09 P-003/P-004):
 *
 *   * SessionsSearchInput + SessionSearchResults — the "search ANYTHING in the
 *     sessions" box. Debounced fetch to GET /api/adv/sessions/search-transcripts
 *     (the shared @papercusp/search engine over the session_turns corpus);
 *     results keep the roster's format — ACTIVE sessions grouped by fleet
 *     first, then INACTIVE — each with its matched excerpts (engine
 *     ts_headline <mark> highlights). Clicking a hit opens the
 *     AgentInspectorModal deep-linked at the matched turn with the term
 *     highlighted (P-005: streamUrl carries find/anchorTs).
 *
 *   * InactiveSessionsSection — the "View inactive sessions" expander at the
 *     popover bottom: every ended adv_session, ended_at DESC, paged from
 *     GET /api/adv/sessions/ended with IntersectionObserver infinite scroll
 *     (the shared PapercupChat sentinel + reentry-lock pattern).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import {
  computeFacets,
  facetPredicate,
  parseFacetSelection,
  serializeFacetSelection,
  toggleFacetValue,
  facetSelectionSize,
  type FacetDef,
  type FacetGroup,
  type FacetSelection,
} from '@papercusp/facets';
import AgentInspectorModal from '@/app/harness/AgentInspectorModal';
import { useOpenHudConversation } from './use-open-hud-conversation';
/* WI-37204 — the SAME pure merge the server's id leg runs, so the instant
   client-side id matches and the server's results are unioned by one rule
   rather than two that can drift. adv-session-search imports only types, so it
   erases to a pure module and is safe in this bundle. */
import { mergeIdMatches } from '@papercusp/operator-core/lib/adv-session-search';
import { LivenessDot, type Liveness } from '@/app/coord/presence-ui';
import { useLexicon } from '@/lib/useLexicon';
import { hitDisplayHtml } from '@/lib/search-highlight';
import type { BoundLexicon } from '@papercusp/lexicon';
import { agentDisplayLabel, agentRoleLabel } from '@/app/harness/agent-display';
import {
  activityLiveness,
  activityLivenessTitle,
  agentGlyph,
  canFocusWindow,
  canForkSession,
  displayName,
  fmtCompactAge,
  groupByFleet,
  resumableSessionId,
  type RosterAgent,
} from './AgentsRunningPill';
/* WI-2047194 — the "View inactive sessions" section now lives in
   @papercusp/agent-roster (the same extraction P-001 did for the live roster),
   so the web portal renders the SAME section from the SAME code. This file
   keeps the operator's binding of it: nuqs expand state, the same-origin fetch,
   the lexicon, and the transcript inspector. */
import {
  INACTIVE_SESSIONS_STYLES,
  InactiveSessionsSection as SharedInactiveSessionsSection,
  appendEndedPage,
  defaultRosterChrome,
  endedDisplayName as sharedEndedDisplayName,
  type EndedSessionRow,
  type EndedSessionsPage,
  type RosterChrome,
  type RosterLabels,
} from '@papercusp/agent-roster';

/** The AdvSessionRow subset the ended-sessions feed serves — the shared
 *  package's row type, re-exported so every existing importer of this path
 *  keeps working unchanged. */
export type { EndedSessionRow };
export { appendEndedPage };

/** One matched transcript turn from /api/adv/sessions/search-transcripts. */
export interface SearchTurnHit {
  turnIdx: number;
  ts?: string | null;
  speaker?: string | null;
  owner?: string | null;
  excerpt: string;
  highlight: string;
  score: number;
  /** WHY this turn matched — classified server-side by @papercusp/search's
   *  `hitProvenance` (P-004). Optional: absent from an older server, and from
   *  a hit built outside the engine. `undefined` means "no claim made". */
  matchedBy?: 'lexical' | 'semantic' | 'both' | 'unknown';
  /** Pre-fusion ts_rank_cd score, when a lexical leg returned this turn. */
  lexicalScore?: number;
  /** Pre-fusion cosine similarity, when the vector leg returned this turn. */
  semanticScore?: number;
  /** Precedence tier that won this turn (P-004 exact/fuzzy recall): `exact` = the raw typed
   *  text occurs in the turn, `fuzzy` = a near-spelling did, `hybrid` = the tokenized/semantic
   *  engine. Absent from an older server ⇒ no claim. */
  tier?: 'exact' | 'fuzzy' | 'hybrid';
  /** Lower-precedence tiers that ALSO returned this turn. */
  alsoMatchedBy?: Array<'exact' | 'fuzzy' | 'hybrid'>;
  /** The lowercased literal this turn actually contains (the exact needle, or the fuzzy
   *  vocabulary word). A deep-link must anchor on THIS — the viewer requires the focused
   *  message to contain its term, so a fuzzy hit anchored on the typo'd query misses itself. */
  focusTerm?: string;
  /** Fuzzy hits only: which query token matched which vocabulary word, and how closely. */
  fuzzy?: { token: string; word: string; similarity: number };
}

/** One matched SESSION (classified server-side against roster + adv rows). */
export interface SearchSessionResult {
  sourceKind: string;
  sessionId: string;
  topScore: number;
  hits: SearchTurnHit[];
  active: RosterAgent | null;
  session: EndedSessionRow | null;
  /**
   * WI-37204 — this session is here because the query IS one of its ids, not
   * because its transcript said anything. `hits` is then legitimately EMPTY,
   * which is the ONE case where an empty `hits` is a result rather than a bug:
   * the card renders off the roster/adv metadata and opens at the head of the
   * transcript instead of at a match. Absent ⇒ an ordinary text hit (and an
   * older server sends nothing here, which reads correctly as "no claim").
   */
  idMatch?: 'ownerId' | 'sessionId' | 'ompThreadId' | null;
}

/**
 * The `&ompSessionKey=` fragment for an omp stream URL, or '' when this row
 * carries no adv-session id (WI-41496).
 *
 * An omp thread id names the transcript FILE; the adv-session id names the HOME
 * it lives under (`su-omp-homes/session-<id>/agent/sessions`). A psu-launched
 * omp agent never writes to the shared `~/.omp` home the route otherwise
 * searches, so without this every omp transcript opened here was empty. The
 * server sweeps the per-session homes when the key is absent, which is what
 * keeps an id-less row working — slower, not broken. Pure — exported for tests.
 */
export function ompSessionKeyParam(sessionKey: number | string | null | undefined): string {
  return sessionKey == null || sessionKey === ''
    ? ''
    : `&ompSessionKey=${encodeURIComponent(String(sessionKey))}`;
}

/** Card label for an id match — mirrors the server's `sessionIdMatchLabel`
 *  wording. Pure — exported for tests. */
export function idMatchLabel(field: NonNullable<SearchSessionResult['idMatch']>): string {
  if (field === 'ownerId') return 'matched su id';
  if (field === 'sessionId') return 'matched session id';
  return 'matched thread id';
}

/**
 * The transcript URL for a session matched by ID, which has no hit to anchor
 * to — so it opens at the HEAD of the transcript with no `find` term.
 *
 * Deliberately NOT `searchHitStreamUrl(result, {}, query)`: that would pass the
 * id itself as `find=`, and the viewer would then scroll to whatever turn
 * happens to mention the id (often none), leaving the pane looking like it
 * failed to find the thing you just successfully found. An id search means
 * "show me THIS session", not "show me where this session says its own name".
 *
 * Prefers the recorded row when there is one — `endedSessionStreamUrl` is the
 * only path that knows how to open a codex session (by its per-session
 * CODEX_HOME, keyed on the adv row id), which the hit-anchored URL cannot do.
 * Pure — exported for tests.
 */
export function idMatchStreamUrl(
  s: Pick<SearchSessionResult, 'sourceKind' | 'sessionId' | 'active' | 'session'>,
): string | null {
  // An ACTIVE session's transcript is live on disk — no `ended=1` (the flag
  // makes the thinking route rematerialize from archive / terminate, which for
  // a running agent would cut the stream it should be following).
  if (s.active) {
    const owner = s.active.ownerId ?? null;
    if (s.sourceKind === 'claude') {
      return `/api/adv/session/thinking?sessionId=${encodeURIComponent(s.sessionId)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`;
    }
    if (s.sourceKind === 'omp') {
      return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(s.sessionId)}${ompSessionKeyParam(s.active.advSessionId ?? s.session?.id)}`;
    }
    // No transcript handle (a presence-only row): fall through to the recorded
    // row, which may still know how to open it.
  }
  return s.session ? endedSessionStreamUrl(s.session) : null;
}

/**
 * The transcript-viewer stream URL for a SEARCH HIT, deep-linked at the match:
 * `find` = the query (the pane highlights + scrolls to it), `anchorTs` = the
 * matched turn's timestamp. Keyed per source kind — claude by session uuid
 * (+ owner isolation-dir hint), omp by thread id, codex by rollout uuid.
 * agent_chat has no transcript viewer ⇒ null (the row shows a note instead of
 * a dead click). Pure — exported for tests.
 */
export function searchHitStreamUrl(
  s: Pick<SearchSessionResult, 'sourceKind' | 'sessionId' | 'active' | 'session'>,
  hit: Pick<SearchTurnHit, 'ts' | 'owner' | 'focusTerm'>,
  query: string,
): string | null {
  // Anchor on the literal this turn ACTUALLY contains (P-004): an exact hit inside a longer
  // token ("furnishedfinder" in www.furnishedfinder.com) and a fuzzy hit (the typed "plam"
  // matched "plan") both contain `focusTerm`, not necessarily the typed query, and the viewer
  // only highlights/scrolls to a message that contains its `find` term.
  const anchor = `&find=${encodeURIComponent(hit.focusTerm || query)}${hit.ts ? `&anchorTs=${encodeURIComponent(hit.ts)}` : ''}`;
  // A hit on an INACTIVE (no live roster agent) session is ended → ended=1 so the
  // thinking route rematerializes an archived transcript / terminates instead of
  // polling forever (WI-3990). An ACTIVE result's agent is still running, so its
  // transcript is live on disk — no flag.
  const ended = s.active ? '' : '&ended=1';
  if (s.sourceKind === 'claude') {
    const owner = hit.owner ?? s.active?.ownerId ?? s.session?.coordOwnerId ?? null;
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(s.sessionId)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}${anchor}${ended}`;
  }
  if (s.sourceKind === 'omp') {
    return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(s.sessionId)}${ompSessionKeyParam(s.active?.advSessionId ?? s.session?.id)}${anchor}${ended}`;
  }
  if (s.sourceKind === 'codex') {
    return `/api/adv/session/thinking?codexRolloutId=${encodeURIComponent(s.sessionId)}${anchor}${ended}`;
  }
  return null;
}

/** The transcript-viewer stream URL for an ENDED session row (no anchor):
 *  claude transcript / omp thread / codex rollout (keyed by the adv row id —
 *  its per-session CODEX_HOME). Null when the row recorded no handle. Pure —
 *  exported for tests. */
export function endedSessionStreamUrl(
  r: Pick<EndedSessionRow, 'id' | 'agent' | 'sessionId' | 'ompThreadId' | 'coordOwnerId'>,
): string | null {
  // ended=1 (WI-3990): this session has ENDED, so a transcript that isn't on
  // disk (archived + deleted ~after death) must be rematerialized-from-archive
  // and backfilled — or the stream terminated. WITHOUT this the thinking route
  // can't tell an ended session from a live one pre-first-turn, so it polls
  // forever and the inspector shows "waiting for the first output" indefinitely
  // instead of the stored history.
  if (r.sessionId) {
    return `/api/adv/session/thinking?sessionId=${encodeURIComponent(r.sessionId)}${r.coordOwnerId ? `&owner=${encodeURIComponent(r.coordOwnerId)}` : ''}&ended=1`;
  }
  if (r.ompThreadId) return `/api/adv/session/thinking?ompThreadId=${encodeURIComponent(r.ompThreadId)}${ompSessionKeyParam(r.id)}&ended=1`;
  if (r.agent === 'codex') return `/api/adv/session/thinking?codexSessionKey=${encodeURIComponent(String(r.id))}&ended=1`;
  return null;
}

/**
 * How to label a hit's match (P-004), or null when the row needs no label.
 * Pure — exported for tests.
 *
 * There are TWO independent things a reader cannot otherwise tell, and the
 * whole point of this helper is that they are NOT the same question:
 *
 *   1. WHICH LEG retrieved this row — `matchedBy`, computed server-side. A
 *      `semantic` hit is one the lexical ranker did not return at all; it is
 *      here on meaning, so whatever terms appear in the excerpt are not the
 *      reason it is on screen.
 *   2. WHETHER THE TEXT SHOWN IS THE MATCH — i.e. does the rendered string
 *      contain any <mark>. With none, the card is showing the head of the
 *      turn, which is exactly as informative as a random 200 characters.
 *
 * ⚠ MEASURED (2026-08-03, live corpus, "why did the gate go red", 30 hits):
 * these two genuinely come apart, which is why an earlier cut of this that
 * inferred one from the other was wrong. 9 of 10 vector-only hits DID have
 * <mark>, and 2 of 20 lexical hits had NONE. `ts_headline` runs over the
 * document against the tsquery at hydration time regardless of which ranker
 * returned the row, so a turn BM25 ranked too low to return can still contain
 * the terms and get them marked.
 *
 * Hence four cases, not two. A lexical hit WITH highlights — the common path —
 * gets no chip: its <mark> already says why it matched, and a chip there would
 * be noise on every result. `unknown`/absent provenance (an older server, a
 * non-engine hit) never claims a leg: silence is the right rendering of "we
 * don't know", and guessing "semantic" would make correct lexical results read
 * as fallbacks.
 */
export function hitMatchLabel(
  hit: Pick<SearchTurnHit, 'matchedBy' | 'semanticScore' | 'highlight' | 'excerpt' | 'tier' | 'fuzzy'>,
): { label: string; title: string; unhighlighted: boolean } | null {
  // P-004 fuzzy tier: the turn does NOT contain what was typed — it contains a near spelling.
  // Always say so (the highlighted word is the vocabulary word, not the query), whatever the
  // hybrid legs think; an exact-tier hit needs no chip (its <mark> IS the typed text).
  if (hit.tier === 'fuzzy') {
    const f = hit.fuzzy;
    const shownText = hit.highlight || hit.excerpt || '';
    return {
      label: 'fuzzy match',
      unhighlighted: !shownText.includes('<mark>'),
      title: f
        ? `Approximate spelling match: "${f.token}" ≈ "${f.word}" (similarity ${f.similarity.toFixed(2)}). ` +
          'The highlighted word is what the turn actually says, not what you typed.'
        : 'Approximate spelling match — the highlighted word is what the turn actually says, not what you typed.',
    };
  }
  // Mirror what the row actually RENDERS — asking whether `highlight` alone
  // has marks would misjudge the fallback case. The row renders through
  // `hitDisplayHtml`, whose precedence this reproduces; it does NOT reuse that
  // helper because this needs the raw text to look for `<mark>`, and
  // `hitDisplayHtml` returns escaped HTML in which `<mark>` is the one tag that
  // survives escaping — so a substring test against it would be testing the
  // escaper, not the engine's highlighting.
  const shown = hit.highlight || hit.excerpt || '';
  const unhighlighted = !shown.includes('<mark>');
  const semantic = hit.matchedBy === 'semantic';
  if (!semantic && !unhighlighted) return null;

  const cosine =
    typeof hit.semanticScore === 'number' ? ` (cosine ${hit.semanticScore.toFixed(2)})` : '';
  const noTermsHere =
    'None of your search terms appear in the text below, so it is the start of the turn ' +
    'rather than the matching phrase — open the hit to read it in context.';

  if (semantic) {
    return {
      label: 'semantic match',
      unhighlighted,
      title: unhighlighted
        ? `Retrieved by MEANING${cosine}, not by term ranking. ${noTermsHere}`
        : `Retrieved by MEANING${cosine}, not by term ranking — the term ranker did not return ` +
          'this turn at all. Any highlighted words below do appear in it, but they are not why ' +
          'it was returned.',
    };
  }
  // Lexical/hybrid/unknown, but nothing highlighted: the excerpt-head case
  // P-004 names. Say so without claiming a leg we have not established.
  return { label: 'no highlight', unhighlighted, title: noTermsHere };
}

/** Display name for an ended session row: label → short owner id → agent+row.
 *
 *  Operator binding of the package's `endedDisplayName`: the generic form takes
 *  a plain label normalizer, and this adapts the operator's `BoundLexicon` onto
 *  it — the same shape as `displayName` in AgentsRunningPill. Callers keep the
 *  original `endedDisplayName(r, lex)` signature. Pure — exported for tests. */
export function endedDisplayName(
  r: Pick<EndedSessionRow, 'id' | 'agent' | 'label' | 'coordOwnerId'>,
  lex?: BoundLexicon,
): string {
  return sharedEndedDisplayName(r, lex ? (raw) => agentDisplayLabel(raw, lex) : undefined);
}

/** The first page of the ended-sessions feed, or a later one when `before` is
 *  the cursor the previous page returned. The operator's DATA seam for the
 *  shared section — same-origin, no auth (the route is `auth: 'public'` on the
 *  loopback-bound operator). Throws on a failed fetch so the section shows its
 *  error state. Exported for tests. */
export async function loadEndedSessionsPage(before: string | null): Promise<EndedSessionsPage> {
  const r = await fetch(`/api/adv/sessions/ended?limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`);
  const j = await r.json() as { ok: boolean; sessions?: EndedSessionRow[]; hasMore?: boolean; nextBefore?: string | null };
  if (!j.ok) throw new Error('ended_fetch_failed');
  return { sessions: j.sessions ?? [], hasMore: Boolean(j.hasMore), nextBefore: j.nextBefore ?? null };
}

/** The operator's chrome for the inactive list: its own LivenessDot (the shared
 *  section renders only that one primitive, so the tooltip/thinking defaults
 *  are never reached). Module scope so the identity is stable across renders. */
const INACTIVE_CHROME: RosterChrome = { ...defaultRosterChrome, LivenessDot };

/** Classify a failed search response into the user-facing message. A route
 *  timeout (the 30s watchdog 408s under host load — 2026-07-09 incident) is
 *  NOT "broken": say so and invite a retry, instead of a dead generic error
 *  the owner reads as "no results". Pure — exported for tests. */
export function searchFailureMessage(status: number | null, errCode?: string | null): string {
  if (status === 408 || status === 503 || status === 504 || errCode === 'timeout') {
    return 'Search timed out — the server is busy right now. Try again in a moment.';
  }
  return 'Search failed.';
}

/** The popover's session search input. Controlled; the parent decides when the
 *  query is "active" (>= 2 chars) and swaps the roster for the results view. */
export function SessionsSearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="pc-agents-sessions__searchwrap">
      <input
        type="search"
        className="pc-agents-sessions__search"
        placeholder="Search anything in all sessions…"
        aria-label="Search session transcripts"
        data-testid="agents-sessions-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <SessionsStyles />
    </div>
  );
}

/** What the results view needs to open the inspector on a click. */
interface InspectTarget {
  streamUrl: string;
  runId: string;
  role: string;
  highlightTerm?: string;
  /** WI-3882: the id to fork/resume into a new terminal (null ⇒ no
   *  Fork/Resume button — codex results, or a source with no resumable id). */
  resumeSessionId?: string | null;
  /** true ⇒ the source agent is still RUNNING — tags the Resume button's
   *  collision-warning tooltip; false ⇒ it has ENDED. Both Resume and Fork are
   *  offered either way (owner ask 2026-07-11). */
  resumeLive?: boolean;
  /** WI-4009 / 2026-07-11: whether the source can be FORKED (claude-only) —
   *  gates the Fork button, independent of active/inactive. */
  resumeCanFork?: boolean;
  /** resume-in-gui-button-2026-08-09: the matched session's COORD owner id — the
   *  key the HUD conversation popup opens on, so the inspector's "Resume in GUI"
   *  button has a destination. null/absent ⇒ no GUI button (never a dead one). */
  resumeGuiOwnerId?: string | null;
  /** WI-6816: the OS terminal-window handles for a still-RUNNING matched
   *  session — present ⇒ the inspector shows its "⤢ Focus window" button.
   *  undefined ⇒ no button (an ended session, or a live one with neither
   *  handle). See searchResultFocusTarget below. */
  focusTarget?: { advSessionId?: number | null; windowId?: string | null; pid?: number | null };
}

/** WI-3882: the Fork/Resume target for a matched search result — an ACTIVE
 *  result's agent is still running (`live:true`, tags the Resume button's
 *  collision tooltip); an INACTIVE result's session has ended (`live:false`).
 *  null ⇒ no button at all (codex, or neither half of the result carries a
 *  resumable id). Owner ask 2026-07-11 (retracted the "fork only for active /
 *  resume only for inactive" split): BOTH Resume and Fork are offered for
 *  active AND inactive. `live` no longer gates presence — it only tags the
 *  Resume collision tooltip. `canFork` (claude-only — `--fork-session` has no
 *  omp equivalent) gates the Fork button, independent of active/inactive. The
 *  Resume button works for any resumable (claude/omp) session either way. Pure
 *  — exported for tests. */
export function searchResultResumeTarget(
  result: Pick<SearchSessionResult, 'active' | 'session'>,
): { sessionId: string; live: boolean; canFork: boolean; guiOwnerId: string | null } | null {
  if (result.active) {
    const sessionId = resumableSessionId(result.active);
    return sessionId
      ? {
          sessionId,
          live: true,
          canFork: canForkSession(result.active),
          // resume-in-gui-button-2026-08-09: the coord owner id the HUD conversation
          // popup is keyed by. Read from whichever half of the result is authoritative
          // — the LIVE roster row here, the ended adv row below — because those are
          // the two places this surface already gets its identity from. Never both:
          // an active result's ended row is an OLDER terminal of the same agent.
          guiOwnerId: result.active.ownerId ?? null,
        }
      : null;
  }
  const sessionId = result.session ? resumableSessionId(result.session) : null;
  return sessionId
    ? {
        sessionId,
        live: false,
        canFork: result.session ? canForkSession(result.session) : false,
        guiOwnerId: result.session?.coordOwnerId ?? null,
      }
    : null;
}

/**
 * WI-6816: the "Focus window" target for a matched search result — the OS
 * terminal-window handles of the ACTIVE (still-running) agent behind the match,
 * or null when there is nothing to raise.
 *
 * Owner-reported 2026-08-02: "in the agents running dropdown when viewing a
 * session there used to be a 'focus window' option if it was focusable, but I
 * don't see that anymore". The button was never deleted — it lives in
 * AgentInspectorModal and renders only when a caller passes `focusTarget`. The
 * ROSTER call site (AgentsRunningPill.tsx) has passed it since 2026-07-01; this
 * SEARCH-results view landed 2026-07-09 and never carried it forward, so
 * reaching a live session through the search box silently lost the affordance.
 * This helper is the search-side twin of searchResultResumeTarget above.
 *
 * Only `result.active` is consulted, deliberately: an INACTIVE result's session
 * has ENDED, so its window is gone and offering focus would be a dead button
 * (the same reason the ended-sessions list below passes no focusTarget either).
 * Gated on the ONE exported canFocusWindow predicate the roster path uses, so
 * the two surfaces cannot drift on what "focusable" means — notably that an
 * `advSessionId` alone is enough (the /adv/sessions/focus endpoint resolves the
 * window from the adv row / its `[adv:<id>]` title fragment), which is what
 * carries essentially every live session here: measured 2026-08-02, 86 of 135
 * roster entries had an advSessionId and ZERO had a pre-resolved windowId.
 * Pure — exported for tests.
 */
export function searchResultFocusTarget(
  result: Pick<SearchSessionResult, 'active'>,
): { advSessionId: number | null; windowId: string | null; pid: number | null } | null {
  const a = result.active;
  if (!a || !canFocusWindow(a)) return null;
  return { advSessionId: a.advSessionId ?? null, windowId: a.windowId ?? null, pid: a.pid ?? null };
}

/** One matched session row + its excerpt hits. Shared by the active (fleet-
 *  grouped) and inactive halves of the results view. */
function SearchResultRow({
  title,
  glyph,
  color,
  meta,
  lastTurnAt,
  nowMs,
  result,
  query,
  liveness,
  livenessTitle,
  onInspect,
}: {
  title: string;
  glyph: string;
  color?: string | null;
  meta: string;
  /** Genuine activity for a live result. Never substitute the process
   *  heartbeat: a keepalive is not an agent turn. */
  lastTurnAt?: string | null;
  nowMs: number;
  result: SearchSessionResult;
  query: string;
  /** The liveness dot for this matched session — activity-derived for an ACTIVE
   *  result (a killed/idle session reads idle/stale, never a false "live"), and
   *  always 'stale' for an INACTIVE (ended) one. The search results used to show
   *  no liveness at all (owner-reported 2026-07-17: "it didn't show that you were
   *  live in the search results page"). */
  liveness: Liveness;
  livenessTitle?: string;
  onInspect: (t: InspectTarget) => void;
}) {
  /* `hit === null` = open the session itself, at the head, with no highlight
     term — the WI-37204 id-match case, where the query named the session rather
     than anything it said. Everything else about the modal (resume, fork,
     focus-window) is identical, which is the point: reaching a session by its
     id must not be a second-class way to arrive at it. */
  const openHit = (hit: SearchTurnHit | null) => {
    const url = hit ? searchHitStreamUrl(result, hit, query) : idMatchStreamUrl(result);
    if (!url) return;
    const resumeTarget = searchResultResumeTarget(result);
    onInspect({
      streamUrl: url,
      runId: result.sessionId,
      role: title,
      highlightTerm: hit ? query : undefined,
      resumeSessionId: resumeTarget?.sessionId ?? null,
      resumeLive: resumeTarget?.live ?? false,
      resumeCanFork: resumeTarget?.canFork ?? false,
      resumeGuiOwnerId: resumeTarget?.guiOwnerId ?? null,
      // WI-6816 — null ⇒ the modal shows no Focus button (never a dead one).
      focusTarget: searchResultFocusTarget(result) ?? undefined,
    });
  };
  const top = result.hits[0] ?? null;
  /* An id match with no hits is still openable — via the head-of-transcript URL
     — so the head row must not fall back to the "no transcript viewer" dead
     state every hit-less result used to get. `openHit(top)` with a null `top`
     IS the head-open path, so the click handlers gate on `openable`, not on
     `top` (which is what used to make the row inert). */
  const openable = top
    ? searchHitStreamUrl(result, top, query) !== null
    : Boolean(result.idMatch) && idMatchStreamUrl(result) !== null;
  const lastTurnAge = fmtCompactAge(lastTurnAt, nowMs);
  const lastTurnLabel = lastTurnAge && lastTurnAt
    ? `Last active turn ${new Date(lastTurnAt).toLocaleString()} · ${lastTurnAge} ago`
    : undefined;
  return (
    <div className="pc-agents-sessions__result" data-testid={`session-hit-${result.sourceKind}-${result.sessionId}`}>
      <div
        className={`pc-agents-roster__row pc-agents-roster__row--nocheck pc-agents-sessions__result-head${openable ? '' : ' is-unopenable'}${result.idMatch ? ' pc-agents-sessions__result-head--idmatch' : ''}`}
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        title={
          openable
            ? top
              ? 'Open at the best match'
              : 'Open this session'
            : 'No transcript viewer for this source'
        }
        onClick={() => openable && openHit(top)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && openable) { e.preventDefault(); openHit(top); }
        }}
      >
        <span className="pc-agents-roster__live">
          <LivenessDot liveness={liveness} size={7} title={livenessTitle} />
          {lastTurnLabel ? (
            <time
              className="pc-agents-roster__age"
              dateTime={lastTurnAt ?? undefined}
              title={lastTurnLabel}
              aria-label={lastTurnLabel}
            >
              {lastTurnAge}
            </time>
          ) : null}
          <span className="pc-agents-sessions__kind" aria-hidden>{result.sourceKind}</span>
        </span>
        <span className="pc-agents-roster__glyph" style={color ? { color } : undefined} aria-hidden>{glyph}</span>
        <span className="pc-agents-roster__name" style={color ? { color } : undefined}>{title}</span>
        <span className="pc-agents-roster__doing">{meta}</span>
        {/* WI-37204: says WHY a card with no excerpts is on screen. Without it
            an id match is indistinguishable from a search that returned a
            session for no visible reason. */}
        {result.idMatch ? (
          <span className="pc-agents-sessions__idmatch" data-testid="id-match-chip">
            {idMatchLabel(result.idMatch)}
          </span>
        ) : null}
      </div>
      {result.hits.map((h) => {
        // P-004: say WHY this turn is here when the text alone cannot — it was
        // retrieved on meaning, or nothing in it is highlighted at all.
        const prov = hitMatchLabel(h);
        return (
          <div
            key={h.turnIdx}
            className={`pc-agents-sessions__hit${prov?.unhighlighted ? ' pc-agents-sessions__hit--excerpt-only' : ''}`}
            role="button"
            tabIndex={0}
            data-testid={`hit-${result.sessionId}-${h.turnIdx}`}
            data-matched-by={h.matchedBy ?? undefined}
            title={prov?.title}
            onClick={() => openHit(h)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHit(h); }
            }}
          >
            {prov && (
              <span className="pc-agents-sessions__provenance" data-testid="hit-provenance">
                {prov.label}
              </span>
            )}
            <span
              // Engine ts_headline output, escaped except its own <mark> tags.
              // The `highlight || excerpt` precedence lives in the shared helper
              // with the escaping, so the three search surfaces cannot drift
              // apart on either half (P-003).
              dangerouslySetInnerHTML={{ __html: hitDisplayHtml(h) }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Context-dependent facet filtering (facet-pills-and-recency-2026-07-12) ────

type SessionFacetMeta = { color?: string | null };

/**
 * Facet definitions over a search result — the ONLY session-specific knowledge;
 * `@papercusp/facets` owns the tally / hide-singletons / sort / filter math.
 * This list is a SUPERSET: a facet with <2 distinct values in the actual results
 * is auto-hidden by computeFacets, so only the facets that genuinely help filter
 * THESE results ever render. Order here = the render order of the facet rows.
 */
export const SESSION_FACETS: FacetDef<SearchSessionResult, SessionFacetMeta>[] = [
  { key: 'status', label: 'Status', extract: (s) => (s.active ? 'active' : 'ended') },
  { key: 'backend', label: 'Agent', extract: (s) => s.sourceKind || null },
  {
    key: 'fleet',
    label: 'Fleet',
    extract: (s) =>
      s.active?.fleetSlug ? { value: s.active.fleetSlug, meta: { color: s.active.fleetColor } } : null,
  },
  { key: 'role', label: 'Role', extract: (s) => s.active?.role ?? s.active?.agentPaneKind ?? s.session?.role ?? null },
  { key: 'plan', label: 'Plan', extract: (s) => s.active?.currentPlanSlug ?? s.session?.planSlug ?? null },
  { key: 'feature', label: 'Work item', extract: (s) => s.active?.feature ?? s.session?.feature ?? null },
  { key: 'machine', label: 'Machine', extract: (s) => s.active?.machineLabel ?? null },
];

/** The `since` ISO for a recency-window token, or null for "all time". This is
 *  the SERVER-side tier: changing it re-queries so the window can surface recent
 *  matches that the relevance-ranked top-N would otherwise have hidden. Pure —
 *  exported for tests. */
export function windowToSinceIso(token: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (token === 'day') return new Date(nowMs - 86_400_000).toISOString();
  if (token === 'week') return new Date(nowMs - 7 * 86_400_000).toISOString();
  return null;
}

const RECENCY_WINDOWS: { token: string | null; label: string }[] = [
  { token: null, label: 'All time' },
  { token: 'day', label: 'Today' },
  { token: 'week', label: 'This week' },
];

/**
 * The context-dependent filter bar under the search box. A "When" row (the
 * server-side recency window — re-queries with `since`), then one row per facet
 * that `@papercusp/facets` decided is worth showing. Selecting pills filters the
 * rendered results client-side (AND across facets, OR within). Counts + fleet
 * color ride from the facet meta.
 */
function FacetBar({
  groups,
  selection,
  onToggle,
  onClearAll,
  windowToken,
  onWindow,
}: {
  groups: FacetGroup<SessionFacetMeta>[];
  selection: FacetSelection;
  onToggle: (key: string, value: string) => void;
  onClearAll: () => void;
  windowToken: string | null;
  onWindow: (token: string | null) => void;
}) {
  const lex = useLexicon();
  const selCount = facetSelectionSize(selection);
  const showClear = selCount > 0 || windowToken != null;
  return (
    <div className="pc-agents-facets" data-testid="agents-facet-bar">
      <div className="pc-agents-facets__row">
        <span className="pc-agents-facets__label">When</span>
        <div className="pc-agents-facets__pills">
          {RECENCY_WINDOWS.map((w) => (
            <button
              key={w.token ?? 'all'}
              type="button"
              className={`pc-agents-facets__pill${(windowToken ?? null) === w.token ? ' is-on' : ''}`}
              data-testid={`facet-when-${w.token ?? 'all'}`}
              aria-pressed={(windowToken ?? null) === w.token}
              onClick={() => onWindow(w.token)}
            >
              {w.label}
            </button>
          ))}
        </div>
        {showClear ? (
          <button
            type="button"
            className="pc-agents-facets__clear"
            data-testid="facet-clear"
            onClick={onClearAll}
          >
            Clear{selCount > 0 ? ` (${selCount})` : ''}
          </button>
        ) : null}
      </div>
      {groups.map((g) => {
        const sel = selection.get(g.key);
        return (
          <div key={g.key} className="pc-agents-facets__row" data-testid={`facet-row-${g.key}`}>
            <span className="pc-agents-facets__label">{g.label ?? g.key}</span>
            <div className="pc-agents-facets__pills">
              {g.values.map((v) => {
                const on = sel?.has(v.value) ?? false;
                return (
                  <button
                    key={v.value}
                    type="button"
                    className={`pc-agents-facets__pill${on ? ' is-on' : ''}`}
                    data-testid={`facet-${g.key}-${v.value}`}
                    aria-pressed={on}
                    onClick={() => onToggle(g.key, v.value)}
                  >
                    {v.meta?.color ? (
                      <span className="pc-agents-facets__dot" style={{ background: v.meta.color }} aria-hidden />
                    ) : null}
                    <span className="pc-agents-facets__pill-text">
                      {g.key === 'role' ? agentRoleLabel(v.value, lex) : v.value}
                    </span>
                    <span className="pc-agents-facets__count">{v.count}</span>
                  </button>
                );
              })}
              {g.hiddenValueCount > 0 ? (
                <span className="pc-agents-facets__more">+{g.hiddenValueCount}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The search-results view: ACTIVE matched sessions grouped by fleet (the same
 * ordering + coloring as the running roster), then the INACTIVE section.
 */
export function SessionSearchResults({
  query,
  nowMs,
  instantIdMatches,
}: {
  query: string;
  nowMs: number;
  /** WI-37204 — sessions the caller resolved by ID from its own roster, on the
   *  keystroke. Rendered immediately and superseded in place when the server's
   *  own id leg answers for the same session (see `mergeIdMatches`), so a live
   *  agent found by id never waits on the round-trip and never double-renders. */
  instantIdMatches?: readonly SearchSessionResult[];
}) {
  const lex = useLexicon();
  const [sessions, setSessions] = useState<SearchSessionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The id this query resolved AS, per the server (WI-37204); null = prose. */
  const [idToken, setIdToken] = useState<string | null>(null);
  // Bumped by the Retry button to re-fire the same query. DELIBERATELY manual —
  // auto-retry against a server that just 408'd under load would stack more
  // heavy queries onto the exact condition that caused the failure.
  const [attempt, setAttempt] = useState(0);
  const [inspecting, setInspecting] = useState<InspectTarget | null>(null);
  // resume-in-gui-button-2026-08-09: where the inspector's "Resume in GUI" button
  // sends you — the HUD tab with this agent's conversation popup open.
  const openHudConversation = useOpenHudConversation();
  // Recency window (server-side re-query) + facet selection — both URL-backed
  // like the rest of the popover (agentsQ / agentsRoster / agentsMachine). Plain
  // useQueryState (no parser) to stay compatible with the suite-wide nuqs mocks
  // (see the note in AgentsRunningPill on agentsQ).
  const [windowRaw, setWindowToken] = useQueryState('agentsWindow');
  const windowToken = typeof windowRaw === 'string' ? windowRaw : null;
  const [facetsRaw, setFacetsRaw] = useQueryState('agentsFacets');
  const selection = useMemo(
    () => parseFacetSelection(typeof facetsRaw === 'string' ? facetsRaw : ''),
    [facetsRaw],
  );

  // WI-4734 (owner-hit: a 20s search with "no indication that the search was
  // still running"): the pending flag flips SYNCHRONOUSLY with the query
  // change — including the debounce window — never only when the fetch fires.
  // Stale previous-query results stay visible but DIMMED (is-stale below), so
  // the UI reads "old results, new search running", not "done".
  const [slowHint, setSlowHint] = useState(false);
  useEffect(() => {
    if (!loading) { setSlowHint(false); return; }
    const t = setTimeout(() => setSlowHint(true), 5_000);
    return () => clearTimeout(t);
  }, [loading]);

  useEffect(() => {
    const ctl = new AbortController();
    // Pending is visible from the FIRST keystroke (see WI-4734 note above).
    setLoading(true);
    setError(null);
    // Debounce keystrokes; abort a stale in-flight search on the next one.
    const t = setTimeout(async () => {
      // CLIENT-SIDE deadline (owner-hit 07-10): a server that never answers —
      // mid-boot after an auto-deploy restart, wedged socket — otherwise spins
      // "Searching…" forever (fetch has no default timeout). 35s sits just past
      // the server's 30s watchdog, so a live-but-slow server's own 408 arrives
      // first and this only trips when the server is truly unresponsive.
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; ctl.abort(); }, 35_000);
      try {
        // Recency window is a SERVER re-query: adding `since` changes WHICH top-30
        // the engine returns, so a recent match hidden by relevance ranking can
        // surface. (The soft recency re-rank is default-on in the route already.)
        const since = windowToSinceIso(windowToken);
        const sinceQs = since ? `&since=${encodeURIComponent(since)}` : '';
        const r = await fetch(`/api/adv/sessions/search-transcripts?q=${encodeURIComponent(query)}&limit=30${sinceQs}`, { signal: ctl.signal });
        const j = await r.json() as { ok: boolean; error?: string; sessions?: SearchSessionResult[]; idToken?: string };
        clearTimeout(deadline);
        if (!j.ok) { setError(searchFailureMessage(r.status, j.error)); setLoading(false); return; }
        setSessions(j.sessions ?? []);
        // WI-37204: the server's verdict on whether this query IS an id, so the
        // empty state can say "no session has that id" instead of the generic
        // "no matches in any session" — which reads as a broken search when you
        // just pasted an id you know is real.
        setIdToken(typeof j.idToken === 'string' ? j.idToken : null);
        setLoading(false);
      } catch {
        clearTimeout(deadline);
        if (timedOut) {
          setError(searchFailureMessage(408, 'timeout'));
          setLoading(false);
        } else if (!ctl.signal.aborted) {
          setError(searchFailureMessage(null));
          setLoading(false);
        }
        // else: superseded by a newer keystroke / unmount — stay silent
        // (loading stays true — the newer effect owns it now).
      }
    }, 200); // WI-4734: 300→200ms — the debounce is part of perceived latency
    return () => { clearTimeout(t); ctl.abort(); };
  }, [query, attempt, windowToken]);

  // The "context-dependent" contract, in two halves:
  //  · VISIBILITY is decided over the FULL result set — a facet with <2 distinct
  //    values can't narrow anything, so it never renders; and the facets that DO
  //    render stay put instead of popping in and out as you select.
  //  · COUNTS are drill-down aware — passing `selection` tallies each facet's
  //    values over the items matching the OTHER facets' selections, so a count is
  //    a promise of what you'd actually get. Without it the counts described the
  //    unfiltered set and every cross-facet click was a potential dead end:
  //    picking status:active still advertised "role: mug 1", and clicking it
  //    landed on "No results match the selected filters" (caught in the live
  //    pixel-drive, 2026-07-12).
  /* WI-37204 — the instant client-side id matches unioned with whatever the
     server has answered so far, via the SAME pure merge the route runs (an id
     match that also has transcript hits keeps them; id matches lead). Every
     read below is of `results`, not `sessions`, so the facet counts, the
     empty state and the rendered rows all describe the same set. */
  const results = useMemo(
    () => mergeIdMatches(instantIdMatches ?? [], sessions),
    [instantIdMatches, sessions],
  );
  const facetGroups = useMemo(
    () => computeFacets(results, SESSION_FACETS, { maxValuesPerFacet: 8, selection }),
    [results, selection],
  );
  const filteredSessions = useMemo(
    () => results.filter(facetPredicate(SESSION_FACETS, selection)),
    [results, selection],
  );
  const onToggleFacet = useCallback(
    (key: string, value: string) =>
      void setFacetsRaw(serializeFacetSelection(toggleFacetValue(selection, key, value)) || null),
    [selection, setFacetsRaw],
  );
  const onClearFacets = useCallback(() => {
    void setFacetsRaw(null);
    void setWindowToken(null);
  }, [setFacetsRaw, setWindowToken]);

  const activeResults = filteredSessions.filter((s) => s.active);
  const inactiveResults = filteredSessions.filter((s) => !s.active);
  const resultByOwner = new Map(activeResults.map((s) => [s.active!.ownerId, s]));
  const groups = groupByFleet(activeResults.map((s) => s.active!));

  return (
    <div className="pc-agents-sessions__results" data-testid="agents-search-results">
      {loading && (
        <div className="pc-agents-sessions__status is-searching" data-testid="search-pending" role="status" aria-live="polite">
          {slowHint
            ? 'Still searching — the server is taking longer than usual…'
            : 'Searching…'}
        </div>
      )}
      {error && (
        <div className="pc-agents-sessions__status is-error" data-testid="search-error">
          {error}{' '}
          <button
            type="button"
            className="pc-agents-sessions__retry"
            data-testid="search-retry"
            onClick={() => setAttempt((a) => a + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {!error && !(loading && results.length === 0) && (
        // WI-4734: stays MOUNTED during a re-search (dimmed via is-stale) so the
        // bar doesn't flicker out on every keystroke now that `loading` spans
        // the debounce window too — and the recency pills stay clickable. A
        // FIRST search (no results yet) still shows "Searching…" alone.
        <div className={loading ? 'is-stale' : undefined}>
          <FacetBar
            groups={facetGroups}
            selection={selection}
            onToggle={onToggleFacet}
            onClearAll={onClearFacets}
            windowToken={windowToken}
            onWindow={(t) => void setWindowToken(t)}
          />
        </div>
      )}
      {!loading && !error && results.length === 0 && (
        <div className="pc-agents-sessions__status" data-testid="search-empty">
          {idToken
            ? `No session has an id starting with "${idToken}", and no transcript mentions it.`
            : 'No matches in any session.'}
        </div>
      )}
      {!loading && !error && results.length > 0 && filteredSessions.length === 0 && (
        <div className="pc-agents-sessions__status" data-testid="facet-empty">
          No results match the selected filters.
        </div>
      )}
      {groups.length > 0 && (
        <div className={`pc-agents-sessions__scroll${loading ? ' is-stale' : ''}`} data-testid="active-results">
          {groups.map((g) => (
            <section key={g.slug ?? '__none'} className="pc-agents-roster__group">
              <header
                className="pc-agents-roster__group-head"
                style={g.slug ? { color: g.color ?? undefined } : undefined}
              >
                <span className="pc-agents-roster__group-caret" aria-hidden>▾</span>
                {g.slug ?? 'No fleet'} <span className="pc-agents-roster__group-count">({g.agents.length})</span>
              </header>
              {g.agents.map((a) => {
                const res = resultByOwner.get(a.ownerId);
                if (!res) return null;
                return (
                  <SearchResultRow
                    key={a.ownerId}
                    title={displayName(a, lex)}
                    glyph={agentGlyph(a)}
                    color={g.color}
                    meta={a.intent || a.currentPlanSlug || '—'}
                    lastTurnAt={a.lastActiveAt}
                    nowMs={nowMs}
                    result={res}
                    query={query}
                    liveness={activityLiveness(a, nowMs)}
                    livenessTitle={activityLivenessTitle(a, nowMs)}
                    onInspect={setInspecting}
                  />
                );
              })}
            </section>
          ))}
        </div>
      )}
      {inactiveResults.length > 0 && (
        <section className={`pc-agents-roster__group${loading ? ' is-stale' : ''}`}>
          <header className="pc-agents-roster__group-head">
            <span className="pc-agents-roster__group-caret" aria-hidden>▾</span>
            Inactive sessions <span className="pc-agents-roster__group-count">({inactiveResults.length})</span>
          </header>
          <div className="pc-agents-sessions__scroll">
            {inactiveResults.map((s) => {
              const row = s.session;
              const title = row ? endedDisplayName(row, lex) : `${s.sourceKind} · ${s.sessionId.slice(0, 8)}…`;
              const endedAgo = row?.endedAt ? `ended ${fmtCompactAge(row.endedAt, nowMs)} ago` : '';
              const meta = [row?.feature, row?.planSlug, endedAgo].filter(Boolean).join(' · ') || '—';
              return (
                <SearchResultRow
                  key={`${s.sourceKind}:${s.sessionId}`}
                  title={title}
                  glyph={agentGlyph({ agentPaneKind: null, role: row?.role ?? null })}
                  meta={meta}
                  nowMs={nowMs}
                  result={s}
                  query={query}
                  liveness="stale"
                  livenessTitle={endedAgo || 'ended session'}
                  onInspect={setInspecting}
                />
              );
            })}
          </div>
        </section>
      )}
      {inspecting ? (
        <AgentInspectorModal
          slug=""
          phase="staging"
          runId={inspecting.runId}
          role={inspecting.role}
          streamUrl={inspecting.streamUrl}
          highlightTerm={inspecting.highlightTerm}
          resumeTarget={inspecting.resumeSessionId
            ? {
                sessionId: inspecting.resumeSessionId,
                live: Boolean(inspecting.resumeLive),
                canFork: Boolean(inspecting.resumeCanFork),
                guiOwnerId: inspecting.resumeGuiOwnerId ?? null,
              }
            : undefined}
          // WI-6816: restores the "⤢ Focus window" button when the match is a
          // still-running, focusable agent — parity with the roster call site
          // (AgentsRunningPill.tsx). undefined for an ended session ⇒ no button.
          focusTarget={inspecting.focusTarget}
          // resume-in-gui-button-2026-08-09 — parity with the roster call site: a
          // session reached through the search box gets the same GUI resume.
          onOpenInGui={openHudConversation}
          open
          onClose={() => setInspecting(null)}
        />
      ) : null}
      <SessionsStyles />
    </div>
  );
}

/**
 * "View inactive sessions" — the expander at the popover bottom. Every ended
 * session ever, newest-ended first, in pages of 30 with infinite scroll.
 *
 * The section itself is `@papercusp/agent-roster`'s `InactiveSessionsSection`
 * (WI-2047194 — the same extraction P-001 did for the live roster, so the web
 * portal renders it too). What this wrapper binds is exactly what is
 * operator-specific: the URL-backed expand state, the same-origin
 * /api/adv/sessions/ended fetch, the lexicon, and the transcript inspector a
 * row click opens.
 */
export function InactiveSessionsSection({
  activeOwnerIds,
  nowMs,
  focusOwnerId = null,
}: {
  /** Owner ids currently shown as RUNNING — their ended rows are older
   *  terminals of a live agent and are elided (mirrors the roster's
   *  dedupeEndedAgainstActive). */
  activeOwnerIds: ReadonlySet<string>;
  nowMs: number;
  /** Deep-link focus (?agentsFocus=, WI-5517): when set, auto-expand and show
   *  ONLY this owner's ended sessions — their session history — INCLUDING rows
   *  the active-elision would normally hide (a running agent's older
   *  terminals ARE its history). */
  focusOwnerId?: string | null;
}) {
  const lex = useLexicon();
  // User-meaningful expand/collapse state goes in the URL (nuqs), never
  // useState (repo convention) — this ALSO fixes WI-3881: AgentsRunningPill
  // returns null (unmounting this whole subtree) whenever the live-roster
  // sync query transiently reports zero running agents, and a plain
  // useState here reset to collapsed on the next remount. A nuqs-backed
  // value lives in the URL independent of the component's mount lifecycle,
  // so it survives that unmount/remount cycle.
  const [expanded, setExpanded] = useQueryState('agentsInactiveOpen', parseAsBoolean.withDefault(false));
  const [inspecting, setInspecting] = useState<EndedSessionRow | null>(null);
  // resume-in-gui-button-2026-08-09 — same destination as the search-results view.
  const openHudConversation = useOpenHudConversation();
  const labels = useMemo<RosterLabels>(() => ({
    term: (key, opts) => lex(key, opts),
    agentLabel: (raw) => agentDisplayLabel(raw, lex),
    roleLabel: (raw) => agentRoleLabel(raw, lex),
  }), [lex]);

  return (
    <>
      <SharedInactiveSessionsSection
        activeOwnerIds={activeOwnerIds}
        nowMs={nowMs}
        focusOwnerId={focusOwnerId}
        expanded={expanded}
        onExpandedChange={(next) => void setExpanded(next)}
        loadPage={loadEndedSessionsPage}
        chrome={INACTIVE_CHROME}
        labels={labels}
        // A row opens only when a transcript viewer can resolve it — the same
        // predicate the modal below relies on for its streamUrl.
        isOpenable={(r) => endedSessionStreamUrl(r) !== null}
        onRowActivate={setInspecting}
      />
      {inspecting ? (
        <AgentInspectorModal
          slug=""
          phase="staging"
          runId={inspecting.sessionId ?? inspecting.ompThreadId ?? String(inspecting.id)}
          role={endedDisplayName(inspecting, lex)}
          streamUrl={endedSessionStreamUrl(inspecting) ?? undefined}
          resumeTarget={resumableSessionId(inspecting)
            ? {
                sessionId: resumableSessionId(inspecting)!,
                live: false,
                canFork: canForkSession(inspecting),
                // resume-in-gui-button-2026-08-09: an ENDED row's own coord owner id.
                // This is the case the GUI button exists for — the session is dead, so
                // clicking it really does spawn a headless `psu --resume`, which comes
                // back under this same id (psu's resume is identity-preserving) and is
                // therefore reachable at this address in the HUD conversation popup.
                guiOwnerId: inspecting.coordOwnerId ?? null,
              }
            : undefined}
          onOpenInGui={openHudConversation}
          open
          onClose={() => setInspecting(null)}
        />
      ) : null}
      <SessionsStyles />
    </>
  );
}

function SessionsStyles() {
  return (
    <style>{`
      /* Sticky header: the search box stays visible while the roster scrolls
         (the popover itself is the scrollport; -4px rides over its padding). */
      .pc-agents-sessions__searchwrap {
        padding: 6px 8px 4px; border-bottom: 1px solid var(--border);
        position: sticky; top: -4px; z-index: 2; background: var(--bg-1, #0b1525);
      }
      .pc-agents-sessions__search {
        width: 100%; box-sizing: border-box; font-size: 12px; padding: 5px 8px;
        background: var(--bg-2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
      }
      .pc-agents-sessions__search:focus { outline: 1px solid var(--accent, #38bdf8); }
      /* The status line, the scroll container and the whole "View inactive
         sessions" footer are the shared package's rules (WI-2047194) — one
         source for both surfaces. Spliced here, not duplicated. */
${INACTIVE_SESSIONS_STYLES}
      /* WI-4734: the in-flight state must be UNMISSABLE — animated ellipsis on
         the status line, and stale previous-query results dimmed (still
         interactive) so they read as "old results, new search running". */
      .pc-agents-sessions__status.is-searching::after {
        content: ''; display: inline-block; width: 1.2em; text-align: left;
        animation: pc-agents-search-dots 1.2s steps(4, end) infinite;
      }
      @keyframes pc-agents-search-dots {
        0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; }
      }
      .is-stale { opacity: 0.45; transition: opacity 120ms ease; }
      .pc-agents-sessions__retry {
        margin-left: 6px; padding: 1px 8px; font-size: 11px; font-style: normal;
        color: var(--accent, #7aa2f7); background: transparent;
        border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
      }
      .pc-agents-sessions__retry:hover { border-color: var(--accent, #7aa2f7); }
      .pc-agents-sessions__result { padding: 2px 0 4px; border-bottom: 1px solid var(--border); }
      .pc-agents-sessions__result:last-child { border-bottom: none; }
      .pc-agents-sessions__result-head.is-unopenable { cursor: default; opacity: 0.75; }
      .pc-agents-sessions__kind {
        font-size: 9px; font-family: ui-monospace, monospace; color: var(--fg-mute);
        border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; line-height: 1.5;
      }
      .pc-agents-sessions__hit {
        margin: 2px 8px 2px 30px; padding: 3px 8px; font-size: 11px; line-height: 1.45;
        color: var(--fg-mute); background: var(--bg-2); border-left: 2px solid var(--border);
        border-radius: 3px; cursor: pointer; word-break: break-word;
      }
      .pc-agents-sessions__hit:hover { border-left-color: var(--accent, #38bdf8); background: color-mix(in oklab, var(--accent), transparent 88%); }
      .pc-agents-sessions__hit mark {
        background: color-mix(in srgb, var(--accent, #38bdf8), transparent 55%);
        color: inherit; border-radius: 2px; padding: 0 1px;
      }
      /* P-004 — nothing in this hit's text is highlighted, so what is shown is
         the head of the turn rather than the match. Italic sets it apart from
         the rows whose <mark>s do explain themselves. (Independent of WHICH
         leg retrieved the row: a vector-only hit is usually still marked.) */
      .pc-agents-sessions__hit--excerpt-only { font-style: italic; }
      .pc-agents-sessions__provenance {
        font-style: normal; font-size: 9px; font-family: ui-monospace, monospace;
        color: var(--fg-mute); border: 1px solid var(--border); border-radius: 3px;
        padding: 0 3px; margin-right: 5px; white-space: nowrap; vertical-align: 1px;
      }
      /* WI-37204 — "matched su id" / "matched session id" on the head row.
         Accented rather than muted like the provenance chip above: it is the
         ONLY thing explaining why a card carrying no excerpts is on screen, so
         it has to be findable at a glance, not read as chrome.

         WARNING: the head row is a GRID (the --nocheck modifier: 4 explicit
         tracks for age/glyph/name/doing), NOT a flex row — so this chip is a
         FIFTH child and needs its own explicit track, exactly as --nocheck
         itself exists because a mismatched track count shifted every cell left
         by one and truncated the name to a single letter (owner-hit 2026-07-11
         r3). A margin-left:auto — the flex idiom — would be inert here; the
         chip sits at the right edge because the doing track ahead of it is
         minmax(0, 1fr) and absorbs the slack. The modifier is applied ONLY when
         the chip renders, so an ordinary text result keeps the 4-track template
         unchanged. */
      .pc-agents-roster__row--nocheck.pc-agents-sessions__result-head--idmatch {
        grid-template-columns: max-content 16px minmax(40px, max-content) minmax(0, 1fr) max-content;
      }
      .pc-agents-sessions__idmatch {
        font-size: 9px; font-family: ui-monospace, monospace; white-space: nowrap;
        color: var(--accent, #7cc4ff);
        border: 1px solid currentColor; border-radius: 3px;
        padding: 0 3px; opacity: 0.85;
      }
      /* Context-dependent facet filter bar (facet-pills-and-recency-2026-07-12) */
      .pc-agents-facets {
        display: flex; flex-direction: column; gap: 3px;
        padding: 5px 8px 6px; border-bottom: 1px solid var(--border);
        background: var(--bg-1, #0b1525);
      }
      .pc-agents-facets__row { display: flex; align-items: flex-start; gap: 6px; }
      .pc-agents-facets__label {
        flex: 0 0 52px; font-size: 10px; text-transform: uppercase; letter-spacing: 0;
        color: var(--fg-mute); padding-top: 3px; line-height: 1.4;
      }
      .pc-agents-facets__pills { display: flex; flex-wrap: wrap; gap: 3px; flex: 1 1 auto; min-width: 0; }
      .pc-agents-facets__pill {
        display: inline-flex; align-items: center; gap: 4px;
        font: inherit; font-size: 10.5px; line-height: 1.5; cursor: pointer;
        padding: 1px 7px; border-radius: 999px;
        background: var(--bg-2); color: var(--fg); border: 1px solid var(--border);
      }
      .pc-agents-facets__pill:hover { border-color: var(--accent, #38bdf8); }
      .pc-agents-facets__pill.is-on {
        background: color-mix(in srgb, var(--accent, #38bdf8) 30%, transparent);
        border-color: var(--accent, #38bdf8); color: var(--fg); font-weight: 600;
      }
      .pc-agents-facets__dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }
      .pc-agents-facets__pill-text { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-agents-facets__count { font-variant-numeric: tabular-nums; font-size: 9.5px; color: var(--fg-mute); }
      .pc-agents-facets__pill.is-on .pc-agents-facets__count { color: inherit; }
      .pc-agents-facets__more { font-size: 10px; color: var(--fg-mute); align-self: center; }
      .pc-agents-facets__clear {
        flex: 0 0 auto; font: inherit; font-size: 10.5px; cursor: pointer;
        padding: 1px 7px; border-radius: 6px; background: transparent;
        color: var(--fg-mute); border: 1px solid var(--border);
      }
      .pc-agents-facets__clear:hover { border-color: var(--accent, #38bdf8); color: var(--fg); }
    `}</style>
  );
}
