/**
 * Orphaned-remote-author terminal closes (EI-21919769900781478).
 *
 * A LEAF module for the same reason as `work-items-harness-scope`: its callers are
 * the write verbs (`work_items:complete`, `work_items:set_state`), and those mock
 * `./work-items` wholesale in their unit tests — a `vi.mock` factory there replaces
 * every export, so a guard living in that module silently becomes `undefined` at
 * exactly the call site that most needs it. Keeping this standalone means the guard
 * is real in tests too, not just in production. `work-items.ts` re-exports it so it
 * stays discoverable next to `selfHealAuthorOriginIfStranded`.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * Both terminal-write paths refuse a remote-authored issue-family row with the same
 * rule, and the rule had no escape hatch for the case where the named authority no
 * longer exists:
 *
 *   "work_item '<id>' is remote-authored and cannot be completed locally; its
 *    authoring peer must claim/resolve it, and this node will receive the terminal
 *    state through federation."
 *
 * Both refusals are correct as designed, and both name the remedy: the authoring
 * peer must act. The bug is that the authoring peer can be permanently GONE, and
 * nothing detected that — so the row could never reach a terminal state, and kept
 * being served as claimable work forever.
 */
import { getOrgPg } from '@papercusp/db-org';

export type OrphanAuthorCloseReason =
  | 'not-remote'
  | 'not-terminal'
  | 'no-recorded-author'
  | 'author-not-ended'
  | 'orphaned-author';

/**
 * The POLICY, as a pure function so it is unit-testable without a database.
 *
 * Deliberately NARROW — every condition must hold, and each failure has its own
 * `reason` so a refusal can say which door closed:
 *  - the row is actually remote-origin;
 *  - the transition is a TERMINAL close (this is never a general remote-mutation bypass);
 *  - the row records an author at all (no recorded author ⇒ not provably orphaned);
 *  - that author's session is provably ENDED.
 *
 * FAIL-CLOSED BY CONSTRUCTION: the liveness lookup this pairs with
 * (`lookupEndedSessions`) is fail-soft and returns an empty Map on ANY error, which
 * arrives here as "not provably ended" and leaves the original refusal intact. A live
 * author, an unknown author, and a total lookup outage are indistinguishable to this
 * function ON PURPOSE — only a positively observed `ended_at` opens the hatch.
 */
export function decideOrphanAuthorClose(input: {
  origin: string | null | undefined;
  isCompletingTransition: boolean;
  author: string | null | undefined;
  authorSessionEndedAt: string | null | undefined;
}): { permit: boolean; reason: OrphanAuthorCloseReason } {
  if (input.origin !== 'remote') return { permit: false, reason: 'not-remote' };
  if (!input.isCompletingTransition) return { permit: false, reason: 'not-terminal' };
  if (!input.author) return { permit: false, reason: 'no-recorded-author' };
  if (!input.authorSessionEndedAt) return { permit: false, reason: 'author-not-ended' };
  return { permit: true, reason: 'orphaned-author' };
}

export type EndedSessionLookupFn = (
  ids: readonly string[],
  workspaceId?: string | null,
) => Promise<Map<string, string | null>>;

async function resolveEndedLookup(injected?: EndedSessionLookupFn): Promise<EndedSessionLookupFn> {
  if (injected) return injected;
  const mod = await import('./agent-tools/coordination/dead-session-recipient-guidance');
  return mod.lookupEndedSessions;
}

/**
 * Read-only probe: has this recorded author's session provably ENDED? Returns the
 * `ended_at` stamp, or null for "not provably ended" (live, unknown, or the lookup
 * itself failed). Used by the fast-fail guard in `work_items:complete`, which must
 * not refuse a row that the real write path would legitimately heal.
 */
export async function lookupRemoteAuthorEndedAt(
  author: string | null | undefined,
  workspaceId?: string | null,
  lookupEnded?: EndedSessionLookupFn,
): Promise<string | null> {
  if (!author) return null;
  try {
    const lookup = await resolveEndedLookup(lookupEnded);
    const ended = await lookup([author], workspaceId ?? null);
    return ended.has(author) ? (ended.get(author) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * The WRITE half. Mirrors `selfHealAuthorOriginIfStranded`'s shape for the same
 * structural reason documented there: an app-level bypass ALONE is not enough,
 * because `setIssueState` writes through the `engineer_issues` VIEW whose INSTEAD OF
 * UPDATE trigger (migration 655, `harness_shared.engineer_issues_view_dml()`)
 * unconditionally no-ops any write while the BASE TABLE still reads `origin='remote'`
 * — skipping only the app-level guard would swap an honest refusal for a confusing
 * "not found" (the trigger returns 0 rows). So the base-table origin is healed FIRST,
 * in the same statement that stamps the audit marker.
 *
 * The UPDATE is scoped tight: it can only ever touch a row whose OWN recorded author
 * is the very id just proved ended — never a row genuinely owned by a live peer.
 */
export async function healOrphanedRemoteOriginIfAuthorEnded(
  id: string,
  opts: {
    isCompletingTransition: boolean;
    by?: string | null;
    workspaceId?: string | null;
    lookupEnded?: EndedSessionLookupFn;
  },
): Promise<{
  healed: boolean;
  author: string | null;
  authorSessionEndedAt: string | null;
  reason: OrphanAuthorCloseReason;
}> {
  const miss = (
    reason: OrphanAuthorCloseReason,
    author: string | null = null,
    endedAt: string | null = null,
  ) => ({ healed: false, author, authorSessionEndedAt: endedAt, reason });
  if (!id) return miss('not-remote');
  if (!opts.isCompletingTransition) return miss('not-terminal');
  const { sql } = getOrgPg();
  const rows = await sql<{ created_by: string | null }[]>`
    SELECT payload #>> '{_ei,created_by}' AS created_by
      FROM harness_shared.work_items
     WHERE feature_id = ${id}
       AND origin = 'remote'`;
  if (rows.length === 0) return miss('not-remote');
  const author = rows[0]?.created_by ?? null;
  if (!author) return miss('no-recorded-author');
  const endedAt = await lookupRemoteAuthorEndedAt(author, opts.workspaceId ?? null, opts.lookupEnded);
  const decision = decideOrphanAuthorClose({
    origin: 'remote',
    isCompletingTransition: opts.isCompletingTransition,
    author,
    authorSessionEndedAt: endedAt,
  });
  if (!decision.permit) return miss(decision.reason, author, endedAt);
  const healed = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET origin = 'local',
           payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
             '_orphanAuthorClose',
             jsonb_build_object(
               'author', ${author}::text,
               'authorSessionEndedAt', ${endedAt}::text,
               'healedBy', ${opts.by ?? null}::text,
               'healedAt', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             )
           )
     WHERE feature_id = ${id}
       AND origin = 'remote'
       AND payload #>> '{_ei,created_by}' = ${author}
    RETURNING feature_id`;
  if (healed.length === 0) return miss('not-remote', author, endedAt);
  return { healed: true, author, authorSessionEndedAt: endedAt, reason: 'orphaned-author' };
}
