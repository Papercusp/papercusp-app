/**
 * source-provenance-resolve.ts — assert-time verification of a TYPED fact
 * sourceRef (coord-authority-hardening-2026-07-11 P-007 / H3+C).
 *
 * A fact's `sourceRef` ("the anchor that proved it") was free text — the same
 * EI-9501 hole H2 closed for relays: "src: owner said so" is unverifiable at
 * read time. When the sourceRef parses as a TYPED ref, the PLATFORM verifies it
 * against its own store AT ASSERT TIME and stamps the fact
 * ({@link FactSourceProvenance}); every future fold then renders the verified
 * quote with ZERO extra reads (the D-002 zero-extra-calls principle: verify
 * once at the write, deliver from the stamp forever).
 *
 * Typed shapes (D-004 — all resolved through the SHARED ref/relay machinery,
 * never a parallel resolver):
 *   msg:<id>            → coord message must exist (P-001 default msg resolver);
 *                         quote = bounded summary/body verbatim.
 *   wi:<id> / WI- / EI- → work-item must exist (P-001 default WI resolver);
 *                         quote = title/summary, label carries kind/state.
 *   session_turn:<source>:<session>:<idx>
 *                      → indexed transcript turn must exist and carry a
 *                        persisted owner-typed/owner-dialog verdict; quote =
 *                        the bounded recorded user text.
 *   owner-turn          → the caller's CURRENT human turn, read server-side
 *                         from the session store (H2 Tier-2 reuse) — the fact
 *                         carries the owner's verbatim words, not the agent's
 *                         paraphrase (D-005).
 * Anything else (plan slugs, prose, gate:/plan: refs) stays a plain free-text
 * anchor — no stamp, unchanged behavior.
 *
 * Fail-soft BY CONTRACT: verification decorates the assert, never blocks it.
 * A lookup miss / store error stamps `{ verified:false, error }` — rendered
 * LOUDLY in folds (`✗unverified`) instead of failing the write; only the
 * caller's zod/scope validation can reject an assert.
 */

import type { AgentIdentity } from '../coordination/identity';
import {
  formatSessionTurnRef,
  parseRefToken,
  clampSnippet,
  type SessionTurnRef,
} from '../coordination/ref-hydrate';
import { hydrateRefs } from '../coordination/ref-hydrate-resolve';
import { resolveRelayProvenance } from '../coordination/relay-provenance-resolve';
import { OWNER_TURN_SENTINEL } from '../coordination/relay-provenance';
import {
  FACT_PROVENANCE_QUOTE_CHARS,
  type FactSourceProvenance,
} from '../../agent-facts/store';
import { redactProvenanceQuote } from './quote-secret-redaction';

export type IndexedSessionTurnProvenance = SessionTurnRef & {
  speaker: string;
  text: string;
  turnOrigin?: string | null;
  turnOriginVerdict?: string | null;
  ts?: string | null;
};

/** Injectable read seam for the exact indexed transcript row used by a
 * session_turn sourceRef. Keeping this seam at the provenance boundary makes
 * unit tests DB-free while production reuses the canonical session_turns
 * index and its persisted origin verdict. */
export type SessionTurnProvenanceLoader = (
  ref: SessionTurnRef,
) => Promise<IndexedSessionTurnProvenance | null>;

export interface ResolveFactSourceProvenanceDeps {
  loadSessionTurn?: SessionTurnProvenanceLoader;
}

const OWNER_VERIFIED_TURN_VERDICTS = new Set(['owner-typed', 'owner-dialog']);

async function loadIndexedSessionTurn(
  identity: AgentIdentity,
  ref: SessionTurnRef,
): Promise<IndexedSessionTurnProvenance | null> {
  const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../../workspace-registry'),
  ]);
  const workspaceId = identity.workspaceId?.trim() || activeWorkspaceId();
  const [row] = await getOrgPg().sql<IndexedSessionTurnProvenance[]>`
    SELECT source_kind AS "sourceKind",
           session_id AS "sessionId",
           turn_idx AS "turnIdx",
           speaker,
           text,
           turn_origin AS "turnOrigin",
           turn_origin_verdict AS "turnOriginVerdict",
           ts::text AS ts
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND source_kind = ${ref.sourceKind}
       AND session_id = ${ref.sessionId}
       AND turn_idx = ${ref.turnIdx}
     ORDER BY CASE WHEN workspace_id = ${workspaceId} THEN 0 ELSE 1 END
     LIMIT 1
  `;
  return row ?? null;
}

/**
 * Resolve a sourceRef into an assert-time provenance stamp.
 * `null` = not a typed ref (free-text anchor — store it unstamped, unchanged).
 */
export async function resolveFactSourceProvenance(
  identity: AgentIdentity,
  sourceRef: string,
  deps: ResolveFactSourceProvenanceDeps = {},
): Promise<FactSourceProvenance | null> {
  const ref = parseRefToken(sourceRef);
  if (!ref) return null;
  const verifiedAt = new Date().toISOString();

  try {
    if (ref.kind === 'owner-turn') {
      const { stamp } = await resolveRelayProvenance(identity, { relayOf: OWNER_TURN_SENTINEL });
      if (stamp?.tier === 'owner-verified-turn') {
        const safe = redactProvenanceQuote(clampSnippet(stamp.quote, FACT_PROVENANCE_QUOTE_CHARS));
        return {
          kind: 'owner-turn',
          verified: true,
          ...(safe.quote ? { quote: safe.quote } : {}),
          ...(safe.redacted ? { quoteRedacted: true } : {}),
          ...(stamp.turnTs ? { label: `owner turn ${stamp.turnTs}` } : {}),
          verifiedAt,
        };
      }
      return { kind: 'owner-turn', verified: false, error: 'owner_turn_unresolved', verifiedAt };
    }

    if (ref.kind === 'session-turn') {
      const label = formatSessionTurnRef(ref);
      const load = deps.loadSessionTurn ?? ((target) => loadIndexedSessionTurn(identity, target));
      const turn = await load({
        sourceKind: ref.sourceKind,
        sessionId: ref.sessionId,
        turnIdx: ref.turnIdx,
      });
      if (!turn) {
        return { kind: 'owner-turn', verified: false, label, error: 'not_found', verifiedAt };
      }
      const verdict = turn.turnOriginVerdict?.toLowerCase() ?? null;
      if (turn.speaker.toLowerCase() !== 'user' || !verdict || !OWNER_VERIFIED_TURN_VERDICTS.has(verdict)) {
        return { kind: 'owner-turn', verified: false, label, error: 'owner_attribution_unverified', verifiedAt };
      }
      const safe = redactProvenanceQuote(clampSnippet(turn.text, FACT_PROVENANCE_QUOTE_CHARS));
      return {
        kind: 'owner-turn',
        verified: true,
        ...(safe.quote ? { quote: safe.quote } : {}),
        ...(safe.redacted ? { quoteRedacted: true } : {}),
        label,
        verifiedAt,
      };
    }

    if (ref.kind === 'msg' || ref.kind === 'work-item') {
      const [h] = await hydrateRefs([ref], {
        budget: { snippetChars: FACT_PROVENANCE_QUOTE_CHARS, maxRefs: 1 },
      });
      if (h?.ok) {
        const safe = redactProvenanceQuote(h.snippet);
        return {
          kind: ref.kind,
          verified: true,
          ...(safe.quote ? { quote: safe.quote } : {}),
          ...(safe.redacted ? { quoteRedacted: true } : {}),
          label: h.label,
          verifiedAt,
        };
      }
      return { kind: ref.kind, verified: false, error: h?.error ?? 'not_found', verifiedAt };
    }
  } catch {
    // Fail-soft: a store hiccup stamps loud-unverified, never blocks the assert.
    const kind = ref.kind === 'msg' || ref.kind === 'work-item' ? ref.kind : 'owner-turn';
    return { kind, verified: false, error: 'resolve_error', verifiedAt };
  }

  // plan-item / gate refs: not in the v1 typed-verification set — free text.
  return null;
}
