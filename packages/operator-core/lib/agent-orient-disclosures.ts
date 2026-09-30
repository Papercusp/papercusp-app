/**
 * agent-orient-disclosures — the DISCLOSURE FAMILY, recorded at orient time so
 * a human popup can show what the agent was actually told
 * (popup-agent-state-coverage-2026-08-18 P-005, D-008).
 *
 * ## The family, and why it is one thing
 *
 * Six fields on the `coord:orient` payload exist for a single reason: this
 * codebase refuses to let a BOUNDED read masquerade as a total one.
 *
 *  - `factsWithheld`             steering facts stripped from a responsive caller
 *  - `factsNarrowed`             the facts fold ran narrowed, not in full
 *  - `factEvictionDisclosures`   a fact you expect may have been cap-evicted
 *  - `claimableTruncated`        the claimable list is genuinely incomplete
 *  - `announcedGatesTruncated`   gates this caller could see that were not shown
 *  - `recipesTruncated`          recipes the search did not surface
 *
 * `claimableTruncated`'s own docblock states the property they all share:
 * *"absence is a positive statement that nothing was cut, which is what makes
 * the marker readable."* Drop them on the way to a screen and that screen
 * re-creates the exact lie each was built to prevent — the agent's facts with
 * no hint some were evicted, its gates with no hint some were withheld, its
 * backlog with no hint it was cut.
 *
 * ## Why RECORDED and not re-derived at view time (the load-bearing decision)
 *
 * Four of the six are artifacts of the ARGUMENTS of the orient call the agent
 * itself made: `factsNarrowed` depends on that call's `mode`,
 * `claimableTruncated` on its `claimableLimit`, `recipesTruncated` on its
 * `recipesLimit` and `intent`, `factsWithheld` on the caller's own
 * responsive-loop classification. Recomputing the family when a HUMAN opens a
 * popup would measure the VIEWER's bounds and render the answer as the agent's.
 *
 * That failure would be invisible and self-confirming: the viewer's own read is
 * unbounded, so it would almost always come back clean, and a clean disclosure
 * line reads as "nothing was withheld from this agent". It would manufacture on
 * screen precisely the false-clean reading the markers exist to prevent — which
 * makes re-derivation worse than showing nothing at all.
 *
 * Hence: the producer records what it emitted, verbatim, and a reader that has
 * no recording shows NOTHING rather than an empty set. `null` (never oriented
 * since the column existed) and `{}` (the last orient genuinely cut nothing)
 * are different readings and every consumer must keep them apart.
 */

import { getOrgPg } from '@papercusp/db-org';
import { notifyAgentOrdersChanged } from './agent-orders-notify';

/** The six markers, carried exactly as the orient payload emitted them.
 *
 *  Every field is optional and OMITTED when the orient did not emit it — the
 *  absence IS the disclosure's meaning, so a normaliser must never fill one in
 *  with a zero/empty default. */
export interface OrientDisclosures {
  factsWithheld?: { count: number; reason: string };
  factsNarrowed?: { fold: string; prefixes: string[]; reason: string };
  factEvictionDisclosures?: Array<{
    scope: string;
    scopeRef: string | null;
    recentEvictedCount: number;
    latestEvictedAt: string;
    meaning: string;
  }>;
  claimableTruncated?: {
    shown: number;
    total?: number;
    totalScope?: string;
    limit?: number;
    truncatedByLimit?: true;
    more: string;
  };
  announcedGatesTruncated?: { shown: number; total: number; more: string };
  recipesTruncated?: {
    shown: number;
    truncatedByLimit?: true;
    limit?: number;
    titlesClipped?: number;
    titleCap?: number;
    more: string;
  };
}

/** A recording, with the instant it was made. `at` is not decoration: markers
 *  from an orient six hours ago describe THAT call, not the session now, and a
 *  consumer that renders them without their age is asserting a currency the
 *  reading does not have. */
export interface RecordedOrientDisclosures {
  disclosures: OrientDisclosures;
  at: string;
}

/** The marker keys, in the order a reader should see them: the three facts
 *  markers first (they qualify one section), then the three bounded-list ones. */
export const ORIENT_DISCLOSURE_KEYS = [
  'factsWithheld',
  'factsNarrowed',
  'factEvictionDisclosures',
  'claimableTruncated',
  'announcedGatesTruncated',
  'recipesTruncated',
] as const satisfies ReadonlyArray<keyof OrientDisclosures>;

export type OrientDisclosureKey = (typeof ORIENT_DISCLOSURE_KEYS)[number];

/**
 * Pick the family off an orient result. PURE → unit-tested.
 *
 * Returns `{}` when the payload carried none — that is the POSITIVE reading
 * ("this orient cut nothing"), and it is deliberately distinct from the `null`
 * a reader gets for a session that has never recorded. Callers must not collapse
 * the two.
 *
 * Typed against a structural shape rather than importing `OrientResult`: this
 * module is read by the UI DTO layer, and importing the orient tool would drag
 * the whole coordination tool graph into it.
 */
export function collectOrientDisclosures(
  payload: Partial<Record<OrientDisclosureKey, unknown>>,
): OrientDisclosures {
  const out: Record<string, unknown> = {};
  for (const key of ORIENT_DISCLOSURE_KEYS) {
    const value = payload?.[key];
    if (value === undefined || value === null) continue;
    // An EMPTY eviction array is not a disclosure — orient itself only sets the
    // field when it found something, and a `[]` reaching here would render as a
    // marker with nothing to say.
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as OrientDisclosures;
}

/** True when a recording says something. Kept as a named predicate so the UI
 *  and the writer cannot disagree about what "nothing to show" means. */
export function hasOrientDisclosures(d: OrientDisclosures | null | undefined): boolean {
  return !!d && ORIENT_DISCLOSURE_KEYS.some((k) => d[k] !== undefined);
}

/**
 * Record one session's disclosure markers.
 *
 * Change-detected on purpose, and for the same reason `persistControlAnchor`
 * detects its own: this runs on essentially EVERY orient, and an unchanged
 * recording pushed to the UI would refresh every open Orders panel on every
 * agent's every wake — a timer dressed as a change. The `IS DISTINCT FROM`
 * comparison is jsonb structural equality, so re-emitting the same markers is a
 * true no-op down to the `_at` stamp.
 *
 * Never throws into its caller: a disclosure recording that fails must degrade
 * to "no recording" (which renders as nothing), never take down the orient it
 * rode in on.
 */
export async function recordOrientDisclosures(
  ownerId: string,
  workspaceId: string,
  disclosures: OrientDisclosures,
): Promise<'written' | 'unchanged' | 'failed'> {
  try {
    const json = JSON.stringify(disclosures ?? {});
    const rows = await getOrgPg().sql<Array<{ moved: boolean }>>`
      INSERT INTO harness_shared.session_briefs
        (owner_id, workspace_id, last_orient_disclosures, last_orient_disclosures_at)
      VALUES (${ownerId}, ${workspaceId}, ${json}::text::jsonb, now())
      ON CONFLICT (owner_id) DO UPDATE SET
        last_orient_disclosures_at = CASE
          WHEN harness_shared.session_briefs.last_orient_disclosures
                 IS DISTINCT FROM EXCLUDED.last_orient_disclosures
            THEN now()
          ELSE harness_shared.session_briefs.last_orient_disclosures_at
        END,
        last_orient_disclosures = EXCLUDED.last_orient_disclosures
      RETURNING (last_orient_disclosures_at = now()) AS moved
    `;
    // RETURNING sees the row AFTER the write, and `now()` is transaction-start
    // time (stable across both mentions in this one statement) — so `moved` is
    // true exactly on the branch that just stamped it, and false when the CASE
    // kept a stamp from an earlier transaction. Comparing the jsonb ourselves
    // would need a second read; this needs none.
    const moved = rows[0]?.moved === true;
    if (moved) await notifyAgentOrdersChanged(ownerId);
    return moved ? 'written' : 'unchanged';
  } catch (err) {
    console.warn(`[agent-orient-disclosures] record(${ownerId}) failed:`, err);
    return 'failed';
  }
}

/**
 * Read one session's recorded markers back.
 *
 * `null` means NO RECORDING — this session has not oriented since the column
 * existed, or the read failed. It does NOT mean "nothing was withheld", and a
 * consumer that renders it as an empty disclosure line has re-introduced the
 * exact defect this module exists to close.
 */
export async function readOrientDisclosures(
  ownerId: string,
): Promise<RecordedOrientDisclosures | null> {
  try {
    const rows = await getOrgPg().sql<Array<{
      last_orient_disclosures: OrientDisclosures | null;
      last_orient_disclosures_at: Date | string | null;
    }>>`
      SELECT last_orient_disclosures, last_orient_disclosures_at
        FROM harness_shared.session_briefs
       WHERE owner_id = ${ownerId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.last_orient_disclosures == null || row.last_orient_disclosures_at == null) {
      return null;
    }
    const at = row.last_orient_disclosures_at;
    const ms = at instanceof Date ? at.getTime() : Date.parse(String(at));
    return {
      disclosures: row.last_orient_disclosures,
      // Normalised to real ISO-8601: this module's PG reads hand back
      // timestamptz in the postgres wire format, and a consumer that compares
      // these strings would sort them against genuine ISO ones incorrectly.
      at: Number.isNaN(ms) ? String(at) : new Date(ms).toISOString(),
    };
  } catch (err) {
    console.warn(`[agent-orient-disclosures] read(${ownerId}) failed:`, err);
    return null;
  }
}
