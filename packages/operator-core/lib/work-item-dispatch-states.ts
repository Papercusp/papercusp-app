/**
 * work-item-dispatch-states — the canonical feature-family lifecycle-state sets
 * shared by the stuck-item recovery layer, so the reaper, the voluntary-release
 * path, the dead-letter dispatcher, and the stuck-items health metric can never
 * disagree about which states mean what (work-queue-stuck-item-recovery-2026-06-17).
 *
 * Pure constants only — NO PG, NO imports — so any layer (incl. the standalone
 * `work-items-stale-claims` reaper) can depend on it without a cycle.
 *
 * These describe the LIVE `harness_features_consolidated.status` vocabulary
 * (todo / in_progress / validating / passed / failing / deprecated / blocked /
 * needs-human / wip), NOT the aspirational dogfood-v5 `feature-state-types.ts`
 * model (backlog/in_queue/working/pending_done/shipped), which is a separate,
 * not-yet-wired lifecycle.
 *
 * ⚠ CLAIMABILITY IS NOT DEFINED HERE. This module answers "may the reaper requeue
 * this row?", never "is this row offered to the claimable pool?". The claimable
 * vocabulary is `CLAIM_STATES_ALLOWLIST` (`scheduler/claim-states.ts`) enforced by
 * `claimFloorsWhereSql` (`work-items.ts`) — and the honest answer is that there is
 * no SINGLE claimable state to name (it is ['open','failing']).
 *
 * That distinction was previously blurred by a `FEATURE_DISPATCHABLE_STATE = 'todo'`
 * export here whose docstring claimed to name the claimable state. It had no
 * production consumer, but it was the most authoritative-looking thing in the tree on
 * a question it answered WRONGLY — a fixture author reaching for it seeded rows that
 * no claim could see, and `work-item-redundancy.integration.test.ts` was red for three
 * weeks (2026-07-19 → 08-02) on `expected undefined to be 'F-051'`, a symptom naming
 * neither the status column nor the vocabulary change. It is deleted rather than
 * re-worded, so the wrong reach finds nothing instead of finding a confident lie
 * (EI-19363744726544384).
 */

/** Settled feature states — a terminal outcome, never re-dispatched and never
 *  requeued by the reaper. (Mirrors the settled set in setWorkItemState that
 *  fires `work-item:done`.)
 *
 *  work-item-status-full-unify (2026-07-19): carries the legacy terminals AND the
 *  unified ones (`done`/`dropped`) as a TRANSITIONAL SUPERSET — without this, the
 *  reaper would read a post-migration `done` row as "stranded mid-flight" and
 *  requeue settled work en masse. Narrow to ['done','dropped'] after cleanup. */
export const FEATURE_TERMINAL_STATES: readonly string[] = ['passed', 'deprecated', 'done', 'dropped'];

/** Issue-family (bug/change/task) settled states — the mirror of
 *  FEATURE_TERMINAL_STATES for the `engineer_issues` dialect.
 *
 *  work-item-status-full-unify (2026-07-19) flipped the issue-family writer to
 *  STORE the unified terminal spellings — `closed`/`deprecated` inputs now write
 *  `dropped`, exactly as `resolved`/`passed` inputs write `done` (see
 *  FEATURE_STATE_ALIASES). This list omitted `dropped` for over a month
 *  (EI-21921121818266895): measured live 2026-08-30, `harness_shared.work_items`
 *  carries 4,322 issue-family rows at status='dropped' — a real, actively-written
 *  terminal state, not a stray/invalid value — every one of them silently
 *  invisible to every terminal-scoped issue diagnostic (`issues-engineer.ts`'s
 *  audit + completionAuthority buckets) and to `premise-probes.ts`'s
 *  `#completion`-anchor terminality check. `resolved`/`closed`/`deprecated` are
 *  kept as the pre-unification legacy spellings (still present on old rows). */
export const ISSUE_TERMINAL_STATES: readonly string[] = ['resolved', 'closed', 'deprecated', 'done', 'dropped'];

/**
 * Terminal in EITHER kind-family — the canonical cross-family union.
 *
 * EI-18653071581558556 / EI-18652789334651795: consumers that see BOTH families
 * (the placement watchdog, burn-down, any "is this unit finished?" check) kept
 * HAND-COPYING this union, and the copies drifted. placement-watchdog's copy was
 * written before work-item-status-full-unify (2026-07-19) added `done`/`dropped`
 * and never caught up, so it recognized only ['passed','deprecated','resolved',
 * 'closed']. Since every consumer reads "not in the set ⇒ still active", finished
 * work was scored as a FAILED placement: measured live on papercusp 2026-07-25,
 * 15 of 17 units reported stranded/cursed were already terminal (14 `done`,
 * 1 `dropped`) — ~88% phantoms — and the status census showed the drifted copy
 * matched just ~18% of terminal rows (done 803 · passed 214 · dropped 206 ·
 * deprecated 2; `resolved`/`closed` never occur at all).
 *
 * DERIVE from this constant — never re-list the words. The drift guard lives in
 * work-item-dispatch-states.test.ts.
 */
export const ANY_FAMILY_TERMINAL_STATES: readonly string[] = [
  ...new Set([...FEATURE_TERMINAL_STATES, ...ISSUE_TERMINAL_STATES]),
];

/**
 * Feature states the reaper / release path must NOT requeue (the requeue TARGET is
 * `open` since work-item-status-full-unify; it was `todo` before the flip):
 *   - `open`         — already claimable, nothing to do;
 *   - `todo`         — retired spelling of the same thing, still held by live rows;
 *   - terminal       — settled, leave alone;
 *   - `blocked`      — a deliberate park with its own delegator-notify signal path;
 *   - `needs-human`  — a deliberate OWNER-park (fleet-scheduler-hardening-2026-07-03
 *     P-004): only the owner can progress it, so a dead holder changes nothing.
 *     Before this, a holder dying (e.g. the 2026-07-03 backlog-clearance fleet
 *     kill) requeued needs-human items to `todo`, the pool re-OFFERED owner-gated
 *     work, and every reclaim cycle re-burned agent turns re-discovering and
 *     re-parking the same items (WI-1774/WI-1775 were each parked needs-human
 *     three separate times in one afternoon). The owner un-parks by setting `todo`.
 * Any OTHER non-null status on a freed row (in_progress, validating, failing,
 * wip, …) is a mid-flight item stranded by a dead/releasing holder and IS
 * requeued. This same predicate defines "freed-but-non-dispatchable" for the
 * stuck-items health metric (P-008a).
 */
export const FEATURE_NON_REQUEUE_STATES: readonly string[] = [
  // work-item-status-full-unify: `open` is the unified claimable token (todo→open in the
  // backfill) — an `open` row is ALREADY claimable, so a freed one needs no requeue.
  'open',
  // The RETIRED `todo` spelling, kept deliberately — NOT leftover drift. Migration 638
  // backfilled the rows and no writer emits it any more (FEATURE_STATE_ALIASES folds
  // todo→open), but the backfill did not reach everything: MEASURED 2026-08-10 on
  // papercusp/papercusp-workspace there are still 28 unheld feature-family rows sitting at
  // 'todo' (23 item_kind='feature' + 5 'chunk', created 2026-06-21 → 07-27). Dropping this
  // entry would make every one of them requeueable — the six consumers that derive from this
  // array (work-items.ts voluntary release, work-queue-health's stuck metric ×2,
  // WORK_ITEM_NON_REQUEUE_STATES in work-items-stale-claims, fleet/spawn-reclaim ×2,
  // fleet/spawn-relaunch) would start rewriting settled legacy rows to 'open' and re-offering
  // them. RETIRE THIS ENTRY ONLY when that count is genuinely 0 — verify, never assume
  // (EI-19363744726544384: the change that proposed dropping it asserted the count was 0 on
  // the strength of a code comment, and the live table said 28):
  //   SELECT count(*) FROM harness_shared.work_items
  //    WHERE status = 'todo' AND item_kind NOT IN ('bug','change','task');
  'todo',
  ...FEATURE_TERMINAL_STATES,
  'blocked',
  'needs-human',
];

/** Pure predicate: is this freed feature row stranded mid-flight (should the
 *  reaper / voluntary-release reset it back to `todo`)? */
export function isRequeueableFeatureState(status: string | null | undefined): boolean {
  return status != null && status !== '' && !FEATURE_NON_REQUEUE_STATES.includes(status);
}

/**
 * The canonical feature-family lifecycle states an AGENT may set via the validated
 * agent-facing path (work_items:set_state / :complete → setWorkItemState). GAP 5 /
 * P-011 / D-010. The DBOS pipeline writes phase statuses (scoping/building/…) via
 * RAW SQL and is NOT governed by this — so app-level validation catches agent typos
 * without freezing the pipeline (D-004). A genuinely-new agent-settable state must be
 * ADDED here deliberately (the reviewed extension), not silently drifted.
 */
export const FEATURE_FAMILY_STATES: readonly string[] = [
  'todo', 'in_progress', 'validating', 'passed', 'failing', 'deprecated', 'blocked', 'wip', 'needs-human',
  // work-item-status-full-unify: the unified vocabulary joins the recognized set. NOTE these are
  // NOT writer-reachable yet — FEATURE_STATE_ALIASES intercepts done/dropped/open BEFORE this
  // allowlist (writers keep storing the legacy tokens until the coordinated cutover); listing them
  // here keeps the terminals⊆vocabulary invariant true for the transitional FEATURE_TERMINAL_STATES.
  'open', 'done', 'dropped',
];

/**
 * Cross-dialect + drift-variant aliases → the UNIFIED work-item enum
 * (open | wip | blocked | needs-human | done | dropped). The unified tokens pass
 * through as identity (no entry needed); the legacy feature dialect + the pre-cutover
 * phase spellings + known separator/case typos all fold onto unified, so a typo lands
 * in the RIGHT state instead of a non-dispatchable limbo (the GAP-5 harm). Inputs are
 * lower-cased before lookup, so case typos normalize too.
 *
 * work-item-status-full-unify (P-003 writer-flip): this map was INVERTED — the feature
 * writer now STORES the unified enum, not the legacy feature vocabulary. `passed`→`done`,
 * `deprecated`→`dropped`, `todo`/`failing`→`open`, `in_progress`/`validating`→`wip`.
 * The passed↔done / deprecated↔dropped nuance is preserved in work_items.terminal_reason,
 * stamped by the writer (setWorkItemState). Legacy tokens stay in FEATURE_FAMILY_STATES
 * as a recognition superset (the DBOS pipeline still writes phase statuses via raw SQL,
 * and readers must classify pre-flip rows) — only the WRITE mapping flips here.
 */
export const FEATURE_STATE_ALIASES: Record<string, string> = {
  // legacy feature dialect + phase spellings → unified enum
  todo: 'open', failing: 'open', in_progress: 'wip', validating: 'wip',
  passed: 'done', deprecated: 'dropped',
  // issue-dialect terminals a mis-targeted caller might pass → unified (defensive)
  resolved: 'done', closed: 'dropped',
  // known separator/case drift variants → unified
  'in-progress': 'wip', inprogress: 'wip', 'in progress': 'wip',
  needs_human: 'needs-human', needshuman: 'needs-human', 'needs human': 'needs-human',
  'need-human': 'needs-human',
};

/**
 * Normalize an agent-supplied feature state onto the canonical vocabulary, or REJECT
 * it (typed, listing the valid set) — the GAP-5 typo guard (P-011 / D-010). Folds
 * case + known separator drift; a truly-unknown state is rejected. Trusted internal
 * restore paths (autonomy revert) bypass this via setWorkItemState's allowNonCanonical.
 */
export function normalizeFeatureStateInput(
  state: string,
): { ok: true; state: string } | { ok: false; valid: readonly string[] } {
  const lower = state.trim().toLowerCase();
  const mapped = FEATURE_STATE_ALIASES[lower] ?? lower;
  if (FEATURE_FAMILY_STATES.includes(mapped)) return { ok: true, state: mapped };
  return { ok: false, valid: FEATURE_FAMILY_STATES };
}

/**
 * Does this agent-supplied state SPELLING resolve to a terminal outcome?
 *
 * agent-protocol-authority-semantics-2026-07-26 P-005 / D-006. The agent-facing
 * writer accepts a wide input vocabulary — the unified enum, the legacy per-family
 * dialects, and known case/separator drift — all of which fold through
 * FEATURE_STATE_ALIASES before the terminal question is even askable. So
 * "is this write terminal?" cannot be answered by membership in
 * ANY_FAMILY_TERMINAL_STATES alone: `passed`, `resolved` and `closed` are terminal
 * only AFTER aliasing, and `todo`/`failing` look unfamiliar but are decidedly not.
 *
 * Folds case + separator drift exactly the way normalizeFeatureStateInput does, so
 * the schema gate and the runtime writer can never disagree about which writes are
 * terminal (a disagreement here would either wave an evidence-less close through or
 * reject a legitimate non-terminal one).
 */
function resolvesToTerminalState(spelling: string): boolean {
  const lower = spelling.trim().toLowerCase();
  const resolved = FEATURE_STATE_ALIASES[lower] ?? lower;
  return ANY_FAMILY_TERMINAL_STATES.includes(resolved);
}

/** Every state spelling the agent-facing writer accepts — the union of the
 *  recognized vocabulary, the alias keys, and both families' terminals. */
const ALL_ACCEPTED_STATE_SPELLINGS: readonly string[] = [
  ...new Set([
    ...FEATURE_FAMILY_STATES,
    ...Object.keys(FEATURE_STATE_ALIASES),
    ...ANY_FAMILY_TERMINAL_STATES,
  ]),
];

/**
 * The accepted spellings that mean "this item is FINISHED", i.e. the writes that
 * MUST carry completion evidence (P-005). DERIVED, never hand-listed — a new alias
 * or terminal added above lands in the right half automatically, which is the whole
 * point: the drift that produced EI-18653071581558556 came from hand-copied lists.
 */
export const TERMINAL_INPUT_STATES: readonly string[] =
  ALL_ACCEPTED_STATE_SPELLINGS.filter(resolvesToTerminalState);

/** The accepted spellings that do NOT settle an item — the complement of
 *  TERMINAL_INPUT_STATES over the same source set (total + disjoint by
 *  construction; asserted in work-item-dispatch-states.test.ts). */
export const NON_TERMINAL_INPUT_STATES: readonly string[] =
  ALL_ACCEPTED_STATE_SPELLINGS.filter((s) => !resolvesToTerminalState(s));

/** Pure predicate for the agent-facing schema gate + the runtime writer: does this
 *  supplied state settle the item (and therefore require completion evidence)? */
export function isTerminalStateInput(state: string): boolean {
  return resolvesToTerminalState(state);
}

/** Default cap on how many times the stale-claim reaper will requeue one row
 *  before dead-lettering it to `blocked` (D-007). Env-overridable. */
export const DEFAULT_STALE_RECLAIM_REQUEUE_CAP = 3;

/** Resolve the requeue cap from the environment (PAPERCUSP_STALE_RECLAIM_REQUEUE_CAP),
 *  falling back to the default. Mirrors the STALE_CLAIM_GRACE_MS tunable pattern. */
export function staleReclaimRequeueCap(): number {
  const v = Number(process.env.PAPERCUSP_STALE_RECLAIM_REQUEUE_CAP ?? DEFAULT_STALE_RECLAIM_REQUEUE_CAP);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_STALE_RECLAIM_REQUEUE_CAP;
}
