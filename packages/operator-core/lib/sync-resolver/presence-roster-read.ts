/**
 * presence-roster-read.ts — the @-assign picker roster, BOUNDED and GUARDABLE
 * (WI-39825, the last of the store-read fan-outs in `sync-resolver/index.ts`).
 *
 * ## Why this is its own module and not still inline in the resolver
 *
 * The same reason as {@link ../sync-resolver/adv-roster-read}: a resolver's only
 * input is its wire `argsSchema`, so a deadline left inline can only be proven
 * to fire by genuinely waiting the budget out — 6s per case, past vitest's 5s
 * default. Moving the compute here makes `budgetMs` a FUNCTION parameter, never
 * a wire field, so a guard shrinks the budget to milliseconds while the shipped
 * client contract is untouched. Extraction is owed HERE (and not at every read
 * site) because this fan-out has a per-leg DEGRADATION POLICY: one leg is the
 * answer and the other is a supplement, so they cannot share a fate.
 *
 * ## What the bound actually fixes
 *
 * Two store legs fan out under one `Promise.all`, and `Promise.all` waits for
 * the slowest. Before this bound a wedged `listWorkspaceMembers` — a different
 * store from presence, on a different failure schedule — took the whole picker
 * past the sync layer's `RESOLVER_READ_TIMEOUT_MS`, so AssignDialog rendered
 * nothing and the user could not assign to ANYONE, including the live sessions
 * whose read had already returned.
 *
 * The legs are not equal:
 *
 *   - `presence` IS the picker. Every online row comes from it, and an empty
 *     online list reads as "nobody is running", which is the single most
 *     misleading thing this dialog can say. A lapse PROPAGATES, exactly as a
 *     throw from that reader already does; the gain is a fast, LABELLED failure
 *     at the budget instead of a hang the resolver timeout converts into
 *     nothing at all.
 *   - `members` supplies the OFFLINE half. The dialog is fully usable without
 *     it — you can still assign to anyone who is live — so its lapse costs its
 *     own section and nothing else.
 *
 * ## Why the members leg is NAMED rather than swallowed
 *
 * The in-place version was `listWorkspaceMembers(wsId).catch(() => [])`. That
 * kept the picker shipping — the important half — but made a wedged or broken
 * membership store INVISIBLE: an empty offline list is byte-identical to "this
 * workspace has no offline members", so a user who cannot find a teammate is
 * told, calmly and falsely, that the teammate is not there. That is the exact
 * `empty`-vs-`unavailable` collapse `degraded-snapshot` exists to prevent. The
 * casualty is now recorded as a shared {@link DegradedField}, and the array is
 * OMITTED entirely when both legs succeed — a healthy read is byte-identical to
 * what it was before, so the field's PRESENCE is the signal.
 *
 * On the kind: a lapse classifies as `read-failed`, not a new `timed-out`
 * member. `UnavailableKind` is a shared union consumed by client guards, and
 * widening it to say what the verbatim reason (`<label> exceeded the read
 * budget`) already says would strand those consumers for no information gain.
 *
 * ## The one thing this cannot report
 *
 * The resolver's wire shape is the flat-row sync contract, so degradation
 * travels on `row[0]._meta` (`attachListMeta`). When presence legitimately
 * returns ZERO live rows AND the members leg degraded, there is no row to carry
 * the meta on and the degradation is visible only in the server log. That case
 * is not reachable in practice — the session doing the reading is itself
 * present — and the alternative (a synthetic row) would put a fake member in a
 * picker whose whole job is naming real ones. Documented rather than papered
 * over; `readAssignableMembers` itself always returns the honest
 * `degradedFields`, so a future non-flat consumer loses nothing.
 */

import { classifyReadFailure, type DegradedField } from './degraded-snapshot';
import { createReadDeadline } from './read-deadline';

/**
 * The whole fan-out's budget, shared by both legs (see `createReadDeadline`:
 * one deadline for the fan-out, not a per-call budget). 6s — the budget every
 * bounded read in this directory carries, sized to fire under the sync layer's
 * ~10s `RESOLVER_READ_TIMEOUT_MS` while sitting well above real :3170 latency
 * (p90 599ms). Both halves of that ordering matter: a budget at or above the
 * resolver ceiling cannot prevent the failure it exists to prevent, and one
 * below normal latency turns a healthy read into an outage.
 */
export const PRESENCE_ROSTER_READ_BUDGET_MS = 6_000;

/** One @-assign picker row — online (from presence) or offline (from members). */
export interface AssignableMemberRow {
  /** What AssignDialog passes to `coord:send`'s `to`. */
  assignAddress: string;
  key: string;
  label: string;
  present: boolean;
  intent: string | null;
  userId: string | null;
  githubUsername: string | null;
}

export interface ReadAssignableMembersOptions {
  /**
   * Explicit workspace, as passed on the wire. `undefined` keeps the resolver's
   * pre-existing asymmetry EXACTLY: presence is read cross-workspace (`null`)
   * while membership is read for the ACTIVE workspace.
   */
  workspace?: string;
  /**
   * Deadline for the whole fan-out. A FUNCTION parameter, never a wire field —
   * it exists so a guard can prove the deadline fires without waiting
   * {@link PRESENCE_ROSTER_READ_BUDGET_MS} out.
   */
  budgetMs?: number;
}

export interface AssignableMembersSnapshot {
  rows: AssignableMemberRow[];
  /**
   * Present ONLY when a supplementary leg lapsed or failed. Absent (not empty)
   * on a healthy read, so its presence is the signal.
   */
  degradedFields?: DegradedField[];
}

interface PresenceRecord {
  ownerId: string;
  ownerLabel: string | null;
  intent: string | null;
  userId: string | null;
  stale?: boolean;
}

interface MemberRecord {
  githubUserId: string | number;
  githubUsername: string;
  displayName?: string | null;
}

/**
 * Read the @-assign picker roster: the LIVE coordination sessions (addressed by
 * ownerId — deliver-and-wake now) UNIONed with the workspace's admitted hive
 * members who are NOT currently present (addressed by `@user:gh:<id>`, which
 * PARKS in slot_parked_messages until that member returns).
 *
 * Rejects only when `presence` — the leg the dialog cannot be honest without —
 * fails or lapses. A membership failure returns the online half TRUE and names
 * the casualty in `degradedFields`.
 */
export async function readAssignableMembers(
  opts: ReadAssignableMembersOptions = {},
): Promise<AssignableMembersSnapshot> {
  const { workspace, budgetMs = PRESENCE_ROSTER_READ_BUDGET_MS } = opts;
  const [{ listPresence }, { listWorkspaceMembers }, { activeWorkspaceId }] = await Promise.all([
    import('../agent-tools/coordination/presence'),
    import('../hive-membership-store'),
    import('../workspace-registry'),
  ]);
  const wsId = workspace ?? activeWorkspaceId();

  const degradedFields: DegradedField[] = [];
  /** Note the supplementary leg's failure instead of swallowing it into `[]`. */
  const noteDegraded = (field: string, err: unknown): never[] => {
    const { kind, reason } = classifyReadFailure(err);
    console.warn(`[dev.assignableMembers] ${field} read failed:`, reason);
    degradedFields.push({ field, kind, reason });
    return [];
  };

  const withinBudget = createReadDeadline(budgetMs);
  const [presence, members] = await Promise.all([
    // PRIMARY: a lapse propagates, as a throw from this reader does today.
    withinBudget(
      listPresence({ workspaceId: workspace ?? null }) as Promise<PresenceRecord[]>,
      'assignable presence',
    ),
    withinBudget(
      listWorkspaceMembers(wsId) as Promise<MemberRecord[]>,
      'assignable members',
    ).catch((err) => noteDegraded('members', err)),
  ]);

  const live = presence.filter((p) => !p.stale);
  // Which github members are already represented by a live session? Today
  // presence carries no github id, so this matches only when a session's userId
  // is already a `gh:<id>` form (nothing on a gh-unauth box) — forward-compatible.
  const liveKeys = new Set<string>();
  for (const p of live) {
    if (p.userId) liveKeys.add(p.userId);
    liveKeys.add(p.ownerId);
  }
  const onlineRows: AssignableMemberRow[] = live.map((p) => ({
    assignAddress: p.ownerId,
    key: p.ownerId,
    label: p.ownerLabel ?? p.ownerId,
    present: true,
    intent: p.intent ?? null,
    userId: p.userId ?? null,
    githubUsername: null,
  }));
  const offlineRows: AssignableMemberRow[] = (members as MemberRecord[])
    .filter((m) => !liveKeys.has(`gh:${m.githubUserId}`) && !liveKeys.has(String(m.githubUserId)))
    .map((m) => ({
      assignAddress: `@user:gh:${m.githubUserId}`,
      key: `gh:${m.githubUserId}`,
      label: m.displayName ?? m.githubUsername,
      present: false,
      intent: null,
      userId: null,
      githubUsername: m.githubUsername,
    }));

  return {
    rows: [...onlineRows, ...offlineRows],
    ...(degradedFields.length > 0 ? { degradedFields } : {}),
  };
}
