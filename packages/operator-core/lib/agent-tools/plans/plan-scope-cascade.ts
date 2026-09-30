/**
 * plan-scope-cascade.ts — propagate a plan SCOPE write to the work it made moot
 * (review-system-rework-reduction-2026-09-23 P-030, unified with P-031 by D-005).
 *
 * WHY. Measured by the fifth audit (D-004): 3,474 tool calls — 29% of
 * ship-main-greening-program-2026-09-15 — went to three "Ship <slug>" carrier items that
 * were later dropped as moot after D-019 superseded their subject plans. P-022 alone drew
 * 1,840 calls on 09-21/22, two days AFTER its subject plan was superseded on 09-19.
 * Nothing connected the write that superseded a plan to the items in OTHER plans whose
 * whole deliverable was shipping that plan, so they stayed claimable and kept pulling
 * agents in. Readiness had the same gap: the carrier plan's acceptance/BAR verdict was only
 * recomputed when somebody happened to ask.
 *
 * WHAT. Called by the write that supersedes a plan (plans:set-plan-status → superseded,
 * which is also how a consolidation retires the plans it absorbs):
 *   1. DETECT carriers: non-terminal, non-observation work items in ANOTHER plan whose title
 *      names shipping / accepting / carrying / grading the superseded plan (whole-slug
 *      token, verb before it — `isMootCarrierTitle`).
 *   2. PARK each one durably out of claim_next / scheduler self-select (the existing
 *      `_claimHold` durable park — NOT a drop: dropping stays a recorded Decision on the
 *      carrier plan). Its typed release contract is keyed to the carrier plan's
 *      acceptance-changed event, so the next re-scope of that plan is the re-evaluation cue.
 *   3. NOTIFY the carrier's live holder, if any.
 *   4. RE-EVALUATE each carrier plan's acceptance/BAR readiness and SURFACE it where readers
 *      look: a prepend-only, idempotent stamp in the carrier plan's `## Now` (the repair
 *      obligation, with the gate's blocking code) and a `now_updated` plan event, which
 *      rides orient's plan-events delta. `now_updated` is deliberately NOT an
 *      acceptance-changing event, so the cascade can never fire its own release trigger.
 *
 * Every step after detection is best-effort PER CARRIER: a failure is reported in the
 * result and never thrown into the plan write that triggered it.
 */

import { parsePlan } from './parser';
import { replaceNowBlock } from './set-now';

/** Sentinel for the carrier-plan Now stamp. Keyed per subject so a re-run is a no-op. */
export const MOOT_CARRIER_NOW_MARK = '⚠ MOOT CARRIER PARKED';

export type PlanScopeWriteCause = 'superseded';

/** Verbs that make an item a CARRIER of another plan (its deliverable is that plan). */
const CARRIER_VERB_RE =
  /\b(?:ship|ships|shipped|shipping|carry|carries|carried|carrying|accept|accepts|accepted|acceptance|grade|grades|graded|grading|land|lands|landing)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is `title` a carrier of `subjectSlug`? The slug must appear as a WHOLE token (a slug is
 * `[a-z0-9-]`, so a longer sibling slug sharing a prefix never matches) and a carrier verb
 * must precede it. The verb is only searched BEFORE the slug, so a slug that itself contains
 * a verb (`ship-main-greening-…`) cannot satisfy the check on its own.
 */
export function isMootCarrierTitle(title: string, subjectSlug: string): boolean {
  const slug = subjectSlug.trim();
  if (!slug || !title) return false;
  const tokenRe = new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(slug)}(?=$|[^A-Za-z0-9-])`, 'i');
  const match = tokenRe.exec(title);
  if (!match) return false;
  const slugAt = match.index + match[1]!.length;
  return CARRIER_VERB_RE.test(title.slice(0, slugAt));
}

export interface CarrierCandidate {
  featureId: string;
  workspaceId: string;
  harnessSlug: string | null;
  /** The plan the carrier lives in (never the superseded subject). */
  sourcePlanSlug: string;
  sourcePlanItemIds: string[];
  title: string;
  status: string;
  takenBy: string | null;
  payload: unknown;
}

export interface GateReading {
  satisfied: boolean | null;
  code: string | null;
  error?: string;
}

export interface MootCarrierStamp {
  subjectSlug: string;
  cause: PlanScopeWriteCause;
  /** Rendered carrier refs, e.g. `WI-10001493 (P-022)`. */
  carriers: string[];
  gate: GateReading | null;
  today?: Date;
}

function gateText(gate: GateReading | null): string {
  if (!gate || gate.satisfied === null) return `not measured${gate?.error ? ` (${gate.error})` : ''}`;
  return gate.satisfied ? 'acceptance gate satisfied' : `acceptance gate BLOCKED: ${gate.code ?? 'unknown code'}`;
}

/** Where the first `**State:**` / `**Next:**` marker begins, or -1. */
const FIRST_MARKER_RE = /\*\*(?:State|Next):\*\*/i;

/**
 * Return the carrier plan's body with a repair banner prepended to its `## Now`, or `null`
 * when there is nothing to do (no Now block — never invent one; or this subject's banner is
 * already present). Pure. Prepend-only: the author's State/Next survive verbatim beneath it.
 */
export function stampMootCarrierNowBlock(body: string, stamp: MootCarrierStamp): string | null {
  if (stamp.carriers.length === 0) return null;
  const now = parsePlan(body).now;
  if (!now) return null;
  const key = `${MOOT_CARRIER_NOW_MARK}: ${stamp.subjectSlug}`;
  if (now.raw.includes(key)) return null;

  const iso = (stamp.today ?? new Date()).toISOString().slice(0, 10);
  const list = stamp.carriers.join(', ');
  const plural = stamp.carriers.length > 1;
  const banner =
    `${key} (${iso}) — plan ${stamp.subjectSlug} was ${stamp.cause}, so ${list} ${plural ? 'are' : 'is'} moot ` +
    `and ${plural ? 'were' : 'was'} parked out of claim_next (parked, not dropped). BAR readiness re-evaluated ` +
    `in the same write: ${gateText(stamp.gate)}. (stamped by plans:set-plan-status, P-030)`;
  const repair =
    `Repair the moot carrier${plural ? 's' : ''} ${list}: record a Decision that re-scopes or drops ` +
    `${plural ? 'them' : 'it'} (plan ${stamp.subjectSlug} was ${stamp.cause}).`;

  const markerAt = now.raw.search(FIRST_MARKER_RE);
  const preamble = markerAt > 0 ? now.raw.slice(0, markerAt).trim() : '';
  const freeProse = !now.state && !now.next ? now.raw.trim() : '';
  const state = [banner, preamble, now.state, freeProse].filter(Boolean).join('\n\n');
  const next = now.next ? `${repair} Then: ${now.next}` : repair;
  return replaceNowBlock(body, state, next);
}

export interface PlanScopeCascadeInput {
  workspaceId: string;
  harnessSlug: string | null;
  subjectSlug: string;
  cause: PlanScopeWriteCause;
  /** Who made the scope write (park provenance, notify sender). */
  actor: string;
}

export interface PlanScopeCascadeDeps {
  /**
   * Open items whose title mentions `subjectSlug`. When `harnessSlug` is set, only that
   * harness's items: plan slugs are unique per (workspace, harness), so an item in another
   * harness that names the same slug refers to a different plan and is not made moot.
   */
  listCandidates(input: { workspaceId: string; harnessSlug: string | null; subjectSlug: string }): Promise<CarrierCandidate[]>;
  isParked(payload: unknown): boolean;
  park(
    carrier: CarrierCandidate,
    park: { reason: string; condition: string; trigger: string; owner: string },
  ): Promise<boolean>;
  notifyHolder(carrier: CarrierCandidate, summary: string): Promise<void>;
  evaluateGate(planSlug: string, harnessSlug: string | null): Promise<GateReading>;
  stampNow(
    planSlug: string,
    scope: { workspaceId: string; harnessSlug: string | null },
    stamp: MootCarrierStamp,
  ): Promise<boolean>;
  emitPlanEvent(planSlug: string, detail: string): Promise<void>;
  /** The release trigger for a park on a carrier in `carrierPlanSlug`. */
  releaseTrigger(carrierPlanSlug: string): string;
}

export interface PlanScopeCascadeCarrierResult {
  id: string;
  plan: string;
  items: string[];
  parked: boolean;
  alreadyParked: boolean;
  holderNotified: boolean;
  error?: string;
}

export interface PlanScopeCascadePlanResult {
  slug: string;
  gate: GateReading;
  nowStamped: boolean;
  eventEmitted: boolean;
  error?: string;
}

export interface PlanScopeCascadeResult {
  subjectSlug: string;
  cause: PlanScopeWriteCause;
  carriers: PlanScopeCascadeCarrierResult[];
  carrierPlans: PlanScopeCascadePlanResult[];
  /** Detection itself failed — nothing was parked and nothing was measured. */
  error?: string;
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function carrierRef(c: CarrierCandidate): string {
  return c.sourcePlanItemIds.length > 0 ? `${c.featureId} (${c.sourcePlanItemIds.join(', ')})` : c.featureId;
}

/**
 * Run the cascade for one scope write. Never throws: detection failure is returned as
 * `error`, per-carrier and per-plan failures ride their own rows.
 */
export async function propagatePlanScopeWrite(
  input: PlanScopeCascadeInput,
  deps: PlanScopeCascadeDeps,
): Promise<PlanScopeCascadeResult> {
  const result: PlanScopeCascadeResult = {
    subjectSlug: input.subjectSlug,
    cause: input.cause,
    carriers: [],
    carrierPlans: [],
  };

  let candidates: CarrierCandidate[];
  try {
    candidates = await deps.listCandidates({
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      subjectSlug: input.subjectSlug,
    });
  } catch (err) {
    return { ...result, error: `carrier detection failed: ${errText(err)}` };
  }
  // Re-checked here, not only in the store query: a same-slug plan in another harness is a
  // different plan, and superseding this one must never park that plan's carriers.
  const sameHarness = (c: CarrierCandidate) => input.harnessSlug == null || c.harnessSlug === input.harnessSlug;
  const carriers = candidates.filter(
    (c) => sameHarness(c) && c.sourcePlanSlug !== input.subjectSlug && isMootCarrierTitle(c.title, input.subjectSlug),
  );

  const byPlan = new Map<string, { harnessSlug: string | null; workspaceId: string; refs: string[] }>();
  for (const carrier of carriers) {
    const row: PlanScopeCascadeCarrierResult = {
      id: carrier.featureId,
      plan: carrier.sourcePlanSlug,
      items: carrier.sourcePlanItemIds,
      parked: false,
      alreadyParked: deps.isParked(carrier.payload),
      holderNotified: false,
    };
    result.carriers.push(row);
    const group = byPlan.get(carrier.sourcePlanSlug) ?? {
      harnessSlug: carrier.harnessSlug,
      workspaceId: carrier.workspaceId,
      refs: [],
    };
    group.refs.push(carrierRef(carrier));
    byPlan.set(carrier.sourcePlanSlug, group);
    if (row.alreadyParked) continue;

    const reason =
      `moot: its subject plan ${input.subjectSlug} was ${input.cause} — parked out of claim_next by the ` +
      `plan supersede cascade (P-030). Parked, not dropped: re-scope or drop it with a Decision on ` +
      `${carrier.sourcePlanSlug}.`;
    try {
      row.parked = await deps.park(carrier, {
        reason,
        condition: `plan ${carrier.sourcePlanSlug} records a Decision that re-scopes or drops ${carrier.featureId}`,
        trigger: deps.releaseTrigger(carrier.sourcePlanSlug),
        owner: carrier.takenBy?.trim() || input.actor,
      });
    } catch (err) {
      row.error = `park failed: ${errText(err)}`;
      continue;
    }
    const holder = carrier.takenBy?.trim();
    if (row.parked && holder) {
      try {
        await deps.notifyHolder(
          carrier,
          `${carrier.featureId} is moot: plan ${input.subjectSlug} was ${input.cause}. It is parked out of ` +
            `claim_next (not dropped); re-scope or drop it with a Decision on ${carrier.sourcePlanSlug}.`,
        );
        row.holderNotified = true;
      } catch {
        /* best-effort: the Now stamp and plan event still carry the obligation */
      }
    }
  }

  for (const [slug, group] of byPlan) {
    const planRow: PlanScopeCascadePlanResult = {
      slug,
      gate: { satisfied: null, code: null },
      nowStamped: false,
      eventEmitted: false,
    };
    result.carrierPlans.push(planRow);
    try {
      planRow.gate = await deps.evaluateGate(slug, group.harnessSlug);
    } catch (err) {
      planRow.gate = { satisfied: null, code: null, error: errText(err) };
    }
    const stamp: MootCarrierStamp = {
      subjectSlug: input.subjectSlug,
      cause: input.cause,
      carriers: group.refs,
      gate: planRow.gate,
    };
    try {
      planRow.nowStamped = await deps.stampNow(
        slug,
        { workspaceId: group.workspaceId, harnessSlug: group.harnessSlug },
        stamp,
      );
    } catch (err) {
      planRow.error = `Now stamp failed: ${errText(err)}`;
    }
    try {
      await deps.emitPlanEvent(
        slug,
        `moot carrier(s) ${group.refs.join(', ')} parked: plan ${input.subjectSlug} ${input.cause}; ` +
          `repair = a Decision that re-scopes or drops them; ${gateText(planRow.gate)}`,
      );
      planRow.eventEmitted = true;
    } catch {
      /* best-effort: observability, not state */
    }
  }
  return result;
}

// ── P-031 (merged into P-030 by D-005): re-evaluate BAR readiness on EVERY scope write ──
//
// WHY. A complete BAR can be made false by a LATER scope write: dropping the last live item
// a BAR maps to (bar_snapshot_mapping_dropped_only), or a Decision that re-scopes the plan.
// The acceptance-bar contract snapshot already computes that verdict live, but nothing read
// it until the ship attempt, so the plan kept being worked toward an unshippable bar
// (measured: R-1 became impossible on 09-19 via D-019 and surfaced only at the 09-23 ship).
//
// WHAT. The write that drops a plan item (plans:set-status → dropped) and the write that
// records a Decision (plans:add-decision) re-read that SAME snapshot in the same call and
// keep ONE banner in the plan's `## Now`: stamped (or replaced) while readiness is blocked,
// removed once it is ready. orient's planNow leg folds the Now block, so the codes reach
// every agent oriented on the plan; the write's own response carries them as `barReadiness`.

/** Sentinel for the BAR-readiness banner in a plan's `## Now`. One per plan, replaced in place. */
export const BAR_READINESS_NOW_MARK = '⚠ BAR READINESS BLOCKED';

export type BarReadinessWriteCause = 'item-dropped' | 'decision-added';

export interface BarReadinessReading {
  /** `null` = NOT MEASURED (the read failed). Never treated as ready, never erases a banner. */
  state: 'ready' | 'blocked' | 'not-applicable' | null;
  codes: string[];
  nextRepair: { code: string; barKey: string | null; action: string } | null;
  error?: string;
}

const PARAGRAPH_SPLIT_RE = /\n\s*\n/;

function isBarReadinessParagraph(paragraph: string): boolean {
  return paragraph.trimStart().startsWith(BAR_READINESS_NOW_MARK);
}

/** The banner minus its `(date, after cause)` stamp, so an unchanged verdict is a no-op. */
function barReadinessKey(paragraph: string): string {
  const trimmed = paragraph.trim();
  const rest = trimmed.slice(BAR_READINESS_NOW_MARK.length).replace(/^\s*\([^)]*\)/, '');
  return `${BAR_READINESS_NOW_MARK}${rest}`;
}

function barReadinessBanner(reading: BarReadinessReading, cause: BarReadinessWriteCause, iso: string): string {
  const repair = reading.nextRepair
    ? ` Next repair: ${reading.nextRepair.action}${reading.nextRepair.barKey ? ` (${reading.nextRepair.barKey})` : ''}.`
    : '';
  return (
    `${BAR_READINESS_NOW_MARK} (${iso}, after ${cause}): ${reading.codes.join(', ')}.${repair} ` +
    `(re-evaluated in the same write by the scope-write cascade, P-030/P-031)`
  );
}

/**
 * Return the plan body with its BAR-readiness banner brought up to date, or `null` when there
 * is nothing to write. Pure. Blocked + codes → stamp or replace the one banner at the top of
 * the State; ready / not-applicable → remove a stale banner; not measured → never touch it.
 * Everything else in the Now (the author's State/Next, other cascade banners) survives verbatim.
 */
export function stampBarReadinessNowBlock(
  body: string,
  reading: BarReadinessReading,
  cause: BarReadinessWriteCause,
  today?: Date,
): string | null {
  if (reading.state === null) return null;
  const now = parsePlan(body).now;
  if (!now) return null;

  const markerAt = now.raw.search(FIRST_MARKER_RE);
  const preamble = markerAt > 0 ? now.raw.slice(0, markerAt).trim() : '';
  const freeProse = !now.state && !now.next ? now.raw.trim() : '';
  const paragraphs = [preamble, now.state, freeProse]
    .filter(Boolean)
    .join('\n\n')
    .split(PARAGRAPH_SPLIT_RE)
    .map((p) => p.trim())
    .filter(Boolean);
  const existing = paragraphs.find(isBarReadinessParagraph) ?? null;
  const rest = paragraphs.filter((p) => !isBarReadinessParagraph(p));

  const blocked = reading.state === 'blocked' && reading.codes.length > 0;
  let state: string;
  if (blocked) {
    const banner = barReadinessBanner(reading, cause, (today ?? new Date()).toISOString().slice(0, 10));
    if (existing !== null && barReadinessKey(existing) === barReadinessKey(banner)) return null;
    state = [banner, ...rest].join('\n\n');
  } else {
    if (existing === null) return null;
    state = rest.join('\n\n') || '—';
  }
  const next = now.next || (blocked && reading.nextRepair ? reading.nextRepair.action : '—');
  return replaceNowBlock(body, state, next);
}

export interface BarReadinessInput {
  workspaceId: string;
  harnessSlug: string | null;
  planSlug: string;
  cause: BarReadinessWriteCause;
}

export interface BarReadinessDeps {
  readBarReadiness(planSlug: string, harnessSlug: string | null): Promise<BarReadinessReading>;
  restampNow(
    planSlug: string,
    scope: { workspaceId: string; harnessSlug: string | null },
    reading: BarReadinessReading,
    cause: BarReadinessWriteCause,
  ): Promise<boolean>;
}

export interface BarReadinessResult {
  slug: string;
  cause: BarReadinessWriteCause;
  state: BarReadinessReading['state'];
  codes: string[];
  nextRepair: BarReadinessReading['nextRepair'];
  /** The plan's `## Now` banner was written (stamped, replaced or cleared) by this call. */
  nowStamped: boolean;
  error?: string;
}

/**
 * Re-read the plan's live BAR readiness after a scope write and bring its Now banner up to
 * date. Never throws into the write that triggered it: a failed read is reported as
 * `state: null` + `error`, and a failed stamp rides `error` beside the measured codes.
 */
export async function reevaluateBarReadinessOnScopeWrite(
  input: BarReadinessInput,
  deps: BarReadinessDeps,
): Promise<BarReadinessResult> {
  let reading: BarReadinessReading;
  try {
    reading = await deps.readBarReadiness(input.planSlug, input.harnessSlug);
  } catch (err) {
    reading = { state: null, codes: [], nextRepair: null, error: `readiness read failed: ${errText(err)}` };
  }
  const result: BarReadinessResult = {
    slug: input.planSlug,
    cause: input.cause,
    state: reading.state,
    codes: reading.codes,
    nextRepair: reading.nextRepair,
    nowStamped: false,
    ...(reading.error ? { error: reading.error } : {}),
  };
  if (reading.state === null) return result;
  try {
    result.nowStamped = await deps.restampNow(
      input.planSlug,
      { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug },
      reading,
      input.cause,
    );
  } catch (err) {
    result.error = `Now stamp failed: ${errText(err)}`;
  }
  return result;
}
