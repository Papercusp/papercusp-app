/**
 * DID THE "FAILED" MEMBERS ACTUALLY DO WORK? — the cross-check that stops a launch-probe false negative
 * from being reported as an empty fleet.
 *
 * THE FAILURE THIS EXISTS TO PREVENT (measured 2026-08-16/18). Fleet membership is decided by a ~25s
 * post-spawn verification probe. Two members were slow to register, were stamped
 * `AGENT DID NOT START — no session registered within 25s`, and were recorded in
 * `launchTransaction.failed` with `verifiedMemberIds: []`. They then ran for 15 and 19 hours and closed
 * 15 work-items between them, every one evidenced. For that entire time `fleet:status` reported a fleet
 * with no members, and when they died nothing noticed, because nothing was watching members the registry
 * did not believe existed.
 *
 * `verifiedMemberIds` is BOOKKEEPING — what a 25-second probe recorded at launch. It is not, and was never,
 * an observation of who is working. The two come apart exactly in the case that matters: a member slow
 * enough to miss its probe is also the member most likely to be misreported for hours.
 *
 * THE CHEAP FALSIFIER. A registry claiming a member never started can be contradicted by one query: did
 * that ownerId ever claim or close a work-item? Only the registry surface holds both halves — the launch
 * record and the work ledger — so it must run the check itself. An agent asked to remember to cross-check
 * by hand will forget, which is precisely what happened.
 *
 * This mirrors what `work_items:burn_down` already does correctly: attribute from the durable ledger
 * rather than the live roster, so members that have since died still count.
 */

/** Evidence that one supposedly-failed ownerId did real work. */
export interface LaunchFalseNegative {
  ownerId: string;
  /** Work-items this owner drove to a terminal state. */
  closes: number;
  /** Work-items currently or previously claimed by this owner. */
  claims: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface LaunchVerificationCrossCheck {
  /** Owner ids the launch transaction recorded as failed that DID do work. Empty array = checked, none
   *  found. `null` = the check could not run — never conflate the two. */
  launchVerificationFalseNegative: LaunchFalseNegative[] | null;
  /** Human-readable verdict, present only when the check found something or could not run. */
  note?: string;
}

/** One owner's activity, as read from the work ledger. */
export interface OwnerWorkActivity {
  ownerId: string;
  closes: number;
  claims: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/**
 * Compare the launch transaction's `failed` list against real work activity.
 *
 * `readActivity` is injected so this is unit-testable without a database, and so a slow or failing query
 * degrades to `null` (unknown) rather than to a confident empty list.
 */
export async function crossCheckLaunchVerification(
  failedOwnerIds: readonly string[],
  readActivity: (ownerIds: readonly string[]) => Promise<OwnerWorkActivity[]>,
): Promise<LaunchVerificationCrossCheck> {
  const ids = [...new Set(failedOwnerIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return { launchVerificationFalseNegative: [] };

  let rows: OwnerWorkActivity[];
  try {
    rows = await readActivity(ids);
  } catch (e) {
    return {
      launchVerificationFalseNegative: null,
      note:
        `could not cross-check ${ids.length} launch-failed member(s) against the work ledger ` +
        `(${e instanceof Error ? e.message : String(e)}). Their "failed" status is UNVERIFIED — a 25s ` +
        'launch probe has false-negatived members that then worked for hours.',
    };
  }

  const hits = rows
    .filter((r) => r.closes > 0 || r.claims > 0)
    .map<LaunchFalseNegative>((r) => ({
      ownerId: r.ownerId,
      closes: r.closes,
      claims: r.claims,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    }))
    .sort((a, b) => b.closes - a.closes || b.claims - a.claims);

  if (hits.length === 0) return { launchVerificationFalseNegative: [] };

  const totalCloses = hits.reduce((n, h) => n + h.closes, 0);
  return {
    launchVerificationFalseNegative: hits,
    note:
      `⚠ LAUNCH VERIFICATION FALSE NEGATIVE: ${hits.length} member(s) recorded as failed have work-ledger ` +
      `activity (${totalCloses} close(s)). The ~25s launch probe did not see them register, but they ran. ` +
      'Do NOT report this fleet as having no members, and do NOT re-launch these ids as if they never ' +
      'started — check whether they are still alive first.',
  };
}

/**
 * The default ledger read. Kept beside the checker so the SQL and the semantics travel together.
 *
 * ⚠ Matches on a PREFIX (`LIKE '<id>%'`) deliberately: owner ids are routinely displayed truncated, and an
 * equality predicate against a truncated id returns zero rows — an instrument failure that is visually
 * identical to "this member really did nothing", which is the exact wrong answer here.
 */
export function buildOwnerActivityReader(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>,
  workspaceId: string,
): (ownerIds: readonly string[]) => Promise<OwnerWorkActivity[]> {
  return async (ownerIds) => {
    const rows = await sql`
      SELECT
        o.owner_id                                                        AS owner_id,
        count(*) FILTER (WHERE w.terminal_owner LIKE o.owner_id || '%')   AS closes,
        count(*) FILTER (WHERE w.taken_by       LIKE o.owner_id || '%')   AS claims,
        min(COALESCE(w.taken_at, to_timestamp(w.closed_ts / 1000)))       AS first_seen_at,
        max(COALESCE(to_timestamp(w.closed_ts / 1000), w.taken_at))       AS last_seen_at
      FROM unnest(${ownerIds as unknown as string[]}::text[]) AS o(owner_id)
      LEFT JOIN harness_shared.work_items w
        ON w.workspace_id = ${workspaceId}
       AND (w.terminal_owner LIKE o.owner_id || '%' OR w.taken_by LIKE o.owner_id || '%')
      GROUP BY o.owner_id
    `;
    return rows.map((r) => ({
      ownerId: String(r.owner_id),
      closes: Number(r.closes ?? 0),
      claims: Number(r.claims ?? 0),
      firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at as string | number | Date).toISOString() : null,
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at as string | number | Date).toISOString() : null,
    }));
  };
}
