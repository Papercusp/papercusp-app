/**
 * known-open-aging.ts — pressure from persistence (EI-363; P-020 @
 * self-improvement-consume-edges-2026-06-12).
 *
 * The P-004 pre-filter is correct dedup — a signal matching an OPEN improvement
 * never burns a capture slot — but it made persistence FREE: service-down:shop,
 * the gym fire-circuit and five insight-staleness keys fired every 15-min tick
 * for ~2 days (280 known-open drops in 20 ticks) and nothing anywhere got more
 * urgent. This module turns sustained firing into escalation:
 *
 *   - CONTINUITY is derived from the existing `watchdog_ticks.known_open_keys`
 *     history (status='ran' rows; the 14-day retention comfortably covers every
 *     threshold) — zero new per-tick writes, and no `updated_at` churn on the
 *     open items (which would starve recurrence-decay).
 *   - Crossing the threshold bumps the open item's severity ONE rank, ONCE per
 *     item, comments the item, and `coord:escalate`s the owner (the same
 *     `openEscalation` path the coord tool uses — the steering-churn precedent).
 *   - Infra-class keys (service-down, fire-circuit-open) use the SHORT
 *     threshold: per D-002 the learning system's own dependencies escalate,
 *     they don't queue — an auto-implement worker cannot fix a docker port.
 *   - Re-escalation is capped (default weekly): still-firing a week after the
 *     last escalation re-escalates (no second bump) — pressure without flood.
 *
 * Escalation state (lastEscalatedAt / count / the spent severity bump) is
 * stamped on the item's `payload.knownOpenAging` via `mergeIssuePayload` — a
 * single shallow-merge key, so each stamp replaces the whole object atomically
 * and never collides with the flat self-improvement keys (implementAttempts,
 * watchdogKey, …). The stamp lands BEFORE the side effects: a partial failure
 * can lose one escalation (the weekly re-escalation is the retry rail) but can
 * never double-bump severity or storm the owner.
 *
 * ⚠ THRESHOLDS ARE THE D-004 *PROPOSED* DEFAULTS — owner ratification is
 * pending (P-004 @ self-improvement-consume-edges-2026-06-12). They are
 * exported consts here AND routine-payload tunables (`agingGeneralThresholdHours`
 * etc. on the improvement-watchdog routine), so ratified values land without a
 * deploy.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  findIssuesByWatchdogKeys,
  updateIssue,
  mergeIssuePayload,
  commentIssue,
  ISSUE_SEVERITIES,
  type EngineerIssue,
  type IssueSeverity,
} from '../../issues-engineer';
import { openEscalation } from '../../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

// ── D-004 PROPOSED defaults (P-004 ratification pending — tunable, see header) ─

/** General signals escalate after this much CONTINUOUS known-open firing. */
export const KNOWN_OPEN_AGING_GENERAL_THRESHOLD_MS = 3 * 24 * 3_600_000; // 3 days
/** Infra-class signals (D-002: escalate, don't queue) use the short threshold. */
export const KNOWN_OPEN_AGING_INFRA_THRESHOLD_MS = 24 * 3_600_000; // 24h
/** A still-firing item re-escalates at most this often (no second severity bump). */
export const KNOWN_OPEN_REESCALATE_INTERVAL_MS = 7 * 24 * 3_600_000; // weekly
/**
 * A silence longer than this between known-open observations resets the run —
 * "continuous" tolerates missed/skipped ticks and deploy pauses (ticks are
 * ~15 min apart) but not a real remission.
 */
export const KNOWN_OPEN_CONTINUITY_GAP_MS = 2 * 3_600_000; // 2h
/** Watchdog sources whose keys age on the INFRA threshold (D-002 classes). */
export const KNOWN_OPEN_INFRA_SOURCES: readonly string[] = ['service-down', 'fire-circuit-open'];
/** Anti-flood: at most this many aging escalations per tick (longest-open first). */
export const DEFAULT_MAX_AGING_ESCALATIONS_PER_TICK = 3;

/** Is this `${source}:${key}` an infra-class key (short threshold)? */
export function isInfraClassKey(watchdogKey: string): boolean {
  return KNOWN_OPEN_INFRA_SOURCES.some((s) => watchdogKey.startsWith(`${s}:`));
}

/**
 * EI-14854: the STABLE coalescing key for a watchdogKey's aging escalations —
 * severity- AND duration-INDEPENDENT, keyed only on the continuous condition (the
 * watchdogKey). Passed as the escalation's `subjectSignature` (a conditionKey, per
 * coord:escalate's guidance) so every re-detection of ONE condition COALESCES onto
 * ONE open row (bumping repeatCount) instead of minting a fresh escalation each
 * ~30-min tick. The old default fell back to `normalizeSubjectSignature(summary)`,
 * but the summary embeds a live `~Nh` duration AND the current issueId (which
 * re-mints as the underlying item is resolved+re-captured), so it never matched
 * the prior row — one continuous stalled-claim condition minted an unbounded flood
 * of un-coalesced advisory escalations.
 */
export function agingConditionKey(watchdogKey: string): string {
  return `known-open-aging:${watchdogKey}`;
}

// ── options ──────────────────────────────────────────────────────────────────

export interface KnownOpenAgingOptions {
  generalThresholdMs?: number;
  infraThresholdMs?: number;
  reescalateIntervalMs?: number;
  continuityGapMs?: number;
  maxPerTick?: number;
  /** Injectable clock (tests). */
  nowMs?: number;
}

/**
 * One known-open key this tick, optionally carrying the evidence the signal
 * re-measured on THIS tick.
 *
 * Why the evidence rides along at all (EI-19920080383279759): a re-firing signal
 * is deduped with `dedupScope:'open'`, so the capture DECLINES and the filed
 * item's body stays frozen at first-fire forever — while the aging path keeps
 * escalating it (major → critical) on evidence it never shows. Measured live:
 * EI-19920080383279759 was escalated to CRITICAL naming pool `brief/user`, a
 * surface whose last row was written 10 days earlier; the pools actually
 * breaching the gate at that moment were `mid-turn/hive` (85.8% zero-hit over
 * 234k recalls) and `injection/harness` — and with `emptyScopeRate` 0.000 they
 * carried the OPPOSITE remedy from the frozen body's "fix the CALLER, not the
 * corpus". An assignee who trusts the body works a fossil.
 *
 * A bare `string` stays valid (a caller with no evidence to hand, and every
 * pre-existing test), so this widens the input without stranding a call site.
 */
export type KnownOpenAgingInput = string | { key: string; evidence?: string | null };

/** Longest current-evidence block rendered into an escalation (chars). */
const AGING_EVIDENCE_MAX_CHARS = 1200;

/** Pure: `KnownOpenAgingInput[]` → the keys, plus the evidence map for rendering. */
export function splitAgingInputs(
  inputs: readonly KnownOpenAgingInput[],
): { keys: string[]; evidenceByKey: Map<string, string> } {
  const keys: string[] = [];
  const evidenceByKey = new Map<string, string>();
  for (const raw of inputs) {
    const key = typeof raw === 'string' ? raw : raw?.key;
    if (typeof key !== 'string' || !key.trim()) continue;
    keys.push(key);
    if (typeof raw !== 'string') {
      const ev = typeof raw.evidence === 'string' ? raw.evidence.trim() : '';
      // Only a NON-EMPTY body is evidence. A blank string must not register, or
      // the renderer would emit an empty "CURRENT EVIDENCE" header that reads as
      // "re-measured and found nothing" — the opposite of "no evidence passed".
      if (ev) evidenceByKey.set(key, ev);
    }
  }
  return { keys, evidenceByKey };
}

/**
 * Pure: the current-evidence block appended to an aging escalation, or '' when
 * this tick handed us no re-measured body for the key.
 */
export function currentEvidenceBlock(evidence: string | undefined): string {
  const body = typeof evidence === 'string' ? evidence.trim() : '';
  if (!body) return '';
  const clipped =
    body.length > AGING_EVIDENCE_MAX_CHARS
      ? `${body.slice(0, AGING_EVIDENCE_MAX_CHARS)}\n… (evidence clipped)`
      : body;
  return (
    `\n\n── CURRENT EVIDENCE (re-measured THIS tick) ──\n${clipped}\n` +
    `⚠ The filed report above was written when the item was FIRST opened and is never rewritten ` +
    `(a re-fire dedupes as an open duplicate). Where the two disagree, THIS block is the live one — ` +
    `the offenders a rotating signal names can change completely, remedy included, while the item stays open.`
  );
}

/**
 * The hour/day-denominated tick tunables (rides `watchdogOptionsFromPayload`'s
 * numeric whitelist, so D-004's ratified values land via the routine payload
 * without a deploy).
 */
export interface KnownOpenAgingTickTunables {
  agingGeneralThresholdHours?: number;
  agingInfraThresholdHours?: number;
  agingReescalateDays?: number;
  agingContinuityGapMinutes?: number;
  maxAgingEscalationsPerTick?: number;
}

/** Pure: tick-payload tunables (hours/days/minutes) → module options (ms). */
export function agingOptionsFromTick(t: KnownOpenAgingTickTunables): KnownOpenAgingOptions {
  const out: KnownOpenAgingOptions = {};
  if (t.agingGeneralThresholdHours !== undefined) out.generalThresholdMs = t.agingGeneralThresholdHours * 3_600_000;
  if (t.agingInfraThresholdHours !== undefined) out.infraThresholdMs = t.agingInfraThresholdHours * 3_600_000;
  if (t.agingReescalateDays !== undefined) out.reescalateIntervalMs = t.agingReescalateDays * 86_400_000;
  if (t.agingContinuityGapMinutes !== undefined) out.continuityGapMs = t.agingContinuityGapMinutes * 60_000;
  if (t.maxAgingEscalationsPerTick !== undefined) out.maxPerTick = t.maxAgingEscalationsPerTick;
  return out;
}

// ── continuity: first-seen derived from the tick history ─────────────────────

/** One historical 'ran' tick: when, and which keys it observed as known-open. */
export interface KnownOpenTickSample {
  tickAtMs: number;
  keys: readonly string[];
}

/**
 * Pure: for each currently-firing key, the start of its CONTINUOUS known-open
 * run. `history` is newest-first 'ran' ticks. The run extends backwards while
 * consecutive observations of the key are ≤ `gapMs` apart (the current tick —
 * `nowMs` — is the newest observation); a longer silence resets it. A key with
 * no history starts its run now. firstSeen clamps at the oldest history row —
 * "open for at least X" is all the threshold comparison needs.
 */
export function computeKnownOpenRuns(
  currentKeys: readonly string[],
  history: readonly KnownOpenTickSample[],
  nowMs: number,
  gapMs: number = KNOWN_OPEN_CONTINUITY_GAP_MS,
): Map<string, number> {
  const runs = new Map<string, number>();
  for (const key of new Set(currentKeys)) {
    let firstSeen = nowMs;
    for (const tick of history) {
      if (tick.tickAtMs > nowMs) continue; // ignore clock skew ahead of "now"
      if (!tick.keys.includes(key)) continue;
      if (firstSeen - tick.tickAtMs > gapMs) break; // silence → run reset
      firstSeen = tick.tickAtMs;
    }
    runs.set(key, firstSeen);
  }
  return runs;
}

/**
 * Default history reader: 'ran' ticks within the lookback that observed any of
 * `keys` (indexed by workspace; the `&&` overlap prunes irrelevant rows).
 * Newest-first, matching `computeKnownOpenRuns`'s contract.
 */
export async function readKnownOpenTickHistory(
  workspaceId: string,
  keys: string[],
  lookbackMs: number,
): Promise<KnownOpenTickSample[]> {
  if (keys.length === 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<{ tick_at: Date | string; known_open_keys: string[] }[]>`
    SELECT tick_at, known_open_keys
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
       AND status = 'ran'
       AND tick_at > now() - make_interval(secs => ${Math.ceil(lookbackMs / 1000)})
       AND known_open_keys && ${keys}::text[]
     ORDER BY tick_at DESC
     LIMIT 2000`;
  return rows.map((r) => ({
    tickAtMs: r.tick_at instanceof Date ? r.tick_at.getTime() : Date.parse(String(r.tick_at)),
    keys: r.known_open_keys ?? [],
  }));
}

// ── aging state on the item payload ──────────────────────────────────────────

/** The `payload.knownOpenAging` stamp (replaced wholesale on each escalation). */
export interface KnownOpenAgingStamp {
  /** Run start (derived) at the last escalation — observability only. */
  firstSeenAt: string;
  /** When this item last escalated — the weekly re-escalation gate. */
  lastEscalatedAt: string;
  /** How many aging escalations this item has had. */
  escalations: number;
  /** The one-per-item severity bump, once spent. */
  severityBumped?: { from: IssueSeverity; to: IssueSeverity; at: string };
}

/** Parsed aging state off an item payload (absent/malformed → never escalated). */
export interface KnownOpenAgingState {
  lastEscalatedAtMs: number | null;
  escalations: number;
  severityBumped: boolean;
}

/** Pure: defensively parse `payload.knownOpenAging`. */
export function parseAgingState(payload: unknown): KnownOpenAgingState {
  const none: KnownOpenAgingState = { lastEscalatedAtMs: null, escalations: 0, severityBumped: false };
  if (payload == null || typeof payload !== 'object') return none;
  const raw = (payload as Record<string, unknown>).knownOpenAging;
  if (raw == null || typeof raw !== 'object') return none;
  const s = raw as Record<string, unknown>;
  const ms = typeof s.lastEscalatedAt === 'string' ? Date.parse(s.lastEscalatedAt) : NaN;
  return {
    lastEscalatedAtMs: Number.isFinite(ms) ? ms : null,
    escalations: typeof s.escalations === 'number' && Number.isFinite(s.escalations) ? s.escalations : 0,
    severityBumped: s.severityBumped != null && typeof s.severityBumped === 'object',
  };
}

/** Pure: one rank toward critical (ISSUE_SEVERITIES is ranked critical-first). */
export function bumpedSeverity(s: IssueSeverity): IssueSeverity | undefined {
  const i = ISSUE_SEVERITIES.indexOf(s);
  return i > 0 ? ISSUE_SEVERITIES[i - 1] : undefined;
}

// ── the pure planner ─────────────────────────────────────────────────────────

/** What one threshold-crossing item should get this tick. */
export interface AgingDecision {
  issueId: string;
  watchdogKey: string;
  title: string;
  severity: IssueSeverity;
  firstSeenMs: number;
  openForMs: number;
  thresholdMs: number;
  infra: boolean;
  /** One-rank bump target — absent when the bump is spent or already critical. */
  bumpTo?: IssueSeverity;
  /** Prior stamp's severityBumped, carried so a re-escalation stamp keeps it. */
  priorSeverityBumped: boolean;
  /** True when this item escalated before (weekly cadence, no second bump). */
  reescalation: boolean;
  /** This escalation's ordinal (prior count + 1). */
  escalationNumber: number;
}

/** The minimal item shape the planner needs (EngineerIssue satisfies it). */
export interface AgingItemInput {
  id: string;
  state: string;
  severity: IssueSeverity;
  title: string;
  payload: unknown | null;
  /**
   * When the ITEM was created (EI-14763). The aging clock is clamped to this so a
   * freshly re-minted item can never inherit a days-old per-KEY run (see the
   * clamp in `planKnownOpenAging`). EngineerIssue.createdAt (ISO) satisfies it;
   * absent ⇒ no clamp (older callers behave exactly as before).
   */
  createdAt?: string | Date | null;
}

/** Pure: parse an item's createdAt to epoch-ms (null when absent/malformed). */
export function itemCreatedMs(item: AgingItemInput): number | null {
  const c = item.createdAt;
  if (c == null) return null;
  const ms = c instanceof Date ? c.getTime() : Date.parse(String(c));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pure: which known-open items have crossed their aging threshold and are not
 * inside the re-escalation cool-down? `runs` maps watchdogKey → run start
 * (`computeKnownOpenRuns`); `items` are the issues matched by those keys
 * (any state — non-open are ignored; newest-first per key wins, matching
 * `findIssuesByWatchdogKeys`'s updated_at DESC order). Longest-open decisions
 * first, capped at `maxPerTick`.
 */
export function planKnownOpenAging(
  runs: ReadonlyMap<string, number>,
  items: readonly AgingItemInput[],
  keyOf: (item: AgingItemInput) => string | undefined,
  opts: KnownOpenAgingOptions = {},
): AgingDecision[] {
  const nowMs = opts.nowMs ?? Date.now();
  const generalMs = opts.generalThresholdMs ?? KNOWN_OPEN_AGING_GENERAL_THRESHOLD_MS;
  const infraMs = opts.infraThresholdMs ?? KNOWN_OPEN_AGING_INFRA_THRESHOLD_MS;
  const reescalateMs = opts.reescalateIntervalMs ?? KNOWN_OPEN_REESCALATE_INTERVAL_MS;
  const maxPerTick = Math.max(0, opts.maxPerTick ?? DEFAULT_MAX_AGING_ESCALATIONS_PER_TICK);

  // Newest open item per watchdogKey (input order is newest-first).
  const openByKey = new Map<string, AgingItemInput>();
  for (const item of items) {
    if (item.state !== 'open') continue;
    const key = keyOf(item);
    if (!key || openByKey.has(key)) continue;
    openByKey.set(key, item);
  }

  const decisions: AgingDecision[] = [];
  for (const [key, runFirstSeenMs] of runs) {
    const item = openByKey.get(key);
    if (!item) continue;
    const infra = isInfraClassKey(key);
    const thresholdMs = infra ? infraMs : generalMs;
    // EI-14763: the run start is derived per-KEY from the tick history, which can
    // span a resolve→re-mint boundary — a watchdogKey that keeps firing across a
    // resolution carries its OLD run onto a freshly-minted item, so a minutes-old
    // item read as "73h old" and phantom-escalated major→critical to the human.
    // Clamp the aging clock to the ITEM's own creation: an item cannot be older
    // than it existed, so a genuinely new mint restarts the clock while a truly
    // long-open item is unaffected (its createdAt precedes the run).
    const createdMs = itemCreatedMs(item);
    const firstSeenMs = createdMs != null ? Math.max(runFirstSeenMs, createdMs) : runFirstSeenMs;
    const openForMs = nowMs - firstSeenMs;
    if (openForMs < thresholdMs) continue;
    const state = parseAgingState(item.payload);
    if (state.lastEscalatedAtMs != null && nowMs - state.lastEscalatedAtMs < reescalateMs) continue;
    const reescalation = state.lastEscalatedAtMs != null;
    const bumpTo = state.severityBumped ? undefined : bumpedSeverity(item.severity);
    decisions.push({
      issueId: item.id,
      watchdogKey: key,
      title: item.title,
      severity: item.severity,
      firstSeenMs,
      openForMs,
      thresholdMs,
      infra,
      ...(bumpTo ? { bumpTo } : {}),
      priorSeverityBumped: state.severityBumped,
      reescalation,
      escalationNumber: state.escalations + 1,
    });
  }
  return decisions.sort((a, b) => b.openForMs - a.openForMs).slice(0, maxPerTick);
}

// ── IO: execute the decisions ────────────────────────────────────────────────

/** Synthetic identity for the watchdog's owner escalations (steering-churn precedent). */
const WATCHDOG_AGING_IDENTITY: AgentIdentity = {
  ownerId: 'system:improvement-watchdog',
  ownerLabel: 'system · improvement-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface KnownOpenAgingDeps {
  readHistory: (workspaceId: string, keys: string[], lookbackMs: number) => Promise<KnownOpenTickSample[]>;
  readItems: (keys: string[]) => Promise<EngineerIssue[]>;
  stampPayload: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  bumpSeverity: (id: string, to: IssueSeverity) => Promise<unknown>;
  comment: (id: string, body: string) => Promise<unknown>;
  escalate: (input: {
    severity: 'advisory';
    summary: string;
    body: string;
    /** EI-14854: a stable conditionKey (subjectSignature) so re-detections coalesce. */
    meta?: { dedupKind?: string; subjectSignature?: string };
  }) => Promise<unknown>;
}

const defaultDeps: KnownOpenAgingDeps = {
  readHistory: readKnownOpenTickHistory,
  readItems: findIssuesByWatchdogKeys,
  stampPayload: (id, patch) => mergeIssuePayload(id, patch),
  bumpSeverity: (id, to) => updateIssue(id, { severity: to, by: 'system:improvement-watchdog' }),
  comment: (id, body) => commentIssue(id, body, 'system:improvement-watchdog'),
  escalate: (input) => openEscalation(WATCHDOG_AGING_IDENTITY, input),
};

/** One executed escalation (the tick result surfaces the issue ids). */
export interface KnownOpenAgingOutcome {
  issueId: string;
  watchdogKey: string;
  reescalation: boolean;
  bumped?: IssueSeverity;
}

const hours = (ms: number): string => `${Math.round(ms / 3_600_000)}h`;

function escalationBody(d: AgingDecision): string {
  const cls = d.infra
    ? 'an INFRA-class key (D-002 @ self-improvement-consume-edges-2026-06-12: the learning system\'s own dependencies escalate, they don\'t queue — the auto lane cannot fix infra)'
    : 'a general signal';
  return (
    `The watchdog key \`${d.watchdogKey}\` has fired as known-open on every tick for ~${hours(d.openForMs)} ` +
    `(continuously since ${new Date(d.firstSeenMs).toISOString()}), crossing the ${hours(d.thresholdMs)} aging ` +
    `threshold for ${cls}.\n\n` +
    `Open improvement: ${d.issueId} — "${d.title}".\n` +
    (d.bumpTo
      ? `Severity bumped ${d.severity} → ${d.bumpTo} (the one-per-item bump).\n`
      : d.priorSeverityBumped
        ? 'Severity bump already spent on an earlier escalation.\n'
        : `Severity is already ${d.severity}; no bump available.\n`) +
    `This is aging escalation #${d.escalationNumber} for this item` +
    (d.reescalation ? ' (re-escalation — it was escalated before and is STILL firing)' : '') +
    `; re-escalation is capped (default weekly).\n\n` +
    `Persistence means nothing and no one is fixing the underlying problem — fix it (or resolve the item ` +
    `if it is genuinely stale). Thresholds are the D-004 PROPOSED defaults pending P-004 ratification; ` +
    `tune via the improvement-watchdog routine payload (agingGeneralThresholdHours / agingInfraThresholdHours / ` +
    `agingReescalateDays).`
  );
}

/**
 * The per-tick entry point: derive runs from tick history, plan, execute. Per
 * decision the STAMP lands first (so a partial failure can suppress at most one
 * escalation until the weekly retry — never double-bump or storm the owner),
 * then escalate → bump → comment, each best-effort. Called by the watchdog tick
 * only when known-open keys exist, so quiet ticks do zero extra reads.
 */
export async function processKnownOpenAging(
  workspaceId: string,
  knownOpenInputs: readonly KnownOpenAgingInput[],
  opts: KnownOpenAgingOptions = {},
  deps: Partial<KnownOpenAgingDeps> = {},
): Promise<KnownOpenAgingOutcome[]> {
  const { keys: knownOpenKeys, evidenceByKey } = splitAgingInputs(knownOpenInputs);
  if (knownOpenKeys.length === 0) return [];
  const d: KnownOpenAgingDeps = { ...defaultDeps, ...deps };
  const nowMs = opts.nowMs ?? Date.now();
  const generalMs = opts.generalThresholdMs ?? KNOWN_OPEN_AGING_GENERAL_THRESHOLD_MS;
  const gapMs = opts.continuityGapMs ?? KNOWN_OPEN_CONTINUITY_GAP_MS;

  // Look back far enough to prove the LONG threshold plus one gap of slack.
  const lookbackMs = generalMs + gapMs + 3_600_000;
  const history = await d.readHistory(workspaceId, knownOpenKeys, lookbackMs);
  const runs = computeKnownOpenRuns(knownOpenKeys, history, nowMs, gapMs);

  const items = await d.readItems([...runs.keys()]);
  const keyOf = (i: AgingItemInput): string | undefined => {
    const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
    return typeof k === 'string' ? k : undefined;
  };
  const decisions = planKnownOpenAging(runs, items, keyOf, { ...opts, nowMs });

  const outcomes: KnownOpenAgingOutcome[] = [];
  for (const dec of decisions) {
    const stamp: KnownOpenAgingStamp = {
      firstSeenAt: new Date(dec.firstSeenMs).toISOString(),
      lastEscalatedAt: new Date(nowMs).toISOString(),
      escalations: dec.escalationNumber,
      ...(dec.bumpTo
        ? { severityBumped: { from: dec.severity, to: dec.bumpTo, at: new Date(nowMs).toISOString() } }
        : {}),
    };
    if (!dec.bumpTo && dec.priorSeverityBumped) {
      // Carry the spent bump forward — the stamp replaces the whole object.
      const prior = (items.find((i) => i.id === dec.issueId)?.payload as Record<string, unknown> | null)?.knownOpenAging;
      const priorBump = prior && typeof prior === 'object' ? (prior as Record<string, unknown>).severityBumped : undefined;
      if (priorBump) stamp.severityBumped = priorBump as KnownOpenAgingStamp['severityBumped'];
    }
    try {
      await d.stampPayload(dec.issueId, { knownOpenAging: stamp });
    } catch (e) {
      console.warn(`[improvement-watchdog] aging stamp failed for ${dec.issueId} (${dec.watchdogKey}) — skipping its escalation this tick: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const outcome: KnownOpenAgingOutcome = {
      issueId: dec.issueId,
      watchdogKey: dec.watchdogKey,
      reescalation: dec.reescalation,
      ...(dec.bumpTo ? { bumped: dec.bumpTo } : {}),
    };
    try {
      await d.escalate({
        severity: 'advisory',
        summary:
          `Known-open aging: ${dec.watchdogKey} still firing after ~${hours(dec.openForMs)} ` +
          `(${dec.issueId}${dec.bumpTo ? `, severity → ${dec.bumpTo}` : ''})`,
        body: escalationBody(dec) + currentEvidenceBlock(evidenceByKey.get(dec.watchdogKey)),
        // EI-14854: coalesce on the CONDITION (the watchdogKey), not the summary —
        // the summary's live `~Nh` duration + re-minted issueId made every tick a
        // fresh, un-coalesced escalation. A stable subjectSignature keys the ONE
        // open row so re-detections bump repeatCount instead of proliferating.
        meta: { subjectSignature: agingConditionKey(dec.watchdogKey) },
      });
    } catch (e) {
      console.warn(`[improvement-watchdog] aging coord:escalate failed for ${dec.issueId} (${dec.watchdogKey}): ${e instanceof Error ? e.message : e}`);
    }
    if (dec.bumpTo) {
      try {
        await d.bumpSeverity(dec.issueId, dec.bumpTo);
      } catch (e) {
        console.warn(`[improvement-watchdog] aging severity bump failed for ${dec.issueId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    try {
      await d.comment(
        dec.issueId,
        `Known-open aging escalation #${dec.escalationNumber}: watchdog key \`${dec.watchdogKey}\` has fired ` +
          `continuously for ~${hours(dec.openForMs)} (threshold ${hours(dec.thresholdMs)}${dec.infra ? ', infra-class' : ''}). ` +
          (dec.bumpTo ? `Severity bumped ${dec.severity} → ${dec.bumpTo}. ` : '') +
          `Owner escalated via coord (re-escalation at most weekly while it keeps firing).` +
          currentEvidenceBlock(evidenceByKey.get(dec.watchdogKey)),
      );
    } catch (e) {
      console.warn(`[improvement-watchdog] aging comment failed for ${dec.issueId}: ${e instanceof Error ? e.message : e}`);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}
