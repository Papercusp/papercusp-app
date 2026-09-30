/**
 * draft-review-watchdog.ts — the Queen↔Scout feedback-loop ANTI-STARVATION backstop
 * (queen-scout-feedback-loop-2026-06-20 D-003 #2, hardening).
 *
 * ⚠ RECIPIENT, POST-RETIREMENT (blender-su-grade-integration-2026-08-11 P-012): every
 * "the Queen" below is HISTORICAL. The Queen is retired
 * (retire-mug-kettle-su-only-2026-08-09); drafts are now reviewed and disposed by the
 * Blender STEWARD — a GOAL-mode su holding the Blender goal — reached through the nudge
 * ladder (nudge-recipient.ts), not by a role lookup.
 *
 * The starvation ARGUMENT below survives the rename intact, and is worth reading on its
 * own terms: it is about a consumer that only acts when IDLE while placement always
 * wins, which is a property of the scheduling relationship, not of the Queen. A steward
 * with its own self-paced loop can starve the same way, which is why this backstop is
 * still live rather than retired alongside the role that named it.
 *
 * THE STARVATION (the root cause this closes): the Scout produces draft plans on a
 * friction-OR-idle cadence (the bp-singleton-scout-0 blueprint, every 30m) and pings
 * the Queen via a DURABLE coord message with NO forced wake (mug-notify.ts:
 * notifyMugDraftRouted → `send`, never `wakeRecipients` — "review is idle-gated per
 * D-003 #2; placement always wins"). So the Queen only REVIEWS scout-routed drafts on
 * an IDLE wake (the `plan-review` idle activity). When the hive's bee slots are
 * chronically full ("fleet saturated"), the Queen is NEVER idle → review never runs →
 * scout-routed drafts (status='draft', origin='scout') sit unreviewed for days, neither
 * ratified (launched) nor deprecated-with-learnings. The Scout keeps producing; the
 * Queen never consumes; the link starves.
 *
 * THE FIX (deadline → friction wake): a deterministic, zero-token sweep on the existing
 * 30s routinesTick. For each STARTED hive it finds scout-routed drafts that have been
 * unreviewed past a deadline and fires ONE debounced WAKE to the live Queen — moving the
 * stale draft off the idle-only path onto the FRICTION wake path, so review competes as
 * normal work. It NEVER ratifies or deprecates a draft (that would fake the link); the
 * Queen still disposes (promote / iterate / deprecate-with-learnings). It is a BACKSTOP,
 * not a cadence: every check is a cheap SQL read and the wake is the exception path.
 *
 * Mirrors the hive watchdog patterns (hive/watchdog.ts pausedHiveRecoverySweep +
 * hive/placement-watchdog.ts fireRecoveryWake): pure deciders split from the PG sweep,
 * env-tunable threshold with a `<=0` kill switch, per-hive debounce over the existing
 * `hive_watchdog_fires` ledger (source='scout-draft-review'), and fail-soft throughout —
 * a watchdog that throws into its caller guards nothing. DEFAULT-SAFE: when no draft is
 * stale it does nothing (no behavior change).
 *
 * WI-2142684 (this backstop's own next-order gap, closed here): a recorded decision used
 * to suppress the alarm PERMANENTLY, correct for a terminal ruling but wrong for a
 * CONDITIONAL hold ("retry once WI-1234 backfills the plan") — a deferred disposition, not
 * a parked one. When the named blocker resolved, nothing re-evaluated the hold and the
 * plan stayed stranded forever (measured: both branches of one hold's own release
 * condition were satisfied, one 69ms after the decision landed — 38h+ later, still
 * unreviewed). `decisionStillSuppresses` now re-evaluates: an unconditional decision still
 * suppresses forever (preserving the antecedent EI-20607516411048124's gain); a conditional
 * one lifts once every WI-/EI- ref it cites has settled (terminal or absent).
 *
 * Where the drafts live (storage, verified against LIVE data 2026-06-29): the DRAFT row
 * is `harness_shared.harness_plans` under the HIVE's OWN workspace_id (e.g.
 * 'papercusp-workspace' — NOT 'default'; the sweep passes the started-hive workspaceId),
 * harness_slug = the hive slug, status='draft', `origin: scout` in the `content`
 * frontmatter, and `updated_at` (auto-bumped on every write — a scout revision off Queen
 * feedback resets the clock, which is correct: the draft was just touched). The
 * scout_routed_ideas ledger carries the same draft under the hive's REAL workspace, so a
 * cross-table workspace join would not line up — origin is read from the plan's own
 * frontmatter instead.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  listBlenderMaintenanceScopes,
  listBlenderMaintenanceWorkspaceIds,
} from '../pot/started';
import { resolveMugOwner } from '../pot/placement-watchdog';
import { deliverScoutNudge } from './nudge-recipient';
import { claimWatchdogFire } from '../pot/watchdog';
import { routineStorageSlug } from '../pot-membership';
import { BLENDER_PLAN_SQL_PATTERN } from '../agent-tools/plans/plan-provenance';
import {
  extractWorkItemRefs,
  getWorkItemRefStates,
  type CitedWorkItemRefState,
} from '../agent-tools/plans/cited-work-item-refs';

// ── tunable (env-overridable, like the liveness-watchdog floor) ───────────────

/** How long a scout-routed draft may sit unreviewed (status still 'draft', untouched)
 *  before the backstop wakes the Queen to review it. Default 12h; env-tunable; `<=0`
 *  DISABLES the whole sweep (kill switch). */
export function scoutDraftReviewStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC ?? 43_200);
  return Number.isFinite(n) ? n : 43_200;
}

// ── pure deciders (unit-tested with no DB) ────────────────────────────────────

/** One scout-routed draft candidate (a status='draft', origin='scout' plan row). */
export interface ScoutDraftCandidate {
  planSlug: string;
  title: string | null;
  /** Epoch ms of the draft row's last write (harness_plans.updated_at). */
  updatedAtMs: number;
  /** Durable review evidence derived from the plan index/content. */
  reviewEvidence?: ScoutDraftReviewEvidence;
}

/**
 * Review evidence is deliberately separate from the plan's operational status.
 * A steward's revision hold and an owner's needs-human gate both leave a plan in
 * `draft` by design, so `status + age` cannot answer whether the plan was seen.
 */
export interface ScoutDraftReviewEvidence {
  /**
   * WI-2142684: true when at least one recorded decision still suppresses the
   * alarm right now — NOT simply "a decision exists". An UNCONDITIONAL ruling
   * (deprecated, not-ready) suppresses permanently, as before. A CONDITIONAL
   * hold ("retry once WI-1234 backfills the plan") suppresses only while its
   * cited WI-/EI- ref(s) remain open; once every cited ref settles (terminal
   * or absent), the hold lifts and the plan becomes selectable again on the
   * normal age deadline. See `decisionStillSuppresses`.
   */
  hasDecision: boolean;
  hasNeedsHumanItem: boolean;
  hasRevisionHold: boolean;
}

const DECLARED_DECISION_RE =
  /^\s*(?:>\s*)?(?:(?:[-*+]\s+|\d+\.\s+)?(?:#{1,6}\s+D-\d{3,}\b|(?:\*\*|__)D-\d{3,}(?:\*\*|__)))/im;
const NEEDS_HUMAN_ITEM_RE =
  /^\s*(?:[-*+]\s+|\d+\.\s+)?\*\*P-\d{3,}\*\*\s+`needs[-_]human`(?:\s|$)/im;

/**
 * WI-2142684: language marking a recorded decision as a DEFERRED/conditional
 * hold ("retry once WI-1234 backfills the plan") rather than a terminal ruling
 * (deprecated / not-ready / needs-human — the latter has its own, unrelated
 * `hasNeedsHumanItem` signal and stays permanently suppressing). Requires BOTH
 * a conditional/temporal cue (retry, once, after, until, when) AND a settling
 * verb (backfills, repairs, resolves, lands, fixes, closes, completes, merges,
 * ships, deploys) — either alone is too weak (a terminal ruling can casually
 * use "after" in an unrelated clause), but the pair together is exactly the
 * shape of a release-condition sentence. Measured against the filing's own
 * example: "retry activation audit after this decision revision or that
 * repair backfills the plan."
 */
const CONDITIONAL_TRIGGER_WORDS_RE = /\b(?:retry|re-try|once|after|until|when)\b/i;
const CONDITIONAL_SETTLE_WORDS_RE =
  /\b(?:backfill(?:s|ed)?|repair(?:s|ed)?|resolve[sd]?|land[sd]?|fix(?:es|ed)?|close[sd]?|complete[sd]?|merge[sd]?|ship(?:s|ped)?|deploy(?:s|ed)?)\b/i;
const CONDITIONAL_DISPOSITION_RE = new RegExp(
  `(?=[\\s\\S]*${CONDITIONAL_TRIGGER_WORDS_RE.source})(?=[\\s\\S]*${CONDITIONAL_SETTLE_WORDS_RE.source})`,
  'i',
);

/**
 * PURE: does this one recorded decision still suppress the staleness alarm
 * right now? (WI-2142684 — see `ScoutDraftReviewEvidence.hasDecision`.)
 *
 * Suppression lifts only when BOTH: (a) the decision's own text reads as a
 * deferred/conditional hold (`CONDITIONAL_DISPOSITION_RE`), not an
 * unconditional ruling, AND (b) it cites at least one WI-/EI- ref, ALL of
 * which have since settled — terminal, or ABSENT (no matching row; itself a
 * "nothing left to wait on" signal, per `getWorkItemRefStates`'s contract). An
 * unconditional decision, a conditional one citing no ref, or one citing a
 * ref that is still open, is unchanged: it keeps suppressing (preserves the
 * antecedent EI-20607516411048124's gain — a steward's terminal ruling must
 * never be re-alarmed). A ref this evaluator expected to have been resolved
 * but is missing from `refStates` fails toward SUPPRESS, not toward alarm.
 *
 * Deliberately NOT keyed on `decision.date` vs a ref's closed-timestamp:
 * `date` is day-granularity only (a "Date: YYYY-MM-DD" line parsed by
 * plan-parser), so a same-day terminal transition BEFORE the decision was
 * written would falsely read as "after" it — a real false-positive risk.
 * Language + citation is the safer two-signal gate, and avoids the exact
 * false-positive class `cited-work-item-refs.ts`'s own docstring warns about
 * (a bare citation of a terminal item is usually background, not a live
 * premise) — that is exactly why citation ALONE is not enough here either.
 */
export function decisionStillSuppresses(
  decision: unknown,
  refStates: ReadonlyMap<string, CitedWorkItemRefState>,
): boolean {
  if (!decision || typeof decision !== 'object') return true;
  const title = String((decision as { title?: unknown }).title ?? '');
  const body = String((decision as { body?: unknown }).body ?? '');
  const text = `${title}\n${body}`;
  if (!CONDITIONAL_DISPOSITION_RE.test(text)) return true; // unconditional ruling: unchanged
  const refs = extractWorkItemRefs(text);
  if (refs.length === 0) return true; // conditional language, nothing to check against
  return refs.some((ref) => {
    const state = refStates.get(ref);
    if (!state) return true; // not resolved — fail toward suppress, never toward a spurious lift
    return state.state !== null && !state.terminal; // still open -> this ref keeps the hold live
  });
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasNeedsHumanItem(items: unknown): boolean {
  return jsonArray(items).some((item) => {
    if (!item || typeof item !== 'object') return false;
    const status = (item as { status?: unknown }).status;
    return typeof status === 'string' && status.trim().toLowerCase().replace('_', '-') === 'needs-human';
  });
}

/**
 * PURE: whether a Scout draft carries a durable review/hold signal. Structured
 * index rows are preferred, while the content fallbacks keep legacy/unindexed
 * plans safe. Ordinary draft boilerplate mentions "review" but does not trip
 * this guard; only an actual decision declaration, needs-human item, or explicit
 * revision hold does.
 */
export function hasDurableScoutReviewEvidence(candidate: ScoutDraftCandidate): boolean {
  const evidence = candidate.reviewEvidence;
  return Boolean(
    evidence?.hasDecision || evidence?.hasNeedsHumanItem || evidence?.hasRevisionHold,
  );
}

/**
 * PURE: which candidate drafts are stale enough to nudge — unreviewed at least
 * `thresholdMs`, oldest first. A `thresholdMs <= 0` (kill switch) selects none. A
 * non-finite timestamp is never selected (don't act blind on a missing clock).
 */
export function selectStaleDrafts(
  candidates: readonly ScoutDraftCandidate[],
  opts: { now: number; thresholdMs: number },
): ScoutDraftCandidate[] {
  if (opts.thresholdMs <= 0) return []; // kill switch
  return candidates
    .filter(
      (c) =>
        !hasDurableScoutReviewEvidence(c) &&
        Number.isFinite(c.updatedAtMs) &&
        opts.now - c.updatedAtMs >= opts.thresholdMs,
    )
    .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
}

/**
 * PURE: should this hive get a review wake this tick? Only when there IS a stale draft
 * and we have not already fired within the debounce window (so a draft that stays stale
 * across many 30s ticks wakes the Queen at most once per window, not every tick).
 */
export function shouldNudgeHive(args: { staleCount: number; alreadyFiredRecently: boolean }): boolean {
  return args.staleCount > 0 && !args.alreadyFiredRecently;
}

/**
 * PURE (EI-13220): human-readable elapsed duration for "unreviewed for …" messaging —
 * days+hours once past a day, otherwise whole hours, otherwise "<1h". Never negative
 * (a clock skew or a draft touched after `now` reads as "<1h", never "-3h").
 */
export function formatStaleDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalHours = Math.floor(clamped / 3_600_000);
  if (totalHours < 1) return '<1h';
  if (totalHours < 24) return `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

// ── the PG sweep ──────────────────────────────────────────────────────────────

interface DraftRow {
  plan_slug: string;
  title: string | null;
  updated_at_ms: string | number | null;
  items?: unknown;
  decisions?: unknown;
  content?: string | null;
}

interface ScoutDraftScopeRow {
  workspace_id: string | null;
  harness_slug: string | null;
}

interface DraftBacklogCountRow {
  c: number | string | null;
}

/** Read this hive's scout-routed DRAFT candidates (no time filter — the pure decider
 *  applies the threshold). Scout-origin is read from the plan's own frontmatter
 *  (`origin: scout`), which both scout rails write. `planWorkspaceId` MUST be the hive's
 *  OWN workspace — where the scout plan rows actually live (verified 'papercusp-workspace',
 *  NOT 'default'); the sweep passes the started-hive workspaceId. */
export async function readScoutDraftCandidates(
  sql: Sql,
  planWorkspaceId: string,
  /** ⚠ The slug plans are STORED under, NOT a routine's raw `installSlug` (WI-6978).
   *  harness_plans is Hive-scoped — the write path collapses a member harness to its
   *  Hive home (resolvePlanScope → potHomeSlugForHarness), so a member's raw slug
   *  matches zero rows here, silently: "no stale drafts" is also the healthy answer.
   *  The sweep resolves it once via routineStorageSlug and passes the result in. */
  planStorageSlug: string,
  opts: { limit?: number } = {},
): Promise<ScoutDraftCandidate[]> {
  const limit = opts.limit ?? 50;
  const rows = await sql<DraftRow[]>`
    SELECT plan_slug, title,
           (extract(epoch FROM updated_at) * 1000)::bigint AS updated_at_ms,
           items,
           decisions,
           content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${planWorkspaceId}
       AND harness_slug = ${planStorageSlug}
       AND status = 'draft'
       AND archived = false
       AND content LIKE ${BLENDER_PLAN_SQL_PATTERN}
     ORDER BY updated_at ASC
     LIMIT ${limit}`;

  // WI-2142684: only a decision that READS as a deferred/conditional hold (and
  // cites a WI-/EI- ref) is even eligible for re-evaluation — batch-resolve
  // every such ref ONCE across the whole page, so the common case (no
  // conditional decision anywhere in this page) costs zero extra queries and
  // the existing single-query assumption holds unchanged.
  const candidateRefs = new Set<string>();
  for (const r of rows) {
    for (const decision of jsonArray(r.decisions)) {
      if (!decision || typeof decision !== 'object') continue;
      const title = String((decision as { title?: unknown }).title ?? '');
      const body = String((decision as { body?: unknown }).body ?? '');
      const text = `${title}\n${body}`;
      if (!CONDITIONAL_DISPOSITION_RE.test(text)) continue;
      for (const ref of extractWorkItemRefs(text)) candidateRefs.add(ref);
    }
  }
  const refStates =
    candidateRefs.size > 0
      ? await getWorkItemRefStates([...candidateRefs], { sql, workspaceId: planWorkspaceId })
      : new Map<string, CitedWorkItemRefState>();

  return rows.map((r) => ({
    planSlug: r.plan_slug,
    title: r.title,
    updatedAtMs: Number(r.updated_at_ms ?? 0),
    reviewEvidence: {
      hasDecision:
        jsonArray(r.decisions).some((d) => decisionStillSuppresses(d, refStates)) ||
        DECLARED_DECISION_RE.test(r.content ?? ''),
      hasNeedsHumanItem:
        hasNeedsHumanItem(r.items) || NEEDS_HUMAN_ITEM_RE.test(r.content ?? ''),
      hasRevisionHold: /\brev(?:ision)?\s+hold\b/i.test(r.content ?? ''),
    },
  }));
}

/**
 * Discover Scout draft scopes directly from the plan store. The registry-backed
 * maintenance population is intentionally narrower than the retained plan
 * corpus, and legacy/default workspace rows can exist without a current Hive
 * registration. Keeping this read at plan-row grain makes the backstop cover
 * every workspace that actually has live Scout drafts.
 */
async function readScoutDraftScopes(sql: Sql): Promise<Array<{ workspaceId: string; planStorageSlug: string }>> {
  const rows = await sql<ScoutDraftScopeRow[]>`
    SELECT DISTINCT workspace_id, harness_slug
      FROM harness_shared.harness_plans
     WHERE status = 'draft'
       AND archived = false
       AND content LIKE ${BLENDER_PLAN_SQL_PATTERN}
  `;
  const seen = new Set<string>();
  const scopes: Array<{ workspaceId: string; planStorageSlug: string }> = [];
  for (const row of rows) {
    const workspaceId = row.workspace_id?.trim();
    const planStorageSlug = row.harness_slug?.trim();
    if (!workspaceId || !planStorageSlug) continue;
    const key = `${workspaceId}\u0000${planStorageSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({ workspaceId, planStorageSlug });
  }
  return scopes;
}

/** Count stale Scout-originated drafts across a workspace when no registered
 * Hive scope exists. This is a coverage probe only; normal processing still
 * uses the Hive-home slug-aware reader above. */
async function countStaleScoutDraftBacklog(sql: Sql, workspaceId: string, staleBeforeMs: number): Promise<number> {
  const rows = await sql<DraftBacklogCountRow[]>`
    SELECT count(*)::int AS c
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND status = 'draft'
       AND archived = false
       AND updated_at <= to_timestamp(${staleBeforeMs} / 1000.0)
       AND content LIKE ${BLENDER_PLAN_SQL_PATTERN}`;
  return Math.max(0, Number(rows[0]?.c ?? 0));
}

export interface ScoutDraftReviewResult {
  workspaceId: string;
  installSlug: string;
  outcome: 'nudged' | 'skipped' | 'error';
  /** Coverage of the registry-backed Blender population evaluated by this tick. */
  evaluatedWorkspaceCount: number;
  evaluatedScopeCount: number;
  /** Number of stale drafts eligible for this backstop's action. */
  eligibleBacklogCount: number;
  staleCount: number;
  reason: string;
}

interface ResolvedScoutDraftScope {
  workspaceId: string;
  installSlug: string;
  planStorageSlug: string;
}

interface ScoutDraftScopeResolutionFailure {
  workspaceId: string;
  installSlug: string;
  error: unknown;
}

/**
 * Fire ONE review wake to the live Queen so she reviews the stale drafts on the FRICTION
 * path (not the idle-only path). Crucially it NEVER touches the draft status — the Queen
 * still ratifies / deprecates.
 *
 * WI-963 (closing the queen-scout-feedback-loop's broken last link — confirmed live: 19+
 * hourly fires recorded in `hive_watchdog_fires` against a draft that stayed unreviewed 3+
 * days). The ONLY delivery this used to attempt was `wakeRecipients([queenOwner], ...)` — an
 * event-key WAKE that only does anything if some session is CURRENTLY watching
 * `inboxWakeKey(queenOwner)`. But the Queen is fresh-per-wake (each wake is a NEW launch
 * under a BRAND-NEW coord owner id, not a long-lived parked process — her adv_sessions rows
 * show short, fully-ENDED sessions, not parked ones), so `queenOwner` (the newest session AT
 * SWEEP TIME) is almost always already a dead session nobody is watching by the time this
 * sweep fires: the wake event fires into the void, `hive_watchdog_fires` still records
 * "nudged" (it only ever recorded that the SWEEP ran, never that delivery landed), and no
 * durable trace of the notification exists anywhere — the backstop was silently a no-op.
 *
 * The fix: use the shared stable `@role:mug` seam (the same channel
 * WI-682 wired `gatherInbox`/mug-brief-launch.ts to drain into EVERY future Mug wake's
 * brief, regardless of her owner id at drain time). This is now the RELIABLE half of the
 * notification; the event-wake above is kept as a best-effort bonus for the rare case a live
 * session happens to be watching that exact key.
 */
export async function fireReviewWake(
  workspaceId: string,
  queenOwner: string | null,
  stale: readonly ScoutDraftCandidate[],
  staleSec: number,
  harnessSlug: string | null = null,
  now: number = Date.now(),
): Promise<void> {
  const hours = Math.max(1, Math.round(staleSec / 3_600));
  const shown = stale.slice(0, 5);
  // EI-13220: the message used to report only the fixed THRESHOLD (e.g. "> 1h"),
  // never each draft's actual elapsed staleness — so a draft stuck for WEEKS
  // (confirmed live: scout-rubric-hive-coordination-health-scorecard-2026-06-26
  // fired hourly from 2026-06-29 to 2026-07-17, unreviewed the entire time) read
  // identically to one that just barely crossed the threshold, making a genuine
  // multi-week starvation look like near-miss noise — which is very likely why
  // that exact fire was mistaken for a "phantom"/nonexistent draft rather than
  // investigated as the real, severe backlog it was. Surface each draft's actual
  // age so the alert can't be mistaken for noise again.
  const list = shown
    .map((s) => `• ${s.planSlug}${s.title ? ` — ${s.title}` : ''} (unreviewed for ${formatStaleDuration(now - s.updatedAtMs)})`)
    .join('\n');
  const more = stale.length > shown.length ? `\n…and ${stale.length - shown.length} more.` : '';
  const oldestStaleMs = shown.length > 0 ? now - shown[0].updatedAtMs : 0;
  const summary =
    `Scout-draft review backstop: ${stale.length} scout-routed draft(s) unreviewed > ${hours}h ` +
    `(oldest: ${formatStaleDuration(oldestStaleMs)} since last update — the plan-review idle activity ` +
    `did not run, because the reviewing steward has not been idle). ` +
    `This is a backstop WAKE, not an idle activity. YOU are the reviewer and you hold the authority to ` +
    `dispose of these: the Mug/Queen tier is RETIRED, so no other role will drain them. Review each and ` +
    `either promote it (= ready), coord:send feedback to its scout owner to iterate, or deprecate it WITH ` +
    `learnings — but do not leave it. Note that a coord reply alone does NOT clear this wake: the backstop ` +
    `selects on the absence of a decision / needs-human item / revision hold, so record your verdict ON the ` +
    `plan (plans:add-decision) or it will re-fire looking untouched.\n\n${list}${more}`;
  // P-034: routed, not Mug-only. With no deliverable Mug this reaches a live su, or
  // escalates to the owner — it never parks in @role:mug where nobody drains it.
  await deliverScoutNudge({
    workspaceId,
    mugOwner: queenOwner,
    summary,
    payload: {
      kind: 'scout-draft-review',
      slugs: stale.map((s) => s.planSlug),
      staleHours: hours,
      oldestStaleMs,
    },
    source: 'scout-draft-review',
    body: `${list}${more}`,
    harnessSlug,
  });
  /*
   * wakeMug owns both direct delivery and durable parking. Keeping that seam
   * centralized prevents a stale per-wake owner from becoming the only route.
   */
}

/**
 * The scout-draft review backstop sweep. For each registered Blender Hive: find scout-routed drafts
 * unreviewed past the deadline, and (debounced per-hive) wake the live Queen to review
 * them. Never throws — a watchdog that crashes its host guards nothing. DEFAULT-SAFE: no
 * stale draft ⇒ no wake. Kill switch: PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC <= 0.
 */
export async function scoutDraftReviewSweep(opts: { now?: number } = {}): Promise<ScoutDraftReviewResult[]> {
  const results: ScoutDraftReviewResult[] = [];
  const staleSec = scoutDraftReviewStaleSec();
  if (staleSec <= 0) return results; // kill switch
  try {
    const registeredScopes = await listBlenderMaintenanceScopes();
    const { sql } = getOrgPg();

    // The registry is the normal source for live maintenance scopes, but it is
    // not the complete population of retained Scout plans. Legacy/default
    // workspace rows can remain after a Hive registration is gone, so union the
    // registry with scopes discovered directly from the plan store. The latter
    // already carries the storage slug; using it as the install slug is the only
    // identity available for an unregistered scope and keeps the durable nudge
    // routed to the correct workspace.
    let discoveredScopes: Array<{ workspaceId: string; planStorageSlug: string }> = [];
    try {
      discoveredScopes = await readScoutDraftScopes(sql);
    } catch (e) {
      // Discovery is an additive coverage leg. A transient failure must not
      // suppress the registry-backed sweep that can still make progress.
      console.warn(`[scout-draft-review] scope discovery failed: ${e instanceof Error ? e.message : e}`);
    }

    const resolvedScopes: ResolvedScoutDraftScope[] = [];
    const resolutionFailures: ScoutDraftScopeResolutionFailure[] = [];
    const seenStorageScopes = new Set<string>();
    const addResolvedScope = (scope: ResolvedScoutDraftScope): void => {
      const key = `${scope.workspaceId}\u0000${scope.planStorageSlug}`;
      if (seenStorageScopes.has(key)) return;
      seenStorageScopes.add(key);
      resolvedScopes.push(scope);
    };

    for (const { workspaceId, installSlug } of registeredScopes) {
      try {
        addResolvedScope({
          workspaceId,
          installSlug,
          planStorageSlug: await routineStorageSlug(installSlug, workspaceId),
        });
      } catch (error) {
        // Preserve the existing per-scope fail-soft behavior: one broken slug
        // resolver must not hide other registered or discovered scopes.
        resolutionFailures.push({ workspaceId, installSlug, error });
      }
    }
    for (const { workspaceId, planStorageSlug } of discoveredScopes) {
      addResolvedScope({
        workspaceId,
        installSlug: planStorageSlug,
        planStorageSlug,
      });
    }

    if (resolvedScopes.length === 0 && resolutionFailures.length === 0) {
      // Keep the existing empty-registry coverage alarm for workspaces whose
      // plan rows are not discoverable (for example while the plan store is
      // temporarily unavailable or a legacy row lacks a usable scope slug).
      const workspaceIds =
        typeof listBlenderMaintenanceWorkspaceIds === 'function'
          ? listBlenderMaintenanceWorkspaceIds()
          : [];
      if (workspaceIds.length === 0) return results;
      const now = opts.now ?? Date.now();
      const staleBeforeMs = now - staleSec * 1_000;
      let eligibleBacklogCount = 0;
      for (const workspaceId of workspaceIds) {
        eligibleBacklogCount += await countStaleScoutDraftBacklog(sql, workspaceId, staleBeforeMs);
      }
      if (eligibleBacklogCount > 0) {
        const reason =
          `${eligibleBacklogCount} eligible stale Scout draft(s) found in ${workspaceIds.length} workspace(s), ` +
          'but no registered or plan-discovered Blender scopes were evaluated';
        console.warn(`[scout-draft-review] ALERT: ${reason}`);
        return [
          {
            workspaceId: '*',
            installSlug: '*',
            outcome: 'error',
            evaluatedWorkspaceCount: 0,
            evaluatedScopeCount: 0,
            eligibleBacklogCount,
            staleCount: eligibleBacklogCount,
            reason,
          },
        ];
      }
      return results;
    }

    const evaluatedWorkspaceCount = new Set([
      ...resolvedScopes.map(({ workspaceId }) => workspaceId),
      ...resolutionFailures.map(({ workspaceId }) => workspaceId),
    ]).size;
    const evaluatedScopeCount = resolvedScopes.length + resolutionFailures.length;
    const now = opts.now ?? Date.now();
    const thresholdMs = staleSec * 1_000;
    const windowHours = Math.max(1, Math.round(staleSec / 3_600));

    for (const { workspaceId, installSlug, error } of resolutionFailures) {
      results.push({
        workspaceId,
        installSlug,
        outcome: 'error',
        evaluatedWorkspaceCount,
        evaluatedScopeCount,
        eligibleBacklogCount: 0,
        staleCount: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    for (const { workspaceId, installSlug, planStorageSlug } of resolvedScopes) {
      try {
        // WI-6978: plans live under the Pot/Hive HOME, not a member harness's own
        // slug. Registered scopes resolve that home above; plan-discovered scopes
        // already carry the storage slug from harness_plans.
        const candidates = await readScoutDraftCandidates(sql, workspaceId, planStorageSlug);
        const stale = selectStaleDrafts(candidates, { now, thresholdMs });
        if (stale.length === 0) continue;
        
        // EI-XXXX: use atomic claimWatchdogFire (with advisory lock) instead of non-atomic
        // check-then-act pattern (recentWatchdogFires + recordFire) to prevent race-condition
        // duplicate fires when concurrent sweeps run. Same pattern as watchdog.ts EI-6760.
        //
        // EI-13220: `reason` (the row this lands on, in hive_watchdog_fires) used to report
        // only the fixed threshold ("> Nh"), never the oldest draft's ACTUAL elapsed
        // staleness — indistinguishable from a near-miss even after weeks unreviewed
        // (confirmed live). Include it so the fire ledger itself is self-explanatory.
        const oldestStaleMs = now - stale[0].updatedAtMs;
        const reason =
          `${stale.length} scout-routed draft(s) unreviewed > ${windowHours}h ` +
          `(oldest: ${formatStaleDuration(oldestStaleMs)}): ` +
          stale.slice(0, 5).map((s) => s.planSlug).join(', ');
        const claimed = await claimWatchdogFire({
          workspaceId,
          installSlug,
          source: 'scout-draft-review',
          reason,
          wakeAt: null,
          windowHours,
        });
        if (!claimed) {
          results.push({
            workspaceId,
            installSlug,
            outcome: 'skipped',
            evaluatedWorkspaceCount,
            evaluatedScopeCount,
            eligibleBacklogCount: stale.length,
            staleCount: stale.length,
            reason: 'debounced',
          });
          continue;
        }

        const queenOwner = await resolveMugOwner(sql, workspaceId, installSlug);
        await fireReviewWake(workspaceId, queenOwner, stale, staleSec, installSlug, now);
        results.push({
          workspaceId,
          installSlug,
          outcome: 'nudged',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: stale.length,
          staleCount: stale.length,
          reason,
        });
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: 0,
          staleCount: 0,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[scout-draft-review] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
