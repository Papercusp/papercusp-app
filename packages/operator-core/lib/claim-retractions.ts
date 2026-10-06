/**
 * claim-retractions — claim IDENTITY + an append-only retract/reinstate log
 * (EI-23765337478012299).
 *
 * THE GAP THIS CLOSES. A carried claim (a `loop:checkpoint` / `work_items:checkpoint`
 * `checks[]` row, keyed by its optional `id`; or any prose that cites `claim:<id>`)
 * had no lifecycle after it was written. When it turned out wrong, the only "retract"
 * was an agent hand-encoding "this is retracted" into TITLE PROSE on whichever
 * surface it remembered — and every surface it forgot kept serving the dead claim as
 * fact. A claim needs an IDENTITY that a retraction can attach to once and that every
 * reader resolves live.
 *
 * MODEL.
 *   • Identity — the check row's `id` (already round-trip-sanitized by
 *     {@link sanitizeCarryRowId}); `claim:<id>` is the prose mention form.
 *   • State   — `harness_shared.claim_retraction_events`, an APPEND-ONLY event log
 *     (migration 1329). The LATEST event per (workspace_id, claim_id) is the claim's
 *     current standing. Nothing is ever updated or deleted, and a retraction is
 *     itself revisable (`reinstate`), so an over-retraction (EI-23759277029988080)
 *     is repairable and the audit trail keeps the full oscillation.
 *   • Readers — carry-brief resolves standings for every id it renders, so a
 *     retracted claim surfaces as `⛔ RETRACTED` beside the row instead of being
 *     served as a still-standing fact.
 *
 * DB idiom is agent-facts/store.ts (`getOrgPg` + `activeWorkspaceId` + `sqlOf(inject)`),
 * so a test injects a client without a module mock.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { sanitizeCarryRowId } from './carry-note';

export const CLAIM_EVENT_KINDS = ['retract', 'reinstate'] as const;
export type ClaimEventKind = (typeof CLAIM_EVENT_KINDS)[number];

/** Mirrors the table CHECKs in migration 1329 so a bad value is a typed refusal here,
 *  not an opaque constraint violation at the DB. */
export const CLAIM_BECAUSE_MAX = 1000;
export const CLAIM_SUPERSEDED_BY_MAX = 300;

/** The latest event for one claim id — its CURRENT standing. */
export interface ClaimStanding {
  claimId: string;
  /** `retract` ⇒ the claim is retracted now; `reinstate` ⇒ a retraction was reversed. */
  kind: ClaimEventKind;
  because: string;
  supersededBy: string | null;
  actor: string;
  recordedAt: string;
  eventSeq: number;
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

/** Strip the prose-mention prefixes a caller may paste (`claim:foo`, `#foo`, `id:foo`),
 *  then sanitize to the same charset a check row's `id` round-trips through. PURE.
 *  Returns null when nothing survives — the caller refuses rather than guessing. */
export function normalizeClaimId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.trim().replace(/^(?:claim:|id:|#)/i, '');
  return sanitizeCarryRowId(stripped);
}

/** Every `claim:<id>` mention in free text, normalized + de-duplicated, in order of
 *  first appearance. PURE. A mention that names no recorded claim is harmless: the
 *  standings lookup simply has no row for it. */
export function extractClaimMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])claim:([A-Za-z0-9._][A-Za-z0-9._:-]*)/gi)) {
    const id = normalizeClaimId(m[1]);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function isRetracted(standing: ClaimStanding | null | undefined): boolean {
  return standing?.kind === 'retract';
}

/** One-line human rendering of a RETRACTED standing, for carry briefs. PURE. */
export function renderRetractedMarker(standing: ClaimStanding): string {
  const day = standing.recordedAt.slice(0, 10);
  const by = standing.supersededBy ? ` — superseded by ${standing.supersededBy}` : '';
  return `⛔ RETRACTED ${day} by ${standing.actor}: ${standing.because}${by} — do NOT act on this claim`;
}

type EventRow = {
  event_seq: string | number;
  claim_id: string;
  event_kind: string;
  because: string;
  superseded_by: string | null;
  actor: string;
  recorded_at: Date | string;
};

function toStanding(r: EventRow): ClaimStanding {
  return {
    claimId: r.claim_id,
    kind: r.event_kind === 'reinstate' ? 'reinstate' : 'retract',
    because: r.because,
    supersededBy: r.superseded_by,
    actor: r.actor,
    recordedAt: new Date(r.recorded_at).toISOString(),
    eventSeq: Number(r.event_seq),
  };
}

export interface ReadClaimStandingsOptions {
  workspaceId?: string;
}

/** Current standing (latest event) for each id that HAS any event. An id absent from
 *  the result has never been retracted or reinstated — i.e. it simply stands. */
export async function readClaimStandings(
  claimIds: readonly string[],
  opts: ReadClaimStandingsOptions = {},
  inject?: Sql,
): Promise<Map<string, ClaimStanding>> {
  const ids = [...new Set(claimIds.map((c) => normalizeClaimId(c)).filter((c): c is string => c !== null))];
  const out = new Map<string, ClaimStanding>();
  if (ids.length === 0) return out;
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<EventRow[]>`
    SELECT DISTINCT ON (claim_id)
           event_seq, claim_id, event_kind, because, superseded_by, actor, recorded_at
      FROM harness_shared.claim_retraction_events
     WHERE workspace_id = ${ws} AND claim_id = ANY(${ids as string[]})
     ORDER BY claim_id, event_seq DESC`;
  for (const r of rows) out.set(r.claim_id, toStanding(r));
  return out;
}

export interface RecordClaimEventInput {
  claimId: string;
  kind: ClaimEventKind;
  because: string;
  supersededBy?: string | null;
  actor: string;
  workspaceId?: string;
}

export type RecordClaimEventResult =
  | { ok: true; changed: boolean; standing: ClaimStanding }
  | { ok: false; error: 'invalid_claim_id' | 'because_required' | 'because_too_long' | 'superseded_by_too_long' | 'not_retracted'; detail: string };

/**
 * Append a retract / reinstate event. Idempotent at the standing level: repeating the
 * latest event verbatim (same kind, because, supersededBy) is a no-op reported
 * `changed:false` rather than a duplicate row. `reinstate` on a claim that is not
 * currently retracted is refused (`not_retracted`) — there is nothing to reverse.
 */
export async function recordClaimEvent(input: RecordClaimEventInput, inject?: Sql): Promise<RecordClaimEventResult> {
  const claimId = normalizeClaimId(input.claimId);
  if (!claimId) {
    return { ok: false, error: 'invalid_claim_id', detail: 'claimId has no usable characters after normalization (allowed: A-Z a-z 0-9 . _ : -).' };
  }
  const because = (input.because ?? '').trim();
  if (!because) return { ok: false, error: 'because_required', detail: 'A retraction/reinstatement must say why.' };
  if (because.length > CLAIM_BECAUSE_MAX) {
    return { ok: false, error: 'because_too_long', detail: `because is ${because.length} chars; max ${CLAIM_BECAUSE_MAX}.` };
  }
  const supersededBy = (input.supersededBy ?? '').trim() || null;
  if (supersededBy && supersededBy.length > CLAIM_SUPERSEDED_BY_MAX) {
    return { ok: false, error: 'superseded_by_too_long', detail: `supersededBy is ${supersededBy.length} chars; max ${CLAIM_SUPERSEDED_BY_MAX}.` };
  }
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();

  const latest = (await readClaimStandings([claimId], { workspaceId: ws }, sql)).get(claimId) ?? null;
  if (input.kind === 'reinstate' && !isRetracted(latest)) {
    return { ok: false, error: 'not_retracted', detail: `claim '${claimId}' is not currently retracted; nothing to reinstate.` };
  }
  if (latest && latest.kind === input.kind && latest.because === because && latest.supersededBy === supersededBy) {
    return { ok: true, changed: false, standing: latest };
  }
  const rows = await sql<EventRow[]>`
    INSERT INTO harness_shared.claim_retraction_events
      (workspace_id, claim_id, event_kind, because, superseded_by, actor)
    VALUES (${ws}, ${claimId}, ${input.kind}, ${because}, ${supersededBy}, ${input.actor})
    RETURNING event_seq, claim_id, event_kind, because, superseded_by, actor, recorded_at`;
  return { ok: true, changed: true, standing: toStanding(rows[0]!) };
}
