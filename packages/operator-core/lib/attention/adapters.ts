/**
 * Adapters: each live attention surface → AttentionItem
 * (planning-attention-importance-2026-05-31, P-009/P-010/P-025/P-026/P-027;
 *  inbox-tiering-and-message-agent-2026-06-05 — tier + owner + message-owner).
 *
 * Pure functions — input record shape in, AttentionItem out. The reader
 * (P-011) fetches the real records from each source and maps them to
 * these minimal input shapes, keeping the adapters free of I/O and of
 * the (submodule-bound) source types. Each adapter is where a kind's
 * title / body / status / importance / tier / owner / action buttons are defined.
 *
 * `tier` (D-002) is computed here from each kind's real meaning, and
 * `needsHuman` is DERIVED from it (`needsHumanForTier`) — never hard-coded —
 * so the invariant `needsHuman === (tier === 'decision')` holds for every item.
 */

import { type Importance } from '@papercusp/plan-parser';
import { parseReportBlock, type ReportBlock } from '@papercusp/chat-protocol';
import {
  type AttentionItem,
  type AttentionAction,
  type AttentionTier,
  ATTENTION_KIND_CATEGORY,
  needsHumanForTier,
  reportTier,
  severityToImportance,
  severityToRiskTier,
  riskTierIsDecision,
  untriaged,
} from './types';
import { classifyReadActionability, type ReadActionability } from '../agent-tools/coordination/liveness-oracle';
import { isMachineEscalationEmitter } from '../agent-tools/coordination/machine-authored';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';

const CHAT: AttentionAction = { id: 'chat', label: 'Chat' };
/** Open a work-item-scoped conversation with the item's owning agent (D-004).
 *  A navigate action (opens a thread sub-surface), present on every item. */
const MESSAGE_OWNER: AttentionAction = { id: 'message-owner', label: 'Message owner' };
/** Discuss — ONE action that replaces the old Chat + Message-owner pair on the
 *  "Other" attention items (escalation/message/smoke/conversation). The UI panel
 *  (DiscussPanel) routes it: reply to the ORIGINATING agent when it's a live,
 *  addressable (non-system) agent, else open a fresh harness agent chat. Folds
 *  two overlapping, confusingly-labelled buttons ("owner" actually meant the
 *  raising agent, and for most escalations that agent is a dead/system identity
 *  the message never reaches) into one intent. (queue-pending-accuracy P-004 ext-2 (A).) */
const DISCUSS: AttentionAction = { id: 'discuss', label: 'Discuss' };

/** First non-empty line, trimmed and truncated for a list-row title. */
function clip(s: string | null | undefined, n = 120): string {
  const firstLine =
    (s ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return firstLine.length > n ? `${firstLine.slice(0, n - 1)}…` : firstLine;
}

/* ── plan item (P-009) ──────────────────────────────────────────────── */

export interface PlanItemInput {
  slug: string;
  harnessSlug: string | null;
  /** P-NNN. */
  id: string;
  text: string;
  storedStatus: string;
  effectiveStatus: string;
  importance: Importance;
  /** The current claimant/assignee, when the reader can resolve one. */
  ownerAgentId?: string | null;
  ownerLabel?: string | null;
}

export function planItemToAttention(it: PlanItemInput): AttentionItem {
  // Tier (D-002): a needs-human item is a Decision; a blocked item is an Alert
  // (work is stuck, worth surfacing); a normal todo/wip item is Activity
  // (agent-actionable, pickable work).
  const tier: AttentionTier =
    it.storedStatus === 'needs-human'
      ? 'decision'
      : it.storedStatus === 'blocked' || it.effectiveStatus === 'blocked'
        ? 'alert'
        : 'activity';
  const needsHuman = needsHumanForTier(tier);
  // The full needs-human toolkit lives in `actions[]` (the single source the
  // card mapper reads — inbox-cards-unification P-009): Answer (free-text
  // decision, navigate → inline InputCard), Resolve (quick done), Drop
  // (won't-do), Chat, Message owner. Non-needs-human plan items are
  // agent-actionable, so the human only gets Chat + Message owner.
  const actions: AttentionAction[] = needsHuman
    ? [
        { id: 'answer', label: 'Answer' },
        { id: 'mark-done', label: 'Resolve', primary: true },
        { id: 'drop', label: 'Drop' },
        CHAT,
        MESSAGE_OWNER,
      ]
    : [CHAT, MESSAGE_OWNER];
  return {
    id: `plan-item:${it.slug}:${it.id}`,
    kind: 'plan-item',
    category: ATTENTION_KIND_CATEGORY['plan-item'],
    source: 'plan',
    harnessSlug: it.harnessSlug,
    planSlug: it.slug,
    itemRef: it.id,
    title: clip(it.text),
    body: it.text,
    status: it.effectiveStatus,
    importance: it.importance,
    tier,
    needsHuman,
    ownerAgentId: it.ownerAgentId ?? null,
    ownerLabel: it.ownerLabel ?? null,
    ...untriaged(),
    actions,
    ref: {
      kind: 'plan-item',
      slug: it.slug,
      itemId: it.id,
      harnessSlug: it.harnessSlug,
      priorStatus: it.storedStatus,
    },
  };
}

/* ── coord escalation (P-010) ───────────────────────────────────────────
 * The DECISION coord-channel (P-102/D-011): an escalation is a BLOCKED decision
 * whose disposition is RESOLVE-WITH-CHOICE (coord:resolve, picking a named
 * option). blocker/question → Decision; advisory → Alert. Distinct from a
 * `coord-message` (a communication, ack) and a `conversation` (a non-blocking
 * coord:ask question, Alert). These three are the coherent coord disposition set.
 */

export interface CoordEscalationInput {
  msgId: string;
  severity: 'blocker' | 'question' | 'advisory';
  summary: string;
  body?: string;
  planSlug?: string | null;
  harnessSlug?: string | null;
  options?: { id: string; label: string }[];
  /** The escalating agent (the coord record's `from`) — drives Message owner. */
  from?: string | null;
  fromLabel?: string | null;
  /** Authoritative held goal stamped by coord:escalate (D-015). */
  goalRef?: string | null;
  /** EI-19401034233741994: the conversation twin this escalation is the
   * Decision-tier leg of (`meta.conversationId`, stamped by `coord:ask-owner`).
   * Only ask-owner escalations carry it; everything else leaves it undefined. */
  conversationId?: string | null;
}

/**
 * queue-pending-accuracy D-005: an escalation is OPERATIONAL — a system/automated
 * alert, NOT a human decision — when its sender is a `system` owner (incl.
 * `system:<emitter>` like `system:hive-placement-watchdog`) AND it carries no
 * options (no choice to make). Placement-watchdog cursed placements + aging
 * sweeps are the dominant class (~7000 open, 135 ever resolved). Genuine human
 * decisions come from agents (coord:escalate / coord:ask-owner) — a real sender,
 * often with options. Operational escalations are surfaced in the ALERT tier and
 * auto-resolved by the reconciliation sweep; they never reach "waiting on you".
 * The shared classifier so the reader (tiering) and the reconcile sweep agree.
 */
/** Named automated, non-human, non-agent INFRA emitters (CI / pipeline bots)
 *  whose option-less escalations are operational status, not owner decisions.
 *  `system[:…]` is matched by the prefix check; this set is for the named bots
 *  (D-006 ext 1). Extend it as new infra emitters appear — never add an AGENT
 *  alias (a bee's escalation can be a genuine ask).
 *
 *  EI-6789/EI-6782 (escalation-aging metric mismatch, 2026-07-02): 'steering-lease'
 *  and 'compaction-watchdog' floods were driving `harness_shared.coord_open_escalations`
 *  to 630+ rows (395 from steering-lease alone, accumulating since 2026-06-25) — the
 *  SAME flood-class EI-1490 fixed for placement-watchdog, just from two NEW automated
 *  senders that predate this set. Each fires a per-instance "Steering proposal:
 *  papercusp/WI-… → feature_order=… (non-holder Swarm; holder …)" /
 *  "fleet member … died on \"Prompt is too long\"…" message whose text embeds a
 *  changing id/count, so the dedup-by-subjectSignature in coordination/escalations.ts
 *  never matches two firings and each becomes a NEW, never-resolved "open" row. This
 *  is what made `computeEscalationsHealth`'s `aging` count (593→596, unbounded) wildly
 *  diverge from the live `coord:escalations{status:open}` page (single/low-double-digit)
 *  — the health panel's full unbounded fold counts every one of these zombie rows; the
 *  paginated read only shows whatever's in its recent-events window. Both are neither a
 *  human decision-with-a-choice (`options` is always null on these) nor a real agent ask
 *  — they're status broadcasts from a named coordination/lifecycle mechanism.
 *
 *  EI-16170: `inference-gateway` (credential-health dead-account alerts,
 *  inference-gateway/launch.ts), `scout-outcome-refresh-sweep`,
 *  `rubric-staleness-watchdog`, and `scorecard-emission-pulse` are the same
 *  shape — each is a named, option-less `system · <name>`/static-client
 *  identity emitting a redundant status advisory, verified via a live-DB
 *  sample of the papercusp-workspace open backlog: none had ever appeared in
 *  this set, so every one of their firings counted toward the human-attention
 *  `aging` figure (contributing to the "326 aging escalations" OverwatchBrief
 *  reading investigated under EI-16170) instead of being demoted to the alert
 *  tier and becoming eligible for the 48h TTL auto-reconcile sweep
 *  (reconcile-escalations.ts) like their siblings above. */
const AUTOMATED_INFRA_EMITTERS = new Set<string>([
  'green-checkpoint',
  'steering-lease',
  'compaction-watchdog',
  'inference-gateway',
  'scout-outcome-refresh-sweep',
  'rubric-staleness-watchdog',
  'scorecard-emission-pulse',
]);

/**
 * WI-2140594: the named set above is RESIDUE, not the source of truth. Every
 * member is also matched by `isMachineEscalationEmitter` (machine-authored.ts),
 * which DERIVES "process emitter" from the sender's shape — `…-watchdog`,
 * `…-sweep`, `…-pulse`, `…-lease`, `…-alarm`, `…-gateway`, `…-detector`, … — and
 * can never reach an agent-session identity (`su-…`, `s-…`, `cup-…`, `role-…`, a
 * bare uuid), the owner GUI, or `human`. The hand list had already drifted six
 * emitters behind the tree (measured 2026-09-01: wall-lapse-watchdog 74 rows,
 * unservable-critical-watchdog 24, goal-owner-report-watchdog 23,
 * intent-divergence-detector 19, goal-liveness-watchdog 7, embed-latency-watchdog
 * 6 — each tiered as an owner decision and reaped only by the 7d dead-author
 * sweep). Add a name here ONLY for an emitter whose name falls outside that
 * shape; a new `…-watchdog` needs nothing.
 */
export function isOperationalEscalation(from: string | null | undefined, hasOptions: boolean): boolean {
  if (hasOptions || typeof from !== 'string') return false;
  return (
    from === 'system' ||
    from.startsWith('system:') ||
    AUTOMATED_INFRA_EMITTERS.has(from) ||
    isMachineEscalationEmitter(from)
  );
}

export function coordEscalationToAttention(e: CoordEscalationInput): AttentionItem {
  const options = e.options ?? [];
  // Tier (D-002/D-001) via the canonical risk scale (queen-autonomy-policy P-013):
  // the escalation's severity folds into `risk_tier`, and the alert-vs-decision
  // tier derives from THAT — one scale, not two. blocker/question (critical/high)
  // → Decision (a genuine human call: coord:ask-owner + coord:escalate(blocker)
  // land here); advisory (low) → Alert (surface, don't demand).
  const riskTier = severityToRiskTier(e.severity);
  // queue-pending-accuracy D-005: a SYSTEM-emitted escalation with no options is
  // OPERATIONAL (placement-watchdog cursed placements, aging sweeps, breakers) —
  // an alert to surface, NOT a human decision-with-choice. Genuine decisions come
  // from agents (coord:escalate / coord:ask-owner) and either come from a real
  // sender or carry options to pick. Surfacing every cursed placement as a
  // "waiting on you" decision flooded the queue (~7000+ open, 135 ever resolved);
  // the derived placements.cursed health metric is the proper rollup.
  const operationalSystem = isOperationalEscalation(e.from, options.length > 0);
  const tier: AttentionTier = operationalSystem ? 'alert' : riskTierIsDecision(riskTier) ? 'decision' : 'alert';
  const needsHuman = needsHumanForTier(tier);
  return {
    id: `coord-escalation:${e.msgId}`,
    kind: 'coord-escalation',
    category: ATTENTION_KIND_CATEGORY['coord-escalation'],
    source: 'coord',
    harnessSlug: e.harnessSlug ?? null,
    planSlug: e.planSlug ?? null,
    itemRef: null,
    title: clip(e.summary),
    body: e.body?.trim() || e.summary,
    status: 'open',
    importance: severityToImportance(e.severity),
    tier,
    needsHuman,
    ownerAgentId: e.from ?? null,
    ownerLabel: e.fromLabel ?? e.from ?? null,
    ...untriaged(),
    // Resolve always (coord:resolve, with the escalation's named options).
    // Discuss routes to the escalating agent or a fresh harness chat (DiscussPanel).
    actions: [{ id: 'resolve', label: 'Resolve', primary: true }, DISCUSS],
    ref: {
      kind: 'coord-escalation',
      msgId: e.msgId,
      options,
      goalRef: e.goalRef ?? null,
      conversationId: e.conversationId ?? null,
    },
  };
}

/* ── coord message addressed to the human (P-027) ───────────────────────
 * The COMMUNICATION coord-channel (P-102/D-011): a message's disposition is ACK
 * (acknowledge/dismiss) — it is NEVER a Decision. A blocked decision is an
 * `coord-escalation` (resolve-with-choice); an open question is a `conversation`
 * (coord:ask). A directly-addressed message is an Alert; a broadcast is Activity.
 */

export interface CoordMessageInput {
  msgId: string;
  summary?: string;
  body?: string;
  from?: string;
  fromLabel?: string | null;
  planSlug?: string | null;
  harnessSlug?: string | null;
  /** `auto:true` marker that coord:emit stamps on lifecycle broadcasts. */
  auto?: boolean;
  /** `lifecycle:'<category>'` marker (completion/claim/intent/…) — presence
   *  alone marks the message as a system lifecycle broadcast. */
  lifecycle?: string | null;
  /** True when the message is addressed DIRECTLY to the human (its `to`
   *  includes the human owner id), not solely a `*` broadcast. */
  directToOwner?: boolean;
  /** agent-report-cards-2026-07-17 P-002: the envelope's structured report-card
   *  payload (`extra.report` stamped by coord:send), RAW — re-validated here
   *  through the canonical `parseReportBlock` (defensive: a foreign/legacy row
   *  may not match the schema; invalid ⇒ silently treated as absent, mirroring
   *  `reportTurnsToAttention`). */
  report?: unknown;
}

export function coordMessageToAttention(m: CoordMessageInput): AttentionItem {
  // Tier (D-002/D-003 + P-102/D-011): classify from STRUCTURED fields, never the
  // text. A message is a COMMUNICATION (its disposition is `ack`), NEVER a
  // Decision — acking is not deciding. Genuine human decisions route through
  // ESCALATIONS (coord:escalate → resolve-with-choice) or open QUESTIONS
  // (coord:ask → conversation); a plain coord:send to the human is an FYI. So:
  // a non-auto message addressed directly to the human → Alert (worth surfacing,
  // but ack-only); an auto/lifecycle broadcast or a plain `*` broadcast →
  // Activity. This collapses the old question-escalation ↔ direct-message overlap
  // (both used to land in Decisions): escalations are now the sole decision
  // coord-channel.
  const isAuto = m.auto === true || (typeof m.lifecycle === 'string' && m.lifecycle.length > 0);
  const baseTier: AttentionTier = isAuto ? 'activity' : m.directToOwner ? 'alert' : 'activity';
  // agent-report-cards P-002: a structured report card riding the message
  // (coord:send `report`, re-validated through the one canonical validator —
  // invalid/foreign payloads degrade to a plain text message, never throw).
  const report = m.report !== undefined && m.report !== null ? parseReportBlock(m.report) : null;
  // D-003: report statuses may ELEVATE the message (a fleet update carrying
  // blocked/failing rows surfaces as an Alert even on a broadcast) but NEVER
  // to Decision — a coord message stays a COMMUNICATION (ack-only, P-102/D-011);
  // a needs-human status in a report card caps at Alert, and a genuine ask
  // still routes through coord:escalate. An auto/lifecycle broadcast is never
  // elevated (lifecycle wins — the same rule that keeps an auto directToOwner
  // message at activity), so machine-stamped robot chatter can't self-promote.
  const tier: AttentionTier =
    report && !isAuto && baseTier === 'activity' && reportTier(report) !== 'activity' ? 'alert' : baseTier;
  const needsHuman = needsHumanForTier(tier);
  return {
    id: `coord-message:${m.msgId}`,
    kind: 'coord-message',
    category: ATTENTION_KIND_CATEGORY['coord-message'],
    source: 'coord',
    harnessSlug: m.harnessSlug ?? null,
    planSlug: m.planSlug ?? null,
    itemRef: null,
    title: clip(m.summary || m.body || 'Message'),
    // Text-only surfaces (mobile route, search) see the sender's prose when
    // there is any, else the report's plain-text rendition — the structured
    // payload rides `report` for the native card renderers.
    body: m.body?.trim() || (report ? reportBody(report) : '') || m.summary || '',
    // Neutral status — there is no real read/ack tracking yet, so don't
    // imply one with an "unread" badge.
    status: 'message',
    importance: 'normal',
    tier,
    needsHuman,
    ownerAgentId: m.from ?? null,
    ownerLabel: m.fromLabel ?? m.from ?? null,
    ...untriaged(),
    // Ack always; Discuss routes to the sender or a fresh harness chat (DiscussPanel).
    actions: [{ id: 'ack', label: 'Acknowledge', primary: true }, DISCUSS],
    ref: { kind: 'coord-message', msgId: m.msgId },
    // agent-report-cards P-002: the validated ReportBlock rides the item so the
    // Inbox detail pane renders it natively (ReportBlockCard) — same field the
    // operator-report adapter sets; absent when the message carries no card.
    ...(report ? { report } : {}),
  };
}

/* ── smoke-test failure (P-025) ─────────────────────────────────────── */

export interface SmokeFailInput {
  harnessSlug: string;
  failureContent?: string | null;
}

export function smokeFailToAttention(s: SmokeFailInput): AttentionItem {
  // A failing smoke test is a problem to surface, not a decision → Alert.
  const tier: AttentionTier = 'alert';
  return {
    id: `smoke-fail:${s.harnessSlug}`,
    kind: 'smoke-fail',
    category: ATTENTION_KIND_CATEGORY['smoke-fail'],
    source: 'harness',
    harnessSlug: s.harnessSlug,
    planSlug: null, // unattached → synthetic "Alerts" bucket
    itemRef: null,
    title: `Smoke test failing — ${s.harnessSlug}`,
    body: (s.failureContent ?? '').trim() || 'The smoke test is failing.',
    status: 'fail',
    importance: 'high',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    // P-003: `ack` is the acknowledgement-class terminal — an operator cannot
    // make a past smoke run pass, so acknowledging that the failure was seen is
    // the honest end of the CARD. Fixing it is engineering work with its own
    // work-item, which is why this is not a source mutation.
    actions: [{ id: 'view-log', label: 'View log', primary: true }, { id: 'ack', label: 'Acknowledge' }, DISCUSS],
    ref: { kind: 'smoke-fail', harnessSlug: s.harnessSlug },
  };
}

/* ── operator `<report>` turn (report-cards-inbox-reconciliation P-003) ── */

export interface OperatorReportInput {
  turnId: string;
  conversationId: string;
  /** The validated `ReportBlock` from `operator_turns.report`. */
  report: ReportBlock;
  /** The turn's `<say>` text — title fallback when the report has none. */
  sayText?: string | null;
}

/** Plain-text rendition of a report block for text-only surfaces (the
 *  mobile/device attention route, search). The structured payload rides
 *  `AttentionItem.report` for the native renderers. */
function reportBody(report: ReportBlock): string {
  const lines: string[] = [];
  for (const p of report.plans) {
    const status = p.status ? `[${p.status}] ` : '';
    const summary = p.summary ? ` — ${p.summary}` : '';
    lines.push(`${status}${p.title}${summary}`);
    for (const it of p.items ?? []) {
      const is = it.status ? `[${it.status}] ` : '';
      const id = it.id ? `${it.id} ` : '';
      lines.push(`  ${is}${id}${it.text}`);
    }
  }
  return lines.join('\n');
}

/**
 * One inbox item per `<report>` turn (D-003 — a 4-plan status report is one
 * row, not four). Tier = worst-of statuses via {@link reportTier}; the
 * operator's report is the precision-filtered output already (Brief 21
 * D-006), so `decision` here means the operator explicitly marked something
 * needs-human/review. Importance follows the tier (a "needs your review"
 * report should be seen today; a status snapshot can wait).
 */
export function operatorReportToAttention(r: OperatorReportInput): AttentionItem {
  const tier = reportTier(r.report);
  const importance: Importance = tier === 'decision' ? 'high' : tier === 'alert' ? 'normal' : 'low';
  // A single-plan report is *about* that plan — adopt its slug so the item
  // groups with the plan in the master list. Multi-plan snapshots stay
  // unattached (the synthetic bucket).
  const planSlug = r.report.plans.length === 1 ? (r.report.plans[0]?.slug ?? null) : null;
  const actions: AttentionAction[] = [{ id: 'resolve', label: 'Resolve', primary: true }];
  if (planSlug) actions.push({ id: 'open', label: 'Open plan' });
  return {
    id: `operator-report:${r.turnId}`,
    kind: 'operator-report',
    category: ATTENTION_KIND_CATEGORY['operator-report'],
    source: 'operator',
    harnessSlug: null, // the operator conversation is workspace-level
    planSlug,
    itemRef: null,
    title: r.report.title ?? (clip(r.sayText) || 'Operator report'),
    body: reportBody(r.report),
    status: 'report',
    importance,
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: 'Operator',
    ...untriaged(),
    actions,
    ref: { kind: 'operator-report', turnId: r.turnId, conversationId: r.conversationId },
    report: r.report,
  };
}

/* ── B-14 / P-100: the folded disposition channels (D-011) ───────────────────
 *
 * Each is a categorized decision/action the Queen did not auto-handle, surfaced
 * on the unified Queue. Resolution stays on the dedicated surface via a navigate
 * `open` action (the smoke-fail/operator-report pattern) — inline-disposition
 * buttons are a follow-on, not a blocker for the fold. CRITICAL: each adapter's
 * READER (plans:attention) filters to the genuinely-AWAITING-HUMAN slice, never
 * the full backlog — improvements only when `needsHuman` (the auto-implement
 * loop's human-routing flag); the execution backlog (work_items) stays separate.
 */

/** issue/improvement severity → importance (distinct from escalation severity). */
function issueSeverityToImportance(sev: string | null | undefined): Importance {
  switch (sev) {
    case 'critical':
      return 'urgent';
    case 'major':
      return 'high';
    case 'nit':
      return 'low';
    default:
      return 'normal'; // 'minor' / unknown
  }
}

/* ── improvement awaiting human triage (P-100) ──────────────────────────── */

export interface ImprovementInput {
  /** engineer_issues id (EI-NNN / WI-NNN). */
  issueId: string;
  title: string;
  body?: string | null;
  severity?: string | null;
  harnessSlug?: string | null;
  /** Source scalars captured before an unattended terminal action. */
  ideaLifecycle?: unknown;
  decidedReason?: string | null;
}

export function improvementToAttention(i: ImprovementInput): AttentionItem {
  // The auto-implement loop set needsHuman → it explicitly routed this to the
  // owner (the reader only passes needsHuman-flagged items), so it is a Decision.
  const tier: AttentionTier = 'decision';
  return {
    id: `improvement:${i.issueId}`,
    kind: 'improvement',
    category: ATTENTION_KIND_CATEGORY['improvement'],
    source: 'harness',
    harnessSlug: i.harnessSlug ?? null,
    planSlug: null, // unattached → the synthetic "Alerts" bucket
    itemRef: null,
    title: clip(i.title),
    body: (i.body ?? '').trim() || i.title,
    status: 'needs-triage',
    importance: issueSeverityToImportance(i.severity),
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    // D-027 follow-on (1): inline Dismiss (improvements:triage reject — closes the
    // idea, and the recall matcher surfaces "already decided" on the next
    // same-signature capture). Triage stays a navigate to the full surface: ACCEPTING
    // an improvement is a routing decision (place/gate/gym), not a one-click — a bare
    // inline "accept" would record an un-targeted decision, so it lives on the source.
    actions: [
      { id: 'open', label: 'Triage', primary: true },
      { id: 'dismiss', label: 'Dismiss' },
    ],
    ref: {
      kind: 'improvement',
      issueId: i.issueId,
      harnessSlug: i.harnessSlug ?? null,
      priorIdeaLifecycle: i.ideaLifecycle ?? null,
      priorDecidedReason: i.decidedReason ?? null,
    },
  };
}

/* ── standing-approval candidate awaiting the owner (P-100) ──────────────── */

export interface StandingApprovalInput {
  capability: string;
  targetHarness: string;
  /** Silent dispatches in the trailing 24h window (≥3 to qualify). */
  count: number;
  lastSeenAt?: string | null;
}

export function standingApprovalToAttention(s: StandingApprovalInput): AttentionItem {
  // The owner must decide whether to grant standing auto-dispatch — a genuine
  // Decision. Category system-control is PROTECTED (never-auto): the Queen can
  // never auto-grant herself a standing approval (the recursion D-005 guards).
  const tier: AttentionTier = 'decision';
  return {
    id: `standing-approval:${s.capability}:${s.targetHarness}`,
    kind: 'standing-approval',
    category: ATTENTION_KIND_CATEGORY['standing-approval'],
    source: 'operator',
    harnessSlug: s.targetHarness,
    planSlug: null,
    itemRef: null,
    title: `Standing approval? ${s.capability} → ${s.targetHarness}`,
    body: `The operator has auto-dispatched ${s.capability} to ${s.targetHarness} ${s.count}× in the last 24h. Grant a standing approval (auto-dispatch without asking) or dismiss.`,
    status: 'pending-approval',
    importance: 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    // D-027 follow-on (1): inline disposition — Grant writes the standing
    // [STANDING-APPROVE] preference entry, Dismiss drops the candidate
    // (operator:standing_approvals_decide). A clean owner binary, so resolve it
    // on the Queue rather than bouncing to the operator-settings surface.
    actions: [
      { id: 'grant', label: 'Grant', primary: true },
      { id: 'dismiss', label: 'Dismiss' },
    ],
    ref: { kind: 'standing-approval', capability: s.capability, targetHarness: s.targetHarness },
  };
}

/* ── open conversation / coord:ask awaiting an answer (P-100) ────────────── */

export interface ConversationInput {
  conversationId: string;
  title: string;
  body?: string | null;
  /** The asking agent (drives Message owner). */
  askerId?: string | null;
  askerLabel?: string | null;
  harnessSlug?: string | null;
}

export function conversationToAttention(c: ConversationInput): AttentionItem {
  // An open question is surfaced as an Alert, not a Decision: many coord:ask
  // conversations are agent↔agent and resolve without the human. The owner can
  // still answer; we surface, we don't demand (mirrors advisory escalations).
  const tier: AttentionTier = 'alert';
  return {
    id: `conversation:${c.conversationId}`,
    kind: 'conversation',
    category: ATTENTION_KIND_CATEGORY['conversation'],
    source: 'coord',
    harnessSlug: c.harnessSlug ?? null,
    planSlug: null,
    itemRef: null,
    title: clip(c.title),
    body: (c.body ?? '').trim() || c.title,
    status: 'open',
    importance: 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: c.askerId ?? null,
    ownerLabel: c.askerLabel ?? c.askerId ?? null,
    ...untriaged(),
    // D-027 follow-on (1): inline disposition — `answer` is a navigate id (the
    // detail pane reveals an inline InputCard); submitting resolves the question
    // with the owner's text (conversations:resolve { accepted_answer }), which
    // captures it to the knowledge layer AND drops it from the Queue (the reader
    // surfaces only open, unanswered conversations).
    // P-003: Answer stays a navigate (it opens the inline input card, and the
    // owner's text becomes the accepted answer). `Close` is the terminal for the
    // question the owner is never going to answer — conversations:resolve on the
    // row itself, so it stops being an open question at the source rather than
    // sitting in the queue forever.
    actions: [{ id: 'answer', label: 'Answer', primary: true }, { id: 'dismiss', label: 'Close' }, DISCUSS],
    ref: { kind: 'conversation', conversationId: c.conversationId },
  };
}

/* ── Scout grading rollup (P-100) ────────────────────────────────────────── */

export interface ScoutGradeInput {
  /** Number of routed Scout ideas with no human grade yet. */
  count: number;
}

/**
 * ONE rollup item for the whole ungraded-Scout-ideas set (never one per idea —
 * routed ideas can number in the thousands, and a grade is OPTIONAL feedback
 * that tunes routing, not an owner-blocking decision). Activity tier, low
 * importance; navigates to the Scout/Learning grade view. The reader emits this
 * only when count > 0.
 */
export function scoutGradeToAttention(g: ScoutGradeInput): AttentionItem {
  const tier: AttentionTier = 'activity';
  return {
    id: 'scout-grade:pending',
    kind: 'scout-grade',
    category: ATTENTION_KIND_CATEGORY['scout-grade'],
    source: 'operator',
    harnessSlug: null,
    planSlug: null,
    itemRef: null,
    title: `${g.count} Scout idea${g.count === 1 ? '' : 's'} awaiting your grade`,
    body: 'Routed Scout ideas have no human grade yet — optional feedback (1–5) that tunes idea routing. Grade them in the Scout view.',
    status: 'ungraded',
    importance: 'low',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    // P-003: grading is OPTIONAL feedback, so there is no per-idea source state
    // an inbox click should mutate — dismissing records that the owner declined
    // the nudge, which is the whole disposition this rollup can have.
    actions: [
      { id: 'open', label: 'Grade ideas', primary: true },
      { id: 'dismiss', label: 'Dismiss' },
    ],
    ref: { kind: 'scout-grade', count: g.count },
  };
}

/* ── owner-inbox-single-pane-2026-07-17 P-005: the folded owner-gate channels ──
 * Each is a DISTINCT wall a working agent explicitly raised — every one already
 * a Decision by construction (the reader only ever passes rows already routed
 * to the owner), so `tier` is always 'decision' here, never derived. */

/* ── needs-human work-item of ANY kind (P-005a) ─────────────────────────── */

export interface WorkItemNeedsHumanInput {
  /** The cross-kind work-item id (feature_id in the harness_shared.work_items
   *  view — WI-/F-/EI- style depending on kind). */
  workItemId: string;
  /** feature | chunk | research-task | bug | change | task. */
  itemKind: string;
  title: string;
  body?: string | null;
  harnessSlug?: string | null;
  ownerAgentId?: string | null;
  ownerLabel?: string | null;
  /** The row's own lifecycle status. P-003 derives WHICH of the source query's
   *  two legs admitted this row, so the terminal action clears the right gate;
   *  omitted ⇒ treated as the payload leg (the issue-family default). */
  status?: string | null;
  /** Exact payload keys whose boolean true admitted the row to the owner gate. */
  ownerGateKeys?: Array<'needsHuman' | 'needsOwnerAction'>;
}

/**
 * A work-item (any kind) an agent routed to the owner via `needs_human_review`
 * (feature-family) or `payload.needsHuman` (issue-family). Distinct from
 * `plan-item`'s needs-human tier: a plan item lives in a plan DOCUMENT and is
 * read from parsed markdown (source #1); a work-item is a row in the
 * `harness_shared.work_items` cross-kind view and may have NO plan attached at
 * all (a bare `improvements:capture` / `work_items:create`). Also distinct from
 * `improvement`: that source is topic-scoped to `papercusp-improvement`
 * (engineer_issues only) — this one is topic-agnostic across every kind,
 * including feature/chunk and untagged bug/change/task rows. The reader dedups
 * the overlap (D-008 — see `dropDuplicateNeedsHumanWorkItems` in sources.ts).
 */
export function workItemNeedsHumanToAttention(i: WorkItemNeedsHumanInput): AttentionItem {
  const tier: AttentionTier = 'decision';
  // P-003: until now EVERY action here was a navigate — Answer opens an input
  // card, Open opens the source, Discuss opens a chat — so the single largest
  // population in the owner's inbox (46% of the bulk-run ledger) had no way to
  // END, by click or by resolver. `Release` clears the owner gate and hands the
  // item back to the agents; `Drop` closes it. Both write the work_items row, so
  // the card cannot re-derive on the next read.
  const ownerGateActions: AttentionAction[] = [
    { id: 'resolve', label: 'Release to agents' },
    { id: 'drop', label: 'Drop' },
  ];
  const actions: AttentionAction[] = i.ownerAgentId
    ? [
        { id: 'answer', label: 'Answer', primary: true },
        ...ownerGateActions,
        { id: 'open', label: i.harnessSlug ? 'Open work item' : 'Open source' },
        DISCUSS,
      ]
    : [
        { ...ownerGateActions[0]!, primary: true },
        ownerGateActions[1]!,
        { id: 'open', label: i.harnessSlug ? 'Open work item' : 'Open source' },
        DISCUSS,
      ];
  return {
    id: `work-item-needs-human:${i.workItemId}`,
    kind: 'work-item-needs-human',
    category: ATTENTION_KIND_CATEGORY['work-item-needs-human'],
    source: 'harness',
    harnessSlug: i.harnessSlug ?? null,
    planSlug: null, // unattached → the synthetic "Alerts" bucket
    /* WI-6597: this WAS null, and it is the identifier every downstream reader
     * keys on — so the HUD Work-items board's ask-vs-work-item dedupe was inert
     * (its `!a.itemRef ||` disjunct was true for 60/60 live cards, double-counting
     * every item that is both a needs-human ROW and an ask), the board's card
     * `ref` degraded to the kind LABEL "Work item", and a curator `wi:<ref>`
     * drill-in had nothing to match. The item id is right here in the input;
     * withholding it bought nothing.
     *
     * HARNESS-QUALIFIED (`<harness>#<id>`), matching what the curator emits and
     * what this module's docblock (see itemRef above) already documents — a
     * work-item lookup is harness-scoped, so a bare id is not resolvable on a
     * cross-harness surface. Readers split it with
     * `apps/operator/lib/work-item-ref.ts` (trailing segment = the id), which
     * also tolerates a `harness:`-prefixed slug. */
    itemRef: i.harnessSlug ? `${i.harnessSlug}#${i.workItemId}` : i.workItemId,
    title: clip(i.title),
    body: (i.body ?? '').trim() || i.title,
    status: `needs-human (${i.itemKind})`,
    importance: 'high',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: i.ownerAgentId ?? null,
    ownerLabel: i.ownerLabel ?? null,
    ...untriaged(),
    actions,
    ref: {
      kind: 'work-item-needs-human',
      workItemId: i.workItemId,
      itemKind: i.itemKind,
      ownerGate: i.status === 'needs-human' ? 'status' : 'payload',
      harnessSlug: i.harnessSlug ?? null,
      priorStatus: i.status ?? null,
      ownerGateKeys: i.ownerGateKeys ?? [],
    },
  };
}

/* ── blocked work-item of ANY kind (curated-signal-cards P-001) ─────────── */

export interface BlockedWorkItemInput {
  /** The cross-kind work-item id (feature_id in the harness_shared.work_items
   *  view — WI-/F-/EI- style depending on kind). */
  workItemId: string;
  /** feature | chunk | research-task | bug | change | task. */
  itemKind: string;
  title: string;
  /** Why it is blocked — external blockers when present, else the summary. */
  reason: string;
  harnessSlug?: string | null;
  ownerAgentId?: string | null;
  ownerLabel?: string | null;
  /** The curator's stable ref for this row, `<harness>#<featureId>` — the
   *  identifier the chat status-card's drill-in carries as `wi:<ref>`. */
  curatorRef?: string | null;
}

/**
 * A work-item parked at `status='blocked'`. The cross-kind counterpart of a
 * blocked PLAN item: `planItemToAttention` already tiers a blocked plan item as
 * an Alert, but that source reads plan DOCUMENTS only — a work-item row in
 * `harness_shared.work_items` (often with no plan attached at all) had no card.
 *
 * Tier is `alert`, never `decision`: work being stuck is a problem worth
 * surfacing, but unblocking it is WORK, not a triage verdict the human is being
 * asked to render. That matches the blocked-plan-item tiering exactly, and it
 * keeps `needsHuman` false so these never inflate the Decisions bucket.
 *
 * The id (`work-item-blocked:<id>`) is the join key the curation salience policy
 * maps its `blocked:<harness>#<id>` signal onto (P-003), so triaging this card
 * suppresses the chat re-nag the same way triaging an escalation already does.
 *
 * `itemRef` carries the curator's `<harness>#<featureId>` ref (NOT a P-NNN —
 * see the field doc) specifically so the ALREADY-SHIPPED chat status-card
 * drill-in resolves onto this card: `resolveInboxDrillIn`
 * (deterministic-status-cards-2026-07-17 / WI-5342) deliberately matches a
 * `wi:<ref>` drill-in against each live item's OWN identifiers rather than
 * enumerating per-kind mappings, and `itemRef` is the identifier it reads.
 * Without this, clicking through a `🚧 Blocked` work-item status card opens the
 * inbox pane with NOTHING selected — which is the live bug this source fixes.
 */
export function blockedWorkItemToAttention(i: BlockedWorkItemInput): AttentionItem {
  const tier: AttentionTier = 'alert';
  return {
    id: `work-item-blocked:${i.workItemId}`,
    kind: 'work-item-blocked',
    category: ATTENTION_KIND_CATEGORY['work-item-blocked'],
    source: 'harness',
    harnessSlug: i.harnessSlug ?? null,
    planSlug: null, // unattached → the synthetic "Alerts" bucket
    itemRef: i.curatorRef ?? null,
    title: clip(i.title),
    body: i.reason.trim() || i.title,
    status: `blocked (${i.itemKind})`,
    importance: 'high',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: i.ownerAgentId ?? null,
    ownerLabel: i.ownerLabel ?? null,
    ...untriaged(),
    // P-003: a permanently-blocked row should be closeable from the surface that
    // shows it. Drop writes the terminal state with the caller's rationale as the
    // completion evidence a terminal close requires.
    actions: [{ id: 'open', label: 'Open', primary: true }, { id: 'drop', label: 'Drop' }, DISCUSS],
    ref: { kind: 'work-item-blocked', workItemId: i.workItemId, itemKind: i.itemKind },
  };
}

/* ── registered owner-wall (P-005b) ─────────────────────────────────────── */

export interface OwnerWallInput {
  source: 'loop-carry-note' | 'work-item' | 'standing-fact';
  ownerId: string | null;
  harnessSlug?: string | null;
  claim: string;
  recheck?: string | null;
  ref?: string | null;
  factScope?: 'workspace' | 'role' | 'owner' | 'harness' | 'work_item';
  factScopeRef?: string | null;
  factKey?: string | null;
  waitingHours?: number | null;
  /** Mirrors coord:walls' liveness join: `stranded` = the raising agent's
   *  session is gone, so answering alone will not resume the work. `stale`
   *  means the session is draining and is not currently actionable. */
  status: 'waiting' | 'stale' | 'stranded' | 'unknown';
  /** Shared read-time verdict. Older callers may provide only `status`; the
   *  adapter keeps that shape as a compatibility fallback. */
  actionability?: ReadActionability;
  livenessState?: SessionState | null;
}

/**
 * Owner-facing queues must not infer "needs the human" from the existence of
 * a row. A live/parked/recorded owner can still receive an answer; draining,
 * ended, and suspect owners cannot; a missing verdict is deliberately
 * unknown. The latter two categories remain visible as Alerts so the stale
 * source is diagnosable without inflating the Decisions/Needs-you count.
 */
function ownerGateActionability(
  actionability: ReadActionability | undefined,
  livenessState: SessionState | null | undefined,
  status: OwnerWallInput['status'],
): ReadActionability {
  if (actionability != null) return actionability;
  if (livenessState != null) return classifyReadActionability(livenessState);
  if (status === 'waiting') return 'actionable';
  if (status === 'stale' || status === 'stranded') return 'non-actionable';
  return 'unknown';
}

function ownerGateStatus(
  actionability: ReadActionability,
  livenessState: SessionState | null | undefined,
  fallback: OwnerWallInput['status'],
): 'waiting' | 'stale' | 'stranded' | 'unknown' {
  if (actionability === 'actionable') return 'waiting';
  if (livenessState === 'draining' || fallback === 'stale') return 'stale';
  if (livenessState === 'ended' || livenessState === 'suspect' || fallback === 'stranded') {
    return 'stranded';
  }
  return 'unknown';
}

function livenessStatusNote(status: 'waiting' | 'stale' | 'stranded' | 'unknown'): string {
  if (status === 'stale') {
    return '\n\n⚠ STALE — the raising session is draining and is not currently actionable; recheck its liveness before answering.';
  }
  if (status === 'stranded') {
    return "\n\n⚠ STRANDED — the raising agent's session has died. Answering alone will not resume this work; it also needs a respawn.";
  }
  if (status === 'unknown') {
    return '\n\n⚠ LIVENESS UNKNOWN — this row is retained for diagnosis but is not counted as waiting on the owner.';
  }
  return '';
}

/**
 * A wall an agent already registered via `loop:checkpoint { walls }` or by
 * parking a work-item in `needs-human` — the SAME union `coord:walls` reads
 * (reuse-first: no new store). Folded into the unified inbox so an owner-gated
 * blocker shows up alongside every other Decision instead of requiring a
 * separate `coord:walls` call. `stranded` walls are flagged in the body: the
 * owner must respawn the agent, not just answer.
 */
export function ownerWallToAttention(w: OwnerWallInput): AttentionItem {
  const actionability = ownerGateActionability(w.actionability, w.livenessState, w.status);
  const projectedStatus = ownerGateStatus(actionability, w.livenessState, w.status);
  const tier: AttentionTier = actionability === 'actionable' ? 'decision' : 'alert';
  const idPart = w.ref ?? w.ownerId ?? w.claim;
  const hours = w.waitingHours ?? 0;
  const workItemSource = w.source === 'work-item' && w.ref && /^(?:WI|EI|F)-\d+$/i.test(w.ref);
  const standingFactSource = w.source === 'standing-fact' && Boolean(w.factScope) && Boolean(w.factKey?.trim());
  // P-003: every branch here was navigate-only, so a registered wall could never
  // be ENDED from the inbox — only talked about. A work-item-backed wall clears
  // through the same owner gate as a `work-item-needs-human` card (a real source
  // mutation); a loop-carry-note wall has no operator-writable row, so its honest
  // terminal is the acknowledgement record instead.
  const wallTerminal: AttentionAction =
    workItemSource || standingFactSource
      ? { id: 'resolve', label: 'Clear wall' }
      : { id: 'dismiss', label: 'Clear wall' };
  const actions: AttentionAction[] =
    actionability === 'actionable' && w.ownerId
      ? [
          { id: 'answer', label: 'Answer', primary: true },
          wallTerminal,
          { id: 'message-owner', label: 'Open agent session' },
          DISCUSS,
        ]
      : workItemSource
        ? [
            { id: 'open', label: w.harnessSlug ? 'Open work item' : 'Open source', primary: true },
            wallTerminal,
            DISCUSS,
          ]
        : w.ownerId
          ? [{ id: 'message-owner', label: 'Open agent session', primary: true }, wallTerminal, DISCUSS]
          : [{ ...wallTerminal, primary: true }, DISCUSS];
  return {
    id: `owner-wall:${w.source}:${idPart}`,
    kind: 'owner-wall',
    category: ATTENTION_KIND_CATEGORY['owner-wall'],
    source: 'harness',
    harnessSlug: w.harnessSlug ?? null,
    planSlug: null,
    itemRef: null,
    title: clip(w.claim),
    body: `${w.claim}${w.recheck ? `\n\nRecheck: ${w.recheck}` : ''}${livenessStatusNote(projectedStatus)}`,
    status: projectedStatus,
    importance: hours >= 4 ? 'urgent' : hours >= 1 ? 'high' : 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: w.ownerId,
    ownerLabel: null,
    ...untriaged(),
    actions,
    ref: {
      kind: 'owner-wall',
      wallSource: w.source,
      wallOwnerId: w.ownerId,
      wallRef: w.ref ?? null,
      ...(standingFactSource
        ? {
            factScope: w.factScope,
            factScopeRef: w.factScopeRef ?? null,
            factKey: w.factKey!.trim(),
          }
        : {}),
    },
  };
}

/* ── pending dark-flag ratification (P-005c) ────────────────────────────── */

export interface DarkFlagRatificationInput {
  /** The FLAGS key (libs/flags/src/types.ts) carried on KNOWN_DARK_FLAGS. */
  flagKey: string;
  justification?: string | null;
  /** The allowlist's DARK_FLAGS_OWNER_REVIEW_BY (advisory) expiry, when present. */
  reviewBy?: string | null;
}

/**
 * A `KNOWN_DARK_FLAGS` entry (libs/flags/src/production-defaults.test.ts) —
 * a flag the CLAUDE.md dark-flag policy allows to ship default-OFF ONLY
 * because it is genuinely incomplete / would-break-the-fleet / owner-authority
 * / a staged cutover, each requiring an owner justification already recorded
 * on the allowlist. Surfacing it here closes the loop: the allowlist is
 * shrink-only, so every entry is a standing ratification-or-graduate decision
 * the owner should eventually see, not a silent permanent exception.
 */
export function darkFlagRatificationToAttention(f: DarkFlagRatificationInput): AttentionItem {
  const tier: AttentionTier = 'decision';
  return {
    id: `dark-flag-ratification:${f.flagKey}`,
    kind: 'dark-flag-ratification',
    category: ATTENTION_KIND_CATEGORY['dark-flag-ratification'],
    source: 'harness',
    harnessSlug: null,
    planSlug: null,
    itemRef: null,
    title: `Dark flag awaiting ratification: ${f.flagKey}`,
    body:
      (f.justification ?? '').trim() ||
      `${f.flagKey} is on the KNOWN_DARK_FLAGS allowlist and defaults OFF pending owner ratification.`,
    status: f.reviewBy ? `awaiting-ratification (review by ${f.reviewBy})` : 'awaiting-ratification',
    importance: 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    // P-003: this card is derived from the STATIC DARK_FLAGS allowlist compiled
    // into libs/flags — no runtime write can remove the entry, so `Review flag`
    // alone left 14% of the bulk-run ledger permanently unresolvable. `Confirm
    // dark` is the acknowledgement-class terminal: a real owner decision that the
    // flag stays dark for now, recorded durably in the triage ledger. Graduating
    // the flag remains a source edit (flip the default ON + shrink the
    // shrink-only allowlist), which is engineering work, not an inbox click.
    actions: [
      { id: 'open', label: 'Review flag', primary: true },
      { id: 'dismiss', label: 'Confirm dark' },
    ],
    ref: { kind: 'dark-flag-ratification', flagKey: f.flagKey },
  };
}

/* ── blocked session / mirrored ask (P-005d) ────────────────────────────── */

export interface BlockedSessionInput {
  sessionId: string;
  client: string;
  refId: string;
  gateKind: 'ask' | 'permission_wait' | 'suppressed_ask';
  question?: string | null;
  ownerAgentId?: string | null;
  harnessSlug?: string | null;
  waitingHours?: number | null;
  /** `suppressed_ask` only (WI-10005039): the deadline the agent declared, ISO-8601. */
  decideBy?: string | null;
  /** `suppressed_ask` only: what the agent WILL do if the owner never answers. Stored as jsonb —
   *  usually the plain string the ingest tool wrote, but rendered defensively. */
  defaultIfUnanswered?: unknown;
  /** The same shared liveness verdict used by coord:walls. Missing data is
   *  unknown and therefore must not become a human decision by default. */
  actionability?: ReadActionability;
  livenessState?: SessionState | null;
}

/** "Default if unanswered: X (decide by T)" — empty parts are omitted, never rendered as "undefined". */
function suppressedAskDisclosure(defaultIfUnanswered: unknown, decideBy: string | null | undefined): string {
  const def =
    defaultIfUnanswered == null
      ? null
      : typeof defaultIfUnanswered === 'string'
        ? defaultIfUnanswered.trim()
        : JSON.stringify(defaultIfUnanswered);
  const parts = [
    def ? `Default if unanswered: ${def}` : 'No default declared',
    decideBy ? `decide by ${decideBy}` : null,
  ].filter((p): p is string => p != null);
  return `\n\n${parts[0]}${parts[1] ? ` (${parts[1]})` : ''}.`;
}

/**
 * A `harness_shared.session_pending_gates` row still open — the watcher's
 * client-agnostic backstop (owner-inbox-single-pane P-002/D-002): a session
 * sitting on an unanswered ask/permission-wait, captured regardless of
 * whether that client's own hook could mirror it as a structured envelope
 * (Codex has no turn-end hook at all — this is its ONLY path to the inbox).
 * Distinct from `conversation` (an explicit `coord:ask`) — this is a raw
 * transcript observation, so the body says plainly that it's a mirror, not a
 * first-class ask.
 */
export function blockedSessionToAttention(g: BlockedSessionInput): AttentionItem {
  const actionability = g.actionability ?? classifyReadActionability(g.livenessState);
  // A suppressed ask is a decision the OWNER owes by construction — the declaring session is
  // typically already gone, so its liveness says nothing about whether the owner must act. Forcing
  // the tier AND the status here is what stops an `ended`/`unknown` asker demoting it to a mere
  // alert stamped "STRANDED … needs a respawn" (the agent died by design; the decision stands).
  const suppressed = g.gateKind === 'suppressed_ask';
  const projectedStatus = suppressed ? 'waiting' : ownerGateStatus(actionability, g.livenessState, 'unknown');
  const tier: AttentionTier = suppressed || actionability === 'actionable' ? 'decision' : 'alert';
  const label =
    g.gateKind === 'permission_wait' ? 'permission prompt' : suppressed ? 'suppressed question' : 'question';
  const hours = g.waitingHours ?? 0;
  const base =
    (g.question ?? '').trim() ||
    `A ${g.client} session (${g.sessionId}) is sitting on an unanswered ${label} — its client hook could not mirror this as a structured ask (D-002 capability matrix).`;
  // The default + deadline ARE the card for a suppressed ask: they let the owner see what happens
  // if they do nothing, and by when (the reaper applies it at decideBy).
  const body = suppressed ? `${base}${suppressedAskDisclosure(g.defaultIfUnanswered, g.decideBy)}` : base;
  return {
    id: `blocked-session:${g.client}:${g.sessionId}:${g.refId}`,
    kind: 'blocked-session',
    category: ATTENTION_KIND_CATEGORY['blocked-session'],
    source: 'harness',
    harnessSlug: g.harnessSlug ?? null,
    planSlug: null,
    itemRef: null,
    title: clip(g.question) || `${g.client} session blocked on a ${label}`,
    body: `${body}${livenessStatusNote(projectedStatus)}`,
    status: `${projectedStatus === 'waiting' ? 'blocked' : projectedStatus} (${g.client})`,
    importance: hours >= 1 ? 'high' : 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: g.ownerAgentId ?? null,
    ownerLabel: null,
    ...untriaged(),
    // P-003: `Clear gate` closes the `session_pending_gates` row — the same
    // transition the watcher/hook performs when the ask clears on its own. Without
    // it a gate whose session died stayed in the inbox with nothing but Discuss.
    actions: [{ id: 'resolve', label: 'Clear gate' }, DISCUSS, MESSAGE_OWNER],
    ref: { kind: 'blocked-session', sessionId: g.sessionId, client: g.client, refId: g.refId },
  };
}

/* ── decision owed (EI-147) ──────────────────────────────────────────────── */

export interface DecisionOwedInput {
  sessionId: string;
  refId: string;
  client: string;
  question: string | null;
  ownerAgentId: string | null;
  harnessSlug: string | null;
  closedAt: string;
}

/**
 * A closed `session_pending_gates` 'ask' row (the owner answered a question)
 * with no matching `plans:add-decision`/`ratify-decision` call by the same
 * owner afterward — decision-owed-source.ts's mechanical heuristic (EI-147:
 * "Owner decisions made in conversation aren't reliably recorded into
 * plans"). Alert tier, never Decision: this is a NUDGE to the conversing
 * agent that a decision may have leaked, not a confirmed miss the owner must
 * personally adjudicate — false positives are expected (not every answered
 * question is plan-worthy).
 */
export function decisionOwedToAttention(d: DecisionOwedInput): AttentionItem {
  const tier: AttentionTier = 'alert';
  return {
    id: `decision-owed:${d.sessionId}:${d.refId}`,
    kind: 'decision-owed',
    category: ATTENTION_KIND_CATEGORY['decision-owed'],
    source: 'harness',
    harnessSlug: d.harnessSlug ?? null,
    planSlug: null,
    itemRef: null,
    title: clip(d.question) || `A ${d.client} session answered a question with no decision recorded`,
    body:
      (d.question ? `"${d.question.trim()}"\n\n` : '') +
      `The owner answered this in session ${d.sessionId}, but no plans:add-decision (or ratify-decision) call by that agent followed — the decision, if there was one, may not be captured in any plan. Review and record it with plans:add-decision if it should be, or ignore if this wasn't a plan-worthy choice.`,
    status: 'possibly unrecorded',
    importance: 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: d.ownerAgentId ?? null,
    ownerLabel: null,
    ...untriaged(),
    // P-003: the card is a mechanical heuristic over ALREADY-CLOSED ask gates, so
    // there is no row to mutate — recording the decision is separate deliberate
    // work (plans:add-decision, reached through Discuss). `No decision owed` is the
    // acknowledgement-class terminal: the owner's verdict that the heuristic fired
    // on something that was never a governed decision.
    actions: [{ id: 'dismiss', label: 'No decision owed' }, DISCUSS, MESSAGE_OWNER],
    ref: { kind: 'decision-owed', sessionId: d.sessionId, refId: d.refId },
  };
}

export interface UnhandledDirectiveInput {
  directiveId: number;
  /** The D-004 display text (directiveDisplayText): full verbatim ≤ cap, else the labelled summary. */
  displayText: string;
  /** The ended session the owner typed it into. */
  recordedBy: string;
  why: 'no-fleet' | 'no-leader' | 'leader-ended';
  fleetSlug: string | null;
  createdAt: string;
}

const UNHANDLED_WHY: Record<UnhandledDirectiveInput['why'], string> = {
  'no-fleet': 'it was not in a fleet',
  'no-leader': 'its fleet has no other leader',
  'leader-ended': 'its fleet leader has ended too',
};

/**
 * An open owner directive nobody is handling (owner-directive-delivery-redesign
 * P-008 / R-7): the session it was typed into ENDED, and there is no live fleet
 * leader or work-item holder to take it (owner-directive-routing.ts). Decision
 * tier: only the owner can say whether it still matters. Any session may adopt
 * and close it, so Discuss is the way to hand it over.
 */
export function unhandledDirectiveToAttention(d: UnhandledDirectiveInput): AttentionItem {
  const tier: AttentionTier = 'decision';
  const fleet = d.fleetSlug ? ` (fleet ${d.fleetSlug})` : '';
  return {
    id: `unhandled-directive:${d.directiveId}`,
    kind: 'unhandled-directive',
    category: ATTENTION_KIND_CATEGORY['unhandled-directive'],
    source: 'coord',
    harnessSlug: null,
    planSlug: null,
    itemRef: null,
    title: `Nobody is handling owner directive #${d.directiveId}`,
    body:
      `${d.displayText}\n\n` +
      `Session ${d.recordedBy}${fleet} ended with this still open, and ${UNHANDLED_WHY[d.why]}. ` +
      `Any session may now adopt it: Discuss to hand it over, or acknowledge to leave it open.`,
    status: 'unhandled',
    importance: 'high',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    actions: [{ id: 'ack', label: 'Leave it open' }, DISCUSS],
    ref: { kind: 'unhandled-directive', directiveId: d.directiveId },
  };
}
