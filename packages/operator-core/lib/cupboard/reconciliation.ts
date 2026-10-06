/**
 * Money reconciliation (agent-economy-flywheel-2026-08-30 P-043, R-31, D-025).
 *
 * The journal (P-042) is reconciled against what actually happened outside it:
 * Stripe balance transactions, the bank feed, and the chain (the DAO Safe and
 * the settlement contract). Hourly runs give PROVISIONAL figures for the open
 * month; a run after month close gives the FINAL figures for the closed month.
 *
 * Three invariants are mandated by the plan:
 *
 *   credit-reserve-covers-outstanding-credits
 *     journal customer-credit-reserve  >=  outstanding prepaid credits
 *   dao-payable-equals-accrued-minus-transferred
 *     journal dao-payable  ==  DAO share accrued  -  DAO transfers seen on chain
 *   safe-balance-equals-receipts-minus-approved-spends
 *     Safe token balance  ==  on-chain receipts  -  approved spends
 *
 * and three matching checks keep the journal those invariants read honest:
 * every external movement has exactly one journal entry with the same net cash
 * effect, and every journal entry's external reference exists at its source.
 *
 * A BREAK opens exactly one work item per invariant and stays open (deduped)
 * until a later run sees the invariant hold again. DAO transfers are paused
 * while any break is open, or while a mandated invariant cannot be evaluated
 * because its source failed: a reconciliation that cannot see must not leave
 * money moving.
 *
 * This module is pure apart from the injected `ReconciliationDeps`; the PG
 * store, the source adapters, the work-item filer and the gate publisher live
 * in reconciliation-runtime.ts.
 */
import {
  MICROS_PER_CENT,
  externalRefKey,
  trialBalance,
  type ExternalRefKind,
  type JournalEntry,
} from './money-journal';

export const MANDATED_INVARIANTS = [
  'credit-reserve-covers-outstanding-credits',
  'dao-payable-equals-accrued-minus-transferred',
  'safe-balance-equals-receipts-minus-approved-spends',
] as const;

export const MATCHING_INVARIANTS = ['journal-matches-stripe', 'journal-matches-bank', 'journal-matches-chain'] as const;

export const RECONCILIATION_INVARIANTS = [...MANDATED_INVARIANTS, ...MATCHING_INVARIANTS] as const;
export type ReconciliationInvariant = (typeof RECONCILIATION_INVARIANTS)[number];

export type ReconciliationMode = 'provisional' | 'final';

/**
 * One source read. `not-configured` means the rail does not exist in this
 * deployment (no bank connected, no Safe deployed); `failed` means it exists
 * and could not be read. They are different facts and are never merged.
 */
export type SourceRead<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'not-configured' };

/** One movement as its source records it. `netCents` is the signed effect on cash (inflow positive). */
export interface ExternalMovement {
  readonly ref: string;
  readonly netCents: number;
}

export interface CreditsSnapshot {
  /** Prepaid credits still owed to customers (available + reserved), in micro-USD. */
  readonly outstandingMicros: number;
}

export interface DaoSnapshot {
  /** DAO transfers settled on chain, in whole cents (the unit the journal records them in). */
  readonly transferredCents: number;
  /**
   * The DAO share accrued on the CHAIN rail according to the commerce ledger, not
   * the journal: the Worker's DAO allocation of every FINAL settlement batch
   * finalized before the period end, rounded to cents per batch exactly as the
   * import rounds it (D-032). The engine adds the journal's dao-payable credits
   * on off-chain entries (the Stripe and bank rails, tied to those sources by
   * their matching checks), so a missing, duplicated or mis-split chain-rail
   * accrual in the journal breaks the invariant.
   */
  readonly chainAccruedCents: number;
}

export interface SafeSnapshot {
  readonly balanceMicros: number;
  readonly receiptsMicros: number;
  readonly approvedSpendsMicros: number;
}

export interface ReconciliationSources {
  readonly stripe: SourceRead<readonly ExternalMovement[]>;
  readonly bank: SourceRead<readonly ExternalMovement[]>;
  readonly chain: SourceRead<readonly ExternalMovement[]>;
  readonly credits: SourceRead<CreditsSnapshot>;
  readonly dao: SourceRead<DaoSnapshot>;
  readonly safe: SourceRead<SafeSnapshot>;
}

export type InvariantStatus = 'ok' | 'broken' | 'unknown' | 'not-configured';

export interface InvariantVerdict {
  readonly invariant: ReconciliationInvariant;
  readonly status: InvariantStatus;
  /** One line a person can act on: the two sides of the comparison, or why it could not be made. */
  readonly detail: string;
}

export interface ReconciliationPeriod {
  readonly mode: ReconciliationMode;
  /** Inclusive start of the period (UTC month start). */
  readonly fromMs: number;
  /** Exclusive end: `now` for a provisional run, the next month start for a final one. */
  readonly untilMs: number;
  /** `YYYY-MM`, the month the run covers. */
  readonly month: string;
}

function monthStartMs(year: number, monthIndex: number): number {
  return Date.UTC(year, monthIndex, 1);
}

function monthLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The open month for a provisional run; the month that just closed for a final one. */
export function reconciliationPeriod(mode: ReconciliationMode, nowMs: number): ReconciliationPeriod {
  const now = new Date(nowMs);
  const currentStart = monthStartMs(now.getUTCFullYear(), now.getUTCMonth());
  if (mode === 'provisional') return { mode, fromMs: currentStart, untilMs: nowMs, month: monthLabel(currentStart) };
  const previousStart = monthStartMs(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return { mode, fromMs: previousStart, untilMs: currentStart, month: monthLabel(previousStart) };
}

const REF_KIND_FOR_MATCH: Readonly<Record<(typeof MATCHING_INVARIANTS)[number], ExternalRefKind>> = {
  'journal-matches-stripe': 'stripe-balance-transaction',
  'journal-matches-bank': 'bank-transaction',
  'journal-matches-chain': 'chain-tx',
};

const SOURCE_FOR_MATCH: Readonly<Record<(typeof MATCHING_INVARIANTS)[number], 'stripe' | 'bank' | 'chain'>> = {
  'journal-matches-stripe': 'stripe',
  'journal-matches-bank': 'bank',
  'journal-matches-chain': 'chain',
};

/** The entry's signed effect on cash: operating debits minus operating credits. */
export function entryNetCashCents(entry: JournalEntry): number {
  let net = 0;
  for (const line of entry.lines) {
    if (line.account !== 'operating') continue;
    net += line.side === 'debit' ? line.cents : -line.cents;
  }
  return net;
}

function unavailable(
  invariant: ReconciliationInvariant,
  read: { status: 'failed'; detail: string } | { status: 'not-configured' },
  source: string,
  mode: ReconciliationMode,
  mandated: boolean,
): InvariantVerdict {
  if (read.status === 'failed') return { invariant, status: 'unknown', detail: `${source} could not be read: ${read.detail}` };
  // A month cannot be closed on a mandated invariant nobody can evaluate.
  if (mode === 'final' && mandated) {
    return { invariant, status: 'unknown', detail: `${source} is not configured, so the final figure cannot be established` };
  }
  return { invariant, status: 'not-configured', detail: `${source} is not configured in this deployment` };
}

function matchingVerdict(
  invariant: (typeof MATCHING_INVARIANTS)[number],
  entries: readonly JournalEntry[],
  read: SourceRead<readonly ExternalMovement[]>,
  period: ReconciliationPeriod,
): InvariantVerdict {
  const source = SOURCE_FOR_MATCH[invariant];
  const refKind = REF_KIND_FOR_MATCH[invariant];
  const inPeriod = entries.filter(
    (e) =>
      e.externalRef.kind === refKind &&
      e.movement !== 'usage-settlement' &&
      e.occurredAtMs >= period.fromMs &&
      e.occurredAtMs < period.untilMs,
  );
  if (read.status !== 'ok') {
    // Journal entries citing a rail that is not configured are themselves a finding:
    // nothing can ever confirm them.
    if (read.status === 'not-configured' && inPeriod.length > 0) {
      return {
        invariant,
        status: 'broken',
        detail: `${inPeriod.length} journal entr${inPeriod.length === 1 ? 'y cites' : 'ies cite'} ${refKind} but no ${source} source is configured to confirm them`,
      };
    }
    return unavailable(invariant, read, source, period.mode, false);
  }
  const journal = new Map<string, number[]>();
  for (const entry of inPeriod) {
    const key = externalRefKey(entry.externalRef);
    const list = journal.get(key) ?? [];
    list.push(entryNetCashCents(entry));
    journal.set(key, list);
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const movement of read.value) {
    if (seen.has(movement.ref)) {
      problems.push(`${source} lists ${movement.ref} twice`);
      continue;
    }
    seen.add(movement.ref);
    const posted = journal.get(movement.ref);
    if (!posted) problems.push(`${movement.ref} (${movement.netCents}c) has no journal entry`);
    else if (posted.length > 1) problems.push(`${movement.ref} is journaled ${posted.length} times`);
    else if (posted[0] !== movement.netCents) {
      problems.push(`${movement.ref}: journal moves ${posted[0]}c of cash, ${source} moved ${movement.netCents}c`);
    }
  }
  for (const key of journal.keys()) {
    if (!seen.has(key)) problems.push(`journal entry ${key} has no ${source} movement`);
  }
  if (problems.length === 0) {
    return { invariant, status: 'ok', detail: `${read.value.length} ${source} movement(s) each match one journal entry` };
  }
  const shown = problems.slice(0, 5).join('; ');
  return {
    invariant,
    status: 'broken',
    detail: problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown,
  };
}

/**
 * dao-payable credits posted by entries that do NOT cite the chain. The chain
 * rail's accrual comes from the Worker instead (D-032), so it is the one part of
 * the accrual the journal cannot vouch for itself.
 */
export function daoCreditedOffChain(entries: readonly JournalEntry[]): number {
  let cents = 0;
  for (const entry of entries) {
    if (entry.externalRef.kind === 'chain-tx') continue;
    for (const line of entry.lines) if (line.account === 'dao-payable' && line.side === 'credit') cents += line.cents;
  }
  return cents;
}

/** Evaluate every invariant for one period. Balances are stocks (cumulative to the period end); matching covers flows within it. */
export function evaluateReconciliation(input: {
  readonly entries: readonly JournalEntry[];
  readonly sources: ReconciliationSources;
  readonly period: ReconciliationPeriod;
}): InvariantVerdict[] {
  const { sources, period } = input;
  const upToEnd = input.entries.filter((e) => e.occurredAtMs < period.untilMs);
  const tb = trialBalance(upToEnd);
  const balance = (account: string) => tb.accounts.find((a) => a.account === account)?.balanceCents ?? 0;
  const credited = (account: string) => tb.accounts.find((a) => a.account === account)?.creditCents ?? 0;
  const verdicts: InvariantVerdict[] = [];

  // 1. Prepaid credits owed to customers are covered by the reserve that holds them.
  {
    const invariant = 'credit-reserve-covers-outstanding-credits' as const;
    const read = sources.credits;
    if (read.status !== 'ok') verdicts.push(unavailable(invariant, read, 'the prepaid-credit store', period.mode, true));
    else {
      const reserveMicros = balance('customer-credit-reserve') * MICROS_PER_CENT;
      const outstanding = read.value.outstandingMicros;
      const ok = reserveMicros >= outstanding;
      verdicts.push({
        invariant,
        status: ok ? 'ok' : 'broken',
        detail: `credit reserve ${reserveMicros} micros ${ok ? '>=' : '<'} outstanding credits ${outstanding} micros`,
      });
    }
  }

  // 2. What the journal says the DAO is owed equals what accrued minus what the chain shows was paid.
  {
    const invariant = 'dao-payable-equals-accrued-minus-transferred' as const;
    const read = sources.dao;
    if (read.status !== 'ok') verdicts.push(unavailable(invariant, read, 'the DAO transfer record on chain', period.mode, true));
    else {
      const payable = balance('dao-payable');
      const offChain = daoCreditedOffChain(upToEnd);
      const accrued = offChain + read.value.chainAccruedCents;
      const expected = accrued - read.value.transferredCents;
      verdicts.push({
        invariant,
        status: payable === expected ? 'ok' : 'broken',
        detail:
          `journal dao-payable ${payable}c; accrued ${accrued}c (off-chain journal ${offChain}c + final settlements ${read.value.chainAccruedCents}c)` +
          ` - transferred on chain ${read.value.transferredCents}c = ${expected}c`,
      });
    }
  }

  // 3. The Safe holds exactly what it received minus what was approved to leave it.
  {
    const invariant = 'safe-balance-equals-receipts-minus-approved-spends' as const;
    const read = sources.safe;
    if (read.status !== 'ok') verdicts.push(unavailable(invariant, read, 'the DAO Safe', period.mode, true));
    else {
      const { balanceMicros, receiptsMicros, approvedSpendsMicros } = read.value;
      const expected = receiptsMicros - approvedSpendsMicros;
      verdicts.push({
        invariant,
        status: balanceMicros === expected ? 'ok' : 'broken',
        detail: `Safe balance ${balanceMicros} micros; receipts ${receiptsMicros} - approved spends ${approvedSpendsMicros} = ${expected} micros`,
      });
    }
  }

  for (const invariant of MATCHING_INVARIANTS) {
    verdicts.push(matchingVerdict(invariant, input.entries, sources[SOURCE_FOR_MATCH[invariant]], period));
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// Breaks: one open row (and one work item) per broken invariant.
// ---------------------------------------------------------------------------

export interface OpenBreak {
  readonly invariant: ReconciliationInvariant;
  readonly workItemId: string | null;
  readonly openedAtMs: number;
  readonly openedByRunId: string;
  /** The mode of the run that opened it; absent when that run never recorded (treated as provisional). */
  readonly openedMode?: ReconciliationMode;
}

export type BreakAction =
  | { readonly kind: 'open'; readonly verdict: InvariantVerdict }
  | { readonly kind: 'keep'; readonly open: OpenBreak; readonly verdict: InvariantVerdict }
  | { readonly kind: 'resolve'; readonly open: OpenBreak; readonly verdict: InvariantVerdict };

/**
 * Diff this run's verdicts against the open breaks. A break is only RESOLVED by
 * an `ok` verdict: an invariant that could not be evaluated keeps its break open,
 * because nothing has shown the money is right again.
 *
 * A break opened by a FINAL run concerns a closed month, which a provisional run
 * (over the open month) never looks at. Only a final run can resolve it; a
 * provisional run leaves it open and untouched, so its detail keeps the evidence.
 */
export function planBreakActions(
  verdicts: readonly InvariantVerdict[],
  open: readonly OpenBreak[],
  mode: ReconciliationMode = 'provisional',
): BreakAction[] {
  const openByInvariant = new Map(open.map((b) => [b.invariant, b]));
  const actions: BreakAction[] = [];
  for (const verdict of verdicts) {
    const existing = openByInvariant.get(verdict.invariant);
    const closedMonthBreak = existing?.openedMode === 'final' && mode !== 'final';
    if (verdict.status === 'broken') {
      if (!existing) actions.push({ kind: 'open', verdict });
      else if (!closedMonthBreak) actions.push({ kind: 'keep', open: existing, verdict });
    } else if (closedMonthBreak) continue;
    else if (existing && verdict.status === 'ok') actions.push({ kind: 'resolve', open: existing, verdict });
    else if (existing) actions.push({ kind: 'keep', open: existing, verdict });
  }
  return actions;
}

export interface TransferGate {
  readonly open: boolean;
  /** Empty when open; otherwise why transfers are paused. */
  readonly reasons: readonly string[];
}

/** DAO transfers run only while no break is open and every mandated invariant could be evaluated. */
export function transferGate(verdicts: readonly InvariantVerdict[], openAfterRun: readonly ReconciliationInvariant[]): TransferGate {
  const reasons: string[] = [];
  for (const invariant of openAfterRun) reasons.push(`break open: ${invariant}`);
  for (const v of verdicts) {
    if (v.status === 'unknown' && (MANDATED_INVARIANTS as readonly string[]).includes(v.invariant)) {
      reasons.push(`cannot evaluate ${v.invariant}: ${v.detail}`);
    }
  }
  return { open: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// One run, end to end, over injected dependencies.
// ---------------------------------------------------------------------------

export interface ReconciliationStore {
  listOpenBreaks(workspaceId: string): Promise<OpenBreak[]>;
  /** Insert the open row; resolves `false` when a concurrent run already opened this invariant. */
  openBreak(workspaceId: string, b: OpenBreak, detail: string): Promise<boolean>;
  setBreakWorkItem(workspaceId: string, invariant: ReconciliationInvariant, workItemId: string): Promise<void>;
  touchBreak(workspaceId: string, invariant: ReconciliationInvariant, runId: string, detail: string): Promise<void>;
  resolveBreak(workspaceId: string, invariant: ReconciliationInvariant, runId: string, atMs: number): Promise<void>;
  recordRun(run: ReconciliationRunRecord): Promise<void>;
}

export interface BreakFiler {
  /** File the work item for a NEW break; returns its id. */
  fileBreak(input: { workspaceId: string; verdict: InvariantVerdict; period: ReconciliationPeriod; runId: string }): Promise<string>;
  /** Note on the existing item that the invariant holds again. */
  noteResolved(input: { workspaceId: string; workItemId: string; verdict: InvariantVerdict; runId: string }): Promise<void>;
}

export type GatePublishResult = { readonly published: true } | { readonly published: false; readonly detail: string };

export interface GatePublisher {
  publish(input: { workspaceId: string; gate: TransferGate; runId: string; atMs: number }): Promise<GatePublishResult>;
}

export interface ReconciliationRunRecord {
  readonly runId: string;
  readonly workspaceId: string;
  readonly period: ReconciliationPeriod;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly verdicts: readonly InvariantVerdict[];
  readonly opened: readonly ReconciliationInvariant[];
  readonly resolved: readonly ReconciliationInvariant[];
  readonly gate: TransferGate;
  readonly gatePublish: GatePublishResult;
}

export interface ReconciliationDeps {
  readonly store: ReconciliationStore;
  readonly filer: BreakFiler;
  readonly gate: GatePublisher;
  readonly now: () => number;
  readonly newRunId: () => string;
}

export async function runReconciliation(
  input: {
    readonly workspaceId: string;
    readonly mode: ReconciliationMode;
    readonly entries: readonly JournalEntry[];
    readonly sources: ReconciliationSources;
    readonly startedAtMs?: number;
  },
  deps: ReconciliationDeps,
): Promise<ReconciliationRunRecord> {
  const startedAtMs = input.startedAtMs ?? deps.now();
  const runId = deps.newRunId();
  const period = reconciliationPeriod(input.mode, startedAtMs);
  const verdicts = evaluateReconciliation({ entries: input.entries, sources: input.sources, period });
  const open = await deps.store.listOpenBreaks(input.workspaceId);
  const actions = planBreakActions(verdicts, open, input.mode);
  const opened: ReconciliationInvariant[] = [];
  const resolved: ReconciliationInvariant[] = [];
  const stillOpen = new Set(open.map((b) => b.invariant));

  for (const action of actions) {
    const invariant = action.verdict.invariant;
    if (action.kind === 'open') {
      const row: OpenBreak = { invariant, workItemId: null, openedAtMs: startedAtMs, openedByRunId: runId, openedMode: input.mode };
      stillOpen.add(invariant);
      // The row is written BEFORE the item is filed, so a concurrent run loses the
      // insert and files nothing: one break, one item.
      if (!(await deps.store.openBreak(input.workspaceId, row, action.verdict.detail))) continue;
      opened.push(invariant);
      const workItemId = await deps.filer.fileBreak({ workspaceId: input.workspaceId, verdict: action.verdict, period, runId });
      await deps.store.setBreakWorkItem(input.workspaceId, invariant, workItemId);
    } else if (action.kind === 'keep') {
      await deps.store.touchBreak(input.workspaceId, invariant, runId, action.verdict.detail);
      // The opening run inserted the row but failed before its item was filed (the
      // filer threw, or the process died): file it now, or the break stays invisible.
      if (!action.open.workItemId) {
        const workItemId = await deps.filer.fileBreak({ workspaceId: input.workspaceId, verdict: action.verdict, period, runId });
        await deps.store.setBreakWorkItem(input.workspaceId, invariant, workItemId);
      }
    } else {
      await deps.store.resolveBreak(input.workspaceId, invariant, runId, startedAtMs);
      stillOpen.delete(invariant);
      resolved.push(invariant);
      if (action.open.workItemId) {
        await deps.filer.noteResolved({ workspaceId: input.workspaceId, workItemId: action.open.workItemId, verdict: action.verdict, runId });
      }
    }
  }

  const gate = transferGate(verdicts, [...stillOpen]);
  const gatePublish = await deps.gate.publish({ workspaceId: input.workspaceId, gate, runId, atMs: startedAtMs });
  const record: ReconciliationRunRecord = {
    runId,
    workspaceId: input.workspaceId,
    period,
    startedAtMs,
    finishedAtMs: deps.now(),
    verdicts,
    opened,
    resolved,
    gate,
    gatePublish,
  };
  await deps.store.recordRun(record);
  return record;
}

/** An in-memory store with the PG store's semantics, for tests and dry runs. */
export function memoryReconciliationStore(): ReconciliationStore & {
  readonly runs: ReconciliationRunRecord[];
  readonly rows: Map<string, OpenBreak & { detail: string; lastRunId: string; resolvedAtMs: number | null }>;
} {
  const rows = new Map<string, OpenBreak & { detail: string; lastRunId: string; resolvedAtMs: number | null }>();
  const runs: ReconciliationRunRecord[] = [];
  const key = (ws: string, inv: string) => `${ws}\u0000${inv}`;
  return {
    rows,
    runs,
    async listOpenBreaks(ws) {
      return [...rows.entries()]
        .filter(([k, r]) => k.startsWith(`${ws}\u0000`) && r.resolvedAtMs === null)
        .map(([, r]) => ({
          invariant: r.invariant,
          workItemId: r.workItemId,
          openedAtMs: r.openedAtMs,
          openedByRunId: r.openedByRunId,
          // Like the PG store, the mode is known only once the opening run recorded.
          openedMode: runs.find((run) => run.runId === r.openedByRunId)?.period.mode,
        }));
    },
    async openBreak(ws, b, detail) {
      const existing = rows.get(key(ws, b.invariant));
      if (existing && existing.resolvedAtMs === null) return false;
      rows.set(key(ws, b.invariant), { ...b, detail, lastRunId: b.openedByRunId, resolvedAtMs: null });
      return true;
    },
    async setBreakWorkItem(ws, inv, id) {
      const r = rows.get(key(ws, inv));
      if (r) rows.set(key(ws, inv), { ...r, workItemId: id });
    },
    async touchBreak(ws, inv, runId, detail) {
      const r = rows.get(key(ws, inv));
      if (r) rows.set(key(ws, inv), { ...r, lastRunId: runId, detail });
    },
    async resolveBreak(ws, inv, runId, atMs) {
      const r = rows.get(key(ws, inv));
      if (r) rows.set(key(ws, inv), { ...r, lastRunId: runId, resolvedAtMs: atMs });
    },
    async recordRun(run) {
      runs.push(run);
    },
  };
}
