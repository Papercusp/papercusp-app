/**
 * G2 admission predicate — the SINGLE source of truth for "is this feature-family
 * work-item auto-runnable without auditor screening?".
 *
 * Plan: shared-hive-trust-admission-2026-06-14 (P-001). Successor to the shipped
 * papercusp-user-protection-gate-2026-05-31, whose gate was enforced ONLY on the
 * feature-frontier read (`dbos/orchestrator-loop.ts` readFrontierFeatures +
 * `@papercusp/orchestrator` state-pg.ts readFeaturesPg). The Hive's fleet/blackboard
 * distribution layer — `claimNextWorkItem`, `claimWorkItem`, `claimReplicaSlotLocal`,
 * `fleet:place_batch` (gatherFrontier) — grew up around that one read and never
 * inherited the predicate, so un-screened REMOTE work was claimable + runnable. This
 * module is that one predicate, applied at EVERY claim/place chokepoint so a future
 * path can't silently re-open the hole.
 *
 * Rule (mirrors `@papercusp/orchestrator` isAutoPickable, D-006 of the predecessor):
 * an item is auto-pickable iff it was authored LOCALLY (origin 'local' or NULL, the
 * pre-G1 back-compat case) OR the auditor ADMITTED it (audit_verdict = 'admit').
 * Remote + un-admitted ⇒ quarantined — fail-safe: it holds even if the auditor lane
 * is unwired/errors/lags. The TRUST-LIST fast-path (a trusted author's
 * verified_author_github_user_id) joins this predicate in Phase 3; the column lands
 * in Phase 2. Until then this is the exact behaviour of the proven frontier gate,
 * brought to every other path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { ACTIONABLE_CONDITION_PREFIXES } from './coord/actionable-conditions';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import { readRoutinePause } from './harness/routines/release-pause-ttl';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * JS form — filter already-loaded rows (placement-gather, list surfacing). Keep this
 * byte-identical in meaning to {@link autoPickableWhereSql}; the drift-guard test
 * (P-006) asserts both agree with `@papercusp/orchestrator` isAutoPickable.
 */
export function isAutoPickable(
  origin: string | null | undefined,
  auditVerdict: string | null | undefined,
  verifiedAuthorGithubUserId?: number | null,
  trustedGithubUserIds?: ReadonlySet<number>,
  authorPubkey?: string | null,
  ownAuthorPubkeys?: ReadonlySet<string>,
): boolean {
  // Local features always bypass the auditor — origin NULL = local (pre-G1 back-compat).
  if (origin == null || origin === 'local') return true;
  // Remote features are pickable when the auditor has admitted them…
  if (auditVerdict === 'admit') return true;
  // …OR the OWN-NODE fast-path: the row was authored by a substrate-log key this
  // workspace already knows as its own (see ownAuthorWhereSql for why that is sound).
  // A blank/absent pubkey NEVER qualifies — see the guards there.
  if (authorPubkey != null && authorPubkey !== '' && ownAuthorPubkeys != null && ownAuthorPubkeys.has(authorPubkey)) {
    return true;
  }
  // …OR the TRUST fast-path (Phase 3 / P-010): a remote+un-admitted item whose
  // VERIFIED author (P-008, never a self-claimed id) is in the owner's LOCAL trust
  // list. The verified id must be present AND in the trusted set — a NULL verified
  // id (unverified / revoked binding / local row) never satisfies it. The caller
  // supplies the workspace's trusted set (it is owner/workspace-scoped — D-004).
  if (
    verifiedAuthorGithubUserId != null &&
    trustedGithubUserIds != null &&
    trustedGithubUserIds.has(verifiedAuthorGithubUserId)
  ) {
    return true;
  }
  return false;
}

/**
 * Issue-family (bug/change/task) LOCAL-claimability predicate — the issue-family
 * counterpart of {@link isAutoPickable}, but SIMPLER: a federated (origin='remote')
 * issue-family row is owned EXCLUSIVELY by its authoring peer's core (the
 * hyperbee->PG projector writes it under LWW — see EI-7833 / migration 521's
 * engineer_issues_view_dml remote-skip guard, and the hard invariant enforced at
 * work-items.ts's issue-family setWorkItemState: "its authoring peer must
 * claim/resolve it"). Unlike the feature family, there is NO audit-admit /
 * trust-list escape hatch here — a remote issue-family row is never locally
 * claimable, full stop. `origin` NULL (pre-federation back-compat) or 'local' is
 * locally claimable; anything else (today only 'remote') is not.
 *
 * WI-3649: `claimNextIssueWorkItem` (the claim_next/scheduler:get_next self-select),
 * `listWorkItems`'s issue branch (`admissibleOnly`), and `observeWorkItem` must all
 * apply this SAME predicate so "claimable"/"available" means what the actual claim
 * path (`claimIssue`'s view-trigger) will honor — mirroring EI-7841's fix, which
 * closed the identical read/write gap for the feature family only.
 */
export function isIssueLocallyClaimable(origin: string | null | undefined): boolean {
  return origin == null || origin === 'local';
}

/**
 * ADMISSION-GATE state — the second, orthogonal admission axis (plan
 * work-queue-admission-and-bulk-dedup-2026-08-24, owner-directed 2026-08-24).
 *
 * WHY IT LIVES HERE rather than in a new module: this file is already "the SINGLE
 * source of truth for is-this-claimable", and the predecessor's whole lesson (see
 * the header) is that an admission rule defined next to ONE consumer silently fails
 * to reach the others. A parallel gate would repeat that exact mistake.
 *
 * ORTHOGONAL, NOT a replacement: the G2 legs above answer "may we run work authored
 * ELSEWHERE?"; this answers "has this item cleared DUPLICATE screening?". A claim
 * chokepoint must satisfy both.
 *
 * The states, and why NULL means admitted:
 *   NULL         legacy / pre-gate row ⇒ ADMITTED (back-compat, exactly as origin
 *                NULL = local above). Every row predating migration 944 is NULL, and
 *                treating those as pending would quarantine the entire live backlog.
 *   'pending'    born-pending; invisible to claim/place until the promoter judges it.
 *   'admitted'   promoter judged it — duplicate screening only, NEVER merit
 *                (redundancy kappa 0.679 vs merit kappa 0.289; plan charter).
 *   'auto'       filing-time bypass: plan-promoted (already passed plan review) or
 *                critical/security severity (post-hoc review instead).
 *   'unreviewed' FAIL-OPEN auto-promotion — the promoter was dead or lagging past its
 *                deadline. Claimable BY DESIGN: the measured system bottleneck is
 *                distribution (greenlit plans sat six days unclaimed), so a dead
 *                promoter must never silently starve the queue. Tagged so the stats
 *                ledger can alarm on a non-zero steady-state count.
 *
 * FAIL-SAFE DIRECTION IS DELIBERATELY INVERTED relative to the G2 legs. There, an
 * unwired auditor must not admit foreign code, so unknown ⇒ refuse. Here, an unwired
 * promoter must not freeze the queue, so unknown ⇒ admit. Both choose the direction
 * whose failure mode is recoverable: a duplicate that slips through is merged later;
 * a starved queue stops all work and is invisible until someone notices.
 */
export type WorkItemAdmission = 'pending' | 'admitted' | 'auto' | 'unreviewed';

/**
 * The `admission` value a NEW item is born with, or `null` for "don't stamp it"
 * (legacy/pre-gate semantics — {@link isAdmitted} reads NULL as admitted).
 *
 * Deliberately NOT `WorkItemAdmission` at the create seam: a filing path may only
 * ever mint 'pending' (gated) or 'auto' (a filing-time bypass it can justify on the
 * spot). 'admitted' is the PROMOTER's verdict and 'unreviewed' is the fail-open
 * watchdog's — neither is something a writer may claim about itself, so the type
 * refuses it rather than relying on a convention nobody reads.
 */
export type BornAdmission = Extract<WorkItemAdmission, 'pending' | 'auto'>;

export function isAdmitted(admission: string | null | undefined): boolean {
  return admission !== 'pending';
}

/**
 * The model promoter's cadence, owned HERE rather than in work-items-admission-promoter.ts
 * (which re-exports it, so its existing consumers are unchanged).
 *
 * EI-21973318733042066: the claim path has to be able to STATE the bound a pending row
 * clears within, and it must not pull a batched-LLM runner's whole module graph into every
 * claim to read one number. Owning it beside {@link isAdmitted} keeps the predicate and its
 * cadence in one module.
 */
export const DEFAULT_PROMOTER_TICK_MINUTES = 30;

/**
 * How many promoter ticks a row may sit pending before the INDEPENDENT deterministic
 * fail-open runner admits it as 'unreviewed' — `runAdmissionFailOpen`'s
 * `startedAt - 2 * tickMinutes` cutoff. This is what makes admission-pending a WAIT rather
 * than a refusal: nobody has to act for it to clear, even if the promoter is dead.
 */
export const ADMISSION_FAIL_OPEN_TICKS = 2;

/** Seconds until the promoter's next tick would normally admit a pending row. */
export function admissionPromoterTickSec(tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES): number {
  return tickMinutes * 60;
}

/** Seconds until the fail-open backstop admits a pending row regardless of the promoter. */
export function admissionFailOpenSec(tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES): number {
  return ADMISSION_FAIL_OPEN_TICKS * tickMinutes * 60;
}

/**
 * EI-24023740620851074 — worst-case seconds from a row's creation until the fail-open
 * backstop admits it. {@link admissionFailOpenSec} is the runner's CUTOFF AGE, not its
 * bound: the runner admits only rows older than the cutoff AT THE MOMENT IT FIRES, and it
 * fires once per tick (the seeded cron `0 15,45 * * * *`, pinned one tick apart by the
 * bound test). A row one second short of the cutoff at one fire waits a whole extra tick,
 * so the honest guarantee is cutoff + one cadence. Publishing the bare cutoff as
 * `guaranteedWithinSec` told refused callers to retry at ~60m for rows that could not clear
 * before ~90m — reported independently five times.
 */
export function admissionFailOpenGuaranteedSec(tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES): number {
  return admissionFailOpenSec(tickMinutes) + admissionPromoterTickSec(tickMinutes);
}

/**
 * EI-22166155287498355: whether the work-item-admission-promoter's MOST RECENT
 * completed fire ended in an error (typically LLM account exhaustion) — the one
 * fact the admission-pending claim floor needs to publish an HONEST retry bound
 * instead of the promoter's healthy-cadence figure unconditionally.
 *
 * The refusal text used to say "typically within ~30m" whether or not the
 * promoter was actually doing that job — a routine that is `active:true` with a
 * recent `lastFiredAt` reads as healthy on every liveness surface even while its
 * WORK errors out every tick, so a caller had no way to tell "not yet" from "the
 * mechanism that would admit this is currently dead" (measured: fleet-wide
 * admission latency silently doubled to the fail-open bound for over an hour).
 *
 * `metadata.last_error` is CLEARED on every successful runner fire and SET on
 * every failed one (packages/operator-core/lib/dbos/routines-workflow.ts,
 * last_error_source:'runner'), so its mere presence already answers the question
 * — no extra staleness/consecutive-tick math needed.
 *
 * ⚠ EI-23383710942512978 — THAT LAST PARAGRAPH IS ONLY TRUE WHILE THE ROUTINE
 * STILL FIRES. "cleared on success, set on failure" is a statement about FIRES,
 * so the moment a routine stops firing, `last_error` FREEZES at whatever the
 * final fire left and nothing will ever clear it. A deliberate pause stops the
 * firing — so a promoter the OWNER paused reports its last pre-pause error
 * forever, and the floor rendered that as "the promoter's last fire errored, so
 * duplicate screening is currently NOT running".
 *
 * That misattribution is the actively dangerous direction: it reads as "a
 * background routine is broken", which invites the reader to re-arm it — and
 * here the routine was an LLM-SPENDING loop the owner paused with "re-arm only
 * on the owner's word". Measured 2026-09-16: `last_fired_at` 16:00:03Z preceded
 * `metadata.pause.pausedAtMs` 16:04:03Z by four minutes, and two separate agents
 * were sent to investigate a promoter fault that did not exist (one filed it as
 * a fleet-wide bug).
 *
 * So the cause is classified, not collapsed to a boolean. `routines:list` has
 * documented this exact distinction all along — "non-null `paused` means a
 * DELIBERATE hold ... a bare active:false with paused:null is the one worth
 * investigating" — and this floor simply did not honour it.
 *
 * Read-only, single indexed row lookup (routines_install_slug_name_key), and
 * fail-open on any query problem: an unreadable health signal must never make an
 * admission-pending refusal look WORSE than the caller already sees (same posture
 * as {@link loadOwnAuthorPubkeys} above).
 */
export type AdmissionPromoterStall =
  /** The promoter is armed and its last fire succeeded — the ordinary case. */
  | { stalled: false }
  /** Deliberately held by an operator/owner. NOT a fault; must not be re-armed to unblock a claim. */
  | { stalled: true; cause: 'paused'; pauseReason: string | null }
  /** Armed, but its last fire errored — the genuine fault this predicate was born for. */
  | { stalled: true; cause: 'errored' }
  /** Inactive with NO pause record: stopped, and nothing durable says why. Worth investigating. */
  | { stalled: true; cause: 'inactive' };

/** The row shape {@link classifyAdmissionPromoterStall} decides from. */
export interface AdmissionPromoterRow {
  active: boolean | null;
  lastFiredAtMs: number | null;
  /** Raw `metadata.pause` jsonb — parsed here via the shared {@link readRoutinePause}. */
  pause: unknown;
  lastError: string | null;
}

/**
 * The PURE decision behind {@link admissionPromoterStall}, split out so the
 * ordering rule above is unit-testable without a database — the DB half is a
 * single indexed SELECT with nothing to get wrong, and this half is where the
 * misattribution actually lived.
 */
export function classifyAdmissionPromoterStall(row: AdmissionPromoterRow): AdmissionPromoterStall {
  const pause = readRoutinePause(row.pause);
  const lastError = row.lastError && row.lastError.length > 0 ? row.lastError : null;

  if (pause.present) {
    // A deliberate hold OUTRANKS a stale error, but only when the error really is
    // an artifact of the last fire BEFORE the pause. If the routine somehow fired
    // and failed AFTER being paused, that error is live news and still wins —
    // "prefer paused" must not become "suppress every error on a paused routine".
    const errorPostDatesPause =
      lastError !== null &&
      pause.pausedAtMs !== null &&
      row.lastFiredAtMs !== null &&
      row.lastFiredAtMs > pause.pausedAtMs;
    if (!errorPostDatesPause) return { stalled: true, cause: 'paused', pauseReason: pause.reason };
    return { stalled: true, cause: 'errored' };
  }

  // No pause record. An inactive routine is stopped for an UNRECORDED reason, which
  // is a different (and more suspicious) thing than one that is armed and erroring.
  if (row.active === false) return { stalled: true, cause: 'inactive' };
  return lastError !== null ? { stalled: true, cause: 'errored' } : { stalled: false };
}

export async function admissionPromoterStall(workspaceId: string): Promise<AdmissionPromoterStall> {
  if (!workspaceId) return { stalled: false };
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      { active: boolean | null; last_fired_at: Date | null; pause: unknown; last_error: string | null }[]
    >`
      SELECT active,
             last_fired_at,
             metadata->'pause'      AS pause,
             metadata->>'last_error' AS last_error
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId}
         AND install_slug = ${operatorHomeHarnessSlug()}
         AND name = 'work-item-admission-promoter'
       LIMIT 1`;
    const row = rows[0];
    if (!row) return { stalled: false };
    const firedMs = row.last_fired_at ? new Date(row.last_fired_at).getTime() : Number.NaN;
    return classifyAdmissionPromoterStall({
      active: row.active,
      lastFiredAtMs: Number.isFinite(firedMs) ? firedMs : null,
      pause: row.pause,
      lastError: row.last_error,
    });
  } catch {
    return { stalled: false };
  }
}

/** Clip a pause reason into refusal text without letting an essay dominate the message. */
const clipReason = (reason: string): string =>
  reason.length <= 240 ? reason : `${reason.slice(0, 237).trimEnd()}...`;

/**
 * The refusal `basis` for each stall cause. Lives beside the predicate (like
 * {@link admissionPendingExplanation} and {@link admissionPendingCreateRemedy})
 * so the cause and the sentence describing it cannot drift apart.
 *
 * Every stalled cause shares the SAME bound — the fail-open runner is the only
 * thing admitting rows in all three — so what changes here is the ATTRIBUTION,
 * which is the whole defect: the bound was already honest, the blame was not.
 */
export function admissionStallBasis(stall: AdmissionPromoterStall): string {
  const failOpenTail =
    'the independent work-item-admission-fail-open runner is the only mechanism presently admitting rows';
  if (!stall.stalled) {
    return (
      'the work-item-admission-promoter cron tick, with the independent ' +
      'work-item-admission-fail-open runner as the backstop if that promoter is dead'
    );
  }
  if (stall.cause === 'paused') {
    return (
      'duplicate screening is PAUSED BY A DELIBERATE HOLD, not broken — ' +
      (stall.pauseReason ? `the recorded reason is: "${clipReason(stall.pauseReason)}"; ` : 'no reason was recorded; ') +
      'do NOT re-arm the promoter to unblock this claim (it is a background LLM-spending loop and the ' +
      `hold may be an owner directive); ${failOpenTail}`
    );
  }
  if (stall.cause === 'inactive') {
    return (
      'the work-item-admission-promoter is INACTIVE with no recorded pause reason, so duplicate ' +
      `screening is currently NOT running and nothing durable says why; ${failOpenTail}`
    );
  }
  return (
    "the work-item-admission-promoter's last fire errored, so duplicate screening is " +
    `currently NOT running; ${failOpenTail}`
  );
}

/**
 * The create-time admission bypasses: the durable `admitted_by` value each one writes,
 * paired with the caller-facing condition that earns it. ONE source — the create path
 * mints from these literals (typed as {@link AdmissionBypassReason}, so removing one is a
 * compile error there) and the claim path's admission-pending remedy is RENDERED from this
 * record, so a bypass added or removed cannot leave either surface behind.
 *
 * EI-21973318733042066 is why the remedy has to be rendered rather than written out: the
 * reporter proposed "let an item's creator name a specific intended owner, so it bypasses
 * screening" as a NEW mechanism. `bypass:explicit-assignment` already IS that mechanism —
 * 235 uses in the three days before the report — and nothing on the refusal path said so,
 * so a launched agent hit a 30-minute wall that its creator could have avoided for free.
 */
export const ADMISSION_CREATE_BYPASSES = [
  { reason: 'bypass:plan-item', condition: 'the item implements a plan item' },
  { reason: 'bypass:severity-critical', condition: "severity:'critical'" },
  { reason: 'bypass:topic-security', condition: "a 'security' topic" },
  { reason: 'bypass:explicit-assignment', condition: 'assign_to names the intended owner' },
] as const satisfies readonly { reason: string; condition: string }[];

export type AdmissionBypassReason = (typeof ADMISSION_CREATE_BYPASSES)[number]['reason'];

/**
 * The operator-facing explanation of the `admission-pending` claim floor, with its bound
 * DERIVED from the cadence above rather than restated. The old string said only "wait for
 * admitted/unreviewed", which is why the reporter could not tell "not yet" from "never".
 */
export function admissionPendingExplanation(tickMinutes = DEFAULT_PROMOTER_TICK_MINUTES): string {
  return (
    'duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or ' +
    'fleet process; launch and queue admission are separate capabilities. A launched agent still needs ' +
    'claimable or validly pre-assigned work. The durable promoter owns admission, and this floor CLEARS ON ITS ' +
    `OWN: the promoter runs on a ${tickMinutes}-minute tick, and an independent fail-open runner ` +
    `admits anything still pending after ${ADMISSION_FAIL_OPEN_TICKS} ticks ` +
    `(${ADMISSION_FAIL_OPEN_TICKS * tickMinutes} min) as 'unreviewed'. It is a WAIT, not a permanent ` +
    'refusal — but a just-created item is typically unclaimable for most of a tick, which outlives ' +
    'many short-lived agents, so waiting is often the wrong move.'
  );
}

/**
 * What the caller can actually DO about an admission-pending refusal. Rendered from
 * {@link ADMISSION_CREATE_BYPASSES} so it cannot drift from the create path that honours it.
 */
export function admissionPendingCreateRemedy(): string {
  return (
    'Choose the work route before creating a replacement. Existing-plan fleet work should use ' +
    'plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc ' +
    'work should be created atomically with assign_to naming the intended owner, then launched with ' +
    'capability:launch-agent. Any one of these makes a NEW item born admitted: ' +
    ADMISSION_CREATE_BYPASSES.map((b) => b.condition).join('; ') +
    '. These are create-time admission bypasses, not blanket authority: assign_to is still checked ' +
    "against the target's live fleet scope, dependencies, locks, security, credentials and resource " +
    'admission; a scope mismatch files the item unassigned and explains why. Launching does not change ' +
    'an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; ' +
    'only the existing server-derived dispatch/force paths may grant their narrower exceptions.'
  );
}

/**
 * SQL form of {@link isAdmitted} — UNQUALIFIED columns, for single-table queries over
 * `harness_features_consolidated` / `work_items`, matching {@link autoPickableWhereSql}.
 *
 * `IS DISTINCT FROM` rather than `<> 'pending' OR IS NULL`: plain `<>` is NULL-false in
 * three-valued logic, which would silently exclude every legacy row — the exact
 * negated-predicate trap the own-author leg's comment warns about.
 */
export function admittedWhereSql(sql: OrgSql, qualifier?: 'wi' | 'ei') {
  // `qualifier` is a closed internal union, never caller input. Keeping all three
  // relation shapes behind this one builder prevents the feature view, the issue
  // base table, and the aliased engineer_issues listing from drifting into subtly
  // different NULL semantics.
  const column = sql.unsafe(qualifier ? `${qualifier}.admission` : 'admission');
  return sql`(${column} IS DISTINCT FROM 'pending')`;
}

/**
 * `wi.`-qualified form — compose ONLY into the issue claim/diagnose queries that alias
 * the base table as `wi` (same contract as {@link isIssueLocallyClaimableWhereSql}).
 */
export function admittedWhereSqlWi(sql: OrgSql) {
  return admittedWhereSql(sql, 'wi');
}

/**
 * SQL form — a composable WHERE fragment for the porsager `sql` instance the caller
 * already holds (so it composes into that query). Columns are UNQUALIFIED — use only
 * in single-table queries over `harness_features_consolidated` (every claim/place
 * chokepoint is one). Pass the caller's own `sql`.
 *
 *   ...WHERE ... AND ${autoPickableWhereSql(sql)}
 */
export function autoPickableWhereSql(sql: OrgSql, workspaceId?: string) {
  // TRUST fast-path (Phase 3 / P-010). The subquery MUST be explicitly scoped to
  // `workspaceId` — NOT left to user_trust_list's RLS — because the admin db
  // handle BYPASSES RLS at some claim chokepoints, so an unscoped subquery would
  // trust-admit a workspace-A feature whose verified author is trusted in
  // workspace B (a cross-workspace trust leak, D-004). `workspaceId` omitted ⇒ the
  // trust leg is dropped entirely (fail-safe: the gate only ever UNDER-admits when
  // the caller can't scope it — never over-admits). verified_author_github_user_id
  // (P-008) is NULL for local / unverified / revoked-binding rows, so only a
  // genuinely-verified trusted author satisfies it.
  const trustLeg = workspaceId
    ? sql` OR (verified_author_github_user_id IS NOT NULL AND verified_author_github_user_id IN (SELECT trusted_github_user_id FROM harness_shared.user_trust_list WHERE workspace_id = ${workspaceId}))`
    : sql``;
  const ownLeg = workspaceId ? sql` OR ${ownAuthorWhereSql(sql, workspaceId)}` : sql``;
  return sql`(origin = 'local' OR origin IS NULL OR audit_verdict = 'admit'${trustLeg}${ownLeg})`;
}

/**
 * OWN-NODE admission leg — the default that makes a single owner's own machines
 * trust each other with no configuration [owner 2026-07-13: "trust our own
 * nodes ... that should be the default. all new papercusp installs should have
 * that behavior without needing to do anything"].
 *
 * WHY THIS EXISTS. `origin` records HOW A ROW ARRIVED, not who wrote it: an item
 * this workspace authored itself, once it round-trips through the 2-machine
 * federation path, comes back projected as origin='remote'. With the auditor lane
 * unbuilt (nothing in production has ever written audit_verdict) and the trust list
 * empty, such a row satisfied NO leg of the gate — so a pot whose whole frontier had
 * federated was quarantined against ITSELF: the Queen surveyed a frontier of zero,
 * correctly placed nothing, and reported success. Silent placement deadlock.
 *
 * WHAT MAKES A KEY "OURS" — and why this is sound rather than a loophole. A row is
 * stamped origin='local' only when OUR OWN core writes it; a peer's row is projected
 * as 'remote'. So "has authored a local-origin row in THIS workspace" is a property a
 * foreign key cannot manufacture from the outside — it is evidence our own substrate
 * log produced that key's writes. It also needs no registry and no setup: a fresh
 * install's first local write enrolls its own key, and a stranger's key never appears.
 *
 * NOT the device-attestation key space. `pot_members.device_attestations[].device_pubkey`
 * is a DIFFERENT key (and base64, where author_pubkey is hex) — it does not identify the
 * substrate log author, so it cannot answer this question.
 *
 * LOAD-BEARING GUARDS:
 *   - workspace-scoped (D-004), for the same admin-handle/RLS-bypass reason as the
 *     trust leg above; `workspaceId` omitted ⇒ the leg is dropped (fail-safe).
 *   - author_pubkey <> '' on BOTH sides. Blank-authored local rows exist (a pre-
 *     federation back-compat case); without this guard '' would enter the own-key set
 *     and admit EVERY remote row that also carries a blank author — turning a scoped
 *     trust decision into an open door.
 * The leg is POSITIVE (an OR arm), so a NULL author_pubkey is falsy in WHERE and simply
 * fails to admit — the three-valued-logic trap only bites a NEGATED predicate.
 */
export function ownAuthorWhereSql(sql: OrgSql, workspaceId: string) {
  return sql`(author_pubkey IS NOT NULL AND author_pubkey <> '' AND author_pubkey IN (
    SELECT DISTINCT author_pubkey
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND (origin = 'local' OR origin IS NULL)
       AND author_pubkey IS NOT NULL
       AND author_pubkey <> ''
  ))`;
}

/**
 * ISSUE-FAMILY own-node leg (work-item-status-full-unify / owner 2026-07-20 "these can't be
 * truly remote"). The FEATURE family already trusts its own nodes via {@link ownAuthorWhereSql}
 * (owner 2026-07-13 "trust our own nodes = the default"); the issue family (isIssueLocallyClaimable)
 * historically hard-refused any origin!='local', with NO escape hatch. But `origin` records HOW a
 * row ARRIVED, not WHO wrote it: a bug THIS box authored, once it round-trips the hyperbee
 * federation, comes back projected origin='remote' — and when the box's substrate node identity
 * drifts (re-provision / device re-key / hive re-join), work authored under the OLD identity is
 * orphaned as un-claimable. This leg admits a remote issue whose author_pubkey is one this
 * workspace has ALSO written locally (evidence OUR substrate log produced it — a foreign key can't
 * manufacture that). Own-keys come from the work_items BASE (ALL families), because a substrate key
 * authors both features and issues; {@link ownAuthorWhereSql}'s harness_features_consolidated
 * source would miss an identity that authored only issues. Columns are `wi.`-qualified — compose
 * ONLY into the issue claim/diagnose queries that alias the base table as `wi`. Same LOAD-BEARING
 * guards as ownAuthorWhereSql: workspace-scoped (D-004), author_pubkey<>'' on BOTH sides.
 */
export function issueOwnAuthorWhereSql(sql: OrgSql, workspaceId: string) {
  return sql`(wi.author_pubkey IS NOT NULL AND wi.author_pubkey <> '' AND wi.author_pubkey IN (
    SELECT own.author_pubkey
      FROM harness_shared.work_items own
     WHERE own.workspace_id = ${workspaceId}
       AND (own.origin = 'local' OR own.origin IS NULL)
       AND own.author_pubkey IS NOT NULL
       AND own.author_pubkey <> ''
  ))`;
}

/**
 * The issue-family locally-claimable SQL floor, own-node aware — the composable counterpart of
 * {@link isIssueLocallyClaimable}. `(origin local/null OR own-node)`; `workspaceId` omitted ⇒ the
 * own-node leg is dropped (fail-safe: only ever UNDER-admits when unscoped). `wi.`-qualified.
 */
export function isIssueLocallyClaimableWhereSql(sql: OrgSql, workspaceId?: string) {
  const ownLeg = workspaceId ? sql` OR ${issueOwnAuthorWhereSql(sql, workspaceId)}` : sql``;
  return sql`(wi.origin IS NULL OR wi.origin = 'local'${ownLeg})`;
}

/**
 * JS counterpart of {@link isIssueLocallyClaimableWhereSql} for a fetched row: local (origin
 * null/'local') OR its author is one of OUR own-node keys (load via {@link loadOwnAuthorPubkeys}).
 * `ownKeys` empty ⇒ degrades to the origin-only check (fail-safe).
 */
export function isIssueLocallyClaimableWithOwn(
  origin: string | null | undefined,
  authorPubkey: string | null | undefined,
  ownKeys: ReadonlySet<string>,
): boolean {
  if (isIssueLocallyClaimable(origin)) return true;
  return !!authorPubkey && authorPubkey !== '' && ownKeys.has(authorPubkey);
}

/**
 * Load this workspace's OWN substrate-log author keys — the JS-gate counterpart of
 * {@link ownAuthorWhereSql}. Workspace-scoped (D-004). Empty set on any read failure
 * (fail-safe: no own-node fast-path rather than over-broad admission).
 *
 * work-item-status-full-unify: derives from the work_items BASE (all families) so it also
 * feeds the issue-family own-node leg ({@link isIssueLocallyClaimableWithOwn}).
 */
export async function loadOwnAuthorPubkeys(workspaceId: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!workspaceId) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ author_pubkey: string }[]>`
      SELECT DISTINCT author_pubkey
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND (origin = 'local' OR origin IS NULL)
         AND author_pubkey IS NOT NULL
         AND author_pubkey <> ''`;
    for (const r of rows) if (r.author_pubkey) out.add(r.author_pubkey);
  } catch {
    /* fail-safe — empty set ⇒ own-node fast-path simply doesn't fire */
  }
  return out;
}

/**
 * P-008 (Phase 2) — the PRODUCER side of the trust gate: resolve a federated
 * feature's `author_pubkey` to a github_user_id ONLY via a VERIFIED, non-revoked
 * device attestation in `hive_members` — never a self-claimed id. Returns NULL
 * when the pubkey has no such attestation (the caller stores NULL → the gate
 * conservatively refuses the trust fast-path). The trust DECISION stays at the
 * consumer (isAutoPickable / autoPickableWhereSql, ws-scoped per D-004); this
 * only establishes "who, provably, authored it".
 *
 * Security invariants (contributor-row-types.ts DeviceAttestationEntry +
 * revoked_pubkeys "a verifier MUST refuse any attestation whose pubkey is here"):
 *   - binding_status = 'verified'  (BINDING_STATUSES: verified|pending|unverified)
 *   - author_pubkey ∈ device_attestations (an attested binding exists)
 *   - author_pubkey ∉ revoked_pubkeys (the device wasn't revoked)
 *   - workspace-scoped (hive_members is owner/workspace-keyed); pot_home_slug
 *     narrows further when known. The COALESCE guards keep a member with a NULL
 *     revoked_pubkeys / device_attestations from being wrongly excluded/erroring.
 */
export async function resolveVerifiedAuthorGithubId(
  sql: OrgSql,
  opts: { workspaceId: string; authorPubkey: string | null | undefined; potHomeSlug?: string },
): Promise<number | null> {
  try {
    return await readVerifiedAuthorGithubId(sql, opts);
  } catch {
    // Best-effort + FAIL-SAFE: an unreadable/absent hive_members (e.g. a transient
    // error, or a projection running against a partial schema) yields NULL → the
    // trust fast-path simply doesn't fire (the gate conservatively refuses), and
    // the federated-ingest projection loop is never crashed by the optional stamp.
    return null;
  }
}

/**
 * {@link resolveVerifiedAuthorGithubId} without the fail-safe: a read error throws.
 * P-537: a batchable projection needs the error, because inside the merge's batch it
 * aborted the transaction and must be followed by `projectionStatementFailed()`.
 */
export async function readVerifiedAuthorGithubId(
  sql: OrgSql,
  opts: { workspaceId: string; authorPubkey: string | null | undefined; potHomeSlug?: string },
): Promise<number | null> {
  const pubkey = (opts.authorPubkey ?? '').trim();
  if (!pubkey || !opts.workspaceId) return null;
  const hiveFilter = opts.potHomeSlug ? sql`AND pot_home_slug = ${opts.potHomeSlug}` : sql``;
  const rows = await sql<{ github_user_id: string | number }[]>`
    SELECT github_user_id
      FROM harness_shared.pot_members
     WHERE workspace_id = ${opts.workspaceId}
       ${hiveFilter}
       AND binding_status = 'verified'
       AND NOT (${pubkey} = ANY(COALESCE(revoked_pubkeys, ARRAY[]::text[])))
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(device_attestations, '[]'::jsonb)) a
          WHERE a->>'device_pubkey' = ${pubkey}
       )
     LIMIT 1`;
  if (!rows[0]) return null;
  const raw = rows[0].github_user_id;
  const id = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(id) ? id : null;
}

/**
 * Load the owner's LOCAL trust list for a workspace as a Set<github_user_id> —
 * the JS-gate (isAutoPickable) counterpart of the SQL trust subquery. WORKSPACE-
 * SCOPED (D-004: the list is owner/workspace-keyed; a remote item must only be
 * trust-admitted against its OWN workspace's list, never cross-workspace). Empty
 * set on any read failure (fail-safe: no trust fast-path rather than over-broad).
 */
export async function loadTrustedGithubUserIds(workspaceId: string): Promise<Set<number>> {
  const out = new Set<number>();
  if (!workspaceId) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ trusted_github_user_id: string | number }[]>`
      SELECT trusted_github_user_id FROM harness_shared.user_trust_list
       WHERE workspace_id = ${workspaceId}`;
    for (const r of rows) {
      const raw = r.trusted_github_user_id;
      const id = typeof raw === 'string' ? Number(raw) : raw;
      if (Number.isFinite(id)) out.add(id);
    }
  } catch {
    /* fail-safe — empty set ⇒ trust fast-path simply doesn't fire */
  }
  return out;
}

/**
 * Per-id admission read for paths that don't already SELECT the item's provenance —
 * the replica lane reads `work_item_replicas`, not the consolidated feature row. Reads
 * origin + audit_verdict and applies {@link isAutoPickable}. A missing row returns
 * `false` (fail-safe: a vanished/foreign item never slips through here; the caller's
 * own not-found handling runs first for the legitimate-missing case).
 */
export async function isWorkItemAutoPickable(
  workItemId: string,
  opts: { harness: string; workspaceId?: string },
): Promise<boolean> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<
    {
      origin: string | null;
      audit_verdict: string | null;
      admission: string | null;
      verified_author_github_user_id: number | string | null;
      author_pubkey: string | null;
    }[]
  >`
    SELECT origin, audit_verdict, admission, verified_author_github_user_id, author_pubkey
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${opts.harness}
       AND workspace_id = ${ws}
       AND feature_id = ${workItemId}
     LIMIT 1`;
  if (!rows[0]) return false;
  if (!isAdmitted(rows[0].admission)) return false;
  // Local / auditor-admitted fast path (no trust-list read needed).
  if (isAutoPickable(rows[0].origin, rows[0].audit_verdict)) return true;
  // OWN-NODE fast-path: authored by a key this workspace knows as its own. Checked
  // in SQL against the SAME definition ownAuthorWhereSql uses, so this per-id path
  // can't drift from the claim/place chokepoints.
  const pubkey = rows[0].author_pubkey;
  if (pubkey) {
    const own = await sql`
      SELECT 1
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${ws}
         AND (origin = 'local' OR origin IS NULL)
         AND author_pubkey = ${pubkey}
       LIMIT 1`;
    if (own.length > 0) return true;
  }
  // TRUST fast-path: a remote+un-admitted item whose VERIFIED author is in this
  // workspace's local trust list (explicitly ws-scoped — D-004). NULL verified id
  // (unverified / revoked / local) never qualifies.
  const raw = rows[0].verified_author_github_user_id;
  const verifiedId = raw == null ? null : typeof raw === 'string' ? Number(raw) : raw;
  if (verifiedId == null || !Number.isFinite(verifiedId)) return false;
  const trusted = await sql`
    SELECT 1 FROM harness_shared.user_trust_list
     WHERE workspace_id = ${ws} AND trusted_github_user_id = ${verifiedId} LIMIT 1`;
  return trusted.length > 0;
}

/**
 * Per-id duplicate-screening read for consumers that hydrate the legacy WorkItem
 * projection (which intentionally does not grow a new selected column for every
 * lifecycle axis). IDs are workspace-unique across both physical families, so the
 * shared base table is the one exact read. Missing rows fail safe.
 */
export async function isWorkItemDuplicateAdmitted(
  workItemId: string,
  opts: { workspaceId?: string } = {},
): Promise<boolean> {
  if (!workItemId) return false;
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ admission: string | null }[]>`
    SELECT admission
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws} AND feature_id = ${workItemId}
     LIMIT 1`;
  return rows[0] ? isAdmitted(rows[0].admission) : false;
}

/**
 * STOP-THE-LINE — the third, orthogonal admission axis (P-013 / D-012 of
 * gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * WHY IT LIVES HERE: same reason as the duplicate-screening axis above — this file is
 * "the SINGLE source of truth for is-this-claimable", and an admission rule defined next
 * to one consumer silently fails to reach the others (this module's header). A parallel
 * gate module would repeat that mistake.
 *
 * WHAT IT SAYS: while the release gate on a harness has been RED-STREAKING for longer
 * than {@link STOP_THE_LINE_RED_HOURS}, non-repair work must not be SELF-SELECTED on
 * that harness — the fleet converges on repair instead of piling new commits onto a
 * broken tree. "A days-red gate being everyone's problem becomes mechanical, not
 * aspirational" (the plan item's own words).
 *
 * THE SIGNAL is the OPEN `gate-red-streak:<harness>` condition item's AGE — P-014's
 * audited condition-singleton substrate (D-010): opened by `trackGateStall`
 * (harness/routines/release-actions.ts) at the same edge as the red-streak alarm,
 * settled by the condition bridge when the gate greens. So the throttle arms and lifts
 * with zero state of its own, and the condition item doubles as the KILL-SWITCH: a
 * stale-open item (bridge missed the green) is lifted by ANY agent settling it — no
 * flag flip, no deploy (D-012 records why there is deliberately no feature flag).
 * NOT gate_health: that lives in per-install routine metadata JSON, and its greenness
 * semantics already burned once (EI-20706962612084953).
 *
 * EXEMPT (the plan item: "repair lanes, infra fixes, and owner-directed work"):
 *   - `item_kind = 'bug'` — fixes ARE the line; never throttled (issue family only).
 *   - alarm-condition items — `condition_key` under an actionable/alarm prefix
 *     ({@link STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES}). Deliberately NOT every
 *     condition item: `plan-promotion:` / `spec-triad:` conditions are ordinary work
 *     inflow, which is exactly what stops (measured 2026-09-01: the live condition-key
 *     population is dominated by plan-promotion rows).
 *   - owner-directed work — a named BY-ID claim bypasses self-select floors by existing
 *     architecture (agent-tools/work_items/claim.ts: "floors gate self-select only; a
 *     named by-id claim is the deliberate operator override"). No code here; recorded
 *     so the mapping is explicit.
 *   NOT exempt: plan-promoted inflow (`bypass:plan-item` admission) — stopping routine
 *   plan work is the point.
 *
 * FAIL-SAFE DIRECTION: like the G2 legs, unknown ⇒ the floor PASSES (no open condition
 * row ⇒ no throttle). The trigger row is minted by exactly one writer under migration
 * 741's partial unique index, so "open and old" is a deliberate, serialized state —
 * never an inference from a metric.
 *
 * Row-EXTRINSIC, like `depsBlockedExclusionSql` — so it belongs to the CLAIM floors
 * (candidate subquery + feature claimFloorsWhereSql), NOT to issueAdmissibleWhereSql's
 * row-intrinsic advertise mirror (issues-engineer.ts documents that boundary:
 * "work_items:claimable remains the only full oracle").
 */
export const STOP_THE_LINE_RED_HOURS = 24;

/** The red-streak condition prefix — must match the trackGateStall producer's key. */
export const GATE_RED_STREAK_CONDITION_PREFIX = 'gate-red-streak:';

/**
 * Condition singletons that OWN live release-gate operations. They are ordinary
 * issue-family bugs so the stop-the-line repair exemption correctly keeps the
 * repair LANE flowing, but the singleton itself must never circulate through
 * opportunistic self-select: exactly one registered gate fixer claims it by id.
 *
 * Keep this list intentionally narrower than ACTIONABLE_CONDITION_PREFIXES.
 * Most actionable alarms are normal repair work; only these two prefixes carry
 * the live gate-control-plane exclusivity contract (release/gate-red-ownership).
 */
export const LIVE_GATE_OPS_CONDITION_PREFIXES = [GATE_RED_STREAK_CONDITION_PREFIX, 'green-stall:'] as const;

/**
 * TRUE means an issue row may survive the LIVE_GATE_OPS reservation floor.
 * This fragment is composed only into issue-family SELF-SELECT reads/writes;
 * the named claim-by-id path deliberately bypasses it, which is how the
 * registered live gate fixer acquires the singleton.
 */
export function liveGateOpsSelfSelectExclusionSql(sql: OrgSql) {
  const reservedPatterns = LIVE_GATE_OPS_CONDITION_PREFIXES.map((prefix) => `${prefix}%`);
  return sql`(
    wi.condition_key IS NULL
    OR NOT (wi.condition_key LIKE ANY(${reservedPatterns as string[]}::text[]))
  )`;
}

/** Static per-id refusal text; unlike stop-the-line, no harness-specific value is needed. */
export function liveGateOpsSelfSelectExplanation(): string {
  return (
    'LIVE_GATE_OPS condition singleton (gate-red-streak: or green-stall:) — reserved to the ' +
    'one registered live gate fixer and excluded from opportunistic self-select. A leader/owner ' +
    'may still dispatch or claim it BY ID after checking gate.greenCheckpoint.ownership.'
  );
}

/**
 * Condition-key prefixes whose items stay claimable while the line is stopped: the
 * alarm/repair catalog ({@link ACTIONABLE_CONDITION_PREFIXES}, the condition-bridge
 * opt-in set) plus `deploy-parity:`, which P-015 files DIRECTLY via
 * `work_items:create { conditionKey }` rather than through the bridge catalog
 * (apps/operator/lib/release/deploy-parity.ts) and is repair work by construction.
 */
export const STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES: readonly string[] = [
  ...ACTIONABLE_CONDITION_PREFIXES,
  'deploy-parity:',
];

/**
 * Which relation shape the floor is being composed into. A closed internal union —
 * never caller input — same safety argument as {@link admittedWhereSql}'s qualifier.
 *   'issue-wi'             — the issue claim/diagnose queries aliasing work_items as `wi`.
 *   'feature-consolidated' — claimFloorsWhereSql's unaliased harness_features_consolidated
 *                            context (correlated refs need the full relation name there,
 *                            matching that builder's own cooldown EXISTS).
 */
export type StopTheLineRowContext = 'issue-wi' | 'feature-consolidated';

/**
 * SQL floor: TRUE ⇒ the candidate row survives stop-the-line (claimable as far as this
 * axis is concerned). Compose like the sibling floors:
 *
 *   ...AND ${stopTheLineExclusionSql(sql, 'issue-wi')}
 *
 * The inner EXISTS probes the open red-streak condition row for the CANDIDATE ROW'S OWN
 * workspace+harness, so only the affected harness throttles; migration 741's partial
 * unique index on open condition keys makes the probe an index hit.
 *
 * The feature-consolidated form has no `condition_key` column on the view (verified
 * 2026-09-01 against information_schema) and its kinds are placement kinds, so it gets
 * no per-row exemption legs — while the line is stopped, feature placement self-select
 * on the harness pauses entirely.
 */
export function stopTheLineExclusionSql(sql: OrgSql, rowContext: StopTheLineRowContext) {
  const q = rowContext === 'issue-wi' ? 'wi.' : 'harness_shared.harness_features_consolidated.';
  const activeRedStreak = sql`EXISTS (
    SELECT 1
      FROM harness_shared.work_items stl
     WHERE stl.workspace_id = ${sql.unsafe(`${q}workspace_id`)}
       AND stl.harness_slug = ${sql.unsafe(`${q}harness_slug`)}
       AND stl.condition_key = ${GATE_RED_STREAK_CONDITION_PREFIX} || stl.harness_slug
       AND NOT (stl.status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
       AND stl.created_ts <= (EXTRACT(EPOCH FROM now()) * 1000)::bigint - ${STOP_THE_LINE_RED_HOURS * 3600 * 1000}
  )`;
  if (rowContext === 'feature-consolidated') {
    return sql`(NOT ${activeRedStreak})`;
  }
  const exemptPrefixPatterns = STOP_THE_LINE_EXEMPT_CONDITION_PREFIXES.map((p) => `${p}%`);
  return sql`(
    wi.item_kind = 'bug'
    OR (wi.condition_key IS NOT NULL AND wi.condition_key LIKE ANY(${exemptPrefixPatterns as string[]}::text[]))
    OR NOT ${activeRedStreak}
  )`;
}

/**
 * The stop-the-line refusal/diagnosis explanation — rendered wherever the `stopTheLine`
 * exclusion bucket surfaces, so a throttled queue reads as a VERDICT with a remedy,
 * never as a drained lane (the context-pressure-claim-gate lesson: a refusal must be a
 * verdict, not silence).
 */
export function stopTheLineExplanation(harness: string): string {
  return (
    `stop-the-line: the ${harness} release gate has been red for over ${STOP_THE_LINE_RED_HOURS}h ` +
    `(an open gate-red-streak:${harness} condition item older than the threshold), so non-repair ` +
    'work is not served for self-select on this harness. Repair work still flows: bugs and ' +
    'alarm-condition items are exempt, and a leader/owner can still dispatch any item BY ID. ' +
    'The throttle lifts on its own when the gate greens (the condition bridge settles the item). ' +
    'If the gate is ACTUALLY green and this persists, the condition item is stale — settling it ' +
    'lifts the throttle immediately.'
  );
}
