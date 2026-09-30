/**
 * loop-gate.ts — notice a work item grinding through slow attempts, and hold the next
 * one until somebody has audited the loop.
 *
 * expensive-verification-loops-2026-09-29 P-002 (R-2). Deterministic by D-001: the
 * rule, the gate and the clearing are code over the attempt ledger (P-001) and the
 * work item's comments; only the audit's CONTENT is agent-written, and the gate checks
 * that content only for the one thing it can check mechanically — that it names every
 * distinct failure fingerprint in the loop.
 *
 * The window. Attempts count from the later of (a) the end of the most recent PASSING
 * attempt and (b) the most recent QUALIFYING audit note. A pass means the loop broke on
 * its own; a qualifying audit means somebody looked at every cause in it. An audit that
 * omits a fingerprint does not move the window, and is reported with what it missed.
 *
 * The rule (R-2): in the window, 2 failed attempts with distinct fingerprints, OR 3 with
 * the same fingerprint, OR total attempt time over budget. Cancelled attempts are not
 * failures but their time counts; a still-running attempt counts its elapsed time, so a
 * hung attempt reaches the budget without ever ending.
 *
 * Fail-open where the gate cannot measure: if the audit notes cannot be read, the gate
 * reports that and does NOT refuse. A gate nobody can clear would be worse than none.
 */
import type { Sql } from 'postgres';
import { listWorkItemAttempts, SLOW_ATTEMPT_MIN_MS, type WorkItemAttempt } from './attempt-ledger';

export const LOOP_DISTINCT_FAILURES = 2;
export const LOOP_REPEATED_FAILURES = 3;
/** Default total attempt time per window. P-007 lets a plan item declare its own. */
export const LOOP_ATTEMPT_BUDGET_MS = 4 * 60 * 60 * 1000;
/** The marker an audit note starts with, so it can be told from ordinary comments. */
export const ATTEMPT_AUDIT_MARKER = '[attempt-audit]';
/** The fingerprint key an attempt with no fingerprint is counted under. */
export const UNFINGERPRINTED = 'unfingerprinted';

export type LoopTrigger = 'distinct-failures' | 'repeated-failure' | 'over-budget';

export interface AttemptAuditNote {
  postedAt: string;
  body: string;
}

export interface LoopVerdict {
  tripped: boolean;
  triggers: LoopTrigger[];
  /** ISO start of the counted window; null when nothing has reset it yet. */
  windowStartedAt: string | null;
  windowAttempts: number;
  windowFailures: number;
  windowMs: number;
  budgetMs: number;
  /** Distinct failure fingerprints in the window — what an audit must name. */
  fingerprints: string[];
  /** Labels for those fingerprints, for a readable refusal. */
  labels: Record<string, string | null>;
  /** The newest audit note inside the window that did NOT qualify, and what it missed. */
  incompleteAudit: { postedAt: string; missing: string[] } | null;
}

function key(a: WorkItemAttempt): string {
  return a.fingerprint ?? UNFINGERPRINTED;
}

function isFailure(a: WorkItemAttempt): boolean {
  return a.outcome === 'fail' || a.outcome === 'unknown';
}

function isAudit(note: AttemptAuditNote): boolean {
  return note.body.trimStart().startsWith(ATTEMPT_AUDIT_MARKER);
}

/** The fingerprints an audit note fails to name. Plain substring match on the key. */
export function auditMissing(note: AttemptAuditNote, fingerprints: readonly string[]): string[] {
  return fingerprints.filter((fp) => !note.body.includes(fp));
}

/** Pure: evaluate the loop rule over attempts + comments. */
export function evaluateLoop(
  attempts: readonly WorkItemAttempt[],
  notes: readonly AttemptAuditNote[],
  opts: { now?: number; budgetMs?: number } = {},
): LoopVerdict {
  const now = opts.now ?? Date.now();
  const budgetMs = opts.budgetMs ?? LOOP_ATTEMPT_BUDGET_MS;
  const audits = notes.filter(isAudit).sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));

  // One chronological pass over attempt ends and audit notes. The window's failure
  // set is what an audit posted at that moment must cover.
  type Ev = { at: number; attempt?: WorkItemAttempt; audit?: AttemptAuditNote };
  const events: Ev[] = [];
  for (const a of attempts) if (a.endedAt) events.push({ at: Date.parse(a.endedAt), attempt: a });
  for (const n of audits) events.push({ at: Date.parse(n.postedAt), audit: n });
  // At a tie an attempt end sorts first: an audit posted the same instant saw it.
  events.sort((x, y) => x.at - y.at || (x.attempt ? -1 : 1));

  let windowStart = Number.NEGATIVE_INFINITY;
  let open = new Set<string>();
  for (const ev of events) {
    if (ev.attempt) {
      if (ev.attempt.outcome === 'pass') {
        windowStart = ev.at;
        open = new Set();
      } else if (isFailure(ev.attempt)) {
        open.add(key(ev.attempt));
      }
    } else if (ev.audit && auditMissing(ev.audit, [...open]).length === 0) {
      windowStart = ev.at;
      open = new Set();
    }
  }

  const inWindow = attempts.filter((a) => Date.parse(a.endedAt ?? a.startedAt) > windowStart || !a.endedAt);
  const failures = inWindow.filter((a) => a.endedAt && isFailure(a));
  const counts = new Map<string, number>();
  const labels: Record<string, string | null> = {};
  for (const f of failures) {
    counts.set(key(f), (counts.get(key(f)) ?? 0) + 1);
    labels[key(f)] = f.label ?? labels[key(f)] ?? null;
  }
  const windowMs = inWindow.reduce((sum, a) => {
    const start = Math.max(Date.parse(a.startedAt), windowStart);
    const end = a.endedAt ? Date.parse(a.endedAt) : now;
    return sum + Math.max(0, end - start);
  }, 0);

  const triggers: LoopTrigger[] = [];
  if (counts.size >= LOOP_DISTINCT_FAILURES) triggers.push('distinct-failures');
  if ([...counts.values()].some((n) => n >= LOOP_REPEATED_FAILURES)) triggers.push('repeated-failure');
  if (windowMs >= budgetMs) triggers.push('over-budget');

  const fingerprints = [...counts.keys()];
  const lateAudit = [...audits].reverse().find((n) => Date.parse(n.postedAt) > windowStart);
  return {
    tripped: triggers.length > 0,
    triggers,
    windowStartedAt: Number.isFinite(windowStart) ? new Date(windowStart).toISOString() : null,
    windowAttempts: inWindow.length,
    windowFailures: failures.length,
    windowMs,
    budgetMs,
    fingerprints,
    labels,
    incompleteAudit: lateAudit ? { postedAt: lateAudit.postedAt, missing: auditMissing(lateAudit, fingerprints) } : null,
  };
}

export interface LoopGateDeps {
  listAttempts?: typeof listWorkItemAttempts;
  /** Returns null when the item's comments cannot be read (the gate then fails open). */
  readNotes?: (workItemId: string) => Promise<AttemptAuditNote[] | null>;
  now?: () => number;
  sql?: Sql;
}

/** A work item's comment thread as audit-note candidates; null when it cannot be read. */
export async function readAttemptAuditNotes(workItemId: string): Promise<AttemptAuditNote[] | null> {
  try {
    // Lazy: issues-engineer is heavy and this module is imported on launch paths.
    const { getIssueThreadWindow } = await import('../issues-engineer');
    const window = await getIssueThreadWindow(workItemId, 200);
    if (!window) return null;
    return window.posts.map((p) => ({ postedAt: new Date(p.created_ts).toISOString(), body: String(p.body ?? '') }));
  } catch {
    return null;
  }
}

export type LoopGateDecision =
  | { allowed: true; verdict: LoopVerdict | null; notesReadable: boolean }
  | { allowed: false; verdict: LoopVerdict; reason: string };

/** The refusal text: what tripped, and the exact note that clears it. */
export function loopRefusalReason(workItemId: string, v: LoopVerdict): string {
  const hours = (ms: number) => (ms / 3_600_000).toFixed(1);
  const causes = v.fingerprints.map((fp) => `${fp}${v.labels[fp] ? ` (${v.labels[fp]})` : ''}`).join('; ');
  const missed = v.incompleteAudit?.missing.length
    ? ` Your audit of ${v.incompleteAudit.postedAt} does not name: ${v.incompleteAudit.missing.join(', ')}.`
    : '';
  return (
    `loop_audit_required — ${workItemId} is grinding (${v.triggers.join(', ')}): ` +
    `${v.windowFailures} failed of ${v.windowAttempts} slow attempts, ${hours(v.windowMs)}h of ${hours(v.budgetMs)}h budget. ` +
    `Failure causes: ${causes || 'none recorded'}.${missed} ` +
    `Before the next slow attempt, audit the harness for defect classes and post ` +
    `work_items:comment { id:'${workItemId}', body:'${ATTEMPT_AUDIT_MARKER} ...' } naming every fingerprint above ` +
    `with its cause and the fix. Quick checks (a focused test, a preflight) are not gated.`
  );
}

/**
 * The gate a slow-attempt launcher calls before it starts. Allows when the item is not
 * looping, when there is no work item, and when the audit notes cannot be read.
 */
export async function checkLoopGate(
  input: { workspaceId: string; workItemId: string | null | undefined; budgetMs?: number },
  deps: LoopGateDeps = {},
): Promise<LoopGateDecision> {
  if (!input.workItemId) return { allowed: true, verdict: null, notesReadable: false };
  try {
    const attempts = await (deps.listAttempts ?? listWorkItemAttempts)(
      { workspaceId: input.workspaceId, workItemId: input.workItemId },
      deps.sql,
    );
    if (attempts.length === 0) return { allowed: true, verdict: null, notesReadable: false };
    const notes = await (deps.readNotes ?? readAttemptAuditNotes)(input.workItemId);
    const verdict = evaluateLoop(attempts, notes ?? [], {
      now: deps.now?.(),
      ...(input.budgetMs ? { budgetMs: input.budgetMs } : {}),
    });
    if (!verdict.tripped) return { allowed: true, verdict, notesReadable: notes !== null };
    if (notes === null) return { allowed: true, verdict, notesReadable: false };
    return { allowed: false, verdict, reason: loopRefusalReason(input.workItemId, verdict) };
  } catch {
    // The gate is a backstop, not a new way for a launch to fail.
    return { allowed: true, verdict: null, notesReadable: false };
  }
}

export interface LoopNudgeDeps extends LoopGateDeps {
  send?: (input: { workspaceId: string; to: string; summary: string; body: string }) => Promise<unknown>;
}

async function defaultNudgeSend(input: { workspaceId: string; to: string; summary: string; body: string }) {
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  return sendMessage(
    {
      ownerId: 'verification-loop-gate',
      ownerLabel: 'verification-loop-gate',
      source: 'static-client',
      workspaceId: input.workspaceId,
      userId: null,
    },
    { to: [input.to], summary: input.summary, body: input.body },
  );
}

/**
 * P-002 nudge: tell the attempt's launcher at the moment THIS closed attempt trips the
 * loop rule — once, not on every later failure (those are refused at launch anyway).
 * Silent when the owner is not an agent id, the notes are unreadable, or anything throws.
 * Returns true when a nudge was sent.
 */
export async function nudgeOnNewLoop(
  input: { workspaceId: string; workItemId: string; taskId: string; ownerId: string | null | undefined },
  deps: LoopNudgeDeps = {},
): Promise<boolean> {
  try {
    const owner = input.ownerId?.trim();
    // launched_by falls back to a principal slug ('capability:bash') or 'unknown'.
    if (!owner || owner === 'unknown' || owner.includes(':')) return false;
    const attempts = await (deps.listAttempts ?? listWorkItemAttempts)(
      { workspaceId: input.workspaceId, workItemId: input.workItemId },
      deps.sql,
    );
    if (!attempts.some((a) => a.taskId === input.taskId)) return false;
    const notes = await (deps.readNotes ?? readAttemptAuditNotes)(input.workItemId);
    if (notes === null) return false;
    const opts = { now: deps.now?.() };
    const withIt = evaluateLoop(attempts, notes, opts);
    if (!withIt.tripped) return false;
    const without = evaluateLoop(
      attempts.filter((a) => a.taskId !== input.taskId),
      notes,
      opts,
    );
    if (without.tripped) return false;
    await (deps.send ?? defaultNudgeSend)({
      workspaceId: input.workspaceId,
      to: owner,
      summary: `${input.workItemId} is grinding (${withIt.triggers.join(', ')}): the next slow attempt will be held until the loop is audited`,
      body: loopRefusalReason(input.workItemId, withIt),
    });
    return true;
  } catch {
    return false;
  }
}

/** The refusal a launcher returns to its caller (JSON-serialisable). */
export interface LoopLaunchRefusal {
  ok: false;
  reason: 'loop_audit_required';
  work_item_id: string;
  triggers: LoopTrigger[];
  fingerprints: string[];
  message: string;
}

/**
 * The launch seam shared by capability:bash and release:cut. Only a launch that can run
 * past SLOW_ATTEMPT_MIN_MS is gated — a background job, or a foreground call given a
 * longer timeout — so the quick checks an audit needs stay free. Returns null to proceed.
 */
export async function loopLaunchRefusal(
  input: {
    workspaceId: string | null | undefined;
    workItemId: string | null | undefined;
    background: boolean;
    timeoutMs: number;
  },
  deps: LoopGateDeps = {},
): Promise<LoopLaunchRefusal | null> {
  if (!input.workspaceId || !input.workItemId) return null;
  if (!input.background && input.timeoutMs <= SLOW_ATTEMPT_MIN_MS) return null;
  const decision = await checkLoopGate({ workspaceId: input.workspaceId, workItemId: input.workItemId }, deps);
  if (decision.allowed) return null;
  return {
    ok: false,
    reason: 'loop_audit_required',
    work_item_id: input.workItemId,
    triggers: decision.verdict.triggers,
    fingerprints: decision.verdict.fingerprints,
    message: decision.reason,
  };
}
