/**
 * workflows-ledger-model — the pure derivations behind the one-frame Workflows tab.
 *
 * Plan: workflows-tab-one-frame-2026-08-28, governed by D-001..D-005.
 *
 * The frame is ONE ledger over every automation the workspace runs, with kind and state as
 * FACETS rather than as navigation (D-001). Everything a row renders is derived here so the
 * facet counts, the sort, the source health and the needs-you strip can be tested without
 * mounting React.
 *
 * ── WHAT THIS MODEL REFUSES TO INVENT ───────────────────────────────────────────────────
 * Three columns are one careless line away from becoming fiction, so each has a rule:
 *
 *   • SPEND (D-005). There is no per-workflow dollar figure in the producers. A triggered
 *     plan's cost is only knowable from `plans.runHistory`, which is fetched for the ONE
 *     inspected plan; a routine's is a classification, never an amount. So the column shows
 *     the model's own honest token ("per run" / "$0" / "possible" / "unknown") and the
 *     verified dollars live in the inspector, where they are actually measured.
 *   • LAST. `null` means never fired. The caller renders an em dash — never "just now" and
 *     never a zero.
 *   • NEXT. Only a real occurrence produces a time. A workflow whose trigger is an external
 *     event has no next time at all and says "on event"; an unknowable one says "—".
 *
 * ── THE NEEDS-YOU STRIP KEEPS D-018's RULE VERBATIM ─────────────────────────────────────
 * `buildNeedsYou` returns `[]` for the healthy case and there is deliberately no "all clear"
 * item to render. An always-present strip that says "all good" trains the operator to stop
 * reading the one region meant to interrupt them, and then it fails on the day it matters.
 * D-004 of this plan re-sites the strip into the frame and preserves that rule unchanged.
 */

import type { AutomationItem, AutomationSourceItem, AutomationTrigger } from './workflows-model';
import { relativeTime } from './workflows-model';

/** Kind facet — the three populations, as a filter rather than as three destinations. */
export type LedgerKind = 'triggered' | 'routine' | 'system';
/** The single state word a row reports; `ready` is the unremarkable case. */
export type LedgerState = 'attention' | 'running' | 'paused' | 'ready';

export type StateFacet = 'all' | 'attention' | 'running' | 'paused';
export type KindFacet = 'all' | LedgerKind;
export type LedgerSort = 'attention' | 'name' | 'last' | 'next';

/** Source → plan → outcome, the chain the tab has always promised, as three fields. */
export interface LedgerChain {
  trigger: string;
  plan: string;
  /** Null when the row declares no outcome — routines and system tasks usually do not. */
  outcome: string | null;
}

export interface LedgerRow {
  id: string;
  label: string;
  description: string;
  kind: LedgerKind;
  state: LedgerState;
  chain: LedgerChain;
  /** Relative time of the last fire; null means it has never fired. */
  lastLabel: string | null;
  /** Short next-fire token: a relative time, "on event", "paused", or "—". */
  nextLabel: string;
  /** Compact, honest spend token — see D-005 and the header comment. */
  spendToken: string;
  /** The producers' full spend sentence, for the inspector. */
  spendLabel: string;
  /** True/false when every known trigger agrees; null when no trigger reports an armed state. */
  armed: boolean | null;
  armedCount: number;
  triggerCount: number;
  planSlug: string | null;
  harness: string | null;
  /** Trigger provider tokens, for the source facet. Matches AutomationSourceItem tokens. */
  sourceKinds: string[];
  needsAttention: boolean;
  running: boolean;
  paused: boolean;
  /** Sort key only — never rendered; null sorts last. */
  nextAt: number | null;
  lastAt: number | null;
}

export interface FacetCounts {
  all: number;
  attention: number;
  running: number;
  paused: number;
  triggered: number;
  routine: number;
  system: number;
}

export interface SourceHealth {
  id: string;
  label: string;
  /** The facet token this pill filters by — equal to the trigger provider it matches. */
  token: string;
  armedCount: number;
  bindingCount: number;
  status: string;
  tone: 'ok' | 'bad';
}

/** What the operator is being asked to do about it. Ported from the retired landing model. */
export type NeedsYouKind = 'reconnect' | 'review-runs';

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  message: string;
  actionLabel: string;
  severity: 'warn' | 'bad';
}

export interface SuggestionChip {
  id: string;
  text: string;
  sourceKind: string;
}

/**
 * The source fields this model reads — a structural subset of `ExternalTriggerSourceAdminRow`.
 * Structural on purpose: the derivation stays out of the operator-core import graph, and a
 * test pins that a real row still satisfies it.
 */
export interface LedgerSourceInput {
  id: string;
  kind: string;
  status: string;
  lastError: string | null;
  failedDeliveries24h: number;
  bindingCount: number;
}

const KIND_BY_AUTOMATION: Record<AutomationItem["kind"], LedgerKind> = {
  "triggered-plan": "triggered",
  "triggered-operation": "triggered",
  "ai-routine": "routine",
  "system-task": "system",
};

function sentenceCase(value: string): string {
  const normalized = value.replaceAll('-', ' ').trim();
  return normalized ? `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}` : normalized;
}

/** A trigger that fires on a provider event rather than on the clock. */
function isEventTrigger(trigger: AutomationTrigger): boolean {
  return trigger.kind === 'external';
}

function armedSummary(triggers: readonly AutomationTrigger[]): {
  armed: boolean | null;
  armedCount: number;
  triggerCount: number;
} {
  const known = triggers.filter((trigger) => trigger.armed != null);
  const armedCount = triggers.filter((trigger) => trigger.armed === true).length;
  if (known.length === 0) return { armed: null, armedCount, triggerCount: triggers.length };
  return { armed: armedCount > 0, armedCount, triggerCount: triggers.length };
}

/**
 * The compact spend token (D-005).
 *
 * A triggered plan gets "per run" rather than a number: the only verified figure comes from
 * `plans.runHistory`, which is read for the inspected plan alone. Printing a dollar amount
 * here would mean either fabricating it or silently showing one row's real cost beside ten
 * rows of zeros.
 */
export function spendToken(item: AutomationItem): string {
  if (item.kind === "triggered-plan" || item.kind === "triggered-operation")
    return "per run";
  const spend = item.routine?.spend;
  if (spend === 'none') return '$0';
  if (spend === 'unknown') return 'unknown';
  return 'possible';
}

function chainFor(item: AutomationItem): LedgerChain {
  const providers = [...new Set(item.triggers.map((trigger) => sentenceCase(trigger.provider)))];
  const trigger = item.flow?.sourceLabel
    ?? (providers.length === 0 ? 'No trigger' : providers.length <= 2 ? providers.join(' + ') : `${providers[0]} + ${providers.length - 1} more`);
  const plan = item.operation
    ? `${item.operation.harnessSlug}#${item.operation.operationId}`
    : (item.planSlug ??
      (item.kind === "ai-routine" ? "routine" : "system task"));
  const outcome = item.flow?.outcomeLabel?.trim() || null;
  return { trigger, plan, outcome };
}

/**
 * The short Next column.
 *
 * Order matters: a paused workflow says so even when a stale occurrence is still on the
 * books, because "in 6h" beside a disarmed trigger is a promise the system will not keep.
 */
function nextLabelFor(item: AutomationItem, nowMs: number): string {
  if (item.paused) return 'paused';
  if (item.nextAt != null && item.nextAt >= nowMs) return relativeTime(item.nextAt, nowMs);
  if (item.triggers.some(isEventTrigger)) return 'on event';
  return '—';
}

function stateFor(item: AutomationItem): LedgerState {
  if (item.needsAttention) return 'attention';
  if (item.running) return 'running';
  if (item.paused) return 'paused';
  return 'ready';
}

/** Shape every automation into one ledger row. No filtering happens here. */
export function buildLedgerRows(
  items: readonly AutomationItem[],
  opts: { nowMs?: number } = {},
): LedgerRow[] {
  const nowMs = opts.nowMs ?? Date.now();
  return items.map((item) => {
    const { armed, armedCount, triggerCount } = armedSummary(item.triggers);
    return {
      id: item.id,
      label: item.label,
      description: item.description,
      kind: KIND_BY_AUTOMATION[item.kind],
      state: stateFor(item),
      chain: chainFor(item),
      lastLabel: item.lastAt == null ? null : relativeTime(item.lastAt, nowMs),
      nextLabel: nextLabelFor(item, nowMs),
      spendToken: spendToken(item),
      spendLabel: item.spendLabel,
      armed,
      armedCount,
      triggerCount,
      planSlug: item.planSlug,
      harness: item.harness,
      sourceKinds: [...new Set(item.triggers.map((trigger) => trigger.provider))],
      needsAttention: item.needsAttention,
      running: item.running,
      paused: item.paused,
      nextAt: item.nextAt,
      lastAt: item.lastAt,
    };
  });
}

/**
 * Facet counts over the WHOLE population, never over the filtered view.
 *
 * A count that shrank as you filtered would make the facet bar useless as a census — the
 * question it answers is "how many are there", not "how many survived my last click".
 */
export function buildFacetCounts(rows: readonly LedgerRow[]): FacetCounts {
  return {
    all: rows.length,
    attention: rows.filter((row) => row.needsAttention).length,
    running: rows.filter((row) => row.running).length,
    paused: rows.filter((row) => row.paused).length,
    triggered: rows.filter((row) => row.kind === 'triggered').length,
    routine: rows.filter((row) => row.kind === 'routine').length,
    system: rows.filter((row) => row.kind === 'system').length,
  };
}

export interface LedgerFilter {
  state?: StateFacet;
  kind?: KindFacet;
  /** A source token from `buildSourceHealth`, or null for no source filter. */
  source?: string | null;
  query?: string;
}

export function filterLedgerRows(
  rows: readonly LedgerRow[],
  filter: LedgerFilter = {},
): LedgerRow[] {
  const needle = (filter.query ?? '').trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filter.state === 'attention' && !row.needsAttention) return false;
    if (filter.state === 'running' && !row.running) return false;
    if (filter.state === 'paused' && !row.paused) return false;
    if (filter.kind && filter.kind !== 'all' && row.kind !== filter.kind) return false;
    if (filter.source && !row.sourceKinds.includes(filter.source)) return false;
    if (!needle) return true;
    return [row.label, row.description, row.planSlug, row.harness, row.chain.trigger, row.chain.plan, row.chain.outcome]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
  });
}

/**
 * Sort the visible rows.
 *
 * `attention` is the default and the only opinionated one: what needs a human, then what is
 * running, then everything else by how soon it fires. It is a stable total order — ties fall
 * through to the label — so a re-render never reshuffles rows under the operator's cursor.
 */
export function sortLedgerRows(rows: readonly LedgerRow[], sort: LedgerSort = 'attention'): LedgerRow[] {
  const copy = [...rows];
  if (sort === 'name') return copy.sort((a, b) => a.label.localeCompare(b.label));
  if (sort === 'last') {
    return copy.sort((a, b) => (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity) || a.label.localeCompare(b.label));
  }
  if (sort === 'next') {
    return copy.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || a.label.localeCompare(b.label));
  }
  return copy.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.paused !== b.paused) return a.paused ? 1 : -1;
    const delta = (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity);
    if (delta !== 0) return delta;
    return a.label.localeCompare(b.label);
  });
}

/** A source is healthy only when it says so AND is not carrying an error. */
function sourceConnected(source: Pick<LedgerSourceInput, 'status' | 'lastError'>): boolean {
  return source.status === 'connected' && !source.lastError;
}

/**
 * The masthead's source-health pills (D-003).
 *
 * `token` is the value the row's `sourceKinds` carries for that source, so clicking a pill
 * filters the ledger to exactly the rows that source drives — a legend and a filter in one
 * control, which is what keeps them from disagreeing.
 */
export function buildSourceHealth(sources: readonly AutomationSourceItem[]): SourceHealth[] {
  // DEDUPED BY TOKEN. A workspace routinely holds several source rows of the same kind (two
  // Gmail accounts, two Calendars), and one pill per ROW rendered the legend as "Gmail 0/1"
  // beside "Gmail 0/2" — two controls with the same name that filter identically, because
  // the token is the kind. Observed live before this was fixed. One pill per kind, counts
  // summed, and the tone degrades if ANY row of that kind is unhealthy: a legend that reads
  // "ok" while one of its two accounts is disconnected is the failure worth avoiding.
  const byToken = new Map<string, SourceHealth>();
  for (const source of sources) {
    const token = source.kind === 'schedule' ? 'schedule' : source.label;
    const healthy = source.kind === 'schedule' || source.status === 'connected';
    const existing = byToken.get(token);
    if (!existing) {
      byToken.set(token, {
        id: source.id,
        label: sentenceCase(source.label),
        token,
        armedCount: source.armedCount,
        bindingCount: source.bindingCount,
        status: source.status,
        // A schedule source is internal plumbing and has no connection to lose; only an
        // external source can be "not connected", so only it can read bad.
        tone: healthy ? 'ok' : 'bad',
      });
      continue;
    }
    existing.armedCount += source.armedCount;
    existing.bindingCount += source.bindingCount;
    if (!healthy) {
      existing.tone = 'bad';
      // Surface the unhealthy row's own status — "connected" would hide the broken one.
      existing.status = source.status;
    }
  }
  return [...byToken.values()];
}

/** Prompt text per source kind — the vocabulary the composer suggests in. */
const CHIP_TEXT: Record<string, string> = {
  'google-gmail': 'When an email from a client arrives…',
  gmail: 'When an email from a client arrives…',
  'google-calendar': 'Before my next meeting…',
  'google-workspace': 'When something changes in Workspace…',
  slack: 'When someone mentions me in Slack…',
  schedule: 'Every morning at 9…',
};

function prettyKind(kind: string): string {
  const named: Record<string, string> = {
    'google-gmail': 'Gmail',
    gmail: 'Gmail',
    'google-calendar': 'Calendar',
    'google-workspace': 'Workspace',
    slack: 'Slack',
    schedule: 'Schedule',
  };
  return named[kind] ?? kind.replaceAll('-', ' ');
}

/**
 * Build the needs-you strip.
 *
 * Returns `[]` when nothing needs the operator — the caller renders NOTHING in that case
 * (D-018, preserved by this plan's D-004). Never returns an "all clear" item.
 */
export function buildNeedsYou(input: {
  sources: readonly LedgerSourceInput[];
  rows: readonly Pick<LedgerRow, 'id' | 'label' | 'needsAttention'>[];
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];

  for (const source of input.sources) {
    // A source with no bindings is not a problem to escalate — nothing depends on it yet.
    if (!sourceConnected(source) && source.bindingCount > 0) {
      items.push({
        id: `needs-you:source:${source.id}`,
        kind: 'reconnect',
        message: source.lastError
          ? `${prettyKind(source.kind)} is failing: ${source.lastError}`
          : `${prettyKind(source.kind)} is ${source.status}`,
        actionLabel: 'Reconnect',
        severity: 'bad',
      });
    }
    if (source.failedDeliveries24h > 0) {
      items.push({
        id: `needs-you:dead-letter:${source.id}`,
        kind: 'review-runs',
        message: `${prettyKind(source.kind)} has ${source.failedDeliveries24h} failed ${
          source.failedDeliveries24h === 1 ? 'delivery' : 'deliveries'
        } in the last 24h`,
        actionLabel: 'Review runs',
        severity: 'warn',
      });
    }
  }

  for (const row of input.rows) {
    if (row.needsAttention) {
      items.push({
        id: `needs-you:workflow:${row.id}`,
        kind: 'review-runs',
        message: `${row.label} needs attention`,
        actionLabel: 'Review runs',
        severity: 'warn',
      });
    }
  }

  return items;
}

export interface CollapsedNeedsYou {
  rows: NeedsYouItem[];
  /** How many raised items are not represented by a row — 0 when everything fits. */
  hiddenCount: number;
}

/**
 * Bound the needs-you strip so it stays an INTERRUPT rather than a wall.
 *
 * Measured on the real workspace: `buildNeedsYou` raised 55 items, and 55 stacked lines
 * defeat D-018 exactly as thoroughly as an always-present "all good" card does — nobody
 * reads the region, so it fails on the day it matters. The rule is that the strip must be
 * scannable in one glance.
 *
 * Two moves, in this order:
 *   1. SOURCE problems stay individual. There are only ever a handful, they name different
 *      connections, and each needs a different fix.
 *   2. Per-workflow attention items COLLAPSE into one counted row once there is more than
 *      one, because "12 workflows need attention" is the actionable sentence — the twelve
 *      names are what the attention FACET is for, which is where the row's action goes.
 *
 * Anything still over `maxRows` is dropped from the rows and reported as `hiddenCount`, so
 * the strip never silently under-reports what it is holding back.
 */
export function collapseNeedsYou(
  items: readonly NeedsYouItem[],
  opts: { maxRows?: number } = {},
): CollapsedNeedsYou {
  const maxRows = Math.max(1, opts.maxRows ?? 4);
  const workflowItems = items.filter((item) => item.id.startsWith('needs-you:workflow:'));
  const sourceItems = items.filter((item) => !item.id.startsWith('needs-you:workflow:'));

  // Severity order: a dead connection outranks a failing run, because nothing the failing
  // run needs can even be attempted while the source is down.
  const ordered = [...sourceItems].sort((a, b) => Number(b.severity === 'bad') - Number(a.severity === 'bad'));

  const rows: NeedsYouItem[] = [...ordered];
  if (workflowItems.length === 1) {
    rows.push(workflowItems[0]);
  } else if (workflowItems.length > 1) {
    rows.push({
      id: 'needs-you:workflows-attention',
      kind: 'review-runs',
      message: `${workflowItems.length} workflows need attention`,
      actionLabel: 'Review',
      severity: 'warn',
    });
  }

  if (rows.length <= maxRows) return { rows, hiddenCount: 0 };
  const kept = rows.slice(0, maxRows);
  // The dropped rows may include the collapsed aggregate, so count the ITEMS it stood for
  // rather than the row — otherwise a strip hiding one row could be hiding fifty problems.
  const droppedRows = rows.slice(maxRows);
  const hiddenCount = droppedRows.reduce(
    (total, row) => total + (row.id === 'needs-you:workflows-attention' ? workflowItems.length : 1),
    0,
  );
  return { rows: kept, hiddenCount };
}

/**
 * Derive the composer's suggestion chips from the sources that are actually connected.
 *
 * A source kind we have no prompt for is SKIPPED rather than rendered as its raw slug: a
 * chip is a suggestion in the operator's language, and "google-pubsub…" is not one.
 */
export function buildSuggestionChips(sources: readonly LedgerSourceInput[]): SuggestionChip[] {
  const chips: SuggestionChip[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!sourceConnected(source)) continue;
    const text = CHIP_TEXT[source.kind];
    if (!text || seen.has(source.kind)) continue;
    seen.add(source.kind);
    chips.push({ id: `chip:${source.kind}`, text, sourceKind: source.kind });
  }
  return chips;
}

/**
 * The one-line population summary beside the title.
 *
 * Counts only — no spend total and no "next fire in". A workspace total would have to be
 * summed from data the producers do not attribute per workflow, and the next-fire time is
 * already on the row it belongs to.
 */
export function buildPopulationSummary(counts: FacetCounts): string {
  const parts = [`${counts.triggered} triggered`];
  if (counts.routine > 0) parts.push(`${counts.routine} ${counts.routine === 1 ? 'routine' : 'routines'}`);
  if (counts.system > 0) parts.push(`${counts.system} system ${counts.system === 1 ? 'task' : 'tasks'}`);
  return parts.join(' · ');
}
