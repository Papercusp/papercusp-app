/**
 * EI-23701433507513915 — one canonical answer to "which owner holds this work-item?".
 *
 * Agents address each other by SHORT handles: the 5-char coord glyph handle (`851c1`),
 * the 8-hex label (`su-851c1a7a`). When one of those reached an assignment verb it was
 * persisted verbatim as `taken_by`, and every later EXACT-equality holder check then
 * refused the real holder:
 *   - work_items:complete — "currently assigned to 'su-851c1a7a', not you ('su-851c1a7a-…')";
 *   - work_items:claim — claimIssue's CAS matches `taken_by` exactly, so the holder's own
 *     re-claim fell through to the force path;
 *   - the force guard — presence/fleet lookups keyed on the short string found nothing
 *     (`presenceFound:false`), so even the holder's own FLEET LEADER was refused
 *     `force_unauthorized`, leaving `work_items:set_state` as the only exit.
 * Measured 2026-09-30: seven items carried short-form owners in `worked_by_history`
 * between 2026-09-05 and 2026-09-30 (5- and 8-hex prefixes), each followed by a manual
 * full-id workaround.
 *
 * One resolver, two halves:
 *   - WRITE (`canonicalizeAssigneeOwnerId`): expand a truncated `su-` id to the UNIQUE full
 *     ownerId it prefixes, or refuse — a prefix is never persisted as a holder.
 *   - READ  (`resolveHolderOwnerId`): apply the same expansion to an already-stored holder
 *     before an identity comparison or a presence/fleet lookup. An unresolvable holder is
 *     returned UNCHANGED, so a read can never widen authority beyond what the stored
 *     string already names (no bare-prefix matching: a 5-char prefix is not an identity).
 */

/** A complete su owner id: `su-` + a lowercase v4-shaped uuid. */
export const FULL_SU_OWNER_ID_RE = /^su-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Shape of the body after `su-`: `h` = one lowercase hex char, `-` = a literal hyphen. */
const FULL_BODY_TEMPLATE = 'hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh';

/**
 * The shortest body treated as an owner prefix. The coord glyph handle is 5 chars
 * (`851c1`), which agents copy into `su-851c1`; anything shorter is not an owner handle.
 */
export const MIN_OWNER_PREFIX_BODY = 4;

/**
 * True when `value` is a STRICT prefix of a full su owner id's shape — `su-` plus at least
 * MIN_OWNER_PREFIX_BODY chars that fit the uuid template position by position. A full id,
 * a non-`su-` identity (`human`, `s-…`, a role), and malformed text are all false, so the
 * caller passes them through untouched.
 */
export function isTruncatedSuOwnerId(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v.startsWith('su-')) return false;
  const body = v.slice(3);
  if (body.length < MIN_OWNER_PREFIX_BODY || body.length >= FULL_BODY_TEMPLATE.length) return false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (FULL_BODY_TEMPLATE[i] === '-' ? ch !== '-' : !/[0-9a-f]/.test(ch)) return false;
  }
  return true;
}

/** Owner ids whose full form starts with `prefix`, scoped to `workspaceId` when known. */
export type OwnerIdPrefixLookup = (input: {
  workspaceId: string | null;
  prefix: string;
  limit: number;
}) => Promise<string[]>;

export type AssigneeCanonicalization =
  | { ok: true; ownerId: string; expandedFrom: string | null }
  | {
      ok: false;
      code: 'assignee_short_form_unresolved' | 'assignee_short_form_ambiguous';
      input: string;
      candidates: string[];
      message: string;
    };

/**
 * The registry of live owner ids is coord presence. A holder resolvable only from an
 * ended, reaped session stays unresolved — the write refuses and the read is unchanged,
 * which is exactly today's behaviour for that case, never a wider one.
 */
export const defaultOwnerIdPrefixLookup: OwnerIdPrefixLookup = async ({ workspaceId, prefix, limit }) => {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // `prefix` passed isTruncatedSuOwnerId, so it is [su-0-9a-f-] only: no LIKE metacharacters.
  const rows = await sql<{ owner_id: string }[]>`
    SELECT DISTINCT owner_id
      FROM harness_shared.coord_presence
     WHERE owner_id LIKE ${`${prefix}%`}
       AND (${workspaceId}::text IS NULL OR workspace_id = ${workspaceId})
     LIMIT ${limit}
  `;
  return rows.map((r) => r.owner_id);
};

/**
 * WRITE half. Pass-through for anything that is not a truncated su id; otherwise expand to
 * the single full owner id it prefixes, or refuse with a message the assigner can act on.
 */
export async function canonicalizeAssigneeOwnerId(
  raw: string,
  opts: { workspaceId?: string | null; lookup?: OwnerIdPrefixLookup } = {},
): Promise<AssigneeCanonicalization> {
  const input = raw.trim();
  if (!isTruncatedSuOwnerId(input)) return { ok: true, ownerId: input, expandedFrom: null };

  let found: string[];
  try {
    found = await (opts.lookup ?? defaultOwnerIdPrefixLookup)({
      // '*' is the unscoped-superuser sentinel, not a workspace. Passed through verbatim it
      // matched no presence row, so every short-form id from an unscoped caller read as unknown.
      workspaceId: opts.workspaceId && opts.workspaceId !== '*' ? opts.workspaceId : null,
      prefix: input,
      limit: 3,
    });
  } catch (err) {
    return {
      ok: false,
      code: 'assignee_short_form_unresolved',
      input,
      candidates: [],
      message:
        `'${input}' is a short-form owner id and the owner lookup failed ` +
        `(${err instanceof Error ? err.message : String(err)}). Pass the FULL ownerId (su-<uuid>).`,
    };
  }
  const candidates = [...new Set(found.filter((id) => FULL_SU_OWNER_ID_RE.test(id) && id.startsWith(input)))];
  if (candidates.length === 1) return { ok: true, ownerId: candidates[0], expandedFrom: input };
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'assignee_short_form_unresolved',
      input,
      candidates,
      message:
        `'${input}' is a short-form owner id that matches no live agent. A prefix is never stored as ` +
        `a holder (EI-23701433507513915): pass the FULL ownerId (su-<uuid>, e.g. from coord:presence).`,
    };
  }
  return {
    ok: false,
    code: 'assignee_short_form_ambiguous',
    input,
    candidates,
    message:
      `'${input}' is a short-form owner id that matches more than one live agent ` +
      `(${candidates.join(', ')}). Pass the FULL ownerId of the one you mean.`,
  };
}

/**
 * READ half. The canonical owner id for an already-stored holder: the unique full id when
 * `stored` is a resolvable truncated su id, otherwise `stored` (trimmed) unchanged. Never
 * throws — a lookup failure degrades to the stored value, i.e. today's exact comparison.
 */
export async function resolveHolderOwnerId(
  stored: string,
  opts: { workspaceId?: string | null; lookup?: OwnerIdPrefixLookup } = {},
): Promise<string> {
  const canonical = await canonicalizeAssigneeOwnerId(stored, opts);
  return canonical.ok ? canonical.ownerId : stored.trim();
}

/**
 * True when the stored holder IS the caller: an exact match, or a truncated holder that
 * resolves uniquely to the caller's full id. The one comparison every holder check shares.
 */
export async function holderIsCaller(
  stored: string | null | undefined,
  callerOwnerId: string,
  opts: { workspaceId?: string | null; lookup?: OwnerIdPrefixLookup } = {},
): Promise<boolean> {
  if (!stored) return false;
  const s = stored.trim();
  if (s === callerOwnerId) return true;
  if (!isTruncatedSuOwnerId(s) || !callerOwnerId.startsWith(s)) return false;
  return (await resolveHolderOwnerId(s, opts)) === callerOwnerId;
}
