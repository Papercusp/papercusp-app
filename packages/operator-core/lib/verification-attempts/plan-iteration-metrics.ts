/**
 * plan-iteration-metrics.ts — attempts-until-pass and the failure-class split per plan item.
 *
 * expensive-verification-loops-2026-09-29 P-007 (R-12). A plan item whose acceptance runs
 * through a slow check (drill, release cut, headless UI run, battery) shows in plan lifecycle
 * how many slow attempts it took to pass, and how its failed attempts split into
 * PRODUCT (the code under test was wrong), HARNESS (the check itself was wrong) and
 * ENVIRONMENT (the rig / host / preconditions were wrong). A high harness or environment
 * share is the signal that attempts are paying for the harness, not the product.
 *
 * Classification is deterministic (D-001: only the audit's CONTENT is agent-written):
 *   1. the latest `[attempt-audit]` note line that names the attempt's fingerprint and
 *      exactly one class word (`product` / `harness` / `environment` / `env`);
 *   2. else a structured harness result's reason code: a `product:` / `harness:` /
 *      `environment:` / `env:` prefix; a preflight or `guard-rail:` failure is environment;
 *      a `tier-gate:` refusal is harness;
 *   3. else `unclassified` — reported as such, never folded into a guess.
 *
 * Best-effort like plan-grinding: a failed read returns null ("not measured").
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { listWorkItemAttempts, type WorkItemAttempt } from './attempt-ledger';
import { ATTEMPT_AUDIT_MARKER, type AttemptAuditNote, readAttemptAuditNotes, UNFINGERPRINTED } from './loop-gate';
import { type LinkedWorkItem, listPlanLinkedWorkItems } from './plan-grinding';

export const FAILURE_CLASSES = ['product', 'harness', 'environment'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface FailureClassSplit {
  product: number;
  harness: number;
  environment: number;
  unclassified: number;
}

export interface IterationMetric {
  itemId: string;
  workItemIds: string[];
  /** Finished slow attempts that produced a verdict (pass / fail / unknown); cancelled excluded. */
  attempts: number;
  /** 1-based position of the first passing attempt; null while the item has not passed. */
  attemptsUntilPass: number | null;
  passed: boolean;
  /** Failed attempts (before and after the first pass) by class. */
  failed: FailureClassSplit;
  cancelled: number;
  running: number;
  /** The item's declared per-attempt cost + iteration budget (`attempt-cost:20m iteration-budget:3`), or null. */
  budget: IterationBudget | null;
  /**
   * True when a declared iteration budget is spent: the item passed only after more attempts
   * than budgeted, or has used every budgeted attempt without passing.
   */
  overBudget: boolean;
}

/**
 * An item's declared verification budget, parsed from inline keywords on its plan line:
 * `attempt-cost:<n>(s|m|h)` (the expected wall time of ONE slow attempt) and
 * `iteration-budget:<n>` (how many slow attempts acceptance may take). Either may be absent.
 */
export interface IterationBudget {
  attemptCostMs: number | null;
  iterations: number | null;
  /** attemptCostMs × iterations when both are declared — the item's total slow-check budget. */
  totalCostMs: number | null;
}

const ATTEMPT_COST = /(?:^|\s)attempt-cost:\s*(\d+(?:\.\d+)?)\s*(s|m|h)\b/i;
const ITERATION_BUDGET = /(?:^|\s)iteration-budget:\s*(\d+)\b/i;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** Pure: the budget declared on one plan item's text, or null when it declares neither keyword. */
export function parseIterationBudget(text: string | null | undefined): IterationBudget | null {
  if (!text) return null;
  const cost = ATTEMPT_COST.exec(text);
  const iters = ITERATION_BUDGET.exec(text);
  const attemptCostMs = cost ? Math.round(Number(cost[1]) * UNIT_MS[cost[2]!.toLowerCase()]!) : null;
  const iterations = iters ? Number(iters[1]) : null;
  if (attemptCostMs === null && (iterations === null || iterations <= 0)) return null;
  const validIterations = iterations !== null && iterations > 0 ? iterations : null;
  return {
    attemptCostMs,
    iterations: validIterations,
    totalCostMs: attemptCostMs !== null && validIterations !== null ? attemptCostMs * validIterations : null,
  };
}

const CLASS_WORD = /\b(product|harness|environment|env)\b/gi;

function normalizeClass(word: string): FailureClass {
  const w = word.toLowerCase();
  return w === 'env' ? 'environment' : (w as FailureClass);
}

function attemptKey(a: WorkItemAttempt): string {
  return a.fingerprint ?? UNFINGERPRINTED;
}

/**
 * The class each fingerprint was given in `[attempt-audit]` notes. A line assigns a class
 * when it names the fingerprint and, with the fingerprint text removed, carries exactly one
 * distinct class word. Later notes override earlier ones.
 */
export function auditFailureClasses(
  notes: readonly AttemptAuditNote[],
  fingerprints: readonly string[],
): Map<string, FailureClass> {
  const out = new Map<string, FailureClass>();
  const audits = notes
    .filter((n) => n.body.trimStart().startsWith(ATTEMPT_AUDIT_MARKER))
    .sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  for (const note of audits) {
    for (const line of note.body.split('\n')) {
      for (const fp of fingerprints) {
        if (!line.includes(fp)) continue;
        const rest = line.split(fp).join(' ');
        const classes = new Set([...rest.matchAll(CLASS_WORD)].map((m) => normalizeClass(m[1]!)));
        if (classes.size === 1) out.set(fp, [...classes][0]!);
      }
    }
  }
  return out;
}

/** The class of one failed attempt (see the module header for the precedence). */
export function classifyFailure(
  a: Pick<WorkItemAttempt, 'fingerprint' | 'structured'>,
  auditClasses: ReadonlyMap<string, FailureClass>,
): FailureClass | 'unclassified' {
  const audited = auditClasses.get(a.fingerprint ?? UNFINGERPRINTED);
  if (audited) return audited;
  const s = a.structured;
  if (!s) return 'unclassified';
  const prefix = /^(product|harness|environment|env):/i.exec(s.reasonCode);
  if (prefix) return normalizeClass(prefix[1]!);
  if (s.phase === 'preflight' || s.reasonCode.startsWith('guard-rail:') || s.reasonCode === 'preflight-failed') return 'environment';
  if (s.reasonCode.startsWith('tier-gate:')) return 'harness';
  return 'unclassified';
}

/** Pure: fold one plan item's attempts (any order, any number of work items) into its metric. */
export function iterationMetric(
  itemId: string,
  workItemIds: readonly string[],
  attempts: readonly WorkItemAttempt[],
  auditClasses: ReadonlyMap<string, FailureClass>,
  budget: IterationBudget | null = null,
): IterationMetric {
  const ordered = [...attempts].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const failed: FailureClassSplit = { product: 0, harness: 0, environment: 0, unclassified: 0 };
  let finished = 0;
  let cancelled = 0;
  let running = 0;
  let attemptsUntilPass: number | null = null;
  for (const a of ordered) {
    if (a.outcome === 'running') {
      running += 1;
      continue;
    }
    if (a.outcome === 'cancelled') {
      cancelled += 1;
      continue;
    }
    finished += 1;
    if (a.outcome === 'pass') {
      if (attemptsUntilPass === null) attemptsUntilPass = finished;
      continue;
    }
    failed[classifyFailure(a, auditClasses)] += 1;
  }
  const cap = budget?.iterations ?? null;
  const overBudget =
    cap !== null && (attemptsUntilPass !== null ? attemptsUntilPass > cap : finished >= cap);
  return {
    itemId,
    workItemIds: [...workItemIds].sort(),
    attempts: finished,
    attemptsUntilPass,
    passed: attemptsUntilPass !== null,
    failed,
    cancelled,
    running,
    budget,
    overBudget,
  };
}

export interface ReadIterationDeps {
  listLinked?: (input: { workspaceId: string; planSlug: string; itemIds: readonly string[] }) => Promise<LinkedWorkItem[]>;
  listAttempts?: typeof listWorkItemAttempts;
  readNotes?: (workItemId: string) => Promise<AttemptAuditNote[] | null>;
  sql?: Sql;
}

/**
 * Iteration metrics for the given plan items (done ones included — attempts-until-pass is
 * most meaningful after the pass). Items with no slow attempts are omitted. Null when the
 * read fails; a work item whose notes cannot be read is classified without audit tags.
 */
export async function readIterationMetrics(
  input: {
    workspaceId: string;
    planSlug: string;
    itemIds: readonly string[];
    /** Plan item text by id — the source of each item's declared budget (see parseIterationBudget). */
    itemTexts?: Readonly<Record<string, string>>;
  },
  deps: ReadIterationDeps = {},
): Promise<IterationMetric[] | null> {
  if (input.itemIds.length === 0) return [];
  const budgets = new Map<string, IterationBudget>();
  for (const id of input.itemIds) {
    const b = parseIterationBudget(input.itemTexts?.[id]);
    if (b) budgets.set(id, b);
  }
  try {
    const sql = deps.sql ?? (getOrgPg().sql as unknown as Sql);
    const linked = deps.listLinked
      ? await deps.listLinked(input)
      : await listPlanLinkedWorkItems(input, sql, { includeTerminal: true });
    type Slot = { workItemIds: string[]; attempts: WorkItemAttempt[]; classes: Map<string, FailureClass> };
    const emptySlot = (): Slot => ({ workItemIds: [], attempts: [], classes: new Map() });
    const byItem = new Map<string, Slot>();
    for (const link of linked) {
      const attempts = await (deps.listAttempts ?? listWorkItemAttempts)(
        { workspaceId: input.workspaceId, workItemId: link.workItemId },
        sql,
      );
      if (attempts.length === 0) continue;
      const notes = (await (deps.readNotes ?? readAttemptAuditNotes)(link.workItemId)) ?? [];
      const classes = auditFailureClasses(notes, [...new Set(attempts.map(attemptKey))]);
      for (const itemId of link.itemIds) {
        const slot = byItem.get(itemId) ?? emptySlot();
        slot.workItemIds.push(link.workItemId);
        slot.attempts.push(...attempts);
        for (const [fp, c] of classes) slot.classes.set(fp, c);
        byItem.set(itemId, slot);
      }
    }
    // An item that declares a budget is reported even before its first slow attempt, so the
    // owner sees the declared cost next to the items already spending it.
    for (const itemId of budgets.keys()) {
      if (!byItem.has(itemId)) byItem.set(itemId, emptySlot());
    }
    return [...byItem.entries()]
      .map(([itemId, s]) =>
        iterationMetric(itemId, s.workItemIds, s.attempts, s.classes, budgets.get(itemId) ?? null),
      )
      .sort((a, b) => a.itemId.localeCompare(b.itemId));
  } catch {
    return null;
  }
}

/** One line per item for the lifecycle text view: `P-003 3 attempts to pass · failed: 1 harness, 1 environment`. */
export function formatIterationMetric(m: IterationMetric): string {
  const head = m.passed ? `${m.attemptsUntilPass} attempt(s) to pass` : `${m.attempts} attempt(s), not passed`;
  const split = (['product', 'harness', 'environment', 'unclassified'] as const)
    .filter((k) => m.failed[k] > 0)
    .map((k) => `${m.failed[k]} ${k}`)
    .join(', ');
  const b = m.budget;
  const budget = b
    ? ` · budget ${[b.iterations !== null ? `${b.iterations} attempt(s)` : null, b.attemptCostMs !== null ? `${Math.round(b.attemptCostMs / 60_000)}m each` : null]
        .filter(Boolean)
        .join(' × ')}${m.overBudget ? ' — OVER BUDGET' : ''}`
    : '';
  return `${m.itemId} ${head}${split ? ` · failed: ${split}` : ''}${m.running ? ` · ${m.running} running` : ''}${budget}`;
}
