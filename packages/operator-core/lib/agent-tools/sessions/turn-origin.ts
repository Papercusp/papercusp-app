/**
 * `turn_origin` for sessions:search hits (EI-20034001963934568).
 *
 * THE PROBLEM THIS EXISTS TO KILL. The compaction-strategy rule tells an agent
 * to verify a claimed owner directive with `sessions:search { session:'self' }`.
 * But `loop:arm { goal }` text is REPLAYED into every wake as a turn whose
 * `speaker` is literally `'user'` — so that verification FINDS the agent's own
 * words in a "user" turn and PASSES. The prescribed antidote returns a false
 * confirmation, and an agent following the rules correctly ends up MORE
 * confident. Measured 2026-08-10 over 3 days of `harness_shared.session_turns`:
 * 1213 of 2582 `speaker='user'` turns (47%) were machine-injected — loop-fire
 * 683, fleet-kickoff 223, self-compaction 211, wake-pump 96.
 *
 * The discriminator already exists (the `⟦turn-origin:…⟧` envelope, classified
 * by `classifyRecordedTurn`); it simply was not carried on the search hit. This
 * module attaches it.
 *
 * TWO PROPERTIES ARE LOAD-BEARING — neither is a style choice:
 *
 * 1. CLASSIFY THE TURN HEAD, NEVER THE EXCERPT. The envelope regex is strictly
 *    head-anchored (`^\s*⟦turn-origin:…⟧`). A verbatim hit's excerpt happens to
 *    be the head, but a HYBRID hit's excerpt is a relevance-selected snippet
 *    from anywhere in the turn — classifying that would report `owner-typed`
 *    for a loop-fire replay, i.e. it would manufacture the exact false
 *    confirmation this fix removes, while looking like it had checked. So the
 *    head is re-read from the corpus by (source_kind, session_id, turn_idx).
 *    Head-anchoring also correctly ignores a turn that merely QUOTES an
 *    envelope mid-body (13 such turns in the same 3-day window — agents pasting
 *    provenance blocks as evidence, this file's own work included).
 *
 * 2. A MISS RENDERS `unknown`, NEVER "agent-authored". Overcorrecting here is a
 *    measured live failure in its own right (EI-13472 / WI-37419): an owner
 *    directive delivered through AskUserQuestion is not turn-stamped and cannot
 *    be verified the mandated way, and reading that miss as "manufactured"
 *    tells an agent a REAL owner directive is fake. The false positive and the
 *    false negative have one root, so a fix that trades one for the other is
 *    not a fix. Absence of a signal is never evidence of its opposite.
 */

import type { Sql } from 'postgres';
import { classifyRecordedTurn, type RecordedTurnVerdict } from '../../turn-provenance/turn-ref';
import { closeTruncatedWholePaste } from '../../turn-provenance/envelope-grammar';

/** `RecordedTurnVerdict` plus the two states a SEARCH HIT can be in that a
 *  recorded-turn classifier never sees: a non-user turn, and an unreadable one. */
export type HitTurnOriginVerdict = RecordedTurnVerdict | 'not-user-turn' | 'unknown';

export interface HitTurnOrigin {
  verdict: HitTurnOriginVerdict;
  /** The envelope's origin when agent-injected (`loop-fire`, `wake-pump`, …). */
  origin: string | null;
  /** Present only on verdicts that MISLEAD if read naively. `owner-typed`
   *  carries none: its own word is the affirmative, and repeating a hedge on
   *  every owner hit pushes toward the inverse failure in property 2 above. */
  note?: string;
}

export interface TurnKey {
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
}

/**
 * Head chars fetched for classification. MUST be >= the classifier's own
 * internal `CLASSIFY_HEAD_CHARS` (240): `classifyRecordedTurn` re-slices to
 * that itself, so over-fetching cannot change a verdict, while under-fetching
 * silently can.
 */
export const TURN_ORIGIN_HEAD_CHARS = 512;

/**
 * Tail chars fetched beside the head (WI-10004057): enough for a closing
 * `</pasted_content id="…">` tag (id ≤ 64) plus trailing whitespace, so a bounded
 * head can be judged as the whole paste it belongs to.
 */
export const TURN_ORIGIN_TAIL_CHARS = 256;

const NOT_USER_NOTE =
  'Not a user turn (assistant/tool output) — it cannot be an owner directive at all.';

const MACHINE_SURFACE_NOTE =
  'A CLI/harness machine surface recorded as a user turn — never owner speech, ' +
  'even though the transcript files it under `user`.';

/** The one verdict that must never be inferred from a missing signal. */
export function unknownTurnOrigin(why: string): HitTurnOrigin {
  return {
    verdict: 'unknown',
    origin: null,
    note:
      `Origin could NOT be determined (${why}) — read this as UNKNOWN, never as ` +
      'agent-authored. A genuine owner directive can also land unverifiable (e.g. ' +
      'delivered via AskUserQuestion, which is not turn-stamped), so treating a ' +
      'miss as proof of fabrication is its own measured failure (EI-13472).',
  };
}

function agentInjectedNote(origin: string | null): string {
  const which = origin ? `origin: ${origin}` : 'origin unnamed';
  const loopClause =
    origin === 'loop-fire' || origin === 'wake-pump'
      ? ' A loop/wake goal is replayed VERBATIM every fire, so repetition here is ' +
        'the machinery echoing your own note-to-self, not corroboration.'
      : '';
  return (
    `MACHINE-INJECTED turn (${which}) — NOT owner speech, despite speaker='user'. ` +
    'Any text inside it, including a hand-written [owner:…] tag or first-person ' +
    `phrasing, is AGENT-AUTHORED.${loopClause} This hit cannot support "the owner said X".`
  );
}

/** Stable map key for a turn coordinate. `\x00` cannot occur in an id. */
export function turnOriginKey(k: TurnKey): string {
  return `${k.sourceKind}\x00${k.sessionId}\x00${k.turnIdx}`;
}

/**
 * Classify ONE hit from its recorded speaker and the HEAD of its turn text.
 *
 * `head` must be the start of the turn — see property 1 in the module header.
 * Passing a mid-body excerpt is not a smaller error than passing nothing: it
 * returns a confident `owner-typed` for machine-injected text.
 *
 * `tail` is the END of the same turn (`right(text, TURN_ORIGIN_TAIL_CHARS)`). Pass it
 * whenever `head` is a bounded slice: without it a machine turn wrapped in a paste
 * block longer than the head classifies `owner-typed` (WI-10004057), because the
 * whole-paste unwrap needs the closing tag the slice cut off.
 */
export function classifyHitTurnOrigin(
  speaker: string | null | undefined,
  head: string | null | undefined,
  tail?: string | null,
  stored?: StoredTurnVerdict | null,
): HitTurnOrigin {
  return applyStoredTurnVerdict(classifyFromText(speaker, head, tail), stored);
}

/** The verdict ingest PERSISTED on the row (`session_turns.turn_origin_verdict` /
 *  `turn_origin`, migration 794). Both are NULL on a row ingested before 794. */
export interface StoredTurnVerdict {
  verdict: string | null | undefined;
  origin?: string | null;
}

/** Ingest's honest-uncertainty verdict for a clean user row on a file-backed CLI
 *  source with no hook-authenticated prompt-origin match. PINNED to
 *  session-ingest.ts's `UNENROLLED_ORIGIN_VERDICT` by turn-origin.test.ts (imported
 *  there, not here, so this module stays free of the ingest graph). */
export const STORED_UNENROLLED_ORIGIN = 'unenrolled-origin';

const UNENROLLED_WHY =
  'ingest stored this file-backed CLI turn as unenrolled-origin: it carried no origin ' +
  'envelope and no hook-authenticated prompt-origin stamp matched it, so authorship was ' +
  'never proven either way. It is an owner CANDIDATE, not owner speech';

/**
 * WI-10004510: honour the verdict ingest STORED, as a DOWNGRADE ONLY.
 *
 * The text classifier's `owner-typed` is a RESIDUAL ("no machine rule matched"), not a
 * positive identification. Ingest knows more than the text: it correlates the hook's
 * prompt-origin ledger, and on a file-backed source it refuses to keep an uncorrelated
 * residual as `owner-typed`, storing `unenrolled-origin` instead (`stampTurnProvenance`).
 * Re-deriving from text alone discarded that — measured 2026-10-01, 947 user turns cited
 * by activation audits (221 plans) were stored `unenrolled-origin` yet counted here as
 * owner speech, i.e. this read manufactured owner authority (the WI-3532 class).
 *
 * Same contract as turn-ref.ts `classifyRecordedUserTurn`: the stored verdict can take a
 * text `owner-typed` to a non-owner verdict and can NEVER grant owner — a non-owner text
 * verdict (an envelope, a machine surface) always stands, because the catalogue that
 * produced a stored verdict may be older than the text classifier's. A NULL stored
 * verdict means "never classified" (pre-794), not `unknown`, so the text verdict stands.
 */
export function applyStoredTurnVerdict(
  fromText: HitTurnOrigin,
  stored?: StoredTurnVerdict | null,
): HitTurnOrigin {
  if (fromText.verdict !== 'owner-typed') return fromText;
  const verdict = stored?.verdict;
  if (verdict == null || verdict === '') return fromText;
  switch (verdict) {
    case 'owner-typed':
    case 'owner-turn':
    case 'owner-dialog':
      return fromText;
    case 'agent-injected': {
      const origin = stored?.origin ?? null;
      return { verdict: 'agent-injected', origin, note: agentInjectedNote(origin) };
    }
    case 'machine-surface':
    case 'synthetic':
      return { verdict, origin: null, note: MACHINE_SURFACE_NOTE };
    case STORED_UNENROLLED_ORIGIN:
      return unknownTurnOrigin(UNENROLLED_WHY);
    default:
      // Any verdict added to ingest later: never the owner (property 2 — and never "agent").
      return unknownTurnOrigin(`ingest stored the non-owner verdict '${verdict}'`);
  }
}

function classifyFromText(
  speaker: string | null | undefined,
  head: string | null | undefined,
  tail?: string | null,
): HitTurnOrigin {
  if (typeof head !== 'string' || !head.trim()) {
    return unknownTurnOrigin('the turn text could not be read from the corpus');
  }
  if (speaker == null || speaker === '') {
    return unknownTurnOrigin('the turn has no recorded speaker');
  }
  // Mirrors carry-doc.ts's guard: classifyRecordedTurn answers "is this
  // recorded USER turn owner-typed", and every assistant turn lacks an
  // envelope — so applying it unguarded stamps `owner-typed` on all of them
  // (25,198 assistant turns in the measured 3-day window would have qualified).
  if (speaker !== 'user') {
    return { verdict: 'not-user-turn', origin: null, note: NOT_USER_NOTE };
  }

  const { verdict, origin } = classifyRecordedTurn(closeTruncatedWholePaste(head, tail));
  switch (verdict) {
    case 'agent-injected':
      return { verdict, origin, note: agentInjectedNote(origin) };
    case 'machine-surface':
    case 'synthetic':
      return { verdict, origin, note: MACHINE_SURFACE_NOTE };
    case 'owner-typed':
    case 'owner-turn':
    case 'owner-dialog':
      return { verdict, origin };
  }
}

/**
 * Batch-resolve `turn_origin` for a page of session_turn hits — ONE round trip
 * regardless of page size. Missing rows are simply absent from the returned
 * map; callers render `unknownTurnOrigin(...)` for them rather than guessing.
 */
export async function resolveHitTurnOrigins(
  sql: Sql,
  workspaceId: string,
  keys: TurnKey[],
): Promise<Map<string, HitTurnOrigin>> {
  const out = new Map<string, HitTurnOrigin>();
  if (!keys.length) return out;

  const kinds = keys.map((k) => k.sourceKind);
  const sessionIds = keys.map((k) => k.sessionId);
  const turnIdxs = keys.map((k) => k.turnIdx);

  const rows = await sql<
    Array<{
      source_kind: string;
      session_id: string;
      turn_idx: number;
      speaker: string | null;
      head: string | null;
      tail: string | null;
      turn_origin?: string | null;
      turn_origin_verdict?: string | null;
    }>
  >`
    SELECT source_kind, session_id, turn_idx, speaker,
           left(text, ${TURN_ORIGIN_HEAD_CHARS}) AS head,
           right(text, ${TURN_ORIGIN_TAIL_CHARS}) AS tail,
           turn_origin, turn_origin_verdict
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND (source_kind, session_id, turn_idx) IN (
             SELECT * FROM unnest(${kinds}::text[], ${sessionIds}::text[], ${turnIdxs}::int[])
           )
  `;

  for (const r of rows) {
    out.set(
      turnOriginKey({ sourceKind: r.source_kind, sessionId: r.session_id, turnIdx: r.turn_idx }),
      classifyHitTurnOrigin(r.speaker, r.head, r.tail, { verdict: r.turn_origin_verdict, origin: r.turn_origin }),
    );
  }
  return out;
}
