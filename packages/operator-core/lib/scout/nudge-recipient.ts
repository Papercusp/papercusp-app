/**
 * nudge-recipient — WHO receives a Scout-rail nudge once the Mug may not exist.
 *
 * Plan: retire-mug-kettle-su-only-2026-08-09 (P-034), closing LOSS GAP 1 + 2 from D-005.
 *
 * ## The gap this closes
 *
 * Three Scout watchdogs exist ONLY to wake the Mug, and the Mug is their designated
 * consumer — not an implementation detail:
 *   - `draft-review-watchdog`    — scout-routed drafts "sit unreviewed for days, neither
 *                                  ratified nor deprecated" unless the Queen reviews them.
 *   - `ungraded-filings-watchdog` — its own header: "nothing MAKES grading happen: the Mug
 *                                  only grades when triage happens to look".
 *   - `ready-plan-autostart`      — consumes plans the Queen ratified to 'ready'.
 *
 * `wakeMug` delivers through two halves: a best-effort direct wake of the resolved Mug
 * owner, plus a durable park to `MUG_COORD_SLOT` ('@role:mug') that the NEXT Mug wake
 * drains. Both halves terminate at the Mug. So with no live Mug — today when one simply
 * is not running, and permanently after the retirement — a nudge parks in a slot nobody
 * drains. Scout keeps producing into a queue with no consumer and NOTHING REPORTS IT.
 * That silent dead-end is the failure mode this module removes.
 *
 * ## Why this is not a change to `wakeMug`
 *
 * `wakeMug` has six call sites and they are two different populations:
 *   - THREE inside `pot/placement-watchdog` itself — genuine Mug placement nudges. They
 *     belong to the retiring tier and SHOULD die with it. Routing those to an su would
 *     hand the su the Mug's placement duties, which is exactly what the retirement is
 *     getting rid of.
 *   - THREE in the Scout watchdogs above — the output rail that must SURVIVE.
 * So the recipient strategy is applied at the Scout call sites, and `wakeMug` stays the
 * Mug-directed primitive (and is still used verbatim when the Mug IS the resolved
 * recipient). Retiring the tier then removes one branch of the ladder rather than
 * stranding a rail.
 *
 * ## The ladder
 *
 *   1. A live/parked **Mug** — unchanged behaviour while the tier is running.
 *   2. Else a live **su** session in the workspace — the replacement reviewer/grader.
 *   3. Else **escalate to the owner** — never a silent drop.
 *
 * Liveness comes from `resolveSessionStates`, THE shared oracle, never from a raw
 * heartbeat: `heartbeatFresh` means the keepalive is ticking, NOT that the session is
 * taking turns, and a warm-dead session reads fresh + `ended`. Picking a recipient off a
 * heartbeat would reintroduce the same silent dead-end one layer down.
 */

import { goalIdFromModes, type ModeLike } from '../modes/goal-session';
import type { PresenceRecord } from '../agent-tools/coordination/presence';
import type { listPresence } from '../agent-tools/coordination/presence';
import type { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';

/**
 * ⚠ EVERY runtime dependency here is imported LAZILY, inside the functions — the same
 * shape `wakeMug` uses one file over for `messages` / `workspace-als`, and for the same
 * reason. The Scout watchdog tests mock `@papercusp/db-org` with ONLY `getOrgPg`, and
 * vitest throws on access to ANY missing mock member. A STATIC import of the presence /
 * liveness modules pulls the real `su-lock-store` (which calls
 * `setAdminPoolStatementTimeoutProvider` at module scope) into their graph, and all three
 * suites then fail to COLLECT — a failure that looks nothing like the change that caused
 * it. Type-only imports above are erased at compile time and are safe.
 *
 * Keep new dependencies dynamic unless you have re-run those suites.
 */
const loadPresence = () => import('../agent-tools/coordination/presence');
const loadLiveness = () => import('../agent-tools/coordination/liveness-oracle');
const loadPlacementWatchdog = () => import('../pot/placement-watchdog');

/** Session states that can actually receive and act on a nudge. */
const DELIVERABLE_STATES = new Set(['live', 'parked']);

/** su session owner ids are minted with this prefix (e.g. `su-bdf16205-…`). */
const SU_OWNER_PREFIX = 'su-';

/**
 * `escalate` and `unresolved` are DELIBERATELY distinct, and collapsing them would
 * recreate the bug this module exists to fix, one level up:
 *   - `escalate`   — we KNOW nobody can act (presence read fine, nobody live). Tell the
 *                    owner; this is a real "your Scout rail has no consumer" signal.
 *   - `unresolved` — we could not TELL (presence/liveness unreadable). Absence of
 *                    evidence, not evidence of absence. Escalating on it would page the
 *                    owner every time a dependency hiccups and train them to ignore it.
 *                    The legacy durable park still ran, so degrade quietly to that.
 */
export type NudgeRecipient =
  | { kind: 'mug'; ownerId: string; why: string }
  | {
      kind: 'su';
      ownerId: string;
      ownerLabel: string;
      why: string;
      /** The P-007 steward tier the chosen su was ranked in (see `stewardTier`). Carried
       *  on the verdict so a caller can decide whether this recipient is one whose JOB is
       *  the nudge (tier 0/1) or merely the most recently active peer (tier 2) — the
       *  distinction `deliverScoutNudge`'s `wakeSu: 'grading-posture'` policy keys on. */
      tier: StewardTier;
    }
  | { kind: 'escalate'; why: string }
  | { kind: 'unresolved'; why: string };

/** P-007 rung-2 preference tiers: 0 = the Blender steward, 1 = any GRADE-mode su,
 *  2 = the most-recently-active fallback. */
export type StewardTier = 0 | 1 | 2;

export interface ResolveNudgeRecipientOpts {
  workspaceId: string;
  /** The currently-resolved Mug coord owner, if the caller already looked it up. */
  mugOwner: string | null;
  /** DI seams for unit tests. */
  listPresenceFn?: typeof listPresence;
  resolveSessionStatesFn?: typeof resolveSessionStates;
  /** P-007 seam: read the registered modes for a set of su owner ids. Defaults to
   *  the `harness_shared.agent_modes` read below; injected in unit tests so rung 2's
   *  ordering is assertable with no PG. */
  readAgentModesFn?: (
    workspaceId: string,
    ownerIds: readonly string[],
  ) => Promise<Map<string, ModeLike[]>>;
  /** P-007 seam: the ACTIVE Blender-steward goal ids (see readBlenderGoalIds).
   *  Injected in unit tests so tier 0 is assertable with no PG. */
  readBlenderGoalIdsFn?: (workspaceId: string) => Promise<ReadonlySet<string>>;
  /** P-037 seam: is the Mug/Kettle tier still runnable? Defaults to the shared
   *  predicate in pot/started.ts (loaded dynamically so a partially-mocked
   *  './started' in a Scout test cannot strand this module at import time). */
  mugKettleSystemEnabledFn?: () => Promise<boolean>;
}

/**
 * P-007 (blender-su-grade-integration-2026-08-11, D-003): the modes a candidate su
 * carries, read from `harness_shared.agent_modes` — the SAME row `goalIdFromModes`
 * derives a goal session from, never a second notion of "who is the steward".
 *
 * Fail-soft to an EMPTY map on any error: an unreadable mode table must degrade rung 2
 * to its prior most-recently-active behaviour, never strand the nudge. That is the same
 * discipline `tierRunnable` applies one rung up — a watchdog whose job is to not go
 * quiet cannot die reading a preference signal.
 */
async function readAgentModes(
  workspaceId: string,
  ownerIds: readonly string[],
): Promise<Map<string, ModeLike[]>> {
  const out = new Map<string, ModeLike[]>();
  if (ownerIds.length === 0) return out;
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT owner_id, mode, subject
      FROM harness_shared.agent_modes
      WHERE workspace_id = ${workspaceId}
        AND owner_id = ANY(${ownerIds as string[]})
    `) as unknown as Array<{ owner_id: string; mode: string; subject: string | null }>;
    for (const r of rows) {
      const list = out.get(r.owner_id) ?? [];
      list.push({ mode: r.mode, subject: r.subject });
      out.set(r.owner_id, list);
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * The stable marker identifying a Blender-steward GOAL: the integration plan's own slug,
 * written into the goal body at creation. There is deliberately no metadata column to key
 * off (`goals:start` exposes no metadata argument, and `agent_modes.subject` is documented
 * as "generic and NOT a foreign key"), so the goal BODY is the marker surface both goals
 * created for this loop already carry.
 *
 * A SET, not a single id, because more than one Blender goal can legitimately exist at
 * once — one was filed at 23:04Z while a second `goals:propose` card was still open with
 * the owner. Ranking every holder of a marked goal as the steward is the correct reading
 * of "is this session running the Blender loop"; picking a winner between duplicate goals
 * is the owner's call, not this resolver's.
 *
 * EXPORTED for the goal-package bundle-integrity gate (WI-41126 / P-007): the bundled
 * work-on-everything goal package's body must carry this marker, and the gate imports
 * the code truth here instead of keeping a copyable literal that could drift.
 */
export const BLENDER_GOAL_BODY_MARKER = 'blender-su-grade-integration-2026-08-11';

/**
 * The ACTIVE Blender-steward goal ids. Fail-soft to an EMPTY set: with no resolvable goal,
 * tier 0 is simply unreachable and rung 2 degrades to the grade-mode preference — never to
 * a wrong promotion, and never to a thrown nudge.
 */
async function readBlenderGoalIds(workspaceId: string): Promise<Set<string>> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT id FROM harness_shared.goals
      WHERE workspace_id = ${workspaceId}
        AND status = 'active'
        AND body LIKE ${'%' + BLENDER_GOAL_BODY_MARKER + '%'}
    `) as unknown as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set();
  }
}

/**
 * P-007 rung-2 preference tiers, best first. A Scout nudge asks someone to GRADE an
 * idea or REVIEW a draft — judgment duties that the retired Mug/Queen used to absorb
 * as a side effect of triage. Handing that to whichever su merely spoke most recently
 * interrupts an arbitrary busy peer, so prefer a session whose JOB it is:
 *
 *   0. THE Blender steward — carries GRADE *and* is bound to one of the active Blender
 *      goals (D-003's steward shape: GOAL mode owning the Blender loop with GRADE
 *      stacked for the health scorecard).
 *   1. Any GRADE-mode session — grading is at least part of its declared posture.
 *   2. Everyone else — the pre-existing most-recently-active fallback, unchanged.
 *
 * Tier 0 tests the goal's IDENTITY, not merely that some goal is present: a grade-mode
 * session bound to an unrelated goal is a worse recipient than the session actually
 * running this loop, and a bare `goalIdFromModes(modes) !== null` ranks the two equally.
 *
 * The ids are DERIVED (a body-marker query — see readBlenderGoalIds), never configured,
 * so nothing has to be written anywhere before the goal exists. The derivation fail-softs
 * to an EMPTY set, which makes tier 0 merely unreachable rather than wrong: every
 * grade-mode session then lands in tier 1, so an unresolvable goal costs one rung of
 * preference instead of demoting the real steward to the recency fallback.
 */
function stewardTier(
  modes: ModeLike[] | undefined,
  blenderGoalIds: ReadonlySet<string>,
): StewardTier {
  if (!modes || modes.length === 0) return 2;
  if (!modes.some((m) => m.mode === GRADE_MODE)) return 2;
  const goalId = goalIdFromModes(modes);
  return goalId !== null && blenderGoalIds.has(goalId) ? 0 : 1;
}

/** The registry id of the GRADE overlay (modes/registry.ts). */
const GRADE_MODE = 'grade';

/**
 * P-037: is the Mug tier still runnable? Fail-CLOSED to `false` — an unreadable
 * flag must not keep the Mug rung eligible, because a nudge routed to a Mug is
 * a nudge NOT routed to a live su, and `wakeMug` is itself gated on the same
 * predicate. Guessing `true` here would strand the nudge between two gates.
 */
async function tierRunnable(fn?: () => Promise<boolean>): Promise<boolean> {
  try {
    if (fn) return await fn();
    const { mugKettleSystemEnabled } = await import('../pot/started');
    return await mugKettleSystemEnabled();
  } catch {
    return false;
  }
}

/**
 * Resolve who should receive a Scout-rail nudge right now.
 *
 * Fail-soft by design: any error resolving liveness degrades to `escalate` rather than
 * throwing, because the caller is a watchdog whose whole purpose is to not go quiet.
 */
export async function resolveNudgeRecipient(
  opts: ResolveNudgeRecipientOpts,
): Promise<NudgeRecipient> {
  // The module LOADS are inside the guard too, not just the calls: a dynamic import can
  // itself throw (a partially-mocked dependency under test, a cycle at boot), and a
  // watchdog whose whole job is to not go quiet must never die resolving its own
  // recipient. Anything unresolvable degrades to `unresolved`, which the caller reports.
  let listFn: typeof listPresence;
  let statesFn: typeof resolveSessionStates;
  try {
    listFn = opts.listPresenceFn ?? (await loadPresence()).listPresence;
    statesFn = opts.resolveSessionStatesFn ?? (await loadLiveness()).resolveSessionStates;
  } catch (e) {
    return {
      kind: 'unresolved',
      why: `presence/liveness modules unavailable (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  let rows: PresenceRecord[] = [];
  try {
    rows = await listFn({ workspaceId: opts.workspaceId });
  } catch (e) {
    return {
      kind: 'unresolved',
      why: `presence unreadable (${e instanceof Error ? e.message : String(e)}) — cannot name a live recipient`,
    };
  }

  // Candidates: the Mug (if the caller resolved one) plus every su session in scope.
  // One oracle call covers both so the Mug and the su are judged by the same rule.
  const suRows = rows.filter((r) => r.ownerId.startsWith(SU_OWNER_PREFIX));
  const subjects = [
    ...(opts.mugOwner ? [{ ownerId: opts.mugOwner }] : []),
    ...suRows.map((r) => ({
      ownerId: r.ownerId,
      heartbeatAt: r.heartbeatAt,
      host: r.host,
      pid: r.pid,
      source: r.source,
    })),
  ];

  if (subjects.length === 0) {
    return { kind: 'escalate', why: 'no Mug and no su session present in this workspace' };
  }

  let verdicts: Map<string, { sessionState?: string | null }>;
  try {
    verdicts = (await statesFn(subjects, { hydratePerId: true })) as Map<
      string,
      { sessionState?: string | null }
    >;
  } catch (e) {
    return {
      kind: 'unresolved',
      why: `liveness oracle failed (${e instanceof Error ? e.message : String(e)}) — refusing to guess a recipient from a raw heartbeat`,
    };
  }

  const deliverable = (ownerId: string): boolean => {
    const v = verdicts.get(ownerId);
    // NO entry means the oracle could not judge this subject (a degraded fetch). Unknown
    // is not "alive" — treat it as undeliverable so we fall through to a real recipient
    // rather than parking a nudge on a session nobody has confirmed is taking turns.
    return v != null && v.sessionState != null && DELIVERABLE_STATES.has(v.sessionState);
  };

  // 1 — the Mug, while the tier is still running.
  //
  // P-037: "while the tier is still running" is now ENFORCED, not assumed. It
  // has to be, because `wakeMug` is gated on the same predicate: were this rung
  // to pick a Mug after the retirement, `deliverScoutNudge` would early-return
  // on it (a deliverable Mug needs no second recipient) while the delivery it
  // returned on had already no-opped — losing the nudge between two gates, the
  // one outcome worse than either the old behaviour or the new one.
  if (opts.mugOwner && deliverable(opts.mugOwner) && (await tierRunnable(opts.mugKettleSystemEnabledFn))) {
    return {
      kind: 'mug',
      ownerId: opts.mugOwner,
      why: `Mug ${opts.mugOwner} is ${verdicts.get(opts.mugOwner)?.sessionState ?? 'unknown'}`,
    };
  }

  // 2 — a live su, preferring the STEWARD (a session whose declared posture is grading;
  //     see stewardTier) and, within a tier, the most recently ACTIVE (not the most
  //     recent heartbeat: the keepalive bumps that on a session doing nothing).
  const liveSu = suRows
    .filter((r) => deliverable(r.ownerId))
    .sort((a, b) => (b.lastActiveAt ?? b.heartbeatAt ?? '').localeCompare(a.lastActiveAt ?? a.heartbeatAt ?? ''));

  if (liveSu.length > 0) {
    // Read modes ONLY for the already-deliverable candidates — a bounded read, and one
    // that cannot change WHO is eligible, only the order among the eligible.
    // The try/catch is around the CALL, not just inside the default reader: an injected
    // seam (or a dynamic import) can throw too, and rung 2 must degrade to recency rather
    // than lose the nudge to a preference signal that is only ever an optimisation.
    let modesByOwner: Map<string, ModeLike[]>;
    try {
      modesByOwner = await (opts.readAgentModesFn ?? readAgentModes)(
        opts.workspaceId,
        liveSu.map((r) => r.ownerId),
      );
    } catch {
      modesByOwner = new Map();
    }
    // Resolve WHICH goals are the Blender ones only if some candidate could actually
    // reach tier 0 (a grade-mode session carrying a goal). On the common path — nobody
    // grading — this rung costs exactly the mode read it already paid, and the query is
    // skipped entirely. Same fail-soft as the mode read: an empty set makes tier 0
    // unreachable, never wrong.
    let blenderGoalIds: ReadonlySet<string> = new Set<string>();
    const someoneCouldBeSteward = liveSu.some((r) => {
      const m = modesByOwner.get(r.ownerId);
      return !!m && m.some((x) => x.mode === GRADE_MODE) && goalIdFromModes(m) !== null;
    });
    if (someoneCouldBeSteward) {
      try {
        blenderGoalIds = await (opts.readBlenderGoalIdsFn ?? readBlenderGoalIds)(opts.workspaceId);
      } catch {
        blenderGoalIds = new Set<string>();
      }
    }
    // Tier each candidate ONCE: the comparator runs O(n log n) times and the winner is
    // re-read below, so a memoised tier keeps the ranking and the `why` string derived
    // from the same evaluation rather than two that could drift.
    const tierByOwner = new Map(
      liveSu.map((r) => [r.ownerId, stewardTier(modesByOwner.get(r.ownerId), blenderGoalIds)] as const),
    );
    // Stable-by-tier: `sort` is stable in V8, so the recency order above is preserved
    // WITHIN each tier and an empty/failed mode read reproduces the prior behaviour
    // exactly (every row lands in tier 2).
    const ranked = [...liveSu].sort(
      (a, b) => (tierByOwner.get(a.ownerId) ?? 2) - (tierByOwner.get(b.ownerId) ?? 2),
    );
    const chosen = ranked[0];
    const tier = tierByOwner.get(chosen.ownerId) ?? 2;
    const tierWhy =
      tier === 0
        ? 'the Blender steward (GRADE + the active Blender goal)'
        : tier === 1
          ? 'a live GRADE-mode su'
          : 'the most recently active su (no grading-posture session was live)';
    return {
      kind: 'su',
      ownerId: chosen.ownerId,
      ownerLabel: chosen.ownerLabel,
      tier,
      why:
        `the Mug tier is RETIRED, so you are the reviewer — routed to ${tierWhy} ${chosen.ownerLabel} ` +
        `(${verdicts.get(chosen.ownerId)?.sessionState ?? 'unknown'}, ${liveSu.length} su candidate(s))`,
    };
  }

  // 3 — nobody home. Say so loudly; never park into a slot with no drainer.
  return {
    kind: 'escalate',
    why:
      `no deliverable recipient: mug=${opts.mugOwner ?? 'none'} ` +
      `(${opts.mugOwner ? (verdicts.get(opts.mugOwner)?.sessionState ?? 'unknown') : 'n/a'}), ` +
      `${suRows.length} su session(s) present but none live/parked`,
  };
}

export interface DeliverScoutNudgeOpts {
  workspaceId: string;
  mugOwner: string | null;
  summary: string;
  source: string;
  payload?: unknown;
  body?: string;
  harnessSlug?: string | null;
  /** Whether to re-invoke the selected su after the durable inbox write.
   *   - `true` — a true PAGER: wake whoever the ladder chose (error-streak alarm).
   *   - `'grading-posture'` — wake ONLY a recipient whose declared posture is the
   *     nudge's own job (steward tier 0/1: the Blender steward or a GRADE-mode su).
   *     A tier-2 recency-fallback su still receives the message, as an un-woken FYI.
   *     WI-10004412: the grading backstop delivered inject-only to a DIFFERENT
   *     recency-fallback su on every fire (13 fires/30d, the same 10 rows each time),
   *     so the one rail whose purpose is to MAKE grading happen never started a turn.
   *     Waking an arbitrary busy peer would trade that for interrupting the wrong agent;
   *     waking a session that registered GRADE mode is waking the agent whose job it is.
   *   - `false`/absent — inject-only for every recipient. */
  wakeSu?: boolean | 'grading-posture';
  /** DI seams forwarded to `resolveNudgeRecipient` (unit tests only). */
  recipientSeams?: Pick<ResolveNudgeRecipientOpts, 'readAgentModesFn' | 'readBlenderGoalIdsFn'>;
}

/**
 * PURE: does this delivery re-invoke its su recipient? Split out so the policy is
 * assertable without the coord stack. Only an `su` verdict can be woken — a mug is
 * woken by its own leg, and escalate/unresolved have no session to wake.
 */
export function shouldWakeSuRecipient(
  recipient: NudgeRecipient,
  wakeSu: DeliverScoutNudgeOpts['wakeSu'],
): boolean {
  if (recipient.kind !== 'su') return false;
  if (wakeSu === true) return true;
  if (wakeSu === 'grading-posture') return recipient.tier <= 1;
  return false;
}

/**
 * Deliver a Scout-rail nudge to whoever can actually act on it, and RETURN which route
 * was taken so the caller can log/record it. Replaces a bare `wakeMug` at the three
 * Scout watchdogs.
 */
export async function deliverScoutNudge(
  opts: DeliverScoutNudgeOpts,
): Promise<NudgeRecipient> {
  const recipient = await resolveNudgeRecipient({
    workspaceId: opts.workspaceId,
    mugOwner: opts.mugOwner,
    ...opts.recipientSeams,
  });

  // ALWAYS run the legacy Mug delivery first — this addition is PURELY ADDITIVE, the
  // same discipline severe-event-broadcast took with its own routing leg.
  //
  // Removing the durable `@role:mug` park when no Mug is live would be a REGRESSION while
  // the tier still runs: the park exists precisely so a FUTURE Mug relaunch drains it, and
  // "no Mug live right now" is the normal state between wakes, not evidence that none is
  // coming. So the park stays and the routed delivery is layered on top; when the tier is
  // finally gated OFF this call becomes a no-op and only the routed leg remains.
  const { wakeMug } = await loadPlacementWatchdog();
  await wakeMug({
    workspaceId: opts.workspaceId,
    mugOwner: recipient.kind === 'mug' ? recipient.ownerId : opts.mugOwner,
    summary: opts.summary,
    source: opts.source,
    payload: opts.payload,
    body: opts.body,
    harnessSlug: opts.harnessSlug,
  });

  // A deliverable Mug will act on it — no second recipient needed.
  if (recipient.kind === 'mug') return recipient;

  // Could not determine liveness — the durable park above is the honest best effort.
  // Do NOT page the owner on a dependency hiccup (see the NudgeRecipient doc).
  if (recipient.kind === 'unresolved') return recipient;

  const [{ sendMessage }, { runWithWorkspace }] = await Promise.all([
    import('../agent-tools/coordination/messages'),
    import('../workspace-als'),
  ]);

  // `human` surfaces to the owner; a concrete su ownerId is a direct address. Either way
  // the message is DIRECTED at someone who exists, never parked in `@role:mug`.
  //
  // ⚠ This is the INTERNAL `sendMessage`, whose `SendOptions.body` is a plain STRING and
  // which has `expectsReply?: boolean` — NOT the `coord:send` TOOL's wire shape (an array
  // of typed sections with `expects`). The two look interchangeable and are not; the
  // adjacent `wakeMug` uses this same string form.
  const to = recipient.kind === 'su' ? [recipient.ownerId] : ['human'];

  // The slot name is INLINED rather than imported from placement-watchdog's
  // MUG_COORD_SLOT: this is diagnostic prose, and the Scout tests mock that module with
  // only { resolveMugOwner, wakeMug }, so reading any other member throws.
  const routingNote =
    `\n\n— Routed by the Scout nudge ladder: ${recipient.why}. ` +
    `YOU are the reviewer and you hold the authority to dispose of this draft — promote it to ready, ` +
    `send its scout owner feedback, or deprecate it with learnings. Do not wait for a Mug or a Queen: ` +
    `that tier is RETIRED (retire-mug-kettle-su-only-2026-08-09), so nothing else will drain this. ` +
    `Before this ladder existed the nudge would have parked in the legacy '@role:mug' slot, where nobody drains it.`;
  const wake = shouldWakeSuRecipient(recipient, opts.wakeSu);
  // Say so when a grading-posture nudge reached a recency-fallback su un-woken: the
  // recipient should know it is an FYI it was chosen for by recency alone, not a page.
  const fyiNote =
    recipient.kind === 'su' && opts.wakeSu === 'grading-posture' && !wake
      ? `\n\nThis is an un-woken FYI: no session with a grading posture (GRADE mode) was live, so the ` +
        `ladder fell back to recency and did not interrupt you. Register GRADE mode (mode:set { mode:'grade' }) ` +
        `if you take on this grading, and later nudges will wake you.`
      : '';

  try {
    await runWithWorkspace(opts.workspaceId, () =>
      sendMessage(
        {
          ownerId: opts.source,
          ownerLabel: opts.source,
          source: 'static-client',
          workspaceId: opts.workspaceId,
          userId: null,
        },
        {
          to,
          summary: opts.summary,
          body: `${opts.body ?? opts.summary}${routingNote}${fyiNote}`,
          expectsReply: recipient.kind === 'escalate',
          harnessSlug: opts.harnessSlug,
          extra: {
            scoutNudge: {
              route: recipient.kind,
              why: recipient.why,
              source: opts.source,
              ...(recipient.kind === 'su' ? { tier: recipient.tier, woken: wake } : {}),
            },
          },
        },
      ),
    );

    // `sendMessage` is deliberately inject-only. That is right for the ordinary
    // review/grade nudges, but not for the error-streak PAGER: without this explicit
    // opt-in the alarm can select a live su, persist a message, and still never start
    // a turn for that recipient. Wake only after the durable write succeeds so a
    // failed send cannot produce an empty wake.
    if (recipient.kind === 'su' && wake) {
      const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
      await wakeRecipients([recipient.ownerId], {
        summary: opts.summary,
        payload: opts.payload,
        source: opts.source,
        workspaceId: opts.workspaceId,
      });
    }
  } catch (e) {
    console.warn(
      `[scout-nudge] ${recipient.kind} delivery failed (${opts.source}): ${e instanceof Error ? e.message : e}`,
    );
  }

  return recipient;
}
