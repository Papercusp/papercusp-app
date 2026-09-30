/**
 * dead-session-recipient-guidance.ts — knowledge-at-symptom-time-2026-08-09 P-005.
 *
 * ## The incident
 *
 * An agent needed to escalate an inference-gateway fault. Memory named
 * `su-fcdb9…` as the gateway's owner. That session was dead, so `coord:send`
 * refused with `unknown_recipient` — and the escalation path evaporated at
 * exactly the moment it was needed. The stored knowledge was not wrong when it
 * was written; it named a SESSION, and sessions die while subsystems do not.
 *
 * ## Why the existing refusal could not help
 *
 * `coord:send`'s `unknown_recipient` message offers: use the short handle, the
 * `su-` prefix, the full ownerId, or look one up in `coord:presence`. Every one
 * of those answers "which LIVE agent did you mean" — a question with no answer
 * here, because no live session will ever again hold that id, and
 * `coord:presence` cannot tell you who owns the inference gateway. So the
 * refusal read as "you typed it wrong" for a caller who had typed exactly what
 * their knowledge said.
 *
 * ## The address that cannot die
 *
 * `@role:<slot>` already exists (EI-2312's stable-slot convention, e.g.
 * `MUG_COORD_SLOT = '@role:mug'`) and is already hardened to resolve against the
 * LIVE roster (EI-13620, {@link ../coordination/role-slot-live-resolve}). Two
 * properties make it the right answer here, both verified against the code
 * rather than assumed:
 *
 *   1. It CANNOT hard-refuse. `recipient-resolve.isSelectorOrWildcard` returns
 *      true for any `@`-prefixed id, and send.ts only runs the roster check when
 *      some recipient is NOT a selector — so a role-addressed send never reaches
 *      the `unknown_recipient` branch at all.
 *   2. When no holder is live it PARKS for the next spawn instead of failing, so
 *      the escalation survives the gap rather than evaporating in it.
 *
 * This module therefore does not build a new ownership registry — it routes the
 * caller to the durable addressing that already exists, at the one moment they
 * are provably looking for it.
 *
 * ## Scoped tight, on purpose
 *
 * The guidance fires ONLY when an unknown recipient is session-SHAPED. A plain
 * typo (`"93a38"`, a fabricated handle) gets the existing message unchanged —
 * lecturing every typo about role addressing would train agents to skim the one
 * refusal that most needs reading.
 */

/**
 * The two ownerId shapes this fleet actually issues, measured against
 * `harness_shared.adv_sessions` 2026-08-09: `su-<uuid>` (the psu/su form, and
 * any other role prefix using a uuid) and `s-<epoch>-<hex>` (the spawned form).
 *
 * Deliberately shape-based rather than prefix-based: binding to the literal
 * `su-` would go quiet for every other role's sessions, which are exactly as
 * mortal. A shape that means "this names one session instance" is the property.
 */
const SESSION_ID_SHAPES: readonly RegExp[] = [
  /^[a-z][a-z0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^s-\d{10,}-[0-9a-f]{6,}$/i,
];

export function isSessionShapedOwnerId(id: string): boolean {
  return SESSION_ID_SHAPES.some((re) => re.test(id.trim()));
}

export type UnknownRecipientKind =
  /** Found in adv_sessions with `ended_at` set — we KNOW it existed and died. */
  | 'ended'
  /** Shaped like a session id but no ended record was found (never recorded, a
   *  different workspace, or the lookup failed). Still session-shaped, so the
   *  guidance applies — we just cannot name the death. */
  | 'session-shaped'
  /** Not session-shaped: a typo or a fabricated handle. Gets no extra guidance. */
  | 'other';

export interface ClassifiedUnknownRecipient {
  id: string;
  kind: UnknownRecipientKind;
  endedAt?: string | null;
}

/** Injectable so the unit tests never need a database. */
export interface EndedSessionLookup {
  (ids: readonly string[]): Promise<Map<string, string | null>>;
}

/**
 * The live lookup: which of these ownerIds name a session that ENDED, and when.
 *
 * Workspace-scoped when the caller knows its workspace (the `adv_sessions`
 * multi-tenant advisory), but a miss is SAFE by construction — an id that
 * belongs to another tenant simply degrades to `'session-shaped'`, which still
 * produces the routing guidance. Fail-soft: any error returns an empty map.
 */
export async function lookupEndedSessions(
  ids: readonly string[],
  workspaceId?: string | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const list = [...new Set(ids.filter(Boolean))];
  if (list.length === 0) return out;
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const ws = workspaceId ?? null;
    const rows = await sql<{ coord_owner_id: string; ended_at: string | null }[]>`
      SELECT coord_owner_id, ended_at
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ANY(${list}::text[])
         AND ended_at IS NOT NULL
         AND (${ws}::text IS NULL OR workspace_id = ${ws})`;
    for (const r of rows) out.set(r.coord_owner_id, r.ended_at);
  } catch {
    return new Map();
  }
  return out;
}

/**
 * Classify each unknown recipient. FAIL-SOFT throughout: a lookup that throws
 * degrades every session-shaped id to `'session-shaped'` and still produces the
 * guidance — the routing advice does not depend on naming the death, and an
 * error path that swallowed the advice would reproduce the original failure.
 */
export async function classifyUnknownRecipients(
  ids: readonly string[],
  lookupEnded?: EndedSessionLookup,
): Promise<ClassifiedUnknownRecipient[]> {
  const sessionShaped = ids.filter(isSessionShapedOwnerId);
  let ended = new Map<string, string | null>();
  if (sessionShaped.length > 0 && lookupEnded) {
    try {
      ended = await lookupEnded(sessionShaped);
    } catch {
      ended = new Map();
    }
  }
  return ids.map((id) => {
    if (!isSessionShapedOwnerId(id)) return { id, kind: 'other' as const };
    if (ended.has(id)) return { id, kind: 'ended' as const, endedAt: ended.get(id) ?? null };
    return { id, kind: 'session-shaped' as const };
  });
}

/**
 * The sentence appended to the `unknown_recipient` refusal. Returns null when no
 * unknown recipient is session-shaped, so the common typo path is untouched.
 *
 * The operative clause leads (P-002 of this same plan: preserve the imperative,
 * excerpt the evidence) — an agent reading only the first line still learns the
 * address to use.
 */
export function roleAddressingGuidance(
  classified: readonly ClassifiedUnknownRecipient[],
  fleetSlug?: string | null,
): string | null {
  const mortal = classified.filter((c) => c.kind === 'ended' || c.kind === 'session-shaped');
  if (mortal.length === 0) return null;

  const confirmed = mortal.filter((c) => c.kind === 'ended');
  const subject = mortal.length === 1 ? `\`${mortal[0].id}\`` : `${mortal.length} of these ids`;

  const death =
    confirmed.length > 0
      ? confirmed[0].endedAt
        ? ` That session ENDED (${confirmed[0].endedAt}) — this is not a typo, and no send to it can ever succeed again.`
        : ' That session has ENDED — this is not a typo, and no send to it can ever succeed again.'
      : ' An id of that shape names ONE SESSION, which is mortal — if it is not in the roster it has almost certainly ended rather than been mistyped.';

  const namedFleet = fleetSlug?.trim();
  const fleetRoute = namedFleet
    ? ` If you are escalating within fleet \`${namedFleet}\`, address its current leader directly: ` +
      `\`@fleet-leader:${namedFleet}\`. That selector resolves the fleet REGISTRY's leader pointer ` +
      'rather than one session id, so it follows leadership rotation and still reaches a leader who ' +
      'is merely offline (their durable inbox keeps the escalation). It is NOT liveness-gated, so it ' +
      'is only as current as the pointer: if that pointer still names a REAPED session the send now ' +
      'refuses with `recipients_unreachable` naming the dead id — read that refusal as "re-resolve ' +
      'the leader", never as "the fleet is unreachable". It used to return ok:true instead ' +
      '(EI-22180848452883121).'
    : '';

  return (
    ` 🔑 ${subject} names a SESSION, not a standing responsibility.${death}` +
    fleetRoute +
    ' If you are addressing WHO OWNS A SUBSYSTEM (or "whoever runs X") rather than that one' +
    ' person, address the ROLE instead: `@role:<slot>`. A role selector resolves to whoever' +
    ' holds it live AND parks for the next spawn if nobody does, so it cannot hard-refuse the' +
    ' way a session id does — `coord:presence` cannot help you here because no live session' +
    ' will ever hold that id again. If a memory or a fact told you this id owns something,' +
    ' that record is the actual defect: it captured a session where it meant a role, and it' +
    ' will strand the next agent too — re-record it as the role selector.'
  );
}
